/**
 * Permanent Canary QA signup path.
 *
 * Canary Clerk is in restricted signup mode. A live QA run therefore does not
 * precreate a user and does not use sign-in tickets: it creates a unique
 * no-mail Backend API invitation for a disposable +clerk_test address, opens
 * the acceptance URL Clerk returned, and completes the real public sign-up UI
 * with Clerk's fixed test OTP. The returned context is the disposable user's
 * authenticated browser context; callers still delete the user in teardown.
 */
import { randomBytes } from 'node:crypto';

import type { Browser, BrowserContext, Page } from '@playwright/test';

import {
  assertClerkTestAuditEmail,
  assertLiveManagedHostingAuditAllowed,
  assertNotProduction,
  CLERK_TEST_OTP_CODE,
} from './config';
import {
  createAuditInvitation,
  deleteAuditUser,
  findAuditUserByEmail,
  revokeAuditInvitation,
  type ClerkInvitation,
} from './clerk-admin';
import { createAuditBrowserContext, type AuditContextOptions } from './session';

const DEFAULT_SIGNUP_TIMEOUT_MS = 120_000;

export interface ClerkSignupUiResult {
  userId: string;
  otpUsed: boolean;
  finalUrl: string;
  passwordRequired: boolean;
}

export interface AcceptAuditInvitationOptions {
  baseUrl: string;
  clerkSecretKey: string;
  email: string;
  /** Same-origin path the product asked sign-up to return to. Omit for the product default. */
  redirectPath?: string;
  timeoutMs?: number;
  /** The contract under test is email OTP. Keep this true in live acceptance. */
  requireOtpStep?: boolean;
}

export interface AuditSignupResult extends ClerkSignupUiResult {
  context: BrowserContext;
  invitation: ClerkInvitation;
}

function assertInternalRedirectPath(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new Error(`[clerk-signup] redirectPath must be a same-origin path, not ${JSON.stringify(path)}`);
  }
}

/** The sign-up URL embedded in the invitation. The product redirect survives inside its redirect_url parameter. */
export function signUpUrlForInvitation(baseUrl: string, redirectPath?: string): string {
  assertNotProduction(baseUrl);
  if (redirectPath) assertInternalRedirectPath(redirectPath);
  const url = new URL('/sign-up', baseUrl);
  if (redirectPath) url.searchParams.set('redirect_url', redirectPath);
  return url.toString();
}

/**
 * The invitation acceptance URL is itself a bearer capability for a few hours.
 * Refuse anything that is not Clerk's development ticket-acceptance endpoint;
 * a malformed or hostile API response must never send the browser elsewhere.
 */
export function assertClerkInvitationAcceptUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('[clerk-signup] invitation acceptance URL is invalid');
  }
  const host = url.hostname.toLowerCase();
  const clerkDevHost = host.endsWith('.clerk.accounts.dev') || host.endsWith('.accounts.dev');
  if (
    url.protocol !== 'https:' ||
    !clerkDevHost ||
    url.pathname !== '/v1/tickets/accept' ||
    !url.searchParams.get('ticket')
  ) {
    throw new Error(`[clerk-signup] refusing unexpected invitation acceptance URL host/path: ${url.origin}${url.pathname}`);
  }
}

async function visibleInput(page: Page, selector: string) {
  const input = page.locator(selector).first();
  if ((await input.count().catch(() => 0)) === 0) return null;
  return (await input.isVisible().catch(() => false)) ? input : null;
}

async function fillIfEmpty(page: Page, selector: string, value: string): Promise<boolean> {
  const input = await visibleInput(page, selector);
  if (!input || !(await input.isEnabled().catch(() => false))) return false;
  if ((await input.inputValue().catch(() => '')) !== '') return false;
  await input.fill(value);
  return true;
}

async function acceptLegalConsentIfPresent(page: Page): Promise<void> {
  const box = page.locator('input[name="legalAccepted"]').first();
  if ((await box.count().catch(() => 0)) === 0) return;
  if (await box.isChecked().catch(() => false)) return;
  if (await box.isVisible().catch(() => false)) {
    await box.check();
    return;
  }
  const id = await box.getAttribute('id').catch(() => null);
  if (id) {
    const label = page.locator(`label[for="${id.replace(/"/g, '\\"')}"]`).first();
    if (await label.isVisible().catch(() => false)) {
      await label.click();
      return;
    }
  }
  await box.click({ force: true }).catch(() => undefined);
}

