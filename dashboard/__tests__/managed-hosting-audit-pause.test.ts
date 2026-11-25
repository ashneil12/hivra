import { chromium } from '@playwright/test';
import globalSetup from '../e2e/global-setup';
import { createAuditUser, mintSignInTicket } from '../e2e/first-run-audit/clerk-admin';
import { reapAuditAccounts } from '../e2e/first-run-audit/reaper';
import { establishAuditSession } from '../e2e/first-run-audit/session';
import { auditEmail, LIVE_AUDIT_AUTH_ENV, LIVE_AUDIT_AUTH_CLERK_TEST_OTP } from '../e2e/first-run-audit/config';

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

  it('blocks new audit users, tickets for existing users, and redemption of already-issued tickets', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    const browser = { newContext: jest.fn() };

    await expect(createAuditUser(key, freshEmail)).rejects.toThrow(blocked);
    await expect(mintSignInTicket(key, existingAuditUser.id)).rejects.toThrow(/sign-in tickets are disabled/);
    await expect(establishAuditSession(browser as never, { baseUrl, email: freshEmail })).rejects.toThrow(blocked);

    expect(fetch).not.toHaveBeenCalled();
    expect(browser.newContext).not.toHaveBeenCalled();
  });

  it('makes every new audit email a Clerk test address on a reserved domain', () => {
    expect(auditEmail('abc123xy', 'example.test')).toBe('firstrun-audit-abc123xy+clerk_test@example.test');
    expect(() => auditEmail('abc123xy', 'hermesos.cloud')).toThrow(/reserved example domain/);
  });

  it('requires the exact Clerk test tag and a reserved domain after explicit opt-in', async () => {
    process.env[LIVE_AUDIT_AUTH_ENV] = LIVE_AUDIT_AUTH_CLERK_TEST_OTP;
    const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));

    await expect(createAuditUser(key, 'firstrun-audit-x+clerk_test.evil@example.test')).rejects.toThrow(/not a Clerk test address/);
    await expect(createAuditUser(key, 'firstrun-audit-x+clerk_test@hermesos.cloud')).rejects.toThrow(/reserved example domain/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('creates a passwordless Clerk test user after explicit opt-in, without touching sign-in tickets', async () => {
    process.env[LIVE_AUDIT_AUTH_ENV] = LIVE_AUDIT_AUTH_CLERK_TEST_OTP;
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({
        id: 'user_new_test',
        email_addresses: [{ email_address: freshEmail }],
        created_at: 123,
      })),
    );

    await expect(createAuditUser(key, freshEmail)).resolves.toMatchObject({ id: 'user_new_test', email: freshEmail });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/users'), expect.objectContaining({ method: 'POST' }));
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/sign_in_tokens'), expect.anything());
  });

  it('still rejects a non-test email after explicit opt-in', async () => {
    process.env[LIVE_AUDIT_AUTH_ENV] = LIVE_AUDIT_AUTH_CLERK_TEST_OTP;
    const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));

    await expect(createAuditUser(key, 'firstrun-audit-real@example.test')).rejects.toThrow(/not a Clerk test address/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects live or unrecognized Clerk keys before any network call', async () => {
    process.env[LIVE_AUDIT_AUTH_ENV] = LIVE_AUDIT_AUTH_CLERK_TEST_OTP;
    const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));

    await expect(createAuditUser('sk_live_fixture', freshEmail)).rejects.toThrow(/test key/);
    await expect(createAuditUser('service-role-fixture', freshEmail)).rejects.toThrow(/test key/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a production target even with the explicit opt-in', async () => {
    process.env[LIVE_AUDIT_AUTH_ENV] = LIVE_AUDIT_AUTH_CLERK_TEST_OTP;
    const browser = { newContext: jest.fn() };

    await expect(establishAuditSession(browser as never, { baseUrl: 'https://hivra.cloud', email: freshEmail })).rejects.toThrow(/refusing to target/);
    await expect(establishAuditSession(browser as never, { baseUrl: 'https://canary.evil.example', email: freshEmail })).rejects.toThrow(/refusing to target/);
    expect(browser.newContext).not.toHaveBeenCalled();
  });

  it('rejects active cleanup before contacting Clerk but keeps its read-only inventory', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([existingAuditUser])),
    );
    const opts = { baseUrl, clerkSecretKey: key, minAgeMs: 0 };

    await expect(reapAuditAccounts(opts)).rejects.toThrow(blocked);
    expect(fetch).not.toHaveBeenCalled();

    await expect(reapAuditAccounts({ ...opts, dryRun: true })).resolves.toMatchObject({
      eligibleAccounts: [{ userId: existingAuditUser.id }],
      reaped: [],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/users?'), expect.objectContaining({ method: 'GET' }));
  });
});
