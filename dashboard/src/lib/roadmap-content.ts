// Copy for /roadmap, from the approved page copy: what exists today, what comes next,
// what comes after that, and what is still research. It is a map of direction, not a
// release calendar, so nothing here carries a date or a promise of one.
//
// Inline marks use the grammar in lib/inline-copy.tsx (**bold**, [label](href)); a
// {name} link target is resolved by the page (the start link, the litepaper, the
// repository).
//
// Token copy. The page is shown to everyone, and the token surfaces are off for most
// viewers (the HIVRA_NEW_TOKEN_SURFACES switch, and the UK geo list when it is on). So a
// sentence about the tokens, the migration, the snapshot, the litepaper or the launchpad
// is written as `{ token, plain? }`: `token` shows only when the surfaces are visible,
// and `plain` (when there is one) is what everyone else reads in its place. A block marked
// `token: true` is left out entirely for everyone else. `resolveRoadmap(false)` is what a
// hidden viewer gets, and roadmap-content.restricted.test.ts reads it word by word.
//
// The only token words a hidden viewer can read are the short "you do not need a token"
// negations listed in ROADMAP_NEGATIONS.
//
// Product definitions. What this page says Arena, Signal, Vault, Challenges, Experience, Foundry,
// Interchange and the Orchestrator are follows the ecosystem map (lib/ecosystem-map.ts, which a test pins to
// the litepaper; the Orchestrator sentence is app/ecosystem/ecosystem-content.ts). Use the map's
// words, shortened, never a different idea of the product. app/roadmap/__tests__/ecosystem-alignment.test.ts
// reads both and fails when they drift apart.

/** The public repository. The page says "open source" and links here; it never names the licence. */
export const ROADMAP_REPOSITORY_URL = "https://github.com/ashneil12/hivra";

export type Sentence = string | { readonly token: string; readonly plain?: string };
/** A paragraph, or a list of sentences joined with a space (so one can be token copy). */
export type Paragraph = Sentence | readonly Sentence[];

export interface RoadmapAction {
  label: string;
  /** A route, or a {start} / {litepaper} placeholder the page resolves. */
  href: string;
  kind: "primary" | "secondary";
  /** Shown only when the token surfaces are visible. */
  token?: true;
}

export type RoadmapBlock =
  | { kind: "text"; text: Paragraph }
  | { kind: "terms"; items: readonly string[] }
  | { kind: "topic"; id: string; heading: string; token?: true; paragraphs: readonly Paragraph[] };

export type RoadmapStageId = "today" | "next" | "then" | "research";

export interface RoadmapStage {
  id: RoadmapStageId;
  heading: string;
  blocks: readonly RoadmapBlock[];
}

export interface RoadmapSection {
  id: string;
  heading: string;
  paragraphs: readonly Paragraph[];
  actions?: readonly RoadmapAction[];
}

/**
 * The three sentences that say a token is not needed. They are the one token wording a viewer
 * who cannot see the token surfaces still reads; they use "a token", never a ticker.
 */
export const ROADMAP_NEGATIONS = [
  "Self-hosting does not require a Hivra account or a token.",
  "Neither using a card nor trying the self-host preview requires you to participate in a token.",
  "You can inspect the work, try the self-host preview, report problems and contribute ideas without having to buy a token.",
] as const;

// UNVERIFIED: this sentence says the snapshot has been taken. It has not been taken yet, so it
// is token copy (hidden while the surfaces are off) and must be checked, or reworded, on the day
// the HIVRA_NEW_TOKEN_SURFACES switch is turned on.
const SNAPSHOT_SENTENCE =
  "The snapshot has already been completed as of 20 October 2026; qualifying holders claim through Sablier, pay the applicable claim fee and are not required to burn legacy tokens.";

export interface RoadmapContent {
  masthead: { heading: string; paragraphs: readonly Paragraph[]; actions: readonly RoadmapAction[] };
  stages: readonly RoadmapStage[];
  history: RoadmapSection;
  progress: RoadmapSection;
  closing: RoadmapSection;
}

