/**
 * The ecosystem map: what Hivra offers today, what is planned next, what comes
 * after that and what is only being researched. One module, so the /ecosystem
 * page, its tests and anything else that names a product (About, llms.txt) read
 * the same stage for the same product.
 *
 * Copy source: Ash's website pack, 05-ecosystem.md (20 October 2026), word for
 * word, except the paid-plan sentence in Agent Computers, which follows the
 * 21 October 2026 rule that every Hivra Cloud computer is paid (plan-facts.ts).
 * `**bold**` runs are kept in the strings and drawn by the page.
 *
 * The statuses mirror LITEPAPER.md ("What we're building around it"). Never
 * move a product between stages here without Ash: ecosystem-map.test.ts reads
 * the litepaper and fails when a product sits in a different group. Being on
 * this map is not the same as being launched; only "Available now" is
 * something a person can use today. No dates, percentages or promises.
 *
 * Client-safe: no server imports.
 */

import { FREE_ACCOUNT_SENTENCE, HOSTED_COMPUTE_NEEDS_PLAN_SHORT } from "@/lib/blog/plan-facts";

export type EcosystemStageId = "available-now" | "next" | "then" | "research";

export interface EcosystemProduct {
  /** Lower case anchor id, for example "gate". */
  slug: string;
  name: string;
  /** The bold line under the name, without markdown. */
  tagline: string;
  /** Body paragraphs. A `**bold**` run is allowed. */
  paragraphs: readonly string[];
}

export interface EcosystemStage {
  id: EcosystemStageId;
  /** The status word: "Available now", "Next", "Then" or "Research". */
  label: string;
  /** What follows the colon in the heading ("Next: Make individual agents..."). Absent for "Available now". */
  title?: string;
  /** The sentence(s) that sit with the heading. */
  intro?: string;
  products: readonly EcosystemProduct[];
}

