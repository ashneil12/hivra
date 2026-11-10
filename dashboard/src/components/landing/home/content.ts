// Homepage copy, in one place so the visible page, the FAQPage JSON-LD and the
// copy tests all read the same strings.
//
// The page is short on purpose (Ash, 10 Nov 2026): say what Hivra does in the
// first screen, show the agents, three steps, the prices, a few answers and one
// closing ask. The long story (the shared-machine argument, the comparison
// table, the open-source essay) lives on /why-hivra, /compare and /security,
// not here.
//
// Rules this file keeps (tested in __tests__/home-copy.test.ts):
// - Prices, sizes and the guarantee come from lib/blog/plan-facts.ts and
//   app/pricing/pricing-content.ts, so they move with checkout.
// - Keep-running claims use the approved wording: a paid computer stays on and
//   is not paused for inactivity; only tmux runs (or Telegram on Claude Code)
//   are promised to carry on (lib/blog/runtime-facts.ts, verbatim).
// - No em or en dashes, no plan names (Starter, Pro, Power), no annual prices,
//   no trial, and no "preview" labels. Omarchy and Windows are not named on
//   this page; where they are named elsewhere they carry their conditions.
// - Hivra runs no free computer (owner decision, 21 Oct 2026). Every computer
//   Hivra Cloud runs is paid, whichever agent it carries, and a free account
//   works with a computer or server the person connects. The page says so in
//   the canonical words wherever a visitor chooses what to start (the agents
//   section, the pricing offers and the closing). No agent card singles out
//   one agent as the paid one.
// - A promised login always carries "subject to the provider's terms".
// - Anything that names a token, the migration, the snapshot or the litepaper
//   is not in this file's always-on copy. The one token sentence is added by
//   homepageFaq() only when the token surfaces are visible to the viewer.

