import { chromium, type FullConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { CANARY_QA_EMAIL_ENV } from './canary-qa/config';
import { CANARY_QA_STORAGE_STATE, saveCanaryQaStorageState } from './canary-qa/auth';
import { assertTicketSignInDisabled } from './first-run-audit/config';
import { launchOptions } from '../scripts/lib/playwright-launch.cjs';

/**
 * Ordinary Playwright auth state.
 *
 * With CANARY_QA_EMAIL set, setup signs in as the standing Canary QA account
 * through the real sign-in page (Clerk test code, no secret needed) and writes
 * its storage state, so the authed, vrt and journey projects run as that
 * account. See e2e/README.md.
 *
 * The historical QA_USER_ID sign-in-ticket path stays hard-disabled because
 * Clerk sent mail after ticket redemption. Without CANARY_QA_EMAIL, setup
 * writes an empty state and authed specs skip.
 */
const AUTH_FILE = CANARY_QA_STORAGE_STATE;

export default async function globalSetup(config: FullConfig) {
  mkdirSync(dirname(AUTH_FILE), { recursive: true });

  if (process.env[CANARY_QA_EMAIL_ENV]) {
    const baseUrl = String(config.projects[0]?.use.baseURL ?? process.env.E2E_BASE_URL ?? 'https://canary.hermesos.cloud');
    const browser = await chromium.launch(launchOptions());
    try {
      await saveCanaryQaStorageState(browser, { baseUrl, path: AUTH_FILE });
    } finally {
      await browser.close();
    }
    return;
  }

  const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
  const QA_USER_ID = process.env.QA_USER_ID;
  if (CLERK_SECRET_KEY && QA_USER_ID) assertTicketSignInDisabled();

  console.warn(`[global-setup] ${CANARY_QA_EMAIL_ENV} is not set — authed specs will skip.`);
  writeFileSync(AUTH_FILE, JSON.stringify({ cookies: [], origins: [] }));
}
