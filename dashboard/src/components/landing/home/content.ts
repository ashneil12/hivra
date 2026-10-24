// Homepage copy, in one place so the visible page, the FAQPage JSON-LD and the
// copy tests all read the same strings.
//
// The wording is Ash's homepage copy (01-homepage.md, 20 Oct 2026), kept as
// written. Where a repo rule needs a different sentence the change is small and
// is recorded in the lane ledger (home.json), not hidden here.
//
// Rules this file keeps (tested in __tests__/home-copy.test.ts):
// - Prices, sizes and the guarantee come from lib/blog/plan-facts.ts and
//   app/pricing/pricing-content.ts, so they move with checkout.
// - Keep-running claims use the approved wording: a paid computer stays on and
//   is not paused for inactivity; only tmux runs (or Telegram on Claude Code)
//   are promised to carry on (lib/blog/runtime-facts.ts, verbatim).
// - No em or en dashes, no plan names (Starter, Pro, Power), no annual prices,
//   no trial, and no "preview" labels. Omarchy and Windows are never called
//   plainly available: the code runs Omarchy as a prepared computer
//   (lib/hivra/computer-catalog.ts, prepared-canary-computers.ts) and refuses
//   to launch one when no prepared slot exists, and Windows runs on the
//   visitor's own server from their own licensed image. So each always carries
//   its condition: "Omarchy (prepared computer)" and "Windows on your own
//   server with your licensed image".
// - Hivra runs no free computer (owner decision, 21 Oct 2026). Every computer
//   Hivra Cloud runs is paid, whichever agent it carries, and a free account
//   works with a computer or server the person connects. The page says so once
//   in each place a visitor chooses what to start (the agents section, the
//   computers block, the pricing offers and the closing), built from the shared
//   sentences in lib/blog/plan-facts.ts. No agent card singles out one agent as
//   the paid one.
// - Anything that names a token, the migration, the snapshot or the litepaper
//   is not in this file's always-on copy. The one token sentence is added by
//   homepageFaq() only when the token surfaces are visible to the viewer.

