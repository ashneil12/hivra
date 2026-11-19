import { createAuditUser, mintSignInTicket } from '../e2e/first-run-audit/clerk-admin';
import { reapAuditAccounts } from '../e2e/first-run-audit/reaper';
import { establishAuditSession } from '../e2e/first-run-audit/session';

jest.mock('@playwright/test', () => ({
  defineConfig: (config: unknown) => config,
  devices: { 'Desktop Chrome': {} },
  chromium: { launch: jest.fn() },
}));

const liveFlags = ['FIRST_RUN_AUDIT', 'LAUNCH_SWEEP', 'REMOTE_DESKTOP_AUDIT', 'TRIAL_JOURNEY'];
const blocked = /Live runs are paused/;
const baseUrl = 'https://canary.example.test';
const key = 'sk_test_fixture';
const freshEmail = 'firstrun-audit-fresh@example.test';
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

  it('blocks new audit users, tickets for existing users, and redemption of already-issued tickets', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
    const browser = { newContext: jest.fn() };

    await expect(createAuditUser(key, freshEmail)).rejects.toThrow(blocked);
    await expect(mintSignInTicket(key, existingAuditUser.id)).rejects.toThrow(blocked);
    await expect(establishAuditSession(browser as never, { baseUrl, ticket: 'fixture' })).rejects.toThrow(blocked);

    expect(fetch).not.toHaveBeenCalled();
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
