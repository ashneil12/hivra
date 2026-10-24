import type { FeaturePageContent } from "./types";
import { closingActions } from "./shared";

// /features/persistent-memory. The copy is 06-persistent-memory.md (20 October 2026); deviations are in the lane ledger.

export const PERSISTENT_MEMORY: FeaturePageContent = {
  slug: "persistent-memory",
  seoTitle: "Persistent Memory for AI Agents | Hivra",
  description:
    "Keep a Hermes agent's user notes, task history and reusable skills on a persistent cloud computer, with files you can inspect and export.",
  eyebrow: "Persistent Memory",
  h1: "Pick up where you left off",
  breadcrumb: "Persistent memory",
  lead: {
    heading: "You shouldn't have to explain your whole project every Monday.",
    blocks: [
      {
        kind: "p",
        text: "AI feels considerably less helpful when every new session starts with the same introduction: what you're building, which tools you use, why you made a particular decision and what happened last time.",
      },
      {
        kind: "p",
        text: "Hermes is built to retain useful information between sessions. Hivra gives it a persistent computer and storage, so that information doesn't depend on an open browser tab or a laptop staying awake.",
      },
      {
        kind: "p",
        text: "This is memory you can work with, not a claim that an AI model remembers everything perfectly. The agent still has to save the right information, retrieve it when relevant and correct mistakes when it gets something wrong.",
      },
    ],
  },
  sections: [
    {
      heading: "A long conversation is not the same as memory",
      blocks: [
        {
          kind: "p",
          text: "A large context window helps a model reason over the material in front of it. It does not, by itself, mean yesterday's conversation will be present tomorrow.",
        },
        {
          kind: "p",
          text: "Persistent memory adds a record outside the model's current context. Useful notes and previous work can be stored, searched and brought back into a new session. That means the agent can build on prior decisions without loading every message it has ever seen into every prompt.",
        },
        {
          kind: "p",
          text: "The distinction matters: a model might not recall an obscure fact until the relevant record is found, and a stored fact can be outdated. Treat memory as useful working material, not an infallible source of truth.",
        },
      ],
    },
    {
      heading: "The different kinds of memory Hermes uses",
      blocks: [
        {
          kind: "terms",
          items: [
            {
              term: "About you.",
              text: "A user model can hold your preferences, projects, working conventions and other information you choose to share. In Hermes, `USER.md` is one of the readable files used for this purpose.",
            },
            {
              term: "What the agent has learned.",
              text: "Curated notes in files such as `MEMORY.md` can capture ongoing project facts, decisions and useful context. They are meant to be maintained rather than allowed to grow endlessly.",
            },
            {
              term: "How to do something again.",
              text: "Skill Documents describe repeatable procedures. If an agent learns a reliable approach to a particular format or workflow, it can keep those instructions for similar tasks in the future. Hermes uses the open agentskills.io style for skills.",
            },
            {
              term: "What happened.",
              text: "Past sessions and event records can provide a trail of tasks, outcomes and corrections. Retrieving an earlier action is different from keeping every detail in the current context.",
            },
          ],
        },
        {
          kind: "p",
          text: "Depending on configuration, Hermes also supports integrations such as Honcho for additional user modelling. Those are options, not a claim that every external memory provider is enabled by default.",
        },
      ],
    },
    {
      heading: "Why hosting matters",
      blocks: [
        {
          kind: "p",
          text: "When memory is stored on a laptop, that laptop holds the working history. Move machines, delete the wrong directory or lose a disk, and the agent may lose important context.",
        },
        {
          kind: "p",
          text: "On Hivra, the agent's working files live with its hosted computer. You can return from another device without copying an entire local environment first. The advantage is convenience and continuity, not magic durability: backups and recovery coverage vary, and you should export anything you cannot afford to lose.",
        },
      ],
    },
    {
      heading: "Separate agents, separate context",
      blocks: [
        {
          kind: "p",
          text: "If you run a development agent and a research agent, they do not automatically share the same memory. That helps keep responsibilities clear and reduces accidental mixing of unrelated work.",
        },
        {
          kind: "p",
          text: "Hivra also offers optional account memory, copied into **new Claude Code and Codex agents**. That's a separate setup convenience, not a live shared memory bus. Hermes does not automatically receive those notes, and Hivra does not currently orchestrate agents or synchronise their memories for you.",
        },
        {
          kind: "p",
          text: "When you want two agents to work from the same information, use a deliberate handoff or a shared external source that you control.",
        },
      ],
    },
    {
      heading: "You can correct what the agent remembers",
      blocks: [
        {
          kind: "p",
          text: "One advantage of readable memory files is that mistakes don't have to become permanent. If Hermes has recorded an outdated project preference or wrong assumption, you can ask it to update the relevant note and inspect the result.",
        },
        {
          kind: "p",
          text: "You can download `USER.md` and `MEMORY.md` through the file explorer on supported Hermes deployments. Hivra also offers a JSON export for Claude Code and Codex chats and memory. Those export paths help you retain control if you decide to switch hosting arrangements later.",
        },
        {
          kind: "p",
          text: "Be careful about secrets. Memory files aren't a password vault. HTTPS protects connections in transit, but Hivra does not promise a separate encryption guarantee for every memory file at rest. Don't put credentials or sensitive personal data in general-purpose agent notes.",
        },
      ],
    },
  ],
  faqs: [
    {
      q: "Does Hermes remember absolutely everything?",
      a: "No. It stores and retrieves useful information according to its memory system and configuration. Retrieval can miss things and recorded facts can be wrong.",
    },
    {
      q: "Can I remove or change a memory?",
      a: "Yes. You can ask the agent to correct or delete relevant notes and inspect the files. Check associated logs or backups separately where applicable.",
    },
    {
      q: "Can I export the data?",
      a: "Hivra offers downloadable Hermes memory files and JSON export for supported Claude Code and Codex data. Always keep independent copies of critical work.",
    },
    {
      q: "How long does memory remain?",
      a: "It stays with the agent's computer for as long as that computer exists. Export anything you want to keep before you cancel or delete the computer.",
    },
    {
      q: "Will one agent see another's memory?",
      a: "Not automatically. Shared external services and deliberate handoffs can still expose information if you grant access.",
    },
    {
      q: "Is memory securely encrypted?",
      a: "Hivra uses HTTPS for connections, but does not promise separate encryption at rest for agent memory files.",
    },
    {
      q: "Does memory use more model tokens?",
      a: "Relevant recalled information may add tokens to a prompt. Curated files and search-based retrieval help avoid loading an entire history each time.",
    },
  ],
  actions: closingActions({ label: "Launch an agent", href: "/agents" }, { label: "Explore plans", href: "/pricing" }),
  related: [
    { label: "Multiple agents", href: "/features/multi-agent" },
    { label: "Scheduled tasks", href: "/features/scheduled-tasks" },
    { label: "Browser automation", href: "/features/browser-automation" },
  ],
};