import {
  ENTRY_PLAN_PRICE,
  ENTRY_PLAN_SIZE,
  HOSTED_COMPUTE_NEEDS_PLAN,
  HOSTED_COMPUTE_NEEDS_PLAN_SHORT,
  LARGER_PLAN_PRICE,
  LARGER_PLAN_SIZE,
  MONEY_BACK_GUARANTEE,
  PLAN_DISPLAY,
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

/** The approved stays-on wording (no full stop, so a sentence can carry on from it). */
export const STAYS_ON = "A paid Hivra Cloud computer stays on and is not paused for inactivity";

export const HERO = {
  titleLead: "Your agent needs a",
  titleWord: "computer.",
  titleTail: "It doesn't need yours.",
  subhead: [
    "Give Claude Code, Codex or your favourite AI agent a computer of its own. Let it build, research and run tasks without sitting beside your personal files, passwords and signed-in accounts.",
    `${STAYS_ON}, even when you close your laptop. Open it from your browser whenever you want to see what it's doing or take over.`,
  ],
  primary: "Launch an agent",
  secondary: "Start with a computer",
  proof: [
    "Use your own Claude or ChatGPT login, subject to the provider's terms, or bring an AI API key.",
    "Let Hivra host it on a paid plan, connect your own server with a free account, or self-host the platform.",
    "Read the code. Hivra is open source.",
  ],
} as const;

/**
 * The live count beside the hero: label and link only; the number and date come
 * from the server. The count is the get_agents_deployed_stats RPC, which counts
 * every agent and every computer that provisioned (archived ones included), so
 * the label says both.
 */
export const AGENTS_STAT = {
  label: "agents and computers launched on Hivra",
  asOf: "As of",
  link: "Full stats",
  href: "/stats",
} as const;

export const REACH = {
  intro: {
    title: "The problem isn't that agents use computers.",
    tail: "It's whose computer they're using.",
    body: [
      "An agent can open files, run commands, install packages, browse websites, test code and sign in to services. That's what makes it useful. It's also why the machine you give it matters.",
      "If you run it on your own laptop, it may be working a few folders away from your photos, private documents, work files and credentials. You can set permissions, of course. But one overly broad permission, a mistake in a command or an instruction hidden in a webpage can turn a routine task into something you never intended.",
    ],
    pull: "You shouldn't have to stop using capable agents to avoid that risk. Give them somewhere else to work.",
  },
  titleB: "Don't make the AI its own guard.",
  bodyB: [
    "A model can be told not to touch something. That instruction is not the same as making the thing inaccessible.",
    "With Hivra, the agent works on a separate computer. You decide which project files, services and accounts to bring into its environment. Your personal laptop is not automatically part of its workspace.",
  ],
  /** The three statements of the interactive. Each is a row of the selector, all present at once. */
  states: [
    {
      id: "shared",
      label: "Shared machine",
      caption: "The agent works alongside your files and signed-in applications. Its reach depends on the permissions available on that machine.",
    },
    {
      id: "separate",
      label: "Separate computer",
      caption: "The agent starts with its own files, sessions and applications. You deliberately connect what a particular job needs.",
    },
    {
      id: "share",
      label: "Share a project, not your entire machine",
      caption: "Give the agent the work without assuming it needs everything else.",
    },
  ],
  note: "Isolation is a useful boundary, not a blanket guarantee. Real security depends on configuration, network access, connected accounts and the software running inside the computer.",
  /** Labels drawn inside the illustration. */
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
  /** A limit worth seeing before the click, shown in italics under the description. */
  note?: string;
  href: string;
  /** Illustrative activity for the card's small screen. */
  screen: string[];
}

/** Where Hivra fits: the comparison table, the website pack's six rows and four columns. */
export const FIT = {
  title: "Keep the agents you like.",
  titleTail: "Move them off your computer.",
  lead: "You don't need to learn an entirely new agent to use Hivra. Bring the tools you already rely on and give each one a place to work.",
  rowHeading: "Where the agent runs",
  columns: ["Your laptop", "A provider-managed agent", "A typical hosted machine", "Hivra"],
  rows: [
    { label: "Works without your laptop staying open", cells: ["No", "Usually", "Yes", "Yes, on a paid cloud plan"] },
    { label: "You choose your agent", cells: ["Yes", "Often limited", "Usually", "Yes, from supported options"] },
    { label: "You can use your own AI credentials", cells: ["Yes", "Provider-dependent", "Provider-dependent", "Yes, where supported"] },
    { label: "Platform source available to inspect", cells: ["Depends on tools", "Usually not", "Provider-dependent", "Yes"] },
    { label: "Can run the whole platform yourself", cells: ["Not applicable", "Usually not", "Provider-dependent", "Yes"] },
    { label: "Separate from your personal machine", cells: ["No", "Yes", "Yes", "Yes"] },
  ],
  note: "Other services and their capabilities change. Check their current documentation rather than treating this overview as a universal comparison.",
  more: "Explore the comparisons",
  moreHref: "/compare",
} as const;

export const AGENTS_SECTION = {
  title: "Pick an agent. Give it a computer.",
  /** One line for every card below: the cost belongs to the computer, not to one agent. */
  paid: HOSTED_COMPUTE_NEEDS_PLAN,
  compare: "Compare supported agents",
  screensNote: "Card screens are illustrations of each agent at work.",
} as const;

export const HOME_AGENTS: HomeAgent[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    role: "Coding",
    line: "Give Claude Code a dedicated environment for writing, fixing and testing software. Sign in with your own supported Claude account, subject to the provider's terms.",
    href: buildLaunchHref({ start: true, profile: "claude-code" }),
    screen: ["> fix the flaky auth test", "● Reading tests/auth.test.ts", "● Editing src/auth.ts", "✓ Tests pass"],
  },
  {
    id: "codex",
    name: "Codex",
    role: "Coding",
    line: "Run OpenAI's coding agent away from your everyday computer, using your own supported ChatGPT login, subject to the provider's terms.",
    href: buildLaunchHref({ start: true, profile: "codex" }),
    screen: ["› add rate limiting to the API", "• Planning the change", "• Writing middleware/limit.ts", "✓ Ready for review"],
  },
  {
    id: "hermes",
    name: "Hermes",
    role: "Research and automation",
    line: "Give Hermes a persistent place for browsing, research, tools and repeat jobs.",
    note: "Hermes runs on Hivra Cloud only.",
    href: buildLaunchHref({ start: true, profile: "hermes" }),
    screen: ["hermes › compare these pricing pages", "reading the sources", "writing notes/pricing.md", "✓ Saved"],
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    role: "Chat-based agent",
    line: "Run an agent you can reach from familiar messaging apps.",
    href: buildLaunchHref({ start: true, profile: "openclaw" }),
    screen: ["openclaw › sort today's messages", "grouping by sender", "drafting replies", "✓ Waiting for you"],
  },
  {
    id: "agent-zero",
    name: "Agent Zero",
    role: "General-purpose agent workspace",
    line: "Give it a task, follow its steps and inspect its work in a separate environment.",
    href: buildLaunchHref({ start: true, profile: "agent-zero" }),
    screen: ["a0 › write the weekly report", "planning 3 steps", "querying the logs", "✓ Report ready"],
  },
  {
    id: "aeon",
    name: "Aeon",
    role: "Scheduled project automation",
    line: "Set jobs running through your GitHub Actions setup and use Hivra to access the agent's screen.",
    href: buildLaunchHref({ start: true, profile: "aeon" }),
    screen: ["aeon › nightly triage", "workflow queued on GitHub", "labelling new issues", "✓ Run complete"],
  },
];

