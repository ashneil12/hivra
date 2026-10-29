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
  verification?: { status?: string } | null;
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
