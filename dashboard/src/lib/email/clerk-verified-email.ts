/**
 * The address to use for a Clerk user in Hivra email (welcome, announcement audience).
 *
 * Clerk lets a user hold an address that was typed in but never verified. That address
 * can belong to someone who never signed up, so only an address Clerk reports as
 * verified may be mailed or enrolled. Preference: the primary address when it is
 * verified, else the first verified address, else null. This follows the same rule as
 * verifiedPrimaryEmailOf in lib/ops-access.ts.
 */

export type ClerkVerifiableEmail = {
  id: string;
  email_address: string;
  verification?: { status?: string | null } | null;
};

export type ClerkUserWithEmails = {
  primary_email_address_id?: string | null;
  email_addresses?: ClerkVerifiableEmail[];
};

export function pickVerifiedEmail(user: ClerkUserWithEmails): string | null {
  const verified = (user.email_addresses ?? []).filter(
    (address) => address.verification?.status === "verified" && Boolean(address.email_address?.trim()),
  );
  const primary = verified.find((address) => address.id === user.primary_email_address_id);
  return (primary ?? verified[0])?.email_address ?? null;
}

/**
 * The same rule for a Clerk backend SDK user (camelCase, as clerkClient().users.getUser
 * returns it): only an address Clerk reports as verified is returned.
 */
export type ClerkSdkUserWithEmails = {
  primaryEmailAddressId?: string | null;
  emailAddresses?: Array<{
    id: string;
    emailAddress: string;
    verification?: { status?: string | null } | null;
  }> | null;
};

export function pickVerifiedSdkEmail(user: ClerkSdkUserWithEmails | null | undefined): string | null {
  return pickVerifiedEmail({
    primary_email_address_id: user?.primaryEmailAddressId,
    email_addresses: (user?.emailAddresses ?? []).map((address) => ({
      id: address.id,
      email_address: address.emailAddress,
      verification: address.verification,
    })),
  });
}
