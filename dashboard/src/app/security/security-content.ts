// Copy for /security, from the approved page copy. Inline marks use the grammar in
// lib/inline-copy.tsx (**bold**, `code`, [label](href)).
//
// Every address here is one that exists: the private reporting form is enabled on
// the public repository, SECURITY.md and docs/SECURITY-MODEL.md are on its main
// branch, the mailbox and the subject convention are the ones SECURITY.md publishes,
// and /.well-known/security.txt is a route in this app. lib/security-contact.ts holds
// them once, so the page, security.txt and SECURITY.md cannot drift apart.
//
// The security model document is a target contract and says so. Nothing here adds an
// assurance the model does not make: no certification, no audit, no zero-access claim,
// and the planned controls stay marked as goals.

import {
  GITHUB_PRIVATE_REPORT_URL,
  SECURITY_EMAIL,
  SECURITY_EMAIL_SUBJECT,
  SECURITY_MODEL_URL,
  SECURITY_POLICY_SOURCE_URL,
} from "@/lib/security-contact";

const MAILTO = `mailto:${SECURITY_EMAIL}?subject=${encodeURIComponent(SECURITY_EMAIL_SUBJECT)}`;

export const SECURITY_COPY = {
  masthead: {
    heading: "Security matters more when software can act.",
    lede: "An AI agent with access to files, a browser, a terminal and online accounts is more than a chatbot. It can do useful work, but mistakes or malicious instructions can have real consequences.",
  },
  position: [
    "Hivra's approach starts with giving agents an environment of their own. A separate computer creates a boundary between an agent's working environment and your everyday device. That is a useful foundation, **not a guarantee that the agent itself is safe**.",
    "We want people to know what the platform does, where its limits are, and how to report something that needs fixing.",
  ],
  report: {
    heading: "Report a vulnerability privately",
    intro:
      "Please avoid posting details of an unpatched vulnerability in a public issue or social media post. Use either of the following channels:",
    channels: [
      {
        label: "GitHub private vulnerability reporting:",
        body: `[Private reporting form](${GITHUB_PRIVATE_REPORT_URL})`,
      },
      {
        label: "Email:",
        body: `[${SECURITY_EMAIL}](${MAILTO}), with **${SECURITY_EMAIL_SUBJECT}** in the subject line`,
      },
    ],
    notPolished:
      "You don't need a polished report. The most useful information is enough for us to understand and reproduce the problem safely.",
    includeLead: "Please include, where possible:",
    include: [
      "**Where you found it.** The affected URL, release, source revision, component or provisioner version.",
      "**What happened.** A minimal, reproducible sequence and the behaviour you expected instead.",
      "**Why it matters.** The apparent impact, particularly whether a boundary between accounts, instances or permissions can be crossed.",
      "**What you observed.** Relevant logs or screenshots with secrets, customer data, internal addresses and reusable access material removed.",
      "**How to reach you.** A safe contact method for questions and verification.",
    ],
    credentials:
      "Please do not send live private keys, passwords, session cookies or other credentials. If something has been exposed, revoke or rotate it first where safe, then share a redacted identifier or fingerprint.",
    testing: {
      heading: "Responsible testing",
      paragraphs: [
        "We welcome good-faith research, but please keep testing within systems and accounts you control or have permission to assess. Do not access other users' data, damage shared infrastructure, interrupt paid services or attempt to establish persistence.",
        "We will respond through the reporting channel, investigate the scope and coordinate remediation and verification. If you would like credit for a finding, let us know. Public acknowledgement should wait until affected users can be protected.",
      ],
      responseTimes:
        "**Response times:** We do not currently promise a fixed acknowledgement or remediation service level. Any future response-time commitments will be documented when we can reliably support them.",
    },
  },
  versions: {
    heading: "Supported versions",
    paragraphs: [
      "Until Hivra publishes a versioned support policy, security fixes target the current code on the maintained main branch. Older commits, previous provisioner bundles and independently modified deployments are not covered by a guaranteed backport programme.",
      "If you self-host, keep your installation and dependencies updated and review the changes you deploy.",
    ],
  },
  model: {
    heading: "What the security model does, and does not, promise",
    paragraphs: [
      "Hivra is built around isolating the environment in which an agent works. That helps reduce how much of your personal machine or other workloads an agent can reach by default.",
      "It does **not** mean every prompt injection, compromised dependency, credential leak, unsafe browser action or application vulnerability has been solved.",
    ],
    limitsLead: "In particular:",
    limits: [
      "An agent may still misuse credentials or permissions legitimately given to it.",
      "Isolation does not make instructions from websites, documents or messages trustworthy.",
      "Network access can expose an agent to external services, malicious content and unintended destinations.",
      "A compromised integration, tool or dependency can affect work inside an otherwise separate environment.",
      "Operator access and infrastructure controls matter. Cloud isolation should not be confused with a claim that the provider has no possible access to underlying systems.",
      "No environment is entirely immune to compromise, and no unattended agent should have unlimited authority.",
    ],
    goals:
      "The longer-term Hivra vision includes stronger permission controls, verification, identity and recovery mechanisms. Those are product goals, not security guarantees available today.",
  },
  implementation: {
    heading: "Check the implementation",
    intro: "We believe security claims should be supported by documented behaviour and code wherever possible.",
    links: [
      `[Security policy (\`SECURITY.md\`)](${SECURITY_POLICY_SOURCE_URL})`,
      `[Hivra security model](${SECURITY_MODEL_URL})`,
      "[`security.txt`](/.well-known/security.txt)",
      "[Why Hivra](/why-hivra)",
      "[How Hivra works](/about)",
    ],
  },
  questions: {
    heading: "Questions or security concerns?",
    body: `Email [**${SECURITY_EMAIL}**](mailto:${SECURITY_EMAIL}). Please use the private reporting channel for anything that could put users or infrastructure at risk.`,
  },
} as const;