export const COMPUTERS = {
  title: "You don't need an agent to use the computer.",
  body: [
    "Launch a computer for yourself. Ubuntu, Omarchy (prepared computer) and Windows on your own server with your licensed image are among the operating-system options, depending on your chosen deployment and its requirements. You can add an agent when you need one.",
    HOSTED_COMPUTE_NEEDS_PLAN_SHORT,
  ],
  ubuntu: { name: "Ubuntu", label: "Launch Ubuntu", href: computerLaunchHref("ubuntu-desktop") },
  explore: { label: "Explore computers", href: "#computers" },
  /** The qualifier prints beside the name, so the chip never reads as plain availability. */
  others: [
    { name: "Omarchy", note: "(prepared computer)", href: computerLaunchHref("omarchy") },
    { name: "Windows", note: "on your own server with your licensed image", href: computerLaunchHref("windows") },
  ],
} as const;

export const HOW = {
  title: "Give it work.",
  titleTail: "Keep the final say.",
  steps: [
    {
      n: "01",
      title: "Leave it running.",
      body: `Start a task, close your laptop and come back later. ${STAYS_ON}. Its files and sessions remain in its own environment, and a run you start in tmux keeps going.`,
    },
    {
      n: "02",
      title: "Open the same computer from anywhere.",
      body: "Use a browser to check its desktop or terminal, read the output, fix something yourself or take over a task. You don't have to guess what happened while you were away.",
    },
    {
      n: "03",
      title: "Choose what it can reach.",
      body: "Connect the repository, file or service the job actually needs. Don't give the agent an entire personal computer simply because it's easier than setting up a boundary.",
    },
  ],
  allowed: ["Your code", "AI key", "Coding tools"],
  blocked: ["Photos", "Passwords", "Bank"],
  note: "Illustrations.",
  primary: "Launch an agent",
  secondary: { label: "See the plans", href: "#pricing" },
} as const;

export const OPEN_SOURCE = {
  title: "Open source means you don't have to take our word for it.",
  body: [
    "Hivra sits between an AI agent and the computer it operates. That's exactly the sort of software you should be allowed to inspect.",
    "The platform's source code is public. Read how it works, raise an issue, contribute to it or run it on infrastructure you control. If our hosting isn't right for you, the software doesn't disappear with your subscription.",
    "Open source isn't the same as a security audit, and it doesn't remove the need to configure your deployments properly. It does mean our claims can be checked rather than accepted on trust.",
  ],
  repoOwner: "ashneil12",
  repoName: "hivra",
  clone: "git clone https://github.com/ashneil12/hivra",
  github: "View Hivra on GitHub",
  security: { label: "Read the security information", href: "/security" },
} as const;

const [ENTRY_SIZE, LARGER_SIZE] = HOSTED_SIZES;

