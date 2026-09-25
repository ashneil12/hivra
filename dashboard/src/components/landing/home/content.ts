// Homepage copy, in one place so the visible page, the FAQPage JSON-LD and the
// copy tests all read the same strings.
//
// Rules this file keeps (tested in __tests__/home-copy.test.ts):
// - Prices, sizes and the guarantee come from lib/blog/plan-facts.ts and
//   app/pricing/pricing-content.ts, so they move with checkout.
// - Keep-running claims come from lib/blog/runtime-facts.ts, verbatim.
// - Lines quoted from the litepaper are copied from LITEPAPER.md, verbatim.
// - No em or en dashes, no plan names, no annual prices, no trial, and
//   "Windows" only in the private-preview sentence.

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

export const HERO = {
  eyebrow: "Hermes OS is now Hivra",
  eyebrowHref: "/why-hivra/evolution",
  titleLead: "Your agent needs a",
  titleWord: "computer.",
  titleTail: "It doesn't need yours.",
  subhead: `Run Claude Code, Codex, Hermes and more on a private cloud computer of their own. It stays on when you close your laptop, and you decide what it can reach. From ${ENTRY_PLAN_PRICE} a month.`,
  primary: "Launch an agent",
  secondary: "Or start with a computer",
  proof: [
    "Your Claude or ChatGPT login, or your own API key",
    "Hivra Cloud, your own server, or self-hosted",
    "Apache 2.0. Source on GitHub.",
  ],
} as const;

/** Lines from LITEPAPER.md ("The problem is where it lives"), verbatim. */
export const REACH = {
  eyebrow: "The problem",
  titleA: "Right now, your agent works where your life is.",
  bodyA: [
    "You ask an agent to fix something. It opens the terminal, reads your project, installs a package. A few minutes later it's in the browser, using a session you signed into yesterday.",
    "That's useful. It's also happening on the computer where you keep your photos, your passwords, your client work and everything else you own.",
  ],
  kicker: "You gave it a job. How much of the rest did you mean to give it?",
  titleB: "A separate computer is just somewhere to draw that line.",
  bodyB: "Share the project. Connect the accounts you want it to use. Keep the rest out.",
  states: [
    { id: "shared", label: "Shared machine", caption: "The agent works beside your personal files and signed-in apps. What it can reach comes down to whatever permissions you set." },
    { id: "separate", label: "Separate computer", caption: "The agent has its own files, apps and sessions. You decide what comes in." },
  ],
  shareCaption: "Share a project folder. Give it the work. Sharing one folder shouldn't open the rest of your life.",
  note: "This is an illustration of the idea. Real protection depends on how the computer, network and accounts are actually set up.",
  items: [
    { id: "photos", label: "Photos" },
    { id: "passwords", label: "Passwords" },
    { id: "bank", label: "Bank session" },
    { id: "clients", label: "Client work" },
    { id: "keys", label: "SSH keys" },
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

export const AGENTS_SECTION = {
  eyebrow: "Agents",
  title: "Pick your agent.",
  titleTail: "It gets its own computer.",
  subhead: "Sign in with your Claude or ChatGPT account, or bring an API key. Run a few side by side, each on a computer of its own.",
  compare: "Compare every agent",
  screensNote: "Card screens are illustrations of each agent at work.",
} as const;

export const HOME_AGENTS: HomeAgent[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    role: "Coding",
    line: "Build, debug and review code. Uses your own Claude login.",
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
    line: "Browse, research and automate work, with its tools and memory in one place.",
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
    line: "Give it a goal. It plans, runs and reports in its own dashboard.",
    href: buildLaunchHref({ start: true, profile: "agent-zero" }),
    screen: ["a0 › write the weekly report", "planning 3 steps", "querying the logs", "✓ Report ready"],
  },
  {
    id: "aeon",
    name: "Aeon",
    role: "Project automation",
    line: "Scheduled agent work on your own GitHub Actions. Hivra hosts its dashboard.",
    href: buildLaunchHref({ start: true, profile: "aeon" }),
    screen: ["aeon › nightly triage", "workflow queued on GitHub", "labelling new issues", "✓ Run complete"],
  },
];

export const COMPUTERS = {
  title: "Just need a computer?",
  body: "Ubuntu is ready now. Windows and Omarchy are in private preview. No agent required.",
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
      body: "Close the laptop. On a paid plan the computer stays on, with its files, sessions and logins where you left them. A run you start in tmux keeps going.",
    },
    {
      n: "02",
      title: "Watch it. Take over from anywhere.",
      body: "Open the desktop or terminal from any browser, even your phone. Check the work, then do the next bit yourself.",
    },
    {
      n: "03",
      title: "It only gets what you give it.",
      body: "Your personal files and signed-in accounts aren't on its computer. Share a project, connect what the job needs, and keep the rest out.",
    },
  ],
  allowed: ["Your repo", "Model key", "Dev tools"],
  blocked: ["Photos", "Passwords", "Bank"],
  note: "Illustrations.",
} as const;

