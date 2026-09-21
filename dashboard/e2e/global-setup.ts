import { chromium, type FullConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Mints a short-lived Clerk sign-in ticket for the dedicated QA user and saves
 * an authenticated storage state for the `authed` project.
 *
 * This is the SAME mechanism the qa-e2e agent uses, verified end-to-end:
 *   POST https://api.clerk.com/v1/sign_in_tokens
 *   Authorization: Bearer ${CLERK_SECRET_KEY}   Content-Type: application/json
 *   { "user_id": QA_USER_ID, "expires_in_seconds": 2700 }
 * then redeem it client-side via Clerk's ticket strategy.
 *
 * If the secrets are absent (e.g. a fork PR with no access), this no-ops — the
 * authed project's specs skip rather than fail the whole run.
 */
const AUTH_FILE = 'e2e/.auth/qa-user.json';

export default async function globalSetup(config: FullConfig) {
  const baseURL =
    config.projects.find((p) => p.use?.baseURL)?.use?.baseURL ||
    process.env.E2E_BASE_URL ||
    'https://canary.hermesos.cloud';

  const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
  const QA_USER_ID = process.env.QA_USER_ID;

  // Write an empty state so the `authed` project can load it; specs guard on it.
  mkdirSync(dirname(AUTH_FILE), { recursive: true });

  if (!CLERK_SECRET_KEY || !QA_USER_ID) {
    console.warn(
      '[global-setup] CLERK_SECRET_KEY / QA_USER_ID not set — authed specs will skip.',
    );
    writeFileSync(AUTH_FILE, JSON.stringify({ cookies: [], origins: [] }));
    return;
  }

  // 1) Mint the ticket via the Clerk Backend API.
  const res = await fetch('https://api.clerk.com/v1/sign_in_tokens', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CLERK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ user_id: QA_USER_ID, expires_in_seconds: 2700 }),
  });
  if (!res.ok) {
    throw new Error(`[global-setup] ticket mint failed: HTTP ${res.status} ${await res.text()}`);
  }
  const { token } = (await res.json()) as { token?: string };
  if (!token) throw new Error('[global-setup] mint returned no token');

  // 2) Redeem the ticket in a real browser to obtain a Clerk session, then
  //    persist the resulting cookies/storage as the authed state.
  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL });
  try {
    await page.goto('/sign-in', { waitUntil: 'domcontentloaded' });
    // Minimal shape of the Clerk client we touch — avoids `any`. Types are erased
    // at runtime, so the browser-context callbacks below run as plain JS.
    type ClerkWin = {
      Clerk?: {
        loaded?: boolean;
        client: {
          signIn: {
            create(o: { strategy: 'ticket'; ticket: string }): Promise<{ createdSessionId: string }>;
          };
        };
        setActive(o: { session: string }): Promise<void>;
      };
    };
    // Clerk must be loaded on the window before we can redeem the ticket.
    await page.waitForFunction(() => !!(window as unknown as ClerkWin).Clerk?.loaded, {
      timeout: 30_000,
    });
    await page.evaluate(async (t) => {
      const clerk = (window as unknown as ClerkWin).Clerk;
      if (!clerk) throw new Error('Clerk failed to load on /sign-in');
      const signIn = await clerk.client.signIn.create({ strategy: 'ticket', ticket: t });
      await clerk.setActive({ session: signIn.createdSessionId });
    }, token);
    // Land on the authed dashboard so the session cookie is fully established.
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded' });
    await page.context().storageState({ path: AUTH_FILE });
    console.log('[global-setup] authed storage state saved →', AUTH_FILE);
  } finally {
    await browser.close();
  }
}
