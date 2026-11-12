// Catalog entry for the Agent Security Check (/tools/ai-agent-security-checklist). Type-only import from the
// catalog: the catalog imports the entries, so a value import here would be a cycle.

import type { ToolEntry } from "../tool-catalog";
import {
  AGENT_SECURITY_FACTS,
  HIVRA_SECURITY_FACTS,
  SOURCE_LIST,
  assess,
  answersFrom,
  resultText,
  type SecurityAnswers,
} from "./agent-security-check";

function answers(partial: Partial<SecurityAnswers>): SecurityAnswers {
  return answersFrom(partial);
}

/** Answers for the worked examples. The page prints exactly what the tool prints for them. */
export const EXAMPLE_ANSWERS = {
  laptop: answers({
    secrets: "unsure",
    spend: "no",
    "ui-private": "yes",
    "ui-auth": "unsure",
    tools: "no",
    approvals: "unsure",
    approvers: "yes",
    senders: "yes",
    untrusted: "no",
    isolation: "no",
    updates: "unsure",
    logs: "no",
  }),
  tidy: answers({
    secrets: "yes",
    spend: "unsure",
    "ui-private": "yes",
    "ui-auth": "yes",
    tools: "yes",
    approvals: "yes",
    approvers: "yes",
    senders: "yes",
    untrusted: "yes",
    isolation: "yes",
    updates: "yes",
    logs: "no",
  }),
  exposed: answers({
    secrets: "yes",
    spend: "yes",
    "ui-private": "no",
    "ui-auth": "no",
    tools: "yes",
    approvals: "yes",
    approvers: "yes",
    senders: "yes",
    untrusted: "yes",
    isolation: "yes",
    updates: "yes",
    logs: "yes",
  }),
} as const;

function exampleText(a: SecurityAnswers): string {
  const result = assess(a);
  return result ? resultText(result) : "";
}