export const OPEN_SOURCE = {
  eyebrow: "Open source",
  title: "Read every line.",
  titleTail: "Run it yourself.",
  body: [
    "The complete Hivra platform uses Apache 2.0. Read the code. Change it. Run it yourself.",
    "This software sits between an agent and things you care about. You should be able to inspect its decisions about access, and keep going without us if we change direction.",
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
  subhead: "Pick where it runs. Your model key or login stays yours wherever it runs, and usage on it is billed by your provider.",
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
    chip: "Preview",
    body: "Connect a server you already pay for and launch Hivra computers on it. You pay your server provider directly.",
    cta: "Connect your server",
    href: PUBLIC_START_HREF,
  },
  selfHost: {
    name: "Self-host Hivra",
    chip: "Preview",
    price: "$0",
    body: "Run the whole platform yourself from the Apache 2.0 source, as a preview for a single operator. You provide the server and pay for it and your model usage.",
    cta: "View on GitHub",
    href: SELF_HOST_SOURCE_URL,
  },
  footnote: "Larger sizes are planned.",
} as const;

/** From FOUNDER_EXCERPTS and LITEPAPER.md, verbatim. */
export const FOUNDER = {
  eyebrow: "Why I'm building Hivra",
  lines: [
    "I run agents every day. I build software with them, dig through problems with them, and get through work that would otherwise take a week.",
    "I'd also like my computer back.",
    "Someone has to be answerable. Someone decides what the agent reaches, where its authority stops, and how to pull the plug.",
  ],
  name: "Ash",
  role: "Founder",
  link: "Read why I'm building Hivra",
  href: "/why-hivra",
} as const;

export const HOMEPAGE_FAQ: { q: string; a: string }[] = [
  {
    q: "What is Hivra?",
    a: "A private cloud computer for your agent, or for you. Launch Claude Code, Codex, Hermes and more on it, or launch Ubuntu and use it yourself.",
  },
  {
    q: "Which agents can I use?",
    a: "Claude Code, Codex, Hermes, OpenClaw and Agent Zero, each on a computer of its own. Aeon's scheduled tasks run on your own GitHub Actions, and the computer hosts its dashboard.",
  },
  {
    q: "Can I use my Claude or ChatGPT account?",
    a: "Yes. Sign in with your own account for Claude Code and Codex, or bring an API key. Usage on your own key or login is billed by your provider.",
  },
  {
    q: "What happens when I close my laptop?",
    a: `${CLI_RUN_LIFETIME} ${SERVER_SIDE_AGENTS_KEEP_WORKING}`,
  },
  {
    q: "Where can it run?",
    a: "On Hivra Cloud, where we run the computer for you. On a server you already have, in preview. Or self-host the whole platform from the Apache 2.0 source, in preview for a single operator.",
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
    a: "No. Self-hosting needs neither a token nor a Hivra account. Available payment methods are shown in the managed checkout.",
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
