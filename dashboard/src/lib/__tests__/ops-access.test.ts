import {
  isOpsAdminUser,
  resolveConfiguredOpsAdminUserIds,
  verifiedPrimaryEmailOf,
  type OpsAdminDirectoryLookup,
} from '../ops-access';

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

describe('resolveConfiguredOpsAdminUserIds', () => {
  const originalAdminEmails = process.env.OPS_ADMIN_EMAILS;
  const originalAdminUserIds = process.env.OPS_ADMIN_USER_IDS;

  beforeEach(() => {
    delete process.env.OPS_ADMIN_EMAILS;
    delete process.env.OPS_ADMIN_USER_IDS;
  });

  afterAll(() => {
    if (originalAdminEmails === undefined) delete process.env.OPS_ADMIN_EMAILS;
    else process.env.OPS_ADMIN_EMAILS = originalAdminEmails;
    if (originalAdminUserIds === undefined) delete process.env.OPS_ADMIN_USER_IDS;
    else process.env.OPS_ADMIN_USER_IDS = originalAdminUserIds;
  });

  const lookupWith = (
    data: Array<{
      id?: string | null;
      primaryEmailAddress?: {
        emailAddress?: string | null;
        verification?: { status?: string | null } | null;
      } | null;
    }>,
  ): OpsAdminDirectoryLookup => ({
    getUserList: jest.fn(async () => ({ data })),
  });

  it('resolves a configured email to the account whose verified primary address matches', async () => {
    process.env.OPS_ADMIN_EMAILS = 'ops@example.com';
    const lookup = lookupWith([
      {
        id: 'user_ops_1',
        primaryEmailAddress: { emailAddress: ' Ops@Example.com ', verification: { status: 'verified' } },
      },
    ]);

    const ids = await resolveConfiguredOpsAdminUserIds(lookup);

    expect(lookup.getUserList).toHaveBeenCalledWith({ emailAddress: ['ops@example.com'], limit: 100 });
    expect(ids).toEqual(new Set(['user_ops_1']));
  });

  it('resolves EVERY configured email, not just the first entry', async () => {
    process.env.OPS_ADMIN_EMAILS = 'first@example.com,second@example.com';
    const byEmail: Record<string, string> = {
      'first@example.com': 'user_first',
      'second@example.com': 'user_second',
    };
    const lookup: OpsAdminDirectoryLookup = {
      getUserList: jest.fn(async (params: { emailAddress: string[] }) => ({
        data: [
          {
            id: byEmail[params.emailAddress[0]],
            primaryEmailAddress: {
              emailAddress: params.emailAddress[0],
              verification: { status: 'verified' },
            },
          },
        ],
      })),
    };

    const ids = await resolveConfiguredOpsAdminUserIds(lookup);
    expect(ids).toEqual(new Set(['user_first', 'user_second']));
  });

  it('unions the configured user ids with the email-resolved ids', async () => {
    process.env.OPS_ADMIN_USER_IDS = 'user_env_1';
    process.env.OPS_ADMIN_EMAILS = 'ops@example.com';
    const lookup = lookupWith([
      {
        id: 'user_ops_1',
        primaryEmailAddress: { emailAddress: 'ops@example.com', verification: { status: 'verified' } },
      },
    ]);

    const ids = await resolveConfiguredOpsAdminUserIds(lookup);
    expect(ids).toEqual(new Set(['user_env_1', 'user_ops_1']));
  });

  it.each([
    ['unverified', { emailAddress: 'ops@example.com', verification: { status: 'unverified' } }],
    ['missing a verification record', { emailAddress: 'ops@example.com' }],
    ['a different address', { emailAddress: 'other@example.com', verification: { status: 'verified' } }],
  ])('excludes an account whose primary email is %s', async (_label, primaryEmailAddress) => {
    process.env.OPS_ADMIN_EMAILS = 'ops@example.com';
    const lookup = lookupWith([{ id: 'user_cust_1', primaryEmailAddress }]);

    const ids = await resolveConfiguredOpsAdminUserIds(lookup);
    expect(ids).toEqual(new Set());
  });

  it('returns only the configured ids when the lookup fails or is absent', async () => {
    process.env.OPS_ADMIN_USER_IDS = 'user_env_1';
    process.env.OPS_ADMIN_EMAILS = 'ops@example.com';
    const failures: string[] = [];
    const failing: OpsAdminDirectoryLookup = {
      getUserList: jest.fn(async () => {
        throw new Error('directory down');
      }),
    };

    const ids = await resolveConfiguredOpsAdminUserIds(failing, (email) => failures.push(email));

    expect(ids).toEqual(new Set(['user_env_1']));
    expect(failures).toEqual(['ops@example.com']);

    expect(await resolveConfiguredOpsAdminUserIds(null)).toEqual(new Set(['user_env_1']));
  });
});