async function clickSignupSubmit(page: Page): Promise<boolean> {
  const primary = page.locator('.cl-formButtonPrimary[type="submit"], button.cl-formButtonPrimary').first();
  if (await primary.isVisible().catch(() => false)) {
    await primary.click();
    return true;
  }

  // Fallback for a Clerk UI revision that drops the targetable class: use the
  // form's own submit control, never a social-button or footer link.
  const submits = page.locator('form button[type="submit"]');
  const count = Math.min(await submits.count().catch(() => 0), 5);
  for (let index = 0; index < count; index += 1) {
    const button = submits.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    const text = ((await button.textContent().catch(() => '')) ?? '').trim();
    if (/^(continue|sign up|create account)$/i.test(text)) {
      await button.click();
      return true;
    }
  }
  return false;
}

async function clickInvitationAcceptance(page: Page): Promise<boolean> {
  // Clerk may show an invitation acknowledgement before it mounts signup.
  // Match only invitation wording so ordinary provider buttons are untouched.
  const buttons = page.locator('button, a[role="button"]');
  const count = Math.min(await buttons.count().catch(() => 0), 12);
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (!(await button.isVisible().catch(() => false))) continue;
    const text = ((await button.textContent().catch(() => '')) ?? '').trim();
    if (/^(accept|accept invite|accept invitation|continue with invitation)$/i.test(text)) {
      await button.click();
      return true;
    }
  }
  return false;
}

async function clerkSignupState(page: Page): Promise<{
  userId: string | null;
  sessionId: string | null;
  path: string;
  signUpStatus: string | null;
  createdSessionId: string | null;
}> {
  return page.evaluate(() => {
    const clerk = (window as unknown as {
      Clerk?: {
        user?: { id?: string } | null;
        session?: { id?: string } | null;
        client?: { signUp?: { status?: string; createdSessionId?: string | null } };
      };
    }).Clerk;
    return {
      userId: clerk?.user?.id ?? null,
      sessionId: clerk?.session?.id ?? null,
      path: window.location.pathname,
      signUpStatus: clerk?.client?.signUp?.status ?? null,
      createdSessionId: clerk?.client?.signUp?.createdSessionId ?? null,
    };
  }).catch(() => ({ userId: null, sessionId: null, path: '', signUpStatus: null, createdSessionId: null }));
}

/**
 * Drive only the public DOM a real invitee sees. This function is separated
 * from invitation creation so it can be exercised offline against a mocked
 * Clerk-shaped document.
 */
export async function completeClerkSignupUi(
  page: Page,
  {
    email,
    timeoutMs = DEFAULT_SIGNUP_TIMEOUT_MS,
    requireOtpStep = true,
  }: {
    email: string;
    timeoutMs?: number;
    requireOtpStep?: boolean;
  },
): Promise<ClerkSignupUiResult> {
  assertClerkTestAuditEmail(email);
  const deadline = Date.now() + timeoutMs;
  const password = `A9!${randomBytes(24).toString('base64url')}`;
  const username = `qa${randomBytes(8).toString('hex')}`;
  let otpUsed = false;
  let passwordRequired = false;
  let lastState = 'not inspected';

  while (Date.now() < deadline) {
    const state = await clerkSignupState(page);
    lastState = `path=${state.path || '(unavailable)'} signUp=${state.signUpStatus ?? 'none'} user=${state.userId ? 'present' : 'absent'}`;
    const onSignup = state.path.startsWith('/sign-up');
    if (!onSignup && state.userId && state.sessionId) {
      if (requireOtpStep && !otpUsed) {
        throw new Error('[clerk-signup] sign-up completed without the Clerk test OTP step; the invitation path did not prove the required email-code form');
      }
      return { userId: state.userId, otpUsed, finalUrl: page.url(), passwordRequired };
    }

    const otp = page.locator('input[data-input-otp], input[autocomplete="one-time-code"]').first();
    if ((await otp.count().catch(() => 0)) > 0 && await otp.isVisible().catch(() => false)) {
      await otp.click();
      await otp.fill(CLERK_TEST_OTP_CODE);
      otpUsed = true;
      await page.waitForTimeout(300);
      continue;
    }

    if (onSignup) {
      if (await clickInvitationAcceptance(page)) {
        await page.waitForTimeout(500);
        continue;
      }
      // Invitation acceptance pre-fills and usually disables the invited
      // address. If a Clerk revision leaves it editable, enter exactly the same
      // disposable address — never a different identity.
      await fillIfEmpty(page, 'input[name="emailAddress"]', email);
      await fillIfEmpty(page, 'input[name="firstName"]', 'FirstRun');
      await fillIfEmpty(page, 'input[name="lastName"]', 'Audit');
      await fillIfEmpty(page, 'input[name="username"]', username);
      if (await fillIfEmpty(page, 'input[name="password"]', password)) passwordRequired = true;
      await acceptLegalConsentIfPresent(page);

      if (await clickSignupSubmit(page)) {
        await page.waitForTimeout(500);
        continue;
      }
    }

    await page.waitForTimeout(250);
  }

  throw new Error(`[clerk-signup] public sign-up UI did not complete within ${timeoutMs}ms (${lastState})`);
}

