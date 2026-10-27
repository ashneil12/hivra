// /ecosystem prose, word for word from Ash's website pack (05-ecosystem.md,
// 20 October 2026). The map itself (stages, products, taglines) is in
// lib/ecosystem-map.ts. `**bold**` runs are kept in the strings and drawn by inline.tsx.
//
// Deviation from the pack, listed in the lane ledger: TOKEN_SECTION.paragraphs[1]
// replaces "Those mechanisms are not the same as features already available in
// Hivra Cloud." That sentence was inaccurate, because compute access for eligible
// holders of the existing token is live. The replacement is the first sentence of
// DORMANT_ACCESS_PARAGRAPH in lib/token-phase-copy.ts plus a proposals sentence.
//
// Everything that names a token, the litepaper or the launchpad concept
// (TOKEN_SECTION, LAUNCHPAD_SECTION and the litepaper link) renders only behind
// TokenSurfaceGate. Keep it out of the intro, the headings and the metadata.

import { LITEPAPER_HREF } from "@/components/public-site/PublicLink";
import { PUBLIC_PROJECT_LINKS } from "@/lib/public-project-links";
import { PUBLIC_START_HREF } from "@/lib/public-start";

const REPOSITORY = PUBLIC_PROJECT_LINKS.repository;

export const INTRO = {
  /** The page opens with one h1 in two lines. */
  titleLead: "Hivra starts with a computer.",
  titleTail: "It doesn't end there.",
  paragraphs: [
    "An AI agent can already write code, use software, browse the web and complete work that would once have needed a person at the keyboard. Giving it a computer of its own is a useful first step.",
    "The harder question is what happens after that. How do you let it use an account without giving it the password? How do you tell whether a tool is safe? How do you find useful software, test it properly and stop something that's going wrong?",
    "Those are the problems behind Hivra's wider ecosystem.",
  ],
  /** Sits in the reading guide beside the intro. */
  guide:
    "This page separates **what you can use now**, **what we intend to build next**, and **ideas still being researched**. Being on the map is not the same as being launched.",
} as const;

export interface EcosystemLink {
  label: string;
  href: string;
}

/** The links under Agent Computers. The first is the button. Hrefs follow the pack. */
export const AGENT_COMPUTERS_LINKS: readonly EcosystemLink[] = [
  { label: "Explore Agent Computers", href: "/" },
  { label: "See the agents", href: "/agents" },
  { label: "Pricing", href: "/pricing" },
];

export const COMPUTER_ROADMAP = {
  heading: "The Agent Computers roadmap continues too",
  paragraph:
    "Alongside the wider ecosystem, we intend to explore an **Orchestrator**, additional computer images including **macOS where technically and legally feasible**, and **custom images**. These are planned additions, not presently supported configurations unless they appear as options in the live product.",
} as const;

export const FIT = {
  heading: "How the pieces fit together",
  intro: "Think of someone installing an agent to run a piece of work:",
  steps: [
    "**Agent Computers** gives it somewhere separate to run.",
    "**Exchange** could help them choose a setup and understand what it requests.",
    "**Gate** could let the agent use a particular account without taking possession of permanent credentials.",
    "**Arena** and **Seal** could provide evidence about what has been tested and under which conditions.",
    "**Signal** could warn when something in that setup turns out to be unsafe.",
    "**Rescue** could help stop access and preserve evidence if it goes wrong.",
    "**Experience**, **Missions** and the longer-term work could make agents more useful together, with clearer boundaries and accountability.",
  ],
  outro: [
    "That's the idea behind the map. Not that every product needs to exist before Hivra is useful, and not that building every one of them is inevitable.",
  ],
} as const;

/** Behind TokenSurfaceGate: the heading, both paragraphs and both links. */
export const TOKEN_SECTION = {
  heading: "What about the token?",
  paragraphs: [
    "Hivra has a separate token ecosystem, with current arrangements and proposed future uses. Some longer-term ideas involve compute, publisher payments, security research and controlled agent budgets.",
    // The pack's "Those mechanisms are not the same as features already available in Hivra Cloud."
    // was inaccurate (compute access for eligible holders is live), so it is replaced here.
    "Eligible $HermesOS holdings are one way to qualify for compute access. The other mechanisms are proposals, not features already available in Hivra Cloud. You can use self-hosted Hivra without a token, and card-paid hosting remains available separately.",
  ],
  links: [
    { label: "Current token information", href: "/token" },
    { label: "Tokenomics and proposals", href: "/tokenomics" },
  ] satisfies readonly EcosystemLink[],
} as const;

/** Behind TokenSurfaceGate. Research only: not a product, a launch or a funding programme. */
export const LAUNCHPAD_SECTION = {
  heading: "What about launching agents with their own tokens?",
  paragraphs: [
    "We're also exploring a longer-term launchpad concept in which creators could launch agent-backed characters and serious AI projects, with Hivra providing the computers and tools to keep them running. A potential builder-support or accelerator programme is part of that early research.",
    "It is **not an available product, announced launch or committed funding programme**. Its economics, regulation, technical design and place in the roadmap need substantially more work. We'll share details when there's a concrete proposal to assess.",
  ],
} as const;

export const FOLLOW = {
  heading: "Follow the work, not just the plan",
  paragraph:
    "The map will change as we learn. The most useful way to judge Hivra is still to try what exists, read the code and watch what actually ships.",
  /**
   * The pack writes the first target as "/". The launch button goes to the real start
   * link (sign up, then Launch asks where it runs). The litepaper link is
   * `/litepaper` in the pack, which is not a route: the real document address is used,
   * and the link renders only behind TokenSurfaceGate.
   */
  launch: { label: "Launch a computer", href: PUBLIC_START_HREF },
  roadmap: { label: "See the roadmap", href: "/roadmap" },
  litepaper: { label: "Read the litepaper", href: LITEPAPER_HREF },
  /** The public repository, from lib/public-project-links.ts. Null (no link) until it is published there. */
  repository: REPOSITORY.status === "published" ? { label: "GitHub", href: REPOSITORY.href } : null,
} as const;
