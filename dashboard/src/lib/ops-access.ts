export interface OpsAdminIdentity {
  userId?: string | null;
  email?: string | null;
}

function parseAllowlist(value?: string | null): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function getConfiguredOpsAdmin(): { email: string | null; userId: string | null } {
  const configuredEmail = parseAllowlist(process.env.OPS_ADMIN_EMAILS)[0] || null;
  const configuredUserId = parseAllowlist(process.env.OPS_ADMIN_USER_IDS)[0] || null;

  return {
    email: configuredEmail,
    userId: configuredUserId,
  };
}

export function isOpsAdminUser(identity: OpsAdminIdentity): boolean {
  const email = identity.email?.trim().toLowerCase() || null;
  const userId = identity.userId?.trim() || null;
  const configuredAdmin = getConfiguredOpsAdmin();

  if (email && configuredAdmin.email && email === configuredAdmin.email) {
    return true;
  }

  if (userId && configuredAdmin.userId && userId.toLowerCase() === configuredAdmin.userId) {
    return true;
  }

  return false;
}
