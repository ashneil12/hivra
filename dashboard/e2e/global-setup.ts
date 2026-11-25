import type { FullConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { assertTicketSignInDisabled } from './first-run-audit/config';

/**
 * Ordinary Playwright auth state.
 *
 * The historical path minted a Clerk sign-in ticket for QA_USER_ID and redeemed
 * it in a browser. That path is hard-disabled because Clerk sent mail after
 * ticket redemption. Live managed-hosting audits use disposable +clerk_test
 * users through e2e/first-run-audit/session.ts instead. Until the standing QA
 * path is redesigned, setup writes an empty state and authed specs skip.
 */
const AUTH_FILE = 'e2e/.auth/qa-user.json';

export default async function globalSetup(_config: FullConfig) {
  const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
  const QA_USER_ID = process.env.QA_USER_ID;
  if (CLERK_SECRET_KEY && QA_USER_ID) assertTicketSignInDisabled();

  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  console.warn('[global-setup] no approved standing QA auth path — authed specs will skip.');
  writeFileSync(AUTH_FILE, JSON.stringify({ cookies: [], origins: [] }));
}
