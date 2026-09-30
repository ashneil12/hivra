// Homepage copy, in one place so the visible page, the FAQPage JSON-LD and the
// copy tests all read the same strings.
//
// Rules this file keeps (tested in __tests__/home-copy.test.ts):
// - Prices, sizes and the guarantee come from lib/blog/plan-facts.ts and
//   app/pricing/pricing-content.ts, so they move with checkout.
// - Keep-running claims come from lib/blog/runtime-facts.ts, verbatim.
// - Lines quoted from the litepaper are copied from LITEPAPER.md, verbatim.
// - No em or en dashes, no plan names, no annual prices, no trial, and
//   no "preview" labels: Ash treats every surface named here as live
//   (2026-09-28), including Windows and Omarchy computers and self-hosting.

import {
  ENTRY_PLAN_PRICE,
  ENTRY_PLAN_SIZE,
  LARGER_PLAN_PRICE,
  LARGER_PLAN_SIZE,
  MONEY_BACK_GUARANTEE,
} from "@/lib/blog/plan-facts";
import { HOSTED_SIZES, SELF_HOST_SOURCE_URL } from "@/app/pricing/pricing-content";
import { CLI_RUN_LIFETIME, SERVER_SIDE_AGENTS_KEEP_WORKING } from "@/lib/blog/runtime-facts";
import { buildLaunchHref } from "@/lib/hivra/launch-navigation";
import { PUBLIC_START_HREF } from "@/lib/public-start";

export { SELF_HOST_SOURCE_URL };

/** Signed-out visitors pass through sign-in and land in Launch with this choice. */
export const AGENT_LAUNCH_HREF = "/dashboard/launch?kind=agent&start=1";

export function computerLaunchHref(profile: "ubuntu-desktop" | "windows" | "omarchy"): string {
  return `/dashboard/launch?kind=computer&start=1&profile=${profile}`;
}

export const GUARANTEE_LINE = `${MONEY_BACK_GUARANTEE}.`;

/** tmux is named in the verified runtime sentence, so the FAQ explains it after the facts. */
export const TMUX_GLOSS = "(tmux is a tool that keeps a program running after you disconnect.)";

export const HERO = {
  eyebrow: "Hermes OS is now Hivra",
  eyebrowHref: "/why-hivra/evolution",
  titleLead: "Your agent needs a",
  titleWord: "computer.",
  titleTail: "It doesn't need yours.",
  subhead: `AI agents like Claude Code and Codex can do real work for you. Hivra gives each one a private computer in the cloud. It keeps working when you close your laptop, and you decide what it can reach. From ${ENTRY_PLAN_PRICE} a month.`,
  primary: "Launch an agent",
  secondary: "Or start with a computer",
  proof: [
    "Your own Claude or ChatGPT account, or your own AI key",
    "We run it, or you run it on your own server",
    "Open source: anyone can read the code",
  ],
} as const;

/** Lines from LITEPAPER.md ("The problem is where it lives"), verbatim. */
export const REACH = {
  eyebrow: "The problem",
  titleA: "Right now, your agent works where your life is.",
  bodyA: [
    "They type commands, read through code, install software, browse the web, use accounts you're signed into, write and run code, and send messages. They keep working while you're somewhere else.",
    "And most of them run on your computer. The same machine that holds your photos, your messages, your passwords, your secret keys, your work and every account you're signed into.",
  ],
  kicker: "Is that really what you want running on your personal computer?",
  titleB: "Don't make the AI its own guard.",
  bodyB: "Give it a computer of its own.",
  states: [
    { id: "shared", label: "Shared machine", caption: "The agent works beside your personal files and signed-in apps. What it can reach comes down to whatever permissions you set." },
    { id: "separate", label: "Separate computer", caption: "The agent has its own files, apps and sessions. You decide what comes in." },
  ],
  shareCaption: "Share a project folder. Give it the work. Sharing one folder shouldn't open the rest of your life.",
  note: "This is an illustration of the idea. Real protection depends on how the computer, network and accounts are actually set up.",
  items: [
    { id: "photos", label: "Photos" },
    { id: "passwords", label: "Passwords" },
    { id: "bank", label: "Bank login" },
    { id: "clients", label: "Work files" },
    { id: "keys", label: "Secret keys" },
  ],
  project: "Project folder",
} as const;

export interface HomeAgent {
  id: "claude-code" | "codex" | "hermes" | "openclaw" | "agent-zero" | "aeon";
  name: string;
  role: string;
  line: string;
  href: string;
  /** Illustrative activity for the card's small screen. */
  screen: string[];
}

/**
 * Where Hivra fits. The columns and rows quote the litepaper's comparison
 * table word for word (home-copy.test.ts checks them against LITEPAPER.md).
 */
