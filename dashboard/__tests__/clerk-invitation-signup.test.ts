import { auditInvitationPayload } from '../e2e/first-run-audit/clerk-admin';
import { assertClerkInvitationAcceptUrl, signUpUrlForInvitation } from '../e2e/first-run-audit/signup';

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
