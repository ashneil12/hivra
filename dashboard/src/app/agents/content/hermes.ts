// /agents/hermes. Wording from Ash's batch 02 file 06-hermes.md, with the edits listed in the lane
// ledger. Hermes runs on Hivra Cloud only (lib/launch/contracts.ts, ownServer false) and can be
// paid for with a key it supports or with Hivra credits (lib/launch/model-access.ts).

import { fill } from "./shared";
import type { AgentPageContent } from "./types";

export const HERMES_CONTENT: AgentPageContent = {
  slug: "hermes",
  h1: "A place for your Hermes agent to live.",
  lead: [
    "There's a difference between asking an AI for help once and having an agent that remembers the project, develops useful skills and comes back to the work tomorrow.",
    "Hermes, the open-source agent from Nous Research, is designed for the second kind of relationship. Hivra gives it a managed computer where its workspace, memory and scheduled jobs can remain available after you log off.",
  ],
  heroLinks: [
    { label: "Deploy Hermes", target: "deploy" },
    { label: "See pricing", target: "pricing" },
  ],
  sections: [
    {
      heading: "More than a one-off conversation",
      blocks: [
        {
          kind: "prose",
          paragraphs: [
            "Hermes is a general-purpose agent you can shape around your own work. You can ask it to research a subject, build something in its workspace, use its tools or run a recurring task on a schedule. As you work together, it can save context and skills rather than starting from a blank slate each time.",
            "That persistence is valuable only if the agent has somewhere to keep it. Hivra provisions a private VM for Hermes, with durable workspace storage and a practical set of interfaces for talking to the agent and inspecting what it is doing.",
            fill("{aiNote} With your own key, the usage belongs to that provider account."),
          ],
        },
      ],
    },
    {
      heading: "What you can build with Hermes",
      blocks: [
        {
          kind: "terms",
          items: [
            {
              term: "A recurring research assistant.",
              text: "Schedule the agent to revisit a topic, prepare a briefing and preserve the context of earlier work.",
            },
            {
              term: "An agent that develops its own toolkit.",
              text: "Install or create skills for repeatable tasks, then reuse them instead of explaining every step again. Review new skills before giving them sensitive access.",
            },
            {
              term: "A project companion.",
              text: "Keep notes, files and work in one environment, with memory that lasts between visits. The usefulness of that memory still depends on how Hermes stores and retrieves it.",
            },
            {
              term: "A practical automation worker.",
              text: "Use cron and available integrations for routine jobs, so that you aren't relying on your laptop staying open.",
            },
          ],
        },
      ],
    },
    {
      heading: "What Hivra adds",
      blocks: [
        {
          kind: "list",
          items: [
            "A managed VM that stays available on paid plans.",
            "Persistent storage for the agent's workspace and memory.",
            "Chat, terminal, files and skills views around the underlying agent.",
            "Access to browser tools and scheduled execution supported by Hermes.",
            "A simpler deployment path than manually configuring the server and services yourself.",
          ],
        },
        {
          kind: "prose",
          paragraphs: [
            "This remains the open-source Hermes project. Hivra hosts it and adds the surrounding operating environment; it doesn't claim ownership of the agent or the model you choose.",
          ],
        },
      ],
    },
    {
      heading: "Set up your Hermes agent",
      blocks: [
        {
          kind: "steps",
          steps: [
            {
              title: "Choose Hermes",
              paragraphs: [
                fill(
                  "Open Hivra's launch flow with Hermes selected, give the agent a name and choose a plan. {paidShort} Hermes runs on Hivra Cloud only. The entry option is **{entry}**, with **{larger}**.",
                ),
              ],
            },
            {
              title: "Get your computer",
              paragraphs: [
                "Hivra provisions the VM and brings the agent environment online. You don't need to begin by renting a VPS, configuring Docker or dealing with a reverse proxy.",
              ],
            },
            {
              title: "Connect a model provider",
              paragraphs: [
                "Enter the key for a model provider Hermes supports, or pay with Hivra credits. With your own key, model use is charged by your provider under its terms. Choose a key with appropriate spending limits, particularly if the agent will be running unattended.",
              ],
            },
            {
              title: "Give it a first job",
              paragraphs: [
                "Start with a project that has a clear outcome. Inspect what Hermes creates, then consider adding schedules, memory rules or skills that make it more useful over time.",
              ],
            },
          ],
        },
      ],
    },
    {
      heading: "Hosting versus self-hosting",
      blocks: [
        {
          kind: "prose",
          paragraphs: [
            "You can run Hermes yourself. If you already have a server and want complete control over the machine, that's a legitimate option. You'll maintain the hosting environment, keep services reachable and handle updates when something breaks.",
            "On Hivra, we do the infrastructure work and give you an accessible workspace around the agent. You still choose its model provider, skills and integrations. And you still need to decide what information and credentials it's safe to give it.",
          ],
        },
      ],
    },
  ],
  faqs: [
    {
      q: "Does Hermes remember earlier sessions?",
      a: "Hermes supports persistent memory, and the Hivra computer provides storage that survives normal logouts. Memory isn't a promise that every detail will always be recalled correctly; the agent's memory system determines what is retained and retrieved.",
    },
    {
      q: "Can Hermes run while I'm asleep?",
      a: "Yes. On a paid computer, the agent stays available and correctly configured scheduled tasks can execute while you're offline. External API limits and task failures can still affect results.",
    },
    {
      q: "Do I bring my own model key?",
      a: fill(
        "Yes. The current setup is built around a supported model provider you connect. {aiNote} Hivra does not add a markup to your own provider's usage; confirm your provider's own rates and limits.",
      ),
    },
    {
      q: "What does hosting cost?",
      a: fill("{paidShort} The entry option is {entry}, or {larger}, plus your model usage. {refund}"),
    },
    {
      q: "Is Hermes developed by Hivra?",
      a: "No. Hermes is an open-source project from Nous Research. Hivra independently hosts it and provides the computer and management surfaces.",
    },
    {
      q: "Can Hermes safely have all my logins?",
      a: "Giving any autonomous agent unrestricted access to important accounts is risky. Use separate accounts or narrowly scoped credentials when possible, set spending and action limits, and keep sensitive operations subject to your review. A private VM is a boundary between environments, not proof that the underlying agent cannot misuse a credential.",
    },
    {
      q: "Can I operate Hivra on my own hardware?",
      a: fill(
        "The Hivra platform is open source. You can explore [self-hosting]({repo}) if you would rather manage the computer and its infrastructure yourself.",
      ),
    },
  ],
  closing: {
    heading: "Give Hermes a home, then let it grow with the work.",
    links: [
      { label: "Deploy Hermes", target: "deploy" },
      { label: "Explore plans", target: "pricing" },
      { label: "See other agents", target: "agents" },
    ],
  },
  affiliation: "Hivra is independent and is not affiliated with or endorsed by Nous Research.",
  related: {
    heading: "Related",
    slugs: ["claude-code", "codex", "openclaw", "aeon", "agent-zero"],
  },
};
