import { chromium } from '@playwright/test';
import globalSetup from '../e2e/global-setup';
import { establishAuditSession } from '../e2e/first-run-audit/session';
import { LIVE_AUDIT_AUTH_ENV, LIVE_AUDIT_AUTH_CLERK_TEST_OTP } from '../e2e/first-run-audit/config';

jest.mock('@playwright/test', () => ({
  defineConfig: (config: unknown) => config,
  devices: { 'Desktop Chrome': {} },
  chromium: { launch: jest.fn() },
}));

const liveFlags = ['FIRST_RUN_AUDIT', 'LAUNCH_SWEEP', 'REMOTE_DESKTOP_AUDIT', 'TRIAL_JOURNEY'];
const blocked = /Live runs are paused/;
const baseUrl = 'https://canary.example.test';
const key = 'sk_test_fixture';
const freshEmail = 'firstrun-audit-fresh+clerk_test@example.test';
const existingAuditUser = {
  id: 'user_audit_existing',
  email_addresses: [{ email_address: 'firstrun-audit-existing@example.test' }],
  created_at: 1,
};

function loadPlaywrightConfig() {
  return jest.isolateModules(() => {
    require('../playwright.config');
  });
}

describe('managed-hosting audit mail pause', () => {
  const env = process.env;

  beforeEach(() => {
    process.env = { ...env };
    for (const flag of liveFlags) delete process.env[flag];
    delete process.env[LIVE_AUDIT_AUTH_ENV];
    delete process.env.CANARY_QA_EMAIL;
  });

  afterEach(() => {
    process.env = env;
    jest.restoreAllMocks();
  });

  it.each(liveFlags)('rejects %s at config load, before Playwright setup', (flag) => {
    process.env[flag] = '1';
    expect(loadPlaywrightConfig).toThrow(blocked);
  });

  it('keeps the ordinary Playwright config loadable', () => {
    expect(loadPlaywrightConfig).not.toThrow();
  });

  it.each(liveFlags)('allows %s only with the explicit Clerk test-OTP opt-in', (flag) => {
    process.env[flag] = '1';
    process.env[LIVE_AUDIT_AUTH_ENV] = LIVE_AUDIT_AUTH_CLERK_TEST_OTP;
    expect(loadPlaywrightConfig).not.toThrow();
  });

  it('rejects an unknown live-auth mode even when a live flag is set', () => {
    process.env.LAUNCH_SWEEP = '1';
    process.env[LIVE_AUDIT_AUTH_ENV] = 'tickets';
    expect(loadPlaywrightConfig).toThrow(blocked);
  });

  it('blocks ordinary Playwright setup from minting or redeeming a ticket for the standing QA user', async () => {
    process.env.CLERK_SECRET_KEY = key;
    process.env.QA_USER_ID = existingAuditUser.id;
    const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));

    await expect(globalSetup({ projects: [] } as never)).rejects.toThrow(/sign-in tickets are disabled/);

    expect(fetch).not.toHaveBeenCalled();
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it('blocks a standing sign-in before opening a browser context without explicit opt-in', async () => {
    const browser = { newContext: jest.fn() };
    await expect(establishAuditSession(browser as never, { baseUrl, email: freshEmail })).rejects.toThrow(blocked);
    expect(browser.newContext).not.toHaveBeenCalled();
  });

  it('fails closed on non-test mail or real domains after explicit opt-in without echoing the credential', async () => {
    process.env[LIVE_AUDIT_AUTH_ENV] = LIVE_AUDIT_AUTH_CLERK_TEST_OTP;
    const browser = { newContext: jest.fn() };
    const invalid = 'fixture+clerk_test.bad@example.test';
    await expect(establishAuditSession(browser as never, { baseUrl, email: invalid }))
      .rejects.toThrow(/not a Clerk test address/);
    await expect(establishAuditSession(browser as never, { baseUrl, email: invalid })).rejects.not.toThrow(invalid);
    await expect(establishAuditSession(browser as never, { baseUrl, email: 'fixture+clerk_test@hermesos.cloud' }))
      .rejects.toThrow(/reserved example domain/);
    expect(browser.newContext).not.toHaveBeenCalled();
  });

  it('rejects a production target even with the explicit opt-in', async () => {
    process.env[LIVE_AUDIT_AUTH_ENV] = LIVE_AUDIT_AUTH_CLERK_TEST_OTP;
    const browser = { newContext: jest.fn() };

    await expect(establishAuditSession(browser as never, { baseUrl: 'https://hivra.cloud', email: freshEmail })).rejects.toThrow(/refusing to target/);
    await expect(establishAuditSession(browser as never, { baseUrl: 'http://canary.hermesos.cloud', email: freshEmail })).rejects.toThrow(/refusing to target/);
    await expect(establishAuditSession(browser as never, { baseUrl: 'https://canary.evil.example', email: freshEmail })).rejects.toThrow(/refusing to target/);
    expect(browser.newContext).not.toHaveBeenCalled();
  });

});
