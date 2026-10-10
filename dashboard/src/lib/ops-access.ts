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

/**
 * Whether OPS_ADMIN_EMAILS names an admin, so a caller that only has a user ID
 * can skip looking up that user's email when no email could match.
 */
export function isOpsAdminEmailConfigured(): boolean {
  return getConfiguredOpsAdmin().email !== null;
}

export interface ClerkUserWithPrimaryEmail {
  primaryEmailAddress?: {
    emailAddress?: string | null;
    verification?: { status?: string | null } | null;
  } | null;
}

/**
 * The user's primary email, only when Clerk has verified it; otherwise null.
 *
 * The ops-admin checks match an email against OPS_ADMIN_EMAILS, so the email
 * they read must be one the person has proven they own. An address that was
 * added but never verified, or any non-primary address, must not be able to
 * make someone an ops admin. This is the same rule the token geo-policy uses
 * (readVerifiedPrimaryEmail in lib/compliance/token-geo-gate.ts), applied to
 * the user object a route already holds so no extra Clerk call is needed.
 */
export function verifiedPrimaryEmailOf(user: ClerkUserWithPrimaryEmail | null | undefined): string | null {
  const primary = user?.primaryEmailAddress;
  if (!primary || primary.verification?.status !== 'verified') return null;
  const email = primary.emailAddress?.trim();
  return email ? email : null;
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
