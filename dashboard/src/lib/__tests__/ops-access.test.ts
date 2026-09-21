import { isOpsAdminUser } from '../ops-access';

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
