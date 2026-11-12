// Homepage copy, in one place so the visible page, the FAQPage JSON-LD and the
// copy tests all read the same strings.
//
// The wording is Ash's final homepage and onboarding copy (12 Nov 2026), used
// word for word. Rules that copy keeps (tested in __tests__/home-copy.test.ts):
// - Prices, sizes and the guarantee come from lib/blog/plan-facts.ts and
//   app/pricing/pricing-content.ts, so they move with checkout. The guarantee
//   is always "7-day money-back guarantee on card payments".
// - "Free" never means free compute: the free account runs on a server the
//   person provides and pays for. Every Hivra Cloud computer needs a paid plan.
// - A promised login always carries "subject to the provider's terms".
// - No unlimited or counted agents, no speed promises, no complete-security
//   claim, no public open-source release until it is verified, and no starter
//   credit until it is active.
// - Agents keep their own interfaces; nothing promises a generic chat.

import {
  ENTRY_PLAN_PRICE,
  ENTRY_PLAN_SIZE,
  LARGER_PLAN_PRICE,
  LARGER_PLAN_SIZE,
  MONEY_BACK_GUARANTEE,
  PLAN_DISPLAY,
} from "@/lib/blog/plan-facts";
import { HOSTED_SIZES, SELF_HOST_SOURCE_URL } from "@/app/pricing/pricing-content";
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

/**
 * The homepage and onboarding wording is Ash's final copy of 12 Nov 2026,
 * used word for word. Change it only with Ash's sign-off.
 */

/** The first screen. */
export const HERO = {
  titleLead: "Give your",
  titleWord: "AI agent",
  titleTail: "a computer of its own.",
  subhead:
    "Run Claude Code, Codex, Hermes and other AI agents on computers separate from your own. Keep your work running when your laptop is closed, access it from anywhere, and give your agents the tools they need without putting your personal computer at risk.",
  primary: "Launch an agent",
  secondary: "See how Hivra works",
  secondaryHref: "#how",
  /** Three short trust points under the buttons, in this order (one icon each in Hero.tsx). */
  proof: ["Your agent's own computer", "Bring your own AI key", "Run on Hivra Cloud or your own infrastructure"],
} as const;