import {
  ENTRY_PLAN_PRICE,
  ENTRY_PLAN_SIZE,
  FREE_ACCOUNT_SENTENCE,
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

/** The first screen: what it is, one sentence on how, one button. */
export const HERO = {
  titleLead: "Launch an AI",
  titleWord: "agent.",
  titleTail: "On a computer of its own.",
  subhead:
    "Pick Claude Code, Codex, Hermes or another agent. Hivra gives it a private cloud computer you open from any browser, away from your own files and accounts.",
  primary: "Launch an agent",
  secondary: "See pricing",
  /** Three short facts under the buttons, in this order (one icon each in Hero.tsx). */
  proof: ["Free to start", "Bring your own AI key", "Open source"],
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

export interface HomeAgent {
  id: "claude-code" | "codex" | "hermes" | "openclaw" | "agent-zero";
  name: string;
  role: string;
  line: string;
  /** A limit worth seeing before the click, shown in italics under the description. */
  note?: string;
  href: string;
  /** Illustrative activity for the card's small screen. */
  screen: string[];
}

export const AGENTS_SECTION = {
  title: "Pick an agent.",
  titleTail: "We'll give it a computer.",
  /** One line for every card below: the cost belongs to the computer, not to one agent. */
  paid: HOSTED_COMPUTE_NEEDS_PLAN,
  compare: "Compare agents",
  screensNote: "Card screens are illustrations.",
} as const;

export const HOME_AGENTS: HomeAgent[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    role: "Coding",
    line: "Write, fix and test software. Sign in with your own Claude account, subject to the provider's terms.",
    href: buildLaunchHref({ start: true, profile: "claude-code" }),
    screen: ["> fix the flaky auth test", "● Editing src/auth.ts", "✓ Tests pass"],
  },
  {
    id: "codex",
    name: "Codex",
    role: "Coding",
    line: "OpenAI's coding agent, with your own ChatGPT login, subject to the provider's terms.",
    href: buildLaunchHref({ start: true, profile: "codex" }),
    screen: ["› add rate limiting", "• Writing middleware/limit.ts", "✓ Ready for review"],
  },
  {
    id: "hermes",
    name: "Hermes",
    role: "Research and automation",
    line: "Browsing, research, tools and repeat jobs, in one place that remembers.",
    note: "Hermes runs on Hivra Cloud only.",
    href: buildLaunchHref({ start: true, profile: "hermes" }),
    screen: ["hermes › compare these pages", "reading the sources", "✓ Saved notes/pricing.md"],
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    role: "Chat-based agent",
    line: "An agent you can reach from the messaging apps you already use.",
    href: buildLaunchHref({ start: true, profile: "openclaw" }),
    screen: ["openclaw › sort today's messages", "drafting replies", "✓ Waiting for you"],
  },
  {
    id: "agent-zero",
    name: "Agent Zero",
    role: "General-purpose agent",
    line: "Give it a task, follow its steps and check its work.",
    href: buildLaunchHref({ start: true, profile: "agent-zero" }),
    screen: ["a0 › write the weekly report", "planning 3 steps", "✓ Report ready"],
  },
];

/** One line under the agents for people who only want a computer. Anchor #computers. */
export const COMPUTERS = {
  lead: "Just need a computer?",
  label: "Launch Ubuntu",
  href: computerLaunchHref("ubuntu-desktop"),
} as const;

/**
 * Three steps from sign-up to a working agent. The model step lists the ways to
 * pay for AI today; add a managed inference option here when it ships, so the
 * page names it in the same sentence as the others.
 */
export const STEPS = {
  title: "Three steps.",
  titleTail: "Then just talk to it.",
  steps: [
    {
      n: "1",
      title: "Pick an agent",
      body: "Claude Code, Codex, Hermes and more. Each one gets its own computer, with its own files and settings.",
    },
    {
      n: "2",
      title: "Connect a model",
      body: "Sign in with your Claude or ChatGPT account where the agent supports it, subject to the provider's terms. Or paste an API key, or pay with Hivra credits.",
    },
    {
      n: "3",
      title: "Chat from anywhere",
      body: `Open it in your browser to chat, watch its screen or take over. ${STAYS_ON}.`,
    },
  ],
} as const;

const [ENTRY_SIZE, LARGER_SIZE] = HOSTED_SIZES;

export const PRICING = {
  title: "Free to start.",
  titleTail: `Hosted from ${ENTRY_PLAN_PRICE} a month.`,
  free: {
    name: "Free",
    price: "$0",
    per: "account",
    size: "Your own server, or self-host",
    body: `${FREE_ACCOUNT_SENTENCE} Or run the open-source platform yourself.`,
    cta: "Sign up free",
    href: PUBLIC_START_HREF,
    selfHost: { label: "Self-host from GitHub", href: SELF_HOST_SOURCE_URL },
  },
  cloud: {
    name: PLAN_DISPLAY.entry,
    price: ENTRY_PLAN_PRICE,
    per: "/month",
    size: ENTRY_PLAN_SIZE,
    body: "We run the computer for you. It stays on, with browser access and nothing to maintain.",
    cta: "Get started",
    href: ENTRY_SIZE.href,
  },
  larger: {
    name: PLAN_DISPLAY.larger,
    price: LARGER_PLAN_PRICE,
    per: "/month",
    size: LARGER_PLAN_SIZE,
    body: "For bigger projects and heavier workloads.",
    cta: "Choose this size",
    href: LARGER_SIZE.href,
  },
  /** The paragraph under the offers. The guarantee sentence ends with a link to the terms. */
  aiUsage:
    "The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits. Charges from your AI provider are separate.",
  guarantee: { lead: `Hosted plans carry a ${MONEY_BACK_GUARANTEE}, subject to the`, link: "terms", href: "/terms" },
  full: { label: "Full pricing", href: "/pricing" },
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

export const FAQ_TITLE = "Questions.";

/** The one sentence about tokens on the page. It renders, and enters the FAQPage JSON-LD, only when the token surfaces are visible. */
export const TOKEN_FAQ_SENTENCE = "Token-related access and future plans are explained separately.";

/**
 * The six questions. `showTokenSentence` is `tokenSurfacesVisible(view)` from
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
      a: "Yes. These are supported agent options. Where supported, you sign in with your own account, subject to the provider's terms. The plan does not include AI usage. Claude Code uses your own Claude or Anthropic account, or Hivra credits. For Codex, bring your own account or key, or pay with Hivra credits.",
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
      a: `No. Hivra is open source: you can connect your own server or self-host the whole platform. Some managed agents and capabilities are Hivra Cloud-specific. ${HOSTED_COMPUTE_NEEDS_PLAN_SHORT}`,
    },
    {
      q: "Do I need a token?",
      a: showTokenSentence
        ? `No. You can use card-paid hosting or self-host without one. ${TOKEN_FAQ_SENTENCE}`
        : "No. You can use card-paid hosting or self-host without one.",
    },
  ];
}

/** The questions with the token sentence left out: what every viewer sees by default. */
export const HOMEPAGE_FAQ = homepageFaq(false);

export const CLOSING = {
  title: "Launch your first agent.",
  paid: "Sign up free and connect a computer or server you already have, or launch on Hivra Cloud with a paid plan.",
  primary: "Launch an agent",
} as const;

export const STICKY = {
  cta: "Launch an agent",
  note: "Free to start",
} as const;
