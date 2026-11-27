import type { ActionLink } from "@/components/public-editorial/ActionLinks";
import type { FeatureFaqItem } from "./types";
import { FREE_ACCOUNT_SENTENCE } from "@/lib/blog/plan-facts";
import { AI_USAGE_NOT_INCLUDED, ENTRY_SIZE_PROSE, GUARANTEE_SENTENCE, LARGER_SIZE_PROSE, OWN_ACCOUNT_TERMS } from "./shared";

// /features. The copy is 01-features-directory.md (20 October 2026); deviations are in the lane ledger.

export const DIRECTORY_EYEBROW = "Features";
export const DIRECTORY_H1 = "Give your agent a computer of its own.";
export const DIRECTORY_BREADCRUMB_LABEL = "Features";

export const DIRECTORY_LEAD = {
  heading: "Less time setting things up. More time getting things done.",
  paragraphs: [
    "An AI agent becomes much more useful when it has somewhere to work. Not just a chat window, but a computer that can keep files, run tools, use a browser and come back to unfinished work tomorrow.",
    "That's what Hivra provides. Run supported agents such as OpenClaw, Claude Code and Codex on cloud computers managed from one dashboard. Hivra handles the infrastructure; you choose the model access and decide what your agent is allowed to do. Your files can outlast your session, even if the computer pauses when idle.",
    "For a Linux workspace on its own, [compare sandboxes and virtual machines](/sandboxes). Features vary by the agent and computer you choose.",
  ],
  actions: [
    { label: "Explore pricing", href: "/pricing", kind: "secondary" },
    { label: "See supported agents", href: "/agents", kind: "primary" },
    { label: "Explore sandboxes", href: "/sandboxes", kind: "secondary" },
  ] satisfies ActionLink[],
};

export const DIRECTORY_ITEMS_HEADING = "Six things that make a difference";

export interface DirectoryItem {
  number: string;
  title: string;
  paragraphs: readonly string[];
  link: { label: string; href: string };
}

export const DIRECTORY_ITEMS: readonly DirectoryItem[] = [
  {
    number: "01.",
    title: "Memory that survives the session",
    paragraphs: [
      "Stop explaining the same project, preferences and decisions every time you return. Hermes keeps user information, working knowledge and reusable skills in files on its persistent computer. You can inspect and correct what it remembers.",
      "Memory isn't perfect or automatic understanding. It depends on what the agent records and retrieves, and you should still check anything important.",
    ],
    link: { label: "Explore persistent memory", href: "/features/persistent-memory" },
  },
  {
    number: "02.",
    title: "A browser that isn't tied to your laptop",
    paragraphs: [
      "On supported Hermes deployments, a persistent Chromium browser is available on the agent's cloud computer. It can navigate websites, follow links, complete permitted forms and collect information. You can inspect its activity and connect other browser providers using your own credentials.",
      "Some websites block automation. Others require a login or human confirmation. A hosted browser doesn't make those restrictions disappear.",
    ],
    link: { label: "Explore browser automation", href: "/features/browser-automation" },
  },
  {
    number: "03.",
    title: "Work that starts on a schedule",
    paragraphs: [
      "Set a recurring task once instead of remembering to prompt your agent every morning. Hermes supports schedules for research, reports, checks and other repeatable work.",
      "A task can still fail, especially when an external service changes. You can review its run history and retry when needed.",
    ],
    link: { label: "Explore scheduled tasks", href: "/features/scheduled-tasks" },
  },
  {
    number: "04.",
    title: "Several agents, without several hosting accounts",
    paragraphs: [
      "Keep a coding agent separate from a researcher or an operations assistant. Each agent has its own computer, configuration and working files, while deployments draw from the resources available on your hosting plan.",
      "They are independent agents, not an automatically coordinated team. Built-in orchestration belongs to Hivra's future plans.",
    ],
    link: { label: "Explore multiple agents", href: "/features/multi-agent" },
  },
  {
    number: "05.",
    title: "No Docker knowledge required",
    paragraphs: [
      "You don't need to install Docker, configure a reverse proxy or manage certificates to get started. Choose an agent, add the credentials it needs, and manage it through Hivra. Logs and a shell remain available for people who want more control.",
    ],
    link: { label: "Explore managed hosting", href: "/features/no-docker-hosting" },
  },
  {
    number: "06.",
    title: "Keep OpenClaw or try Hermes",
    paragraphs: [
      "Already use OpenClaw? You don't have to abandon it to use Hivra. Compare OpenClaw with Hermes if its approach to memory, skills and workflows suits you better. Check your configurations and integrations before switching.",
    ],
    link: { label: "Explore the OpenClaw option", href: "/features/openclaw-alternative" },
  },
];

export const DIRECTORY_PRICE = {
  heading: "What is included in the hosting price?",
  paragraphs: [
    `Paid agent hosting starts at **${ENTRY_SIZE_PROSE}**. A larger option is **${LARGER_SIZE_PROSE}**. Either size covers the managed computer resources. ${AI_USAGE_NOT_INCLUDED} ${OWN_ACCOUNT_TERMS}`,
    FREE_ACCOUNT_SENTENCE,
    `Available agent counts, capacity and framework restrictions depend on the plan. See the live [pricing page](/pricing) before choosing. ${GUARANTEE_SENTENCE}`,
  ],
  actions: [
    { label: "See pricing", href: "/pricing", kind: "secondary" },
    { label: "Launch an agent", href: "/agents", kind: "primary" },
  ] satisfies ActionLink[],
};

export const DIRECTORY_FAQS: readonly FeatureFaqItem[] = [
  {
    q: "Can I use more than one agent?",
    a: "Yes, within the agent and compute limits of your plan, shown at checkout. Each gets its own environment. Concurrent heavy workloads compete for available resources.",
  },
  {
    q: "Will Hivra do the AI work without an API key?",
    // A direct answer to the question. The hosting-price section above carries the approved C6 sentence once, so the answer does not repeat it.
    a: "Not as part of the plan. Hivra provides the computer, and model charges and usage rules are separate.",
  },
  {
    q: "Does persistent hosting guarantee uninterrupted work?",
    a: "No. Your files can persist between sessions, but idle settings, external websites, model providers, software updates and infrastructure failures can affect whether a task keeps running.",
  },
  {
    q: "Is everything shown here available for every agent?",
    a: "No. Browser, scheduler, memory and dashboard features vary by framework. The individual pages explain the relevant differences.",
  },
];