async function cleanupFailedSignup(secretKey: string, email: string, invitationId: string): Promise<string> {
  // If the browser died after Clerk created the user, delete that exact user.
  // Otherwise revoke the still-pending invitation so the bearer URL cannot be
  // replayed later. Cleanup errors are reported, never hidden.
  const user = await findAuditUserByEmail(secretKey, email);
  if (user) {
    const deleted = await deleteAuditUser(secretKey, user.id, { verifyDeletion: true });
    return deleted ? 'deleted partially-created user' : 'partially-created user already absent';
  }
  if (!await revokeAuditInvitation(secretKey, invitationId)) {
    throw new Error('[clerk-signup] invitation revocation not confirmed');
  }
  return 'revoked unaccepted invitation';
}

/** Create the invitation, open it in this page, and complete the public signup form. */
export async function acceptAuditInvitation(
  page: Page,
  options: AcceptAuditInvitationOptions,
): Promise<ClerkSignupUiResult & { invitation: ClerkInvitation }> {
  assertLiveManagedHostingAuditAllowed();
  assertNotProduction(options.baseUrl);
  assertClerkTestAuditEmail(options.email);
  const invitation = await createAuditInvitation(
    options.clerkSecretKey,
    options.email,
    signUpUrlForInvitation(options.baseUrl, options.redirectPath),
  );

  try {
    assertClerkInvitationAcceptUrl(invitation.url);
    await page.goto(invitation.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const result = await completeClerkSignupUi(page, {
      email: options.email,
      timeoutMs: options.timeoutMs,
      requireOtpStep: options.requireOtpStep ?? true,
    });

    if (options.redirectPath) {
      const finalUrl = new URL(result.finalUrl);
      const finalPath = `${finalUrl.pathname}${finalUrl.search}`;
      if (finalPath !== options.redirectPath) {
        throw new Error(`[clerk-signup] authenticated redirect was ${finalPath}, expected exact ${options.redirectPath}`);
      }
    }
    return { ...result, invitation };
  } catch (error) {
    let cleanup = 'cleanup not attempted';
    try {
      cleanup = await cleanupFailedSignup(options.clerkSecretKey, options.email, invitation.id);
    } catch (cleanupError) {
      cleanup = `cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} [invitation signup cleanup: ${cleanup}]`);
  }
}

/** High-level path used by live QA harnesses: virgin browser + invited public signup. */
export async function signUpAuditUser(
  browser: Browser,
  options: AcceptAuditInvitationOptions & Pick<AuditContextOptions, 'onContext'>,
): Promise<AuditSignupResult> {
  const context = await createAuditBrowserContext(browser, {
    baseUrl: options.baseUrl,
    onContext: options.onContext,
  });
  const page = await context.newPage();
  try {
    const result = await acceptAuditInvitation(page, options);
    return { ...result, context };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}