export const roadmapContent: RoadmapContent = {
  masthead: {
    heading: "The Hivra roadmap.",
    paragraphs: [
      "Hivra started with a simple problem: useful AI agents need somewhere reliable to work. A laptop that goes to sleep, a terminal you cannot safely leave running or a server you have to configure yourself can turn a promising agent into another maintenance task.",
      "We began by making it easier to give an agent its own computer. Now we're working towards the infrastructure those agents will need as they become more capable, connected and useful.",
      "This roadmap separates **what you can use**, **what we're building towards** and **what we're still researching**. It isn't a release calendar. Research directions can change, projects can be dropped and some things will take longer than we'd like.",
    ],
    actions: [
      { label: "Get started", href: "{start}", kind: "primary" },
      { label: "Explore the ecosystem", href: "/ecosystem", kind: "secondary" },
      { label: "Read the litepaper", href: "{litepaper}", kind: "secondary", token: true },
    ],
  },
  stages: [
    {
      id: "today",
      heading: "Available today",
      blocks: [
        {
          kind: "topic",
          id: "agent-computers",
          heading: "Agent Computers",
          paragraphs: [
            "Deploy a computer for an AI agent or for your own use. Choose from supported agent experiences including Hermes, Claude Code, Codex, Agent Zero and OpenClaw, or begin with a general-purpose computer.",
            "A persistent computer gives your tools, files and sessions somewhere to live between connections. It doesn't make individual agent tasks infallible, and each framework still has its own capabilities and limitations.",
          ],
        },
        {
          kind: "topic",
          id: "choose-where-it-runs",
          heading: "Choose where it runs",
          paragraphs: [
            [
              // Hivra Cloud and connecting a server you already have are plainly available: a free account is defined
              // as "bring your own computer", so it needs the connect flow to be a working product. That is true only
              // if the release that ships this copy includes the connect flow. ROADMAP.md still lists it as "On
              // Canary, not yet on hivra.cloud" (the "Where things stand" paragraph, lines 22 to 24, and the Slice 3
              // row), so ecosystem-alignment.test.ts keeps reading that line: when it changes, confirm this sentence.
              // Self-hosting the whole platform stays a preview (README.md headlines "Self-host preview"), as does
              // every other mention of it on this page, including ROADMAP_NEGATIONS.
              "Hivra Cloud is where Hivra runs computers for you, on a paid plan. You can also connect a server you already have, and a free account is enough for that. Self-hosting the whole platform is a preview.",
              ROADMAP_NEGATIONS[0],
            ],
          ],
        },
        {
          kind: "topic",
          id: "tools-around-the-computer",
          heading: "The tools around the computer",
          paragraphs: [
            "Depending on the framework and configuration, existing capabilities include terminals, agent interfaces, logs, monitoring, skills, memory, scheduled tasks and provider-key configuration. Check each [agent page](/agents) for what is actually supported.",
          ],
        },
        {
          kind: "topic",
          id: "a-straightforward-way-to-pay",
          heading: "A straightforward way to pay",
          paragraphs: [
            [
              {
                token: "Hivra Cloud has ordinary subscription pricing as well as the token-related access arrangements described on the billing and token pages.",
                plain: "Hivra Cloud has ordinary subscription pricing.",
              },
              ROADMAP_NEGATIONS[1],
            ],
            [
              { token: "During the migration from $HermesOS to $HIVRA, eligibility and claim instructions belong on the dedicated token pages." },
              { token: SNAPSHOT_SENTENCE },
            ],
          ],
        },
      ],
    },
    {
      id: "next",
      heading: "Next: make the computer easier to trust and easier to use",
      blocks: [
        {
          kind: "topic",
          id: "gate",
          heading: "Gate: clearer authority for agents",
          paragraphs: [
            "An agent should be able to do its job without holding unlimited access to everything you own. Gate is the proposed layer for understanding and controlling permissions, approving consequential actions and making boundaries easier to manage.",
            "This is a product direction, not a claim that every agent action is already governed by Gate.",
          ],
        },
        {
          kind: "topic",
          id: "exchange",
          heading: "Exchange: find and share what works",
          paragraphs: [
            "A place to discover, distribute and eventually publish agents, tools, skills and working configurations. The goal is to make getting value from an agent easier than assembling the same setup from scratch.",
          ],
        },
        {
          kind: "topic",
          id: "arena",
          heading: "Arena: test before you trust",
          paragraphs: [
            "Agents can be impressive in demonstrations and disappointing in real use. Arena is intended as a controlled place to put agents and tools under pressure: difficult or adversarial tasks, a check on whether their boundaries hold and evidence of what happened, rather than a polished demo.",
          ],
        },
        {
          kind: "topic",
          id: "signal",
          heading: "Signal: security warnings you can act on",
          paragraphs: [
            "Security information isn't much use when it sits in a scattered chat thread or arrives after people have installed the affected tool. Signal aims to collect, verify and share actionable notices about unsafe tools, broken integrations and relevant threats. The goal is useful evidence, not an endless feed of unverified alarms.",
          ],
        },
      ],
    },
    {
      id: "then",
      heading: "Then: the supporting pieces",
      blocks: [
        {
          kind: "text",
          text: "These areas extend the same idea, but they need more design, testing and prioritisation before they become product commitments.",
        },
        {
          kind: "terms",
          items: [
            "**Vault:** narrowly scoped answers to a question, without opening the whole account behind it.",
            "**Passport:** portable identity and provenance for agents and their work.",
            "**Seal:** evidence and assurance around what a tool or agent has actually been tested for.",
            "**Rescue:** recovery paths when an agent breaks its environment or makes a mess.",
            "**Challenges:** could reward authorised security research, giving researchers permission to find real weaknesses and a clear route for reporting them.",
            "**Experience:** explores how to share lessons an agent has learned, with their assumptions, limits and provenance, so another agent or person can decide whether they apply.",
          ],
        },
        { kind: "text", text: "These concepts are connected, but they do not all have to launch together." },
      ],
    },
    {
      id: "research",
      heading: "Research: where this could lead",
      blocks: [
        { kind: "text", text: "Some of the most interesting questions are still open." },
        {
          kind: "text",
          text: "**Missions** explores giving agents complex objectives with clear scope and accountability. **Foundry** looks at how agents could run useful services while humans remain responsible for what those services do, what they spend and what happens when they fail. **Colony** considers what happens when several agents cooperate rather than simply coexist. **Interchange** explores scoped allowances for a defined job, with limits, records and the ability for the owner to revoke them. **Ports** considers connections with tools and services beyond Hivra.",
        },
        {
          kind: "text",
          text: "We also intend to explore an Orchestrator, a single place to talk to all your agents and hand work between them, alongside additional computer images including macOS where technically and legally feasible, and custom images. These are planned additions, not presently supported configurations. Availability, licensing, cost and safety are unresolved considerations.",
        },
        {
          kind: "topic",
          id: "launchpad",
          heading: "A possible launchpad and builder programme",
          token: true,
          paragraphs: [
            "We are researching a separate concept that would let creators launch AI-backed characters and projects, potentially alongside their own tokens. Hivra could provide the actual computing infrastructure behind those launches, with revenue from launch services helping support further development and, eventually, promising AI builders.",
            "It is **not a live product or committed launch**. The mechanics, funding model, safeguards and legal requirements still need substantial work. We plan to revisit it after the current launch.",
          ],
        },
      ],
    },
  ],
  history: {
    id: "original-plan",
    heading: "What happened to the original 2026 plan?",
    paragraphs: [
      [
        {
          token:
            "The first roadmap, written in April 2026 when the project was moving out of HermesOS, described a wider agent operating system, operator packs, a Hive Mind intelligence layer, token payments and an agent marketplace.",
          plain:
            "The first roadmap, written in April 2026 when the project was moving out of HermesOS, described a wider agent operating system, operator packs, a Hive Mind intelligence layer and an agent marketplace.",
        },
      ],
      [
        "Some of those ideas evolved into the current architecture.",
        {
          token:
            "Others remain research questions, and some original token assumptions no longer apply. In particular, the April roadmap's Bankr-linked token descriptions are **historical**, not instructions for the present migration.",
          plain: "Others remain research questions.",
        },
      ],
      "We are keeping that earlier document as part of the project's history rather than pretending the plan never changed.",
    ],
  },
  progress: {
    id: "how-to-read-progress",
    heading: "How to read progress",
    paragraphs: [
      "A feature belongs in the 'available' category only when people can actually use it. Research, prototype work and design documents are not the same as a released product.",
      [
        "For shipped changes, visit the [changelog](/changelog). For the live state of Hivra's public pages, visit [status](/status).",
        { token: "For the broader reasoning and longer-term vision, read the [litepaper]({litepaper})." },
      ],
    ],
  },
  closing: {
    id: "build-with-us",
    heading: "Build with us",
    paragraphs: [
      ["Hivra is [open source]({repository}).", ROADMAP_NEGATIONS[2]],
    ],
    actions: [
      { label: "Explore Hivra", href: "/about", kind: "secondary" },
      { label: "Start a computer", href: "{start}", kind: "primary" },
    ],
  },
};

