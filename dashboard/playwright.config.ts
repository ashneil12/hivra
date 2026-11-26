import { defineConfig, devices } from '@playwright/test';

import { CANARY_QA_STORAGE_STATE } from './e2e/canary-qa/auth';
import { assertCanaryQaBaseUrl, CANARY_QA_EMAIL_ENV, readCanaryQaEmail } from './e2e/canary-qa/config';
import { assertLiveManagedHostingAuditAllowed } from './e2e/first-run-audit/config';
import { browserLaunchOptions } from './scripts/lib/playwright-launch.cjs';

/**
 * Dashboard E2E + visual-regression (VRT) — Tier 1 of the QA pyramid.
 *
 * Targets a DEPLOYED url (default: live canary) rather than building Next 16 on
 * the runner — matches the qa-e2e agent's approach and keeps CI light. Point it
 * at a Vercel preview URL per-PR later via E2E_BASE_URL.
 *
 * Public specs need no auth. Authenticated specs use the standing Canary QA
 * account; ticket sign-in remains disabled.
 */
const BASE_URL = process.env.E2E_BASE_URL || 'https://canary.hermesos.cloud';
const privateBrowserArtifacts = { screenshot: 'off', video: 'off', trace: 'off' } as const;

/**
 * The FIRST-RUN AUDIT provisions REAL PAID INFRASTRUCTURE (a Proxmox VM on the
 * canary host) on every run. It must never fire on an ordinary `playwright test`.
 *
 * So its project only EXISTS when FIRST_RUN_AUDIT=1. Without that flag no project's
 * testMatch selects e2e/first-run-audit.spec.ts, so the file is not run. The
 * spec carries the same guard independently — two locks, because the
 * failure mode is spending money.
 */
const FIRST_RUN_AUDIT_ENABLED = process.env.FIRST_RUN_AUDIT === '1';
const FIRST_RUN_AUDIT_TIMEOUT_MS = Number.parseInt(
  process.env.FIRST_RUN_AUDIT_TEST_TIMEOUT_MS ?? '',
  10,
) || 40 * 60_000;
const REMOTE_DESKTOP_AUDIT_ENABLED = process.env.REMOTE_DESKTOP_AUDIT === '1';
/**
 * The LAUNCH SWEEP launches every agent and computer on Canary through the real
 * Launch page (e2e/launch-sweep.spec.ts). Real infrastructure, so it is gated
 * the same way as the first-run audit: the project only exists with
 * LAUNCH_SWEEP=1. Keep one worker on the shared Canary host and account.
 */
const LAUNCH_SWEEP_ENABLED = process.env.LAUNCH_SWEEP === '1';
// The trial-to-Pro journey (e2e/trial-to-pro.spec.ts): Stripe test mode on
// Canary, opt-in only with TRIAL_JOURNEY=1.
const TRIAL_JOURNEY_ENABLED = process.env.TRIAL_JOURNEY === '1';
const VENICE_CLAIM_ACCEPTANCE_ENABLED = process.env.VENICE_CLAIM_ACCEPTANCE === '1';
if (VENICE_CLAIM_ACCEPTANCE_ENABLED) {
  assertCanaryQaBaseUrl(BASE_URL);
  try {
    readCanaryQaEmail();
  } catch {
    throw new Error(`[venice-claim-acceptance] Set ${CANARY_QA_EMAIL_ENV} to the standing Canary QA account from private notes.`);
  }
}
if (FIRST_RUN_AUDIT_ENABLED || REMOTE_DESKTOP_AUDIT_ENABLED || LAUNCH_SWEEP_ENABLED || TRIAL_JOURNEY_ENABLED) {
  assertLiveManagedHostingAuditAllowed();
}
// One run id shared by every worker (they inherit this process's env).
if (LAUNCH_SWEEP_ENABLED && !process.env.LAUNCH_SWEEP_RUN_ID) {
  process.env.LAUNCH_SWEEP_RUN_ID = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${Math.random().toString(16).slice(2, 6)}`;
}

export default defineConfig({
  testDir: './e2e',
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
    // Local runs: installed Chrome, sandbox on. See scripts/lib/playwright-launch.cjs.
    ...browserLaunchOptions(),
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
              storageState: undefined,
              ...privateBrowserArtifacts,
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
              ...privateBrowserArtifacts,
            },
          },
        ]
      : []),
    ...(TRIAL_JOURNEY_ENABLED
      ? [
          {
            name: 'trial-journey',
            testMatch: /trial-to-pro\.spec\.ts/,
            timeout: 80 * 60_000,
            // Never retried: a retry would start a second checkout.
            retries: 0,
            use: { ...devices['Desktop Chrome'], storageState: undefined, ...privateBrowserArtifacts },
          },
        ]
      : []),
    {
      // Browser-only deterministic coverage; this project routes every fixture
      // response locally and performs no live navigation.
      name: 'offline-browser',
      testMatch: /\.offline\.spec\.ts/,
      timeout: 30_000,
      retries: 0,
      use: {
        ...devices['Desktop Chrome'],
        storageState: undefined,
      },
    },
    ...(VENICE_CLAIM_ACCEPTANCE_ENABLED
      ? [
          {
            name: 'venice-claim-acceptance',
            testMatch: /venice-claim\.acceptance\.spec\.ts/,
            retries: 0,
            use: {
              ...devices['Desktop Chrome'],
              storageState: CANARY_QA_STORAGE_STATE,
              ...privateBrowserArtifacts,
            },
          },
        ]
      : []),
    ...(LAUNCH_SWEEP_ENABLED
      ? [
          {
            name: 'launch-sweep',
            testMatch: /launch-sweep\.spec\.ts/,
            timeout: 65 * 60_000,
            // NEVER retry: a retry launches and bills a second computer, and
            // hides exactly the flakiness customers would hit.
            retries: 0,
            use: {
              ...devices['Desktop Chrome'],
              storageState: undefined,
              ...privateBrowserArtifacts,
            },
          },
        ]
      : []),
  ],
});
