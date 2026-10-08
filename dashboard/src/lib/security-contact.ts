// How to report a security problem in Hivra. Everything here already appears in
// the public repository's SECURITY.md and on the site (the footer and privacy
// policy list info@hivra.cloud), so /security, /.well-known/security.txt and
// SECURITY.md cannot drift apart. Never add an address that is not in
// SECURITY.md: a contact that nobody reads is worse than none.

import { SUPPORT_EMAIL } from "@/lib/support-channels";

export const SECURITY_EMAIL = SUPPORT_EMAIL;
export const SECURITY_EMAIL_SUBJECT = "[Hivra security]";
export const GITHUB_PRIVATE_REPORT_URL = "https://github.com/ashneil12/hivra/security/advisories/new";
export const SECURITY_POLICY_SOURCE_URL = "https://github.com/ashneil12/hivra/blob/main/SECURITY.md";
export const SECURITY_MODEL_URL = "https://github.com/ashneil12/hivra/blob/main/docs/SECURITY-MODEL.md";

/**
 * RFC 9116 requires an Expires field, recommends less than a year ahead, and
 * treats the file as stale after it. security-txt.test.ts fails once this date
 * has passed (and if it is set more than a year out), so the file cannot go
 * stale unnoticed: renew it to a date under a year away.
 */
export const SECURITY_TXT_EXPIRES = "2027-06-30T00:00:00.000Z";

/** The body of /.well-known/security.txt (RFC 9116). */
export function buildSecurityTxt(siteUrl: string): string {
  return [
    `# How to report a security problem in Hivra: ${siteUrl}/security`,
    `Contact: mailto:${SECURITY_EMAIL}`,
    `Contact: ${GITHUB_PRIVATE_REPORT_URL}`,
    `Expires: ${SECURITY_TXT_EXPIRES}`,
    "Preferred-Languages: en",
    `Canonical: ${siteUrl}/.well-known/security.txt`,
    `Policy: ${siteUrl}/security`,
    "",
  ].join("\n");
}