export const PRICING = {
  title: "Start free on your own server.",
  titleTail: `Or let us run it from ${ENTRY_PLAN_PRICE} a month.`,
  cloud: {
    name: PLAN_DISPLAY.entry,
    price: ENTRY_PLAN_PRICE,
    per: "/month",
    size: ENTRY_PLAN_SIZE,
    body: "A hosted computer that stays on, with browser access and no server maintenance to take on yourself.",
    cta: "Get started",
    href: ENTRY_SIZE.href,
  },
  larger: {
    name: PLAN_DISPLAY.larger,
    price: LARGER_PLAN_PRICE,
    per: "/month",
    size: LARGER_PLAN_SIZE,
    body: "For larger projects and workloads that need more resources.",
    cta: "Choose this size",
    href: LARGER_SIZE.href,
  },
  server: {
    name: "Connect your server",
    body: "Use infrastructure you already rent and pay that provider directly. A free account is enough.",
    cta: "Connect a server",
    href: PUBLIC_START_HREF,
  },
  selfHost: {
    name: "Self-host the platform",
    price: "$0",
    per: "software cost",
    body: "Run Hivra's open-source platform yourself. Your own server and AI usage still cost money.",
    cta: "See the repository",
    href: SELF_HOST_SOURCE_URL,
  },
  /** The paragraph under the offers. The guarantee sentence ends with a link to the terms. */
  aiUsage:
    "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits. Charges from your AI provider are separate.",
  guarantee: { lead: `Hosted plans carry a ${MONEY_BACK_GUARANTEE}, subject to the`, link: "terms", href: "/terms" },
  full: { label: "Full pricing and what's included", href: "/pricing" },
} as const;

/** From FOUNDER_EXCERPTS and LITEPAPER.md. Not shown while SHOW_FOUNDER_SECTION is false. */
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

/**
 * Homepage founder / personal-background section and chrome links to it.
 * Off until Ash finishes the page. Flip to true to restore the section,
 * header/footer links, and the #founder anchor. Content above stays intact.
 */
export const SHOW_FOUNDER_SECTION = false;

export const FAQ_TITLE = "A few questions, answered.";

/** The one sentence about tokens on the page. It renders, and enters the FAQPage JSON-LD, only when the token surfaces are visible. */
export const TOKEN_FAQ_SENTENCE = "Token-related access and future plans are explained separately.";

/**
 * The seven questions. `showTokenSentence` is `tokenSurfacesVisible(view)` from
 * lib/compliance/token-surface-view.ts: with the surfaces off (the production
 * default) or the viewer geo-blocked, the token question ends after its first
 * two sentences and no other sentence on the page mentions one.
 */
export function homepageFaq(showTokenSentence: boolean): { q: string; a: string }[] {
  return [
    {
      q: "What exactly is Hivra?",
      a: "Software for giving AI agents their own computers, hosted by Hivra or deployed on infrastructure you control. You can also use those computers yourself without an agent.",
    },
    {
      q: "Can I keep using Claude Code or Codex?",
      a: "Yes. These are supported agent options. Where supported, you sign in with your own account, subject to the provider's terms. The plan does not include AI usage. Claude Code uses your own Claude or Anthropic account. For Codex, bring your own account or key, or pay with Hivra credits.",
    },
    {
      q: "What happens when I close my laptop?",
      a: `${CLI_RUN_LIFETIME} ${SERVER_SIDE_AGENTS_KEEP_WORKING} You can return to the same environment through your browser.`,
    },
    {
      q: "Does a separate computer make the agent perfectly safe?",
      a: "No. It gives you an important boundary, but connected services, account permissions, networking and configuration still matter.",
    },
    {
      q: "Do I have to use Hivra Cloud?",
      a: `No. You can connect your own server or self-host the open-source platform. Some managed agents and capabilities are Hivra Cloud-specific. ${HOSTED_COMPUTE_NEEDS_PLAN_SHORT}`,
    },
    {
      q: "Do I need a token?",
      a: showTokenSentence
        ? `No. You can use card-paid hosting or self-host without one. ${TOKEN_FAQ_SENTENCE}`
        : "No. You can use card-paid hosting or self-host without one.",
    },
    {
      q: "Why not rent a normal server?",
      a: "You can. Hivra is for people who'd rather start with an agent-ready environment, browser access and a dashboard than assemble those pieces themselves.",
    },
  ];
}

/** The questions with the token sentence left out: what every viewer sees by default. */
export const HOMEPAGE_FAQ = homepageFaq(false);

export const CLOSING = {
  title: "Start with one computer.",
  body: "Give it a project, see what it can do and keep the rest of your life outside its workspace.",
  paid: "Sign up free and connect a computer or server you already have, or launch on Hivra Cloud with a paid plan. Or self-host it free from GitHub.",
  primary: "Launch an agent",
  secondary: "Start with a computer",
} as const;

export const STICKY = {
  cta: "Launch an agent",
  note: "Free to start",
} as const;
