import { isOpsAdminUser, verifiedPrimaryEmailOf } from '../ops-access';

describe('verifiedPrimaryEmailOf', () => {
  it('returns the primary email when Clerk has verified it', () => {
    expect(
      verifiedPrimaryEmailOf({
        primaryEmailAddress: { emailAddress: ' Admin@Example.com ', verification: { status: 'verified' } },
      }),
    ).toBe('Admin@Example.com');
  });

  it.each([
    ['unverified', { emailAddress: 'a@example.com', verification: { status: 'unverified' } }],
    ['transferable', { emailAddress: 'a@example.com', verification: { status: 'transferable' } }],
    ['no verification record', { emailAddress: 'a@example.com' }],
    ['null verification', { emailAddress: 'a@example.com', verification: null }],
    ['an empty address', { emailAddress: '  ', verification: { status: 'verified' } }],
  ])('returns null for a primary email with %s', (_label, primary) => {
    expect(verifiedPrimaryEmailOf({ primaryEmailAddress: primary })).toBeNull();
  });

  it('returns null when there is no primary email, whatever other addresses exist', () => {
    const user = { emailAddresses: [{ emailAddress: 'a@example.com', verification: { status: 'verified' } }] };
    expect(verifiedPrimaryEmailOf(user as never)).toBeNull();
    expect(verifiedPrimaryEmailOf(null)).toBeNull();
    expect(verifiedPrimaryEmailOf(undefined)).toBeNull();
  });
});

describe('isOpsAdminUser', () => {
  const originalAdminEmails = process.env.OPS_ADMIN_EMAILS;
  const originalAdminUserIds = process.env.OPS_ADMIN_USER_IDS;

  beforeEach(() => {
    delete process.env.OPS_ADMIN_EMAILS;
    delete process.env.OPS_ADMIN_USER_IDS;
  });

  afterAll(() => {
    process.env.OPS_ADMIN_EMAILS = originalAdminEmails;
    process.env.OPS_ADMIN_USER_IDS = originalAdminUserIds;
  });

  it('allows only the first configured admin email and rejects other emails', () => {
    process.env.OPS_ADMIN_EMAILS = 'admin@example.com,second@example.com';

    expect(isOpsAdminUser({ email: 'admin@example.com' })).toBe(true);
    expect(isOpsAdminUser({ email: 'second@example.com' })).toBe(false);
    expect(isOpsAdminUser({ email: 'someone@example.com' })).toBe(false);
  });

  it('falls back to only the first configured user id when no admin email exists', () => {
    process.env.OPS_ADMIN_USER_IDS = 'user_123,user_456';

    expect(isOpsAdminUser({ userId: 'user_123' })).toBe(true);
    expect(isOpsAdminUser({ userId: 'user_456' })).toBe(false);
    expect(isOpsAdminUser({ userId: 'user_999' })).toBe(false);
  });

  it('rejects access when no env override is present', () => {
    expect(isOpsAdminUser({ email: 'admin@example.com' })).toBe(false);
    expect(isOpsAdminUser({ email: 'other@example.com' })).toBe(false);
  });
});