export interface ResolvedTopic {
  id: string;
  heading: string;
  paragraphs: string[];
}

export type ResolvedBlock =
  | { kind: "text"; text: string }
  | { kind: "terms"; items: string[] }
  | ({ kind: "topic" } & ResolvedTopic);

export interface ResolvedStage {
  id: RoadmapStageId;
  heading: string;
  blocks: ResolvedBlock[];
}

export interface ResolvedSection {
  id: string;
  heading: string;
  paragraphs: string[];
  actions: RoadmapAction[];
}

export interface ResolvedRoadmap {
  masthead: { heading: string; paragraphs: string[]; actions: RoadmapAction[] };
  stages: ResolvedStage[];
  history: ResolvedSection;
  progress: ResolvedSection;
  closing: ResolvedSection;
}

function isSentenceList(value: Paragraph): value is readonly Sentence[] {
  return Array.isArray(value);
}

function resolveSentence(sentence: Sentence, visible: boolean): string | null {
  if (typeof sentence === "string") return sentence;
  return visible ? sentence.token : (sentence.plain ?? null);
}

function resolveParagraph(paragraph: Paragraph, visible: boolean): string | null {
  const sentences = isSentenceList(paragraph) ? paragraph : [paragraph as Sentence];
  const kept = sentences.map((sentence) => resolveSentence(sentence, visible)).filter((text): text is string => text !== null);
  return kept.length ? kept.join(" ") : null;
}

