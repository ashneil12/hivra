/**
 * Sign in as the standing Canary QA account through the real Canary sign-in
 * page: email, Continue, then Clerk's fixed test code. No Clerk secret is
 * needed, only CANARY_QA_EMAIL.
 */
import type { Browser, Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { assertClerkTestAuditEmail, CLERK_TEST_OTP_CODE } from '../first-run-audit/config';
import { assertCanaryQaBaseUrl, readCanaryQaEmail } from './config';

export const CANARY_QA_STORAGE_STATE = 'e2e/.auth/qa-user.json';

export async function signInAsCanaryQa(
  page: Page,
  { baseUrl, email = readCanaryQaEmail() }: { baseUrl: string; email?: string },
): Promise<void> {
  const origin = assertCanaryQaBaseUrl(baseUrl);
  assertClerkTestAuditEmail(email);
  await page.goto(`${origin}/sign-in`, { waitUntil: 'domcontentloaded' });
  const signInUrl = new URL(page.url());
  if (signInUrl.origin !== origin || !/^\/sign-in(?:\/|$)/.test(signInUrl.pathname)) {
    throw new Error('[canary-qa] Clerk sign-in did not remain on the expected origin.');
  }

  const rejectCookies = page.getByRole('button', { name: 'Reject all' });
  await rejectCookies.click({ timeout: 5_000 }).catch(() => undefined);

  try {
    await page.locator('input[name="identifier"]').fill(email, { timeout: 45_000 });
  } catch {
    throw new Error('[canary-qa] could not fill the Clerk sign-in identifier.');
  }
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  const code = page.locator('input[autocomplete="one-time-code"], input[name="code"]').first();
  await code.waitFor({ state: 'visible', timeout: 30_000 });
  await code.click();
  await page.keyboard.type(CLERK_TEST_OTP_CODE, { delay: 50 });

  await page.waitForURL((url) => url.origin === origin && /^\/dashboard(?:\/|$)/.test(url.pathname), { timeout: 60_000 });
}

/** Signs in in a fresh context and writes Playwright storage state for the authed projects. */
export async function saveCanaryQaStorageState(
  browser: Browser,
  { baseUrl, path = CANARY_QA_STORAGE_STATE }: { baseUrl: string; path?: string },
): Promise<void> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await signInAsCanaryQa(page, { baseUrl });
    mkdirSync(dirname(path), { recursive: true });
    await context.storageState({ path });
  } finally {
    await context.close();
  }
}
