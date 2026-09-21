import { defineConfig, devices } from '@playwright/test';

/**
 * Dashboard E2E + visual-regression (VRT) — Tier 1 of the QA pyramid.
 *
 * Targets a DEPLOYED url (default: live canary) rather than building Next 16 on
 * the runner — matches the qa-e2e agent's approach and keeps CI light. Point it
 * at a Vercel preview URL per-PR later via E2E_BASE_URL.
 *
 * Auth: golden-path specs reuse the verified Clerk sign-in-ticket mechanism
 * (see e2e/global-setup.ts). Public specs need no auth.
 */
const BASE_URL = process.env.E2E_BASE_URL || 'https://canary.hermesos.cloud';

/**
 * The FIRST-RUN AUDIT provisions REAL PAID INFRASTRUCTURE (a Proxmox VM on the
 * canary host) on every run. It must never fire on an ordinary `playwright test`.
 *
 * So its project only EXISTS when FIRST_RUN_AUDIT=1. Without that flag no project's
 * testMatch selects e2e/first-run-audit.spec.ts, so the file is collected and never
 * run. The spec carries the same guard independently — two locks, because the
 * failure mode is spending money.
 */
const FIRST_RUN_AUDIT_ENABLED = process.env.FIRST_RUN_AUDIT === '1';
const FIRST_RUN_AUDIT_TIMEOUT_MS = Number.parseInt(
  process.env.FIRST_RUN_AUDIT_TEST_TIMEOUT_MS ?? '',
  10,
) || 40 * 60_000;
const REMOTE_DESKTOP_AUDIT_ENABLED = process.env.REMOTE_DESKTOP_AUDIT === '1';

export default defineConfig({
  testDir: './e2e',
  // global-setup mints a Clerk ticket + saves storage state for authed specs.
  // It no-ops (skips authed projects) when CLERK_SECRET_KEY / QA_USER_ID absent.
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  expect: {
    timeout: 15_000,
    // Font/AA rendering differs across OS; tolerate sub-pixel noise so VRT flags
    // real layout/visual breaks, not rendering jitter. Baselines are generated
    // ON the Linux CI runner (never commit Mac-generated snapshots).
    toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' },
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['html', { open: 'never' }], ['github'], ['list']]
    : [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'public',
      testMatch: /.*\.public\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'authed',
      testMatch: /.*\.authed\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/qa-user.json',
      },
    },
    {
      name: 'vrt',
      testMatch: /.*\.vrt\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/qa-user.json',
      },
    },
    {
      name: 'journey',
      testMatch: /.*\.journey\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/qa-user.json',
      },
    },
    // Opt-in only. See the note above FIRST_RUN_AUDIT_ENABLED.
    ...(FIRST_RUN_AUDIT_ENABLED
      ? [
          {
            name: 'first-run-audit',
            testMatch: /first-run-audit\.spec\.ts/,
            timeout: FIRST_RUN_AUDIT_TIMEOUT_MS,
            // NEVER retry: a retry would provision a second VM and bill for it.
            // A failed audit run is a data point, not something to paper over.
            retries: 0,
            use: {
              ...devices['Desktop Chrome'],
              // The audit mints its own virgin session — it must not inherit the
              // QA user's storage state.
              storageState: undefined,
            },
          },
        ]
      : []),
    ...(REMOTE_DESKTOP_AUDIT_ENABLED
      ? [
          {
            name: 'remote-desktop-audit',
            testMatch: /remote-desktop-canary\.spec\.ts/,
            timeout: 55 * 60_000,
            retries: 0,
            use: {
              ...devices['Desktop Chrome'],
              storageState: undefined,
            },
          },
        ]
      : []),
  ],
});
