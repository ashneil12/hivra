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
 * EVERY user id named in OPS_ADMIN_USER_IDS (the env is a comma-separated
 * list; isOpsAdminUser above only honors the first entry). Customer-facing
 * sweeps use this to exclude all operators, not just the first configured id.
 */
export function configuredOpsAdminUserIds(): Set<string> {
  return new Set(parseAllowlist(process.env.OPS_ADMIN_USER_IDS));
}

/**
 * EVERY email named in OPS_ADMIN_EMAILS — the list counterpart of
 * configuredOpsAdminUserIds, for the same reason: isOpsAdminUser honors
 * only the first configured entry, but sweeps must exclude all operators.
 */
export function configuredOpsAdminEmails(): string[] {
  return parseAllowlist(process.env.OPS_ADMIN_EMAILS);
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

/**
 * The single normalization every ops-admin user-id comparison uses: trim +
 * lowercase, matching what parseAllowlist already does to configured ids.
 * Stored user ids and configured ids must both pass through this before
 * comparing, or casing differences silently defeat the admin filter.
 */
export function normalizeOpsUserId(userId: string | null | undefined): string | null {
  const trimmed = userId?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

export function isOpsAdminUser(identity: OpsAdminIdentity): boolean {
  const email = identity.email?.trim().toLowerCase() || null;
  const userId = normalizeOpsUserId(identity.userId);
  const configuredAdmin = getConfiguredOpsAdmin();

  if (email && configuredAdmin.email && email === configuredAdmin.email) {
    return true;
  }

  if (userId && configuredAdmin.userId && userId.toLowerCase() === configuredAdmin.userId) {
    return true;
  }

  return false;
}

/**
 * The slice of the user directory the ops-admin email→id resolution needs:
 * the accounts holding a configured address. Matches the shape of
 * clerkClient().users.getUserList — kept injectable so this module never
 * imports the Clerk client itself.
 */
export interface OpsAdminDirectoryLookup {
  getUserList: (params: {
    emailAddress: string[];
    limit?: number;
  }) => Promise<{
    data: Array<ClerkUserWithPrimaryEmail & { id?: string | null }>;
  }>;
}

/**
 * The account ids the configured ops admins resolve to: the ids named in
 * OPS_ADMIN_USER_IDS plus the account of every user whose Clerk-VERIFIED
 * primary email is named in OPS_ADMIN_EMAILS.
 *
 * The request-time check (isOpsAdminUser over an identity whose email came
 * from verifiedPrimaryEmailOf) already grants such a user ops-admin
 * rights — they open the ops pages — so a sweep that excludes operator
 * rows by account id must resolve the same set: without it an ops admin
 * configured only by email contributes no id to the exclusion and their
 * own boxes page as customer incidents.
 *
 * Only the verified primary address qualifies — the same bar the
 * request-time check sets — so a configured address sitting on someone's
 * account as a secondary or unverified address cannot exclude their boxes
 * either.
 *
 * A failed lookup for one email skips that email and reports through
 * onLookupFailure: resolution degrades to the configured ids, never to
 * fabricated matches.
 */
export async function resolveConfiguredOpsAdminUserIds(
  lookup: OpsAdminDirectoryLookup | null | undefined,
  onLookupFailure?: (email: string, error: unknown) => void,
): Promise<Set<string>> {
  const ids = configuredOpsAdminUserIds();
  const emails = configuredOpsAdminEmails();
  if (!lookup || emails.length === 0) return ids;
  for (const email of emails) {
    let candidates: Array<ClerkUserWithPrimaryEmail & { id?: string | null }>;
    try {
      const result = await lookup.getUserList({ emailAddress: [email], limit: 100 });
      candidates = result.data ?? [];
    } catch (error) {
      onLookupFailure?.(email, error);
      continue;
    }
    for (const user of candidates) {
      const verified = verifiedPrimaryEmailOf(user);
      if (verified && verified.toLowerCase() === email) {
        const id = normalizeOpsUserId(user.id);
        if (id) ids.add(id);
      }
    }
  }
  return ids;
}