/** Straight under the hero: why the agent gets a computer of its own. */
export const SEPARATE = {
  title: "Your agent needs computer access.",
  titleTail: "It doesn't need your computer.",
  paragraphs: [
    "AI agents can browse the web, run commands, install software, access files and make changes on your behalf.",
    "That's what makes them useful. It's also why you should think carefully about where they run.",
    "Your personal computer holds far more than the work you've asked an agent to do. It holds your files, browser sessions, credentials and access to other systems.",
    "Hivra gives your agent a separate computer for its work. Your own computer stays separate, while you can still access the agent, see what it's doing and take control when needed.",
    "You shouldn't have to choose between giving an agent the tools it needs and keeping your own computer separate.",
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

export interface HomeAgent {
  id: "claude-code" | "codex" | "hermes" | "openclaw" | "agent-zero";
  name: string;
  role: string;
  line: string;
  /** A second paragraph under the line, such as how the agent signs in. */
  detail?: string;
  /** A limit worth seeing before the click, shown in italics under the description. */
  note?: string;
  /** A short label on the card's top edge. Only the one agent most people should start with carries it. */
  badge?: string;
  href: string;
  /** Illustrative activity for the card's small screen. */
  screen: string[];
}

export const AGENTS_SECTION = {
  title: "Choose your agent.",
  titleTail: "We'll give it a computer.",
  intro: "Different agents are good at different things. Pick the one that works best for you, and Hivra gives it a computer to run on.",
  compare: "Compare agents",
  screensNote: "Card screens are illustrations.",
} as const;

export const HOME_AGENTS: HomeAgent[] = [
  {
    id: "hermes",
    name: "Hermes Agent",
    role: "Research and automation",
    line: "Research topics, browse the web, work with tools, write, automate recurring tasks and remember useful context across conversations.",
    badge: "Recommended",
    href: buildLaunchHref({ start: true, profile: "hermes" }),
    screen: ["hermes › compare these pages", "reading the sources", "✓ Saved notes/pricing.md"],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    role: "Coding with Claude",
    line: "Build applications, work with existing projects, fix bugs, run tests and make changes to code without running Claude Code directly on your personal computer.",
    detail: "Sign in with your Claude account, subject to the provider's terms, or use Hivra credits where supported.",
    href: buildLaunchHref({ start: true, profile: "claude-code" }),
    screen: ["> fix the flaky auth test", "● Editing src/auth.ts", "✓ Tests pass"],
  },
  {
    id: "codex",
    name: "OpenAI Codex",
    role: "Coding with Codex",
    line: "Write, review, debug and test code in a dedicated environment. Work on software projects without giving the agent direct access to your personal computer.",
    detail: "Sign in with your ChatGPT account, subject to the provider's terms, or use a supported API key.",
    href: buildLaunchHref({ start: true, profile: "codex" }),
    screen: ["› add rate limiting", "• Writing middleware/limit.ts", "✓ Ready for review"],
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    role: "Your agent in your messaging apps",
    line: "Run an AI agent you can communicate with through supported messaging platforms, while its work happens on a separate computer.",
    href: buildLaunchHref({ start: true, profile: "openclaw" }),
    screen: ["openclaw › sort today's messages", "drafting replies", "✓ Waiting for you"],
  },
  {
    id: "agent-zero",
    name: "Agent Zero",
    role: "For more involved tasks",
    line: "Give it a complex task and let it work through the steps using its available tools. Follow its progress and inspect the results.",
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

/** How it works: four steps, with where it runs as its own step. */
export const STEPS = {
  title: "Your agent's computer,",
  titleTail: "without the complicated setup.",
  steps: [
    {
      n: "1",
      title: "Choose your agent",
      body: "Pick Hermes, Claude Code, Codex or another supported agent. Each gets its own computer, files and working environment.",
    },
    {
      n: "2",
      title: "Connect its AI",
      body: "Use Hivra credits or connect a supported API key. Some agents also let you sign in with your existing Claude or ChatGPT account, subject to the provider's terms.",
    },
    {
      n: "3",
      title: "Choose where it runs",
      body: "Use Hivra Cloud and we'll handle the infrastructure, or connect a supported server you already manage.",
    },
    {
      n: "4",
      title: "Launch and get to work",
      body: "Open your agent from your browser and use its supported interface. Your work and environment remain on the agent's computer, even when you close your laptop.",
    },
  ],
} as const;

const [ENTRY_SIZE, LARGER_SIZE] = HOSTED_SIZES;

export const PRICING = {
  title: "Your agent's computer.",
  titleTail: "Your choice of where it runs.",
  lead: ["Run it on Hivra Cloud, or use infrastructure you already control.", `Hivra Cloud starts at ${ENTRY_PLAN_PRICE}/month.`],
  cloud: {
    name: PLAN_DISPLAY.entry,
    tagline: `Managed hosting | From ${ENTRY_PLAN_PRICE}/month`,
    price: ENTRY_PLAN_PRICE,
    per: "/month",
    size: ENTRY_PLAN_SIZE,
    body: [
      "We provide and maintain the computer for you.",
      "Your agent gets a dedicated working environment that stays available when your laptop is closed. Access it from your browser without managing the underlying server.",
    ],
    cta: "Get started with Hivra Cloud",
    href: ENTRY_SIZE.href,
    note: `${MONEY_BACK_GUARANTEE}.`,
  },
  larger: {
    name: PLAN_DISPLAY.larger,
    tagline: "Additional computing resources",
    price: LARGER_PLAN_PRICE,
    per: "/month",
    size: LARGER_PLAN_SIZE,
    body: [
      "For agents and workloads that need more processing power, memory or storage.",
      "Choose a larger computer as your requirements grow.",
    ],
    cta: "Compare plans",
    href: "/pricing",
  },
  free: {
    name: "Your own server",
    tagline: "No Hivra hosting charge",
    body: [
      "Already have a server? Connect a supported Proxmox VE environment and run compatible agents using infrastructure you control.",
      "You provide and maintain the server. Hivra doesn't charge you for hosting it.",
      "You can also self-host the open-source platform independently, once using a supported public release.",
      "Hermes currently requires Hivra Cloud through the hosted service.",
    ],
    cta: "Connect your server",
    href: PUBLIC_START_HREF,
  },
  /** Kept for the larger size's checkout link, which the pricing page uses. */
  largerCheckoutHref: LARGER_SIZE.href,
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

export const FAQ_TITLE = "Frequently asked questions";

/** Kept for callers that still pass it; no homepage question mentions a token any more. */
export const TOKEN_FAQ_SENTENCE = "Token-related access and future plans are explained separately.";

/**
 * The questions, in order. An answer's paragraphs are separated by a blank
 * line; the page shows each as its own paragraph. `showTokenSentence` is
 * accepted for compatibility and changes nothing.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function homepageFaq(_showTokenSentence = false): { q: string; a: string }[] {
  return [
    {
      q: "Is Hivra free?",
      a: [
        "Creating a Hivra account is free.",
        "You can connect supported infrastructure you own without paying Hivra for hosting. You'll still be responsible for the cost and maintenance of that infrastructure.",
        `Hivra Cloud is our managed option, starting at ${ENTRY_PLAN_PRICE} per month. Every Hivra Cloud computer requires a paid plan.`,
        "Some agents, including Hermes, currently require Hivra Cloud through the hosted service.",
      ].join("\n\n"),
    },
    {
      q: "Do I need my own server?",
      a: [
        "No. Hivra Cloud provides the computer and handles the infrastructure for you.",
        "If you already have compatible infrastructure, you can connect that instead.",
      ].join("\n\n"),
    },
    {
      q: "Do I need an API key?",
      a: [
        "Not necessarily.",
        "You can use Hivra credits, connect a supported model provider's API key, or sign in with an eligible Claude or ChatGPT account where the agent supports it, subject to the provider's terms.",
      ].join("\n\n"),
    },
    {
      q: "Will my agent keep running if I close my laptop?",
      a: [
        "Yes, provided its computer remains running.",
        "The agent's files and environment stay on its computer rather than your laptop. Scheduled and background work depends on the agent's capabilities and configuration.",
      ].join("\n\n"),
    },
    {
      q: "Is my agent completely isolated and secure?",
      a: [
        "Hivra gives agents separate computing environments so they don't need to run directly on your personal computer.",
        "This reduces direct exposure to your local files and accounts, but no environment can guarantee complete security. What an agent can access also depends on the credentials, networking, permissions and integrations you give it.",
      ].join("\n\n"),
    },
    {
      q: "Can I use my own Claude or ChatGPT subscription?",
      a: [
        "Where the selected agent supports account sign-in, you can use an eligible provider account, subject to that provider's terms.",
        "You can also use supported API keys or Hivra credits, depending on the agent.",
      ].join("\n\n"),
    },
    {
      q: "Is Hivra open source?",
      a: [
        "Hivra is being developed as an open-source platform, with the aim of letting people operate the functional platform on infrastructure they control.",
        "The public repository and supported self-hosting instructions will be provided when the release is ready.",
      ].join("\n\n"),
    },
  ];
}

/** What every viewer sees. */
export const HOMEPAGE_FAQ = homepageFaq(false);

export const CLOSING = {
  title: "Your agent doesn't need to run on your computer.",
  paragraphs: [
    "Give it a computer of its own, keep your work separate, and access it wherever you are.",
    `Launch on Hivra Cloud from ${ENTRY_PLAN_PRICE}/month, with a ${MONEY_BACK_GUARANTEE}.`,
    "Or connect supported infrastructure you already control.",
  ],
  primary: "Launch an agent",
  secondary: "Use my own server",
  secondaryHref: PUBLIC_START_HREF,
} as const;

export const STICKY = {
  cta: "Launch an agent",
  note: `Hivra Cloud from ${ENTRY_PLAN_PRICE}/month`,
} as const;