export const AGENT_SECURITY_CHECK_ENTRY: ToolEntry = {
  slug: "ai-agent-security-checklist",
  name: "Agent Security Check",
  h1: "Is your AI agent setup safe? A 12-point security check",
  subhead:
    "Answer twelve yes, no or not-sure questions about your OpenClaw or Hermes setup and get a score band with your top three fixes, each with the command or setting from the vendor's docs.",
  metaTitle: "AI Agent Security Checklist: OpenClaw and Hermes",
  browserTitle: "AI Agent Security Checklist: OpenClaw and Hermes | Hivra",
  metaDescription:
    "Check your OpenClaw or Hermes setup against 12 security questions. Get a score band and your top three fixes, with commands from the upstream docs.",
  intro: {
    lede: "An AI agent is software that can run commands, read your files and message people on your behalf. That is the point of it, and it is also why the setup matters. Most of the risk is not in the agent. It is in who can reach it, what it is allowed to do, and what it reads.",
    body: [
      "This check has twelve questions in eight groups: secrets and API keys, network exposure, what the agent may do, approvals, messages from strangers, isolation, updates and logs. Each one says why it matters in a sentence and gives the fix. Where the OpenClaw or Hermes security docs state a command or setting, you get it, and the page links the source. Where they do not, it says so and does not invent one.",
      "You get a band, not a percentage, because twelve answers cannot support a number. The band comes with your top three fixes, in the order to do them. It is built from what the vendors and the OWASP list for LLM apps tell you to do. It is not an audit, and neither project calls the other, or itself, unsafe. Both ask you to configure them carefully.",
    ],
    note: "Your answers stay in your browser. Nothing is sent anywhere, and nothing you type is stored, because the page takes no typed text. The page address carries only your yes, no and not-sure choices if you copy the link.",
  },
  faqs: [
    {
      q: "Is OpenClaw safe to run?",
      a: "It depends on how you set it up, which is what the OpenClaw docs say too. Their security model assumes one trust boundary per gateway. On a regular install the gateway binds to loopback, unknown senders get a pairing code and group access is allowlisted. Container images default to an exposed bind, so you pair that with auth. Sandboxing is opt-in. The documented risks are an exposed gateway, open access for senders, tools that run on the host, secrets under the state folder and prompt injection. Run openclaw security audit to see where your setup has drifted from the defaults.",
    },
    {
      q: "What are the main OpenClaw security risks?",
      a: "From OpenClaw's own security pages: a Control UI reachable from other machines without a token or password, a direct message policy set to open, tools such as exec and browser enabled for an agent that reads untrusted content, no sandbox, tokens and credentials stored under the state folder with loose permissions, and session transcripts that keep credentials exactly as typed. OWASP adds a general one for any agent: excessive agency, meaning more capability than the job needs.",
    },
    {
      q: "Is Hermes Agent secure?",
      a: "Hermes documents a set of controls and defaults rather than a guarantee. Command approvals default to smart mode, unknown users are denied unless you allow them, a Docker backend can contain commands, and the guide tells you to keep the environment file readable only by your user. It also tells you to avoid the yolo mode and to never open gateway access to all users in production. Updating is one command, hermes update, and hermes doctor lists supply-chain advisories. The same caveat applies: the settings only help if you use them.",
    },
    {
      q: "How do I run the OpenClaw security audit?",
      a: "Run openclaw security audit. OpenClaw describes it as the one command that tells you whether your setup has drifted from the defaults. Its docs list the checks it makes, including a blank or short gateway token, and openclaw doctor can warn about loose permissions on the state folder and offer to tighten them. The audit is a good first run, and this checklist covers the parts it cannot see, such as your model provider's spending limit and where the agent runs.",
    },
    {
      q: "Can someone hijack my agent by sending it a message or an email?",
      a: "They can try, and that is called prompt injection. OWASP lists it first among the risks for LLM apps. OpenClaw's docs point out that the content itself is a threat surface: a web page, an email or a document the agent reads can carry instructions even when only you can message the bot. No setting removes the risk. What you control is the damage: restrict the shell, file and messaging tools while the agent reads outside content, require approval for risky commands, and keep keys out of its reach.",
    },
    {
      q: "Should I run an AI agent on my main laptop?",
      a: "Treat it as a choice with a cost. An agent runs as your user, with your files, browser sessions and keys in reach. For a first look at a local setup, a laptop with the agent limited to read-only tools is a sensible start. For anything that reads email or web pages, or that other people can message, a separate machine, VM or container is safer. Hermes can run commands in a Docker container, and OpenClaw has opt-in sandboxing. A computer of its own, which Hivra provides and so does any VPS, gives the same separation without extra setup on your laptop.",
    },
    {
      q: "Does an isolated computer make an agent safe?",
      a: "No. Isolation keeps a mistake or a hijacked agent away from your laptop, which is worth having, but it does nothing about who can message the agent, what its tools can do, or what it reads. A hijacked agent on its own computer can still use whatever that computer holds, including model keys. That is why isolation is one of twelve checks here and not the whole list.",
    },
  ],
  faqCode: [
    "openclaw security audit",
    "openclaw doctor",
    "hermes update",
    "hermes doctor",
  ],
  relatedLinks: [
    { href: "/agents/hermes", label: "Run Hermes on Hivra" },
    { href: "/agents/openclaw", label: "Run OpenClaw on Hivra" },
    { href: "/tools/agent-survival-check", label: "Agent survival check" },
    { href: "/pricing", label: "Hivra pricing" },
  ],
  componentKey: "agent-security-check",
  primaryKeyword: "openclaw security",
  vendors: ["OpenClaw", "Nous Research", "OWASP"],
  method: {
    heading: "What the checks rest on",
    lastVerified: AGENT_SECURITY_FACTS.lastVerified,
    paragraphs: [
      {
        text: "Each check comes from a control that a vendor or OWASP asks for in writing. The OpenClaw commands and settings come from its security pages on network exposure, tool permissions, access control, prompt injection and secrets and storage. The Hermes commands and settings come from the Hermes security guide. The risk framing, prompt injection and excessive agency among them, comes from the OWASP Top 10 for LLM Applications 2025.",
        sources: [...SOURCE_LIST],
      },
      {
        text: `Every check carries a weight from 1 to 3 for how much it limits the damage if something goes wrong. A no opens the full weight and not sure opens half, because a control you cannot confirm is not the same as one that is missing. The points set the band. A no on a check weighted 3 never lands in well covered, and a control UI that is both reachable and has no login lifts the band to at least several gaps. The weights are our judgement, shown beside each question, not a measurement.`,
      },
      {
        text: "The twelve checks are not every control. They are the ones we could source to the vendors' pages or to OWASP. We do not run your setup, so the tool cannot tell whether your answers are true. Where a vendor's docs do not give a command, the check says so. For the spending limit, the advice is common practice and the page labels it that way.",
      },
      {
        text: "The section on what a Hivra computer changes states only what is written in Hivra's own code and status document, and lists what Hivra does not do. It makes no claim of an audit or certification.",
      },
    ],
  },
  examples: [
    {
      title: "A first install on a laptop, mostly defaults",
      inputs: "Some key files unchecked, no spending limit, no tool limits, reading email and web pages, on the main laptop",
      command: exampleText(EXAMPLE_ANSWERS.laptop),
      result:
        "A long list rather than a verdict. The control UI is on localhost and only approved people can message the agent, which are the two things the defaults give you. Isolation and the untrusted-content check lead because they decide how far a bad instruction could reach.",
    },
    {
      title: "A tidy setup with one habit missing",
      inputs: "Everything in place except a spending limit that is unconfirmed and no routine for reading logs",
      command: exampleText(EXAMPLE_ANSWERS.tidy),
      result:
        "Well covered. The two open items are small: confirm the limit with your model provider and put a log read in the calendar. The band says nothing about what changes next month, so run it again after you add a tool or a channel.",
    },
    {
      title: "A reachable control UI with no login",
      inputs: "Everything else done, but the UI is reachable from the internet and has no token or password",
      command: exampleText(EXAMPLE_ANSWERS.exposed),
      result:
        "Several gaps, even though ten of twelve checks are fine. That pairing is the one the tool will not let a good total hide. Bind to loopback and set token auth first, then run the audit again.",
    },
  ],
};

export const AGENT_SECURITY_HIVRA_NOTE = HIVRA_SECURITY_FACTS.stillYours;
