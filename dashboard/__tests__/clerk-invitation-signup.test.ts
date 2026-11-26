/** @jest-environment node */
import type { Page } from '@playwright/test';
import * as auditConfig from '../e2e/first-run-audit/config';
import { auditInvitationPayload } from '../e2e/first-run-audit/clerk-admin';
import { acceptAuditInvitation, assertClerkInvitationAcceptUrl, signUpUrlForInvitation } from '../e2e/first-run-audit/signup';

const EMAIL = 'qa-signup+clerk_test@example.test';
const LAUNCH = '/dashboard/launch?agent=hermes&inference=venice&ref=venice&code=VENICE';

describe('Clerk invitation signup guards', () => {
  it('builds the exact no-mail, collision-failing invitation payload', () => {
    expect(auditInvitationPayload(EMAIL, 'https://canary.hermesos.cloud/sign-up')).toEqual({
      email_address: EMAIL,
      notify: false,
      ignore_existing: false,
      expires_in_days: 1,
      redirect_url: 'https://canary.hermesos.cloud/sign-up',
      public_metadata: { hivra_qa: 'clerk-invitation-signup' },
    });
  });

  it('preserves the product deep link inside the sign-up redirect parameter', () => {
    const url = new URL(signUpUrlForInvitation('https://canary.hermesos.cloud', LAUNCH));
    expect(`${url.origin}${url.pathname}`).toBe('https://canary.hermesos.cloud/sign-up');
    expect(url.searchParams.get('redirect_url')).toBe(LAUNCH);
  });

  it.each([
    'https://evil.example/callback',
    '//evil.example/callback',
    'C:\\evil',
  ])('rejects a non-same-origin redirect path: %s', (redirectPath) => {
    expect(() => signUpUrlForInvitation('https://canary.hermesos.cloud', redirectPath)).toThrow(/same-origin path/);
  });

  it.each([
    'https://hivra-canary.clerk.accounts.dev/v1/tickets/accept?ticket=ticket_123',
    'https://hivra-canary.accounts.dev/v1/tickets/accept?ticket=ticket_123',
  ])('accepts Clerk development ticket URLs: %s', (url) => {
    expect(() => assertClerkInvitationAcceptUrl(url)).not.toThrow();
  });

  it.each([
    'http://hivra-canary.clerk.accounts.dev/v1/tickets/accept?ticket=ticket_123',
    'https://hivra.cloud/v1/tickets/accept?ticket=ticket_123',
    'https://hivra-canary.clerk.accounts.dev/sign-up?ticket=ticket_123',
    'https://hivra-canary.clerk.accounts.dev/v1/tickets/accept',
    'not a url',
  ])('rejects a non-Clerk or malformed invitation acceptance URL: %s', (url) => {
    expect(() => assertClerkInvitationAcceptUrl(url)).toThrow(/invitation acceptance URL/);
  });

  it('rejects production Canary targets', () => {
    expect(() => signUpUrlForInvitation('https://hivra.cloud', LAUNCH)).toThrow(/canary-only/);
  });
});

describe('Failed Clerk signup cleanup', () => {
  const clerkSecretKey = ['sk', 'test', 'fixture'].join('_');
  const invitation = { id: 'fixture-invitation', url: 'https://hivra-canary.clerk.accounts.dev/v1/tickets/accept?ticket=fixture' };
  const user = { id: 'fixture-user', email_addresses: [{ email_address: EMAIL }] };
  const signup = () => acceptAuditInvitation(
    { goto: jest.fn().mockRejectedValue(new Error('fixture browser failed')), context: jest.fn().mockReturnValue({ route: jest.fn().mockResolvedValue(undefined) }) } as unknown as Page,
    { baseUrl: 'https://canary.hermesos.cloud', clerkSecretKey, email: EMAIL },
  );

  beforeEach(() => {
    jest.spyOn(auditConfig, 'assertLiveManagedHostingAuditAllowed').mockImplementation(() => {});
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('unexpected fixture request'))
      .mockResolvedValueOnce(Response.json(invitation))
      .mockResolvedValueOnce(Response.json({ token: 'fixture-testing-token', expires_at: Math.floor(Date.now() / 1000) + 600 }));
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    () => new Response(null, { status: 503 }),
    () => Response.json({ unexpected: [] }),
    () => new Response('{'),
  ])('stops after an inconclusive lookup', async (response) => {
    jest.mocked(fetch).mockResolvedValueOnce(response());
    await expect(signup()).rejects.toThrow(/invitation signup cleanup: cleanup failed/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['missing addresses', [{ id: user.id }]],
    ['no addresses', [{ id: user.id, email_addresses: [] }]],
    ['a blank address', [{ id: user.id, email_addresses: [{ email_address: '' }] }]],
    ['the exact address only in the second slot', [{ id: user.id, email_addresses: [
      { email_address: 'other@example.test' }, { email_address: EMAIL },
    ] }]],
    ['an exact address plus an extra address', [{ id: user.id, email_addresses: [
      { email_address: EMAIL }, { email_address: 'other@example.test' },
    ] }]],
    ['only a different address', [{ id: user.id, email_addresses: [{ email_address: 'other@example.test' }] }]],
    ['multiple returned users', [user, { ...user, id: 'other-user' }]],
  ])('does not revoke or delete when the user lookup returns %s', async (_scenario, rows) => {
    jest.mocked(fetch).mockResolvedValueOnce(Response.json(rows)).mockResolvedValueOnce(Response.json({}));
    await expect(signup()).rejects.toThrow('cleanup failed: [clerk] exact email lookup returned an unresolved user identity');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([404, 503])('reports revocation failure (HTTP %i)', async (status) => {
    jest.mocked(fetch).mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(new Response(null, { status }));
    await expect(signup()).rejects.toThrow(/invitation signup cleanup: cleanup failed/);
    expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('/revoke'), expect.objectContaining({ method: 'POST' }));
  });

  it('revokes only after a successful empty lookup', async () => {
    jest.mocked(fetch).mockResolvedValueOnce(Response.json([])).mockResolvedValueOnce(Response.json({}));
    await expect(signup()).rejects.toThrow('invitation signup cleanup: revoked unaccepted invitation');
    expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('/revoke'), expect.objectContaining({ method: 'POST' }));
  });

  it.each([
    [{ id: user.id, deleted: true }, /deleted partially-created user/],
    [{ id: user.id, deleted: false }, /cleanup failed: Clerk user deletion not confirmed/],
  ])('reports user deletion according to the exact receipt', async (receipt, expected) => {
    jest.mocked(fetch).mockResolvedValueOnce(Response.json([user])).mockResolvedValueOnce(Response.json(receipt));
    await expect(signup()).rejects.toThrow(expected);
    expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('/users/fixture-user'), expect.objectContaining({ method: 'DELETE' }));
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
