// Copy for /about: the page that says who and what Hivra is, for people, search
// engines and answer engines.
//
// Every fact here is already public on the site or in the repository: the
// homepage (what it runs, the founder's first name and role, the FAQ), /pricing
// (plans and the guarantee), /terms and /privacy (contact), the agent pages (the
// non-affiliation line) and SECURITY.md. The site names no legal entity, address
// or funding source, so this page names none. Add one only when the owner
// supplies it (checklist T1 and T6).
//
// about.test.tsx pins the required lines and runs the shared banned-claims list
// over everything below.

import { ENTRY_PLAN_PRICE, ENTRY_PLAN_SIZE, MONEY_BACK_GUARANTEE } from "@/lib/blog/plan-facts";
import { NON_AFFILIATION_LINE, SITE_DESCRIPTION } from "@/lib/brand-description";
import { SECURITY_EMAIL } from "@/lib/security-contact";

export const ABOUT_TITLE = "About Hivra, formerly HermesOS";
export const ABOUT_DESCRIPTION =
  "Hivra (formerly HermesOS) is an open-source computer for you and your AI agents. What it is, what it is not, what it costs and how to reach us.";

export const REPOSITORY_LABEL = "github.com/ashneil12/hivra";

/** The sentence that answers "is this the Hivra I am looking for?" */
export const DISAMBIGUATION =
  "Hivra at hivra.cloud is unrelated to other projects called Hivra, such as hivra.ai and hivra.app.";

export const ABOUT_SECTIONS = {
  is: {
    heading: "What Hivra is",
    paragraphs: [
      "Hivra gives an AI agent a computer of its own, or gives you one. Launch Claude Code, Codex, Hermes, OpenClaw, Agent Zero or Aeon, each on a computer of its own, or start an Ubuntu computer and use it yourself.",
      "It runs on Hivra Cloud, where Hivra runs the computer for you, or on your own server, because the platform is open source and you can self-host it. Hermes runs on Hivra Cloud only, and OpenClaw and Agent Zero need a paid plan there.",
      "Hivra was called HermesOS before. Existing users, deployments and accounts carried over.",
    ],
  },
  isNot: {
    heading: "What Hivra is not",
    items: [
      "It is not an AI model. You bring your own model key, or sign in with your own Claude or ChatGPT account, and your AI company bills you for what you use.",
      NON_AFFILIATION_LINE + " Hermes Agent is a Nous Research project, Claude Code is Anthropic's and Codex is OpenAI's. Hivra runs them on a computer of their own.",
      "It does not need a token. Running Hivra yourself needs neither a token nor a Hivra account.",
    ],
  },
  built: {
    heading: "How it is built and what it costs",
    paragraphs: [
      `Hivra is built in the open. The source code is public at ${REPOSITORY_LABEL}, and you can read it and run it yourself.`,
      `Hivra Cloud costs ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}. Self-hosting is free: you pay for your own server and your own AI usage. Paid plans come with a ${MONEY_BACK_GUARANTEE}.`,
      "Hivra is built by Ash, the founder, who explains why in the founder's note.",
    ],
  },
  contact: {
    heading: "Contact and things you can check",
    lead: `Questions and support: ${SECURITY_EMAIL}. You can check the rest yourself:`,
  },
  others: {
    heading: "Not the other Hivras",
    paragraphs: [
      DISAMBIGUATION,
      "If you are not sure you are on the right site, check the address: this one is hivra.cloud.",
    ],
  },
} as const;

/** Links under "Contact and things you can check". Every target is a real page. */
export const ABOUT_LINKS: Array<{ label: string; href: string; note: string }> = [
  { label: "Source code", href: "https://github.com/ashneil12/hivra", note: "the open source repository" },
  { label: "Pricing", href: "/pricing", note: "plans, sizes and the money-back guarantee" },
  { label: "Status", href: "/status", note: "live health of the public surfaces" },
  { label: "Security", href: "/security", note: "how to report a vulnerability" },
  { label: "Terms", href: "/terms", note: "the terms of service" },
  { label: "Privacy", href: "/privacy", note: "how your data is handled" },
  { label: "Why I'm building Hivra", href: "/why-hivra", note: "the founder's note" },
  { label: "X (@HivraOS)", href: "https://x.com/HivraOS", note: "the official account" },
];

export const ABOUT_FAQ: { q: string; a: string }[] = [
  { q: "What is Hivra?", a: SITE_DESCRIPTION },
  {
    q: "Is Hivra the same as HermesOS?",
    a: "Yes. HermesOS is the former name of Hivra. Existing users, deployments and accounts carried over.",
  },
  {
    q: "Is Hivra open source?",
    a: `Yes. The source code is public at ${REPOSITORY_LABEL}, and you can run the whole platform yourself.`,
  },
  {
    q: "Is Hivra affiliated with Nous Research, Anthropic or OpenAI?",
    a: `No. ${NON_AFFILIATION_LINE} Hermes Agent is a Nous Research project, Claude Code is Anthropic's and Codex is OpenAI's. Hivra runs them on a computer of their own, with your own account or key.`,
  },
  { q: "Is Hivra the same as hivra.ai or hivra.app?", a: `No. ${DISAMBIGUATION}` },
  {
    q: "Is Hivra legit?",
    a: `Judge it from what you can check. The source code is public at ${REPOSITORY_LABEL}, the terms, privacy policy, status page and pricing are linked on this page, paid plans come with a ${MONEY_BACK_GUARANTEE}, and you can reach Hivra at ${SECURITY_EMAIL}.`,
  },
  {
    q: "How do I contact Hivra or report a security problem?",
    a: `Email ${SECURITY_EMAIL} for questions and support. To report a vulnerability privately, follow the steps at hivra.cloud/security.`,
  },
];
