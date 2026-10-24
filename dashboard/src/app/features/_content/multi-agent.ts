import type { FeaturePageContent } from "./types";
import { ENTRY_SIZE_PROSE, LARGER_SIZE_PROSE, closingActions } from "./shared";

// /features/multi-agent. The copy is 03-multi-agent.md (20 October 2026); deviations are in the lane ledger.

export const MULTI_AGENT: FeaturePageContent = {
  slug: "multi-agent",
  seoTitle: "Host Multiple AI Agents on Hivra",
  description:
    "Run multiple AI agents on managed cloud computers, with separate memory and tools and a shared hosting resource allowance.",
  eyebrow: "Multiple AI Agents",
  h1: "Separate jobs, one Hivra account",
  breadcrumb: "Multiple agents",
  lead: {
    heading: "Your coding agent doesn't need to know your customer support queue.",
    blocks: [
      {
        kind: "p",
        text: "It's tempting to give one assistant every responsibility. Then its instructions grow, its tools pile up, and its history becomes a mixture of unrelated work. A task that should be straightforward starts with ten minutes of explaining which project you mean.",
      },
      {
        kind: "p",
        text: "Hivra lets you keep different jobs in different places. You might run Hermes for research, Claude Code or Codex for development, and OpenClaw for messaging workflows, all managed under the same account on a Hivra Cloud plan.",
      },
      {
        kind: "p",
        text: "Each agent has its own cloud computer and configuration. You decide what it can access, which models it uses and what work belongs to it.",
      },
    ],
  },
  sections: [
    {
      heading: "Why separate agents?",
      blocks: [
        {
          kind: "terms",
          items: [
            {
              term: "Clearer responsibilities.",
              text: "A research agent can concentrate on collecting sources and maintaining background notes. A coding agent can keep repository access and development instructions without inheriting unrelated customer conversations.",
            },
            {
              term: "More deliberate permissions.",
              text: "The agent that drafts content might only need a document folder. The agent that maintains a server needs very different credentials. Splitting responsibilities makes it easier to give each one less access.",
            },
            {
              term: "More useful memory.",
              text: "Independent working files stop every role from accumulating one enormous, confusing history. An agent can keep what matters for its own work rather than carrying everything you've ever told another assistant.",
            },
          ],
        },
        {
          kind: "p",
          text: "You can still share information deliberately, through a common document or an external tool, when two agents need the same facts.",
        },
      ],
    },
    {
      heading: "Individual computers, shared plan resources",
      blocks: [
        {
          kind: "p",
          text: `The current Hivra model provides a compute pool at the plan level. The sizes on offer are **${ENTRY_SIZE_PROSE}** and **${LARGER_SIZE_PROSE}**. Your agents draw from the resources available on that plan rather than requiring a completely separate Hivra account for each role.`,
        },
        {
          kind: "p",
          text: "This isn't unlimited compute. If several agents compile code, launch browsers or process large files at the same time, they compete for CPU and memory. The number of active agents is also capped by plan and shown at checkout.",
        },
        {
          kind: "p",
          text: "For lighter workloads, staggering scheduled jobs often matters more than adding another agent. A researcher can prepare a morning brief before a coding task starts later in the day.",
        },
      ],
    },
    {
      heading: "What isolation means here",
      blocks: [
        {
          kind: "p",
          text: "Agent profiles have separate memory and working environments. One agent's session history is not automatically loaded into another's. That reduces accidental mixing of contexts and gives you better control over what each agent is meant to do.",
        },
        {
          kind: "p",
          text: "It does not remove every possible route for shared access. If you give two agents credentials to the same cloud drive, database or account, both may reach the same external information. Plan your permissions around those real connections, not just around the fact that the agents have different names.",
        },
        {
          kind: "p",
          text: "Claude Code and Codex also have an optional shared account-memory feature: notes entered in the dashboard can be copied into a **new** coding agent at launch. That is a starting document, not live synchronisation between existing agents. Hermes does not receive it automatically.",
        },
      ],
    },
    {
      heading: "How would you actually use this?",
      blocks: [
        {
          kind: "p",
          text: "**A solo builder:** Claude Code works on the app, Hermes researches the market, and a scheduled agent organises useful findings for the next development session.",
        },
        {
          kind: "p",
          text: "**A small business:** one agent prepares a daily operations summary, another checks approved website updates and a third drafts customer responses for a human to review.",
        },
        {
          kind: "p",
          text: "**A content team:** one agent collects sources, another prepares draft material and an editor remains responsible for the final publication.",
        },
        {
          kind: "p",
          text: "In each case, the handoffs are currently yours to design. Hivra does **not** yet provide built-in orchestration that automatically coordinates an entire team of agents. That capability is planned for the future.",
        },
      ],
    },
  ],
  faqs: [
    {
      q: "Does every agent cost a separate monthly hosting subscription?",
      a: "Hivra's plans use shared compute resources with agent-count limits. You should check the current checkout for the number of active agents included and any additional conditions.",
    },
    {
      q: "Can I mix Hermes, Claude Code, Codex and OpenClaw?",
      a: "Yes, where each framework is supported by your plan and deployment type. Framework-specific features remain different.",
    },
    {
      q: "Do the agents collaborate automatically?",
      a: "No. You can connect them through shared external tools or manual handoffs. Native orchestration is not a launched feature.",
    },
    {
      q: "Can they use different models?",
      a: "Where supported by their frameworks, yes. Each agent can use different model credentials or preferences. Your provider's account rules and inference charges still apply.",
    },
    {
      q: "What if two agents edit the same document?",
      a: "They can conflict or overwrite one another. Set clear ownership of files and ordering of tasks, or use a system with proper version control.",
    },
    {
      q: "Is all memory shared?",
      a: "No. Working memory is isolated by agent. Optional copied account memory for new Claude Code and Codex agents is a separate, explicitly configured feature.",
    },
  ],
  actions: closingActions({ label: "Explore agents", href: "/agents" }, { label: "See pricing", href: "/pricing" }),
  related: [
    { label: "Persistent memory", href: "/features/persistent-memory" },
    { label: "Scheduled tasks", href: "/features/scheduled-tasks" },
    { label: "Browser automation", href: "/features/browser-automation" },
  ],
};