export const FIT = {
  eyebrow: "Where it fits",
  title: "Keep the agents you like.",
  titleTail: "Move them off your computer.",
  lead: "Use any of them. Just stop running them on the computer where the rest of your life lives.",
  columns: ["Your own computer", "The maker's computer", "A hosted agent computer", "Hivra"],
  examples: ["Your laptop", "Muse, Grok Bot", "Rented in the cloud", "Open source"],
  rows: [
    { label: "Keeps your personal computer out of it", cells: ["No", "Yes", "Yes", "Yes"] },
    { label: "Stays on when your laptop closes", cells: ["No", "Yes", "Yes", "Yes"] },
    { label: "You choose the agent", cells: ["Yes", "No", "Yes", "Yes"] },
    { label: "You use your own AI account", cells: ["Yes", "No", "Yes", "Yes"] },
    { label: "Pick the operating system: Linux, Windows or Omarchy", cells: ["Yours", "Theirs", "Linux", "Yes"] },
    { label: "You can read the code", cells: ["Depends", "No", "No", "Yes"] },
    { label: "You can run it on your own computer or server", cells: ["Yes", "No", "No", "Yes"] },
  ],
  verdict: "Hivra is the one you can check.",
  more: "How Hivra compares",
  moreHref: "/docs/litepaper/index.html#fit",
  note: "How these services described themselves in September 2026. They change quickly, so check the current details before you rely on them.",
} as const;

export const AGENTS_SECTION = {
  eyebrow: "Agents",
  title: "Pick your agent.",
  titleTail: "It gets its own computer.",
  subhead: "Sign in with your own Claude or ChatGPT account, or use your own AI key. Run a few side by side, each on a computer of its own.",
  compare: "Compare every agent",
  screensNote: "Card screens are illustrations of each agent at work.",
} as const;

export const HOME_AGENTS: HomeAgent[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    role: "Coding",
    line: "Write, fix and check code. Uses your own Claude login.",
    href: buildLaunchHref({ start: true, profile: "claude-code" }),
    screen: ["> fix the flaky auth test", "● Reading tests/auth.test.ts", "● Editing src/auth.ts", "✓ Tests pass"],
  },
  {
    id: "codex",
    name: "Codex",
    role: "Coding",
    line: "OpenAI's coding agent. Uses your own ChatGPT login.",
    href: buildLaunchHref({ start: true, profile: "codex" }),
    screen: ["› add rate limiting to the API", "• Planning the change", "• Writing middleware/limit.ts", "✓ Ready for review"],
  },
  {
    id: "hermes",
    name: "Hermes",
    role: "Research and automation",
    line: "Browses the web, does research and handles repeat jobs, with its tools and memory in one place.",
    href: buildLaunchHref({ start: true, profile: "hermes" }),
    screen: ["hermes › compare these pricing pages", "reading the sources", "writing notes/pricing.md", "✓ Saved"],
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    role: "Automation",
    line: "An agent you message from the chat apps you already use.",
    href: buildLaunchHref({ start: true, profile: "openclaw" }),
    screen: ["openclaw › sort today's messages", "grouping by sender", "drafting replies", "✓ Waiting for you"],
  },
  {
    id: "agent-zero",
    name: "Agent Zero",
    role: "Agent workspace",
    line: "Give it a goal. It plans the steps, does them and reports back on its own screen.",
    href: buildLaunchHref({ start: true, profile: "agent-zero" }),
    screen: ["a0 › write the weekly report", "planning 3 steps", "querying the logs", "✓ Report ready"],
  },
  {
    id: "aeon",
    name: "Aeon",
    role: "Project automation",
    line: "Runs jobs on a timer through your own GitHub Actions. Hivra hosts its screen.",
    href: buildLaunchHref({ start: true, profile: "aeon" }),
    screen: ["aeon › nightly triage", "workflow queued on GitHub", "labelling new issues", "✓ Run complete"],
  },
];

export const COMPUTERS = {
  title: "Just need a computer?",
  body: "Ubuntu, Windows or Omarchy, with an agent or without one.",
  ubuntu: { label: "Launch Ubuntu", href: computerLaunchHref("ubuntu-desktop") },
  previews: [
    { name: "Windows", href: computerLaunchHref("windows") },
    { name: "Omarchy", href: computerLaunchHref("omarchy") },
  ],
} as const;

export const HOW = {
  eyebrow: "How it works",
  title: "Hand it the work.",
  titleTail: "Keep the control.",
  steps: [
    {
      n: "01",
      title: "It stays on when you don't.",
      body: "Close the laptop. On a paid plan the computer stays on, with its files and logins where you left them. A run you start in tmux (a tool that keeps programs going) keeps going.",
    },
    {
      n: "02",
      title: "Watch it. Take over from anywhere.",
      body: "Open its desktop or text window from any browser, even on your phone. Check the work, then do the next bit yourself.",
    },
    {
      n: "03",
      title: "It only gets what you give it.",
      body: "Your personal files and signed-in accounts aren't on its computer. Share a project, connect what the job needs, and keep the rest out.",
    },
  ],
  allowed: ["Your code", "AI key", "Coding tools"],
  blocked: ["Photos", "Passwords", "Bank"],
  note: "Illustrations.",
} as const;