function resolveParagraphs(paragraphs: readonly Paragraph[], visible: boolean): string[] {
  return paragraphs.map((paragraph) => resolveParagraph(paragraph, visible)).filter((text): text is string => text !== null);
}

function resolveActions(actions: readonly RoadmapAction[] | undefined, visible: boolean): RoadmapAction[] {
  return (actions ?? []).filter((action) => visible || !action.token).map((action) => ({ ...action }));
}

function resolveSection(section: RoadmapSection, visible: boolean): ResolvedSection {
  return {
    id: section.id,
    heading: section.heading,
    paragraphs: resolveParagraphs(section.paragraphs, visible),
    actions: resolveActions(section.actions, visible),
  };
}

/**
 * The roadmap as one viewer may read it. `visible` is tokenSurfacesVisible(view): the switch is on
 * and the viewer is not in a listed country. When it is false every token sentence is replaced by its
 * plain wording or left out, and a token-only block is dropped.
 */
export function resolveRoadmap(visible: boolean): ResolvedRoadmap {
  const stages: ResolvedStage[] = roadmapContent.stages.map((stage) => ({
    id: stage.id,
    heading: stage.heading,
    blocks: stage.blocks.flatMap((block): ResolvedBlock[] => {
      if (block.kind === "terms") return [{ kind: "terms", items: [...block.items] }];
      if (block.kind === "text") {
        const text = resolveParagraph(block.text, visible);
        return text === null ? [] : [{ kind: "text", text }];
      }
      if (block.token && !visible) return [];
      const paragraphs = resolveParagraphs(block.paragraphs, visible);
      return paragraphs.length ? [{ kind: "topic", id: block.id, heading: block.heading, paragraphs }] : [];
    }),
  }));

  return {
    masthead: {
      heading: roadmapContent.masthead.heading,
      paragraphs: resolveParagraphs(roadmapContent.masthead.paragraphs, visible),
      actions: resolveActions(roadmapContent.masthead.actions, visible),
    },
    stages: stages.filter((stage) => stage.blocks.length > 0),
    history: resolveSection(roadmapContent.history, visible),
    progress: resolveSection(roadmapContent.progress, visible),
    closing: resolveSection(roadmapContent.closing, visible),
  };
}

/** Every string the resolved roadmap shows or links to, for scans. */
export function roadmapStrings(roadmap: ResolvedRoadmap): string[] {
  const out: string[] = [roadmap.masthead.heading, ...roadmap.masthead.paragraphs];
  const actions = (list: RoadmapAction[]) => list.flatMap((action) => [action.label, action.href]);
  out.push(...actions(roadmap.masthead.actions));
  for (const stage of roadmap.stages) {
    out.push(stage.heading);
    for (const block of stage.blocks) {
      if (block.kind === "text") out.push(block.text);
      else if (block.kind === "terms") out.push(...block.items);
      else out.push(block.heading, ...block.paragraphs);
    }
  }
  for (const section of [roadmap.history, roadmap.progress, roadmap.closing]) {
    out.push(section.heading, ...section.paragraphs, ...actions(section.actions));
  }
  return out;
}
