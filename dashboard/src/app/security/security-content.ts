// Copy for /security. Every statement comes from the public repository's
// SECURITY.md or docs/SECURITY-MODEL.md and says the same thing in plainer
// words; the lines the tests pin are kept word for word. No isolation,
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
  "How to report a security problem in Hivra privately, what to put in the report, and what Hivra does and doesn't claim about its security.";

export const REPORT_INCLUDES = [
  "the affected revision, release, URL, component or provisioner version",
  "a minimal reproduction, and the boundary you expected versus the one you observed",
  "the likely impact, and whether anyone has tried to exploit it",
  "relevant logs, with credentials, customer data, host addresses and reusable access material removed",
  "a safe way to contact you for follow-up",
] as const;

export const SECURITY_SECTIONS = {
  report: {
    heading: "Report a vulnerability privately",
    intro: "Don't open a public issue for an unpatched vulnerability. Use one of these two channels:",
    channels: [
      { label: "GitHub private vulnerability reporting", href: GITHUB_PRIVATE_REPORT_URL },
      { label: `Email ${SECURITY_EMAIL} with the subject ${SECURITY_EMAIL_SUBJECT}`, href: `mailto:${SECURITY_EMAIL}` },
    ],
    includeLead: "Please include:",
    keys: "Don't send live private keys or reusable credentials. If one has been exposed, revoke it first when that's safe, then send only its identifier or cryptographic fingerprint.",
    care: "While you're researching, please don't access other users' data, change paid infrastructure or degrade a shared service.",
    response:
      "Hivra acknowledges a report through the same channel it came in on, then coordinates a scoped fix and verification plan. If you ask for credit, Hivra publishes it once affected users can be protected. No response-time promise is made until Hivra documents a staffed public security-response rotation.",
  },
  versions: {
    heading: "Supported versions",
    body: "Until the first tagged public release, Hivra applies security fixes to the latest commit on the main branch. It doesn't maintain older commits, old provisioner bundles or independently modified deployments.",
  },
  claims: {
    heading: "What Hivra claims and what it doesn't",
    paragraphs: [
      "Hivra runs capable, long-lived agents with code execution, files, browsers, networks and credentials. The security model is a target contract. It says what must be true, and it does not claim that every control is already in place.",
      "Hivra cannot guarantee that capable agents are harmless or that compromise is impossible. The security claims on this site are meant to stay narrow, each one tied to behavior that has been checked.",
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