export const ECOSYSTEM_STAGES: readonly EcosystemStage[] = [
  {
    id: "available-now",
    label: "Available now",
    products: [
      {
        slug: "agent-computers",
        name: "Agent Computers",
        tagline: "A separate place for agents, and people, to work.",
        paragraphs: [
          "Launch supported AI agents on computers away from your personal laptop, or start a computer for yourself. Work through the browser, choose which files and services to connect, and decide whether Hivra hosts the environment or you operate it.",
          `Supported workflows include coding agents, general-purpose agents, browser-accessible environments and ordinary computers. Which desktops, operating systems and agents are available depends on the deployment option. ${HOSTED_COMPUTE_NEEDS_PLAN_SHORT} ${FREE_ACCOUNT_SENTENCE}`,
          "Agent Computers are the foundation. They give a task somewhere to happen without assuming that the agent should have access to everything you own.",
        ],
      },
    ],
  },
  {
    id: "next",
    label: "Next",
    title: "Make individual agents more useful and accountable",
    intro: "These products are planned. They are not currently available simply because they're named here.",
    products: [
      {
        slug: "gate",
        name: "Gate",
        tagline: "Give an agent access to an account without handing it the secret.",
        paragraphs: [
          "Agents need to interact with real services. But a password or API key often grants far more access than a single task requires. Gate is intended to place controls between the agent and the account: only the permitted action, on the permitted resource, for as long as it's needed.",
          "The ambition is to authorise useful work without giving agents unrestricted credentials to keep, copy or reuse. The actual enforcement mechanisms and integrations will need to be designed and tested service by service.",
        ],
      },
      {
        slug: "exchange",
        name: "Exchange",
        tagline: "Find an agent, tool or setup that's worth using.",
        paragraphs: [
          "A place to discover agents, skills, computer configurations and repeatable workflows. The important part isn't only browsing a catalogue; it's knowing what you're installing, who published it and what access it asks for.",
          "Exchange is intended to make useful setups easier to share while giving users enough information to make an informed choice. Publisher checks and security labels are plans, not guarantees for third-party software today.",
        ],
      },
      {
        slug: "arena",
        name: "Arena",
        tagline: "Test an agent before you trust it with more.",
        paragraphs: [
          "Arena is intended as a controlled place to put agents and tools under pressure. Give them difficult or adversarial tasks, test whether their boundaries hold, and keep evidence of what happened.",
          "It would help researchers and builders find failures in a reproducible way, without running those tests against uninvolved people or real production accounts.",
        ],
      },
      {
        slug: "signal",
        name: "Signal",
        tagline: "Turn security findings into warnings people can act on.",
        paragraphs: [
          "Security information isn't much use when it sits in a scattered chat thread or arrives after people have installed the affected tool. Signal aims to collect, verify and share actionable notices about unsafe tools, broken integrations and relevant threats.",
          "The distinction between a report, an investigated finding and a confirmed warning will matter. The goal is useful evidence, not an endless feed of unverified alarms.",
        ],
      },
    ],
  },
  {
    id: "then",
    label: "Then",
    title: "Identity, recovery and shared knowledge",
    intro:
      "These ideas follow the first planned products in the intended sequence. The order may change; none comes with a promised release date.",
    products: [
      {
        slug: "vault",
        name: "Vault",
        tagline: "Answer the question without opening the whole account.",
        paragraphs: [
          "An agent might need to know whether you're free on Tuesday. That doesn't mean it needs your entire calendar, every guest list and the ability to edit events. Vault explores ways to return narrowly scoped answers rather than broad underlying data.",
        ],
      },
      {
        slug: "passport",
        name: "Passport",
        tagline: "A checkable identity for an agent.",
        paragraphs: [
          "Who made it? Which version is running? What permissions does it request? Passport is intended to make those answers discoverable and verifiable, especially when agents and tools move between publishers, machines and services.",
        ],
      },
      {
        slug: "seal",
        name: "Seal",
        tagline: "Security claims backed by evidence.",
        paragraphs: [
          "A badge should mean more than somebody saying a tool is safe. Seal would tie specific claims to specific tests, dates and artefacts. A pass in one test would not become a blanket promise that an agent can never misbehave.",
        ],
      },
      {
        slug: "rescue",
        name: "Rescue",
        tagline: "Know how to stop a problem and recover.",
        paragraphs: [
          "When an agent does something it shouldn't, the first steps should be practical: stop its execution, cut off access, preserve relevant evidence and make recovery possible. Rescue is a proposal for a more coordinated response rather than a claim that every mistake can be undone.",
        ],
      },
      {
        slug: "challenges",
        name: "Challenges",
        tagline: "Reward useful, authorised security research.",
        paragraphs: [
          "Controlled challenges could give researchers permission to find real weaknesses and a clear route for reporting them. The scope and reward mechanics would need to be defined before anyone could treat them as an active programme.",
        ],
      },
      {
        slug: "experience",
        name: "Experience",
        tagline: "Share lessons that can be checked.",
        paragraphs: [
          "An agent may learn a useful workflow or discover a failure pattern. Experience explores how to publish that knowledge with its assumptions, limits and provenance, so another agent or person can decide whether it applies to their own situation.",
        ],
      },
    ],
  },
  {
    id: "research",
    label: "Research",
    title: "Things worth exploring, not yet promises",
    products: [
      {
        slug: "missions",
        name: "Missions",
        tagline: "Several agents, one defined job.",
        paragraphs: [
          "A way to coordinate multiple agents around a shared goal, with a budget, delegated tasks and a clear point at which the work is finished.",
        ],
      },
      {
        slug: "foundry",
        name: "Foundry",
        tagline: "Services operated by agents, with someone accountable.",
        paragraphs: [
          "An exploration of how agents could run useful services while humans remain responsible for what those services do, what they spend and what happens when they fail.",
        ],
      },
      {
        slug: "colony",
        name: "Colony",
        tagline: "Practice worlds for multi-agent behaviour.",
        paragraphs: [
          "Resettable environments where agents can interact, cooperate, fail and be studied without giving their experiments access to real users' systems.",
        ],
      },
      {
        slug: "interchange",
        name: "Interchange",
        tagline: "Budgets an agent can use, but not own.",
        paragraphs: [
          "Scoped allowances for a defined job, with limits, records and the ability for the owner to revoke them. This is about making agent spending controllable rather than assuming a wallet alone makes it safe.",
        ],
      },
      {
        slug: "ports",
        name: "Ports",
        tagline: "Narrow links to the outside world.",
        paragraphs: [
          "Interfaces that expose specific functions of other services or devices without opening everything behind them. The rules and risk model would depend on each integration.",
        ],
      },
    ],
  },
];

/** Every product with the stage it sits in, in map order. */
export const ECOSYSTEM_PRODUCTS: readonly (EcosystemProduct & { stage: EcosystemStageId })[] = ECOSYSTEM_STAGES.flatMap(
  (stage) => stage.products.map((product) => ({ ...product, stage: stage.id })),
);

/** The 15 names, in map order. */
export const ECOSYSTEM_PRODUCT_NAMES: readonly string[] = ECOSYSTEM_PRODUCTS.map((product) => product.name);

/** Anchor id for a product name, or undefined when the name is not on the map. */
export function ecosystemProductSlug(name: string): string | undefined {
  return ECOSYSTEM_PRODUCTS.find((product) => product.name === name)?.slug;
}

/** The stage a product sits in, or undefined when the name is not on the map. */
export function ecosystemStageOf(name: string): EcosystemStageId | undefined {
  return ECOSYSTEM_PRODUCTS.find((product) => product.name === name)?.stage;
}