export const OPEN_SOURCE = {
  eyebrow: "Open source",
  title: "Read every line.",
  titleTail: "Run it yourself.",
  body: [
    "Every line of Hivra is open source, so anyone can read the code. Change it. Run it yourself.",
    "This software sits between an agent and the things you care about. You should be able to check how it decides what the agent can touch, and keep going without us if we change direction.",
  ],
  repoOwner: "ashneil12",
  repoName: "hivra",
  clone: "git clone https://github.com/ashneil12/hivra",
  github: "View on GitHub",
  commitment: "Read the open-source commitment",
  commitmentHref: "/docs/litepaper/index.html#platform",
} as const;

const [ENTRY_SIZE, LARGER_SIZE] = HOSTED_SIZES;

export const PRICING = {
  eyebrow: "Pricing",
  title: "Free to self-host.",
  titleTail: `From ${ENTRY_PLAN_PRICE} a month on Hivra Cloud.`,
  subhead: "Pick where it runs. Your own AI key or login stays yours wherever it runs, and your AI company bills you for what you use.",
  cloud: {
    name: "Hivra Cloud",
    marker: "Start here",
    price: ENTRY_PLAN_PRICE,
    size: ENTRY_PLAN_SIZE,
    body: `${ENTRY_SIZE.body} Open it from any browser, including your phone.`,
    cta: "Launch on Hivra Cloud",
    href: ENTRY_SIZE.href,
    guarantee: GUARANTEE_LINE,
    more: `Need more room? ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}.`,
    moreCta: "Choose this size",
    moreHref: LARGER_SIZE.href,
  },
  server: {
    name: "Your own server",
    body: "Connect a server you already pay for and launch Hivra computers on it. You pay your server provider directly.",
    cta: "Connect your server",
    href: PUBLIC_START_HREF,
  },
  selfHost: {
    name: "Self-host Hivra",
    price: "$0",
    body: "Run the whole platform yourself from the open source code. You supply the server and pay for it, and for your AI usage.",
    cta: "View on GitHub",
    href: SELF_HOST_SOURCE_URL,
  },
  footnote: "Larger sizes are planned. A vCPU is one slice of a processor, and RAM is the computer's working memory.",
} as const;

/** From FOUNDER_EXCERPTS and LITEPAPER.md, verbatim. */
export const FOUNDER = {
  eyebrow: "Why I'm building Hivra",
  lines: [
    "I run agents every day. I build software with them, dig through problems with them, and get through work that would otherwise take a week.",
    "I don't want that progress to mean handing more of my own computer to software I can't fully predict.",
    "The more capable the agent, the less sense it makes to let the model decide where the boundary is.",
  ],
  name: "Ash",
  role: "Founder",
  link: "Read why I'm building Hivra",
  href: "/why-hivra",
} as const;

export const HOMEPAGE_FAQ: { q: string; a: string }[] = [
  {
    q: "What is Hivra?",
    a: "A private computer in the cloud for an AI agent, or for you. An agent is an AI that does jobs for you. Launch Claude Code, Codex, Hermes and more on it, or launch Ubuntu and use it yourself.",
  },
  {
    q: "Which agents can I use?",
    a: "Claude Code, Codex, Hermes, OpenClaw and Agent Zero, each on a computer of its own. Aeon's scheduled tasks run on your own GitHub Actions, and the computer hosts its dashboard.",
  },
  {
    q: "Can I use my Claude or ChatGPT account?",
    a: "Yes. Sign in with your own account for Claude Code and Codex, or bring an API key (a password that lets a program use an AI). Your AI company bills you for what you use.",
  },
  {
    q: "What happens when I close my laptop?",
    a: `${CLI_RUN_LIFETIME} ${SERVER_SIDE_AGENTS_KEEP_WORKING} ${TMUX_GLOSS}`,
  },
  {
    q: "Where can it run?",
    a: "On Hivra Cloud, where we run the computer for you. On a server you already have. Or run the whole platform yourself from the open source code.",
  },
  {
    q: "How much does it cost?",
    a: `Self-hosting is free. Hivra Cloud is ${ENTRY_PLAN_PRICE} a month for ${ENTRY_PLAN_SIZE}, or ${LARGER_PLAN_PRICE} a month for ${LARGER_PLAN_SIZE}, with a ${MONEY_BACK_GUARANTEE}.`,
  },
  {
    q: "Why not just rent a server?",
    a: "You could. It'd be cheaper and you'd spend a weekend setting it up, then an hour a month keeping it alive. Some people enjoy that. If you're one of them, go and enjoy it.",
  },
  {
    q: "Do I need the token?",
    a: "No. Running Hivra yourself needs neither a token nor a Hivra account. The ways to pay are shown at checkout.",
  },
];

export const CLOSING = {
  title: "Start with one computer.",
  titleTail: "Make it yours.",
  body: `From ${ENTRY_PLAN_PRICE} a month on Hivra Cloud, with a ${MONEY_BACK_GUARANTEE}.`,
  selfHostLead: "Or self-host it free from",
  selfHostLink: "GitHub",
  primary: "Launch an agent",
  secondary: "Or start with a computer",
} as const;

export const STICKY = {
  cta: "Launch an agent",
  note: `From ${ENTRY_PLAN_PRICE} a month`,
} as const;
