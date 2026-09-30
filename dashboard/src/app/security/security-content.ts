// Copy for /security. Every statement comes from the public repository's
// SECURITY.md or docs/SECURITY-MODEL.md, worded the same way. No isolation,
// encryption or key-handling claim is made here: the security model is a target
// contract, and it says so itself.

import {
  GITHUB_PRIVATE_REPORT_URL,
  SECURITY_EMAIL,
  SECURITY_EMAIL_SUBJECT,
  SECURITY_MODEL_URL,
  SECURITY_POLICY_SOURCE_URL,
} from "@/lib/security-contact";

export const SECURITY_TITLE = "Security and how to report a vulnerability";
export const SECURITY_DESCRIPTION =
  "How to report a security problem in Hivra privately, what to include, and what Hivra does and does not claim about its security.";

export const REPORT_INCLUDES = [
  "the affected revision, release, URL, component or provisioner version",
  "a minimal reproduction and the expected versus observed boundary",
  "the likely impact, and whether exploitation has been attempted",
  "relevant logs with credentials, customer data, host addresses and reusable access material removed",
  "a safe way to contact you for follow-up",
] as const;

export const SECURITY_SECTIONS = {
  report: {
    heading: "Report a vulnerability privately",
    intro: "Do not open a public issue for an unpatched vulnerability. Use one of these two channels:",
    channels: [
      { label: "GitHub private vulnerability reporting", href: GITHUB_PRIVATE_REPORT_URL },
      { label: `Email ${SECURITY_EMAIL} with the subject ${SECURITY_EMAIL_SUBJECT}`, href: `mailto:${SECURITY_EMAIL}` },
    ],
    includeLead: "Please include:",
    keys: "Do not send live private keys or reusable credentials. Revoke exposed material first when safe, then send only its identifier or cryptographic fingerprint.",
    care: "Please avoid accessing other users' data, changing paid infrastructure or degrading a shared service while researching.",
    response:
      "Hivra acknowledges a report through the same channel, coordinates a scoped fix and verification plan, and publishes credit when you ask, after affected users can be protected. No response-time promise is made until a staffed public security-response rotation is documented.",
  },
  versions: {
    heading: "Supported versions",
    body: "Until the first tagged public release, security fixes are applied to the latest commit on the main branch. Older commits, old provisioner bundles and independently modified deployments are not maintained.",
  },
  claims: {
    heading: "What Hivra claims, and what it does not",
    paragraphs: [
      "Hivra runs capable, long-lived agents with code execution, files, browsers, networks and credentials. Its security model is a target contract: it says what must be true, and it does not claim that every control is already in place.",
      "Hivra cannot guarantee that capable agents are harmless or that compromise is impossible. Security claims on this site are meant to be narrow and tied to behavior that has been checked.",
    ],
  },
  links: {
    heading: "Read the source documents",
    items: [
      { label: "Security policy (SECURITY.md)", href: SECURITY_POLICY_SOURCE_URL },
      { label: "Security model", href: SECURITY_MODEL_URL },
      { label: "security.txt", href: "/.well-known/security.txt" },
    ],
  },
} as const;
