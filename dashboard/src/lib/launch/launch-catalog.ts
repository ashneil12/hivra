// The Launch catalog: what each launchable agent or computer is for, and the
// few facts its page shows before Review. Pure data (no React), so the Launch
// page, its tests and later surfaces can share it.
//
// A fact that already lives in code is read from there, not repeated here: the
// maker is agent-catalog's vendor, and places, browsers and model access come
// from PROFILE_DETAILS and model-access. This file adds only what nothing else
// records: the job a thing does, the words people search by, how you talk to
// it, where its maker publishes it, a picture, and a few good first tasks.

import { PROFILE_DETAILS, type LaunchProfileId } from "./contracts";

/** Off by default: the catalog view of Launch is unreleased. Client-safe: the
 * NEXT_PUBLIC value is inlined at build time, so read it by its literal name. */
export function isLaunchCatalogEnabled(value: string | undefined = process.env.NEXT_PUBLIC_HIVRA_LAUNCH_CATALOG): boolean {
  const flag = value?.trim().toLowerCase();
  return flag === "1" || flag === "true";
}

export type CatalogJobId = "coding" | "research" | "messages" | "automation" | "assistant";

/** The jobs people browse by, in the order they are shown. */
export const CATALOG_JOBS: readonly { id: CatalogJobId; label: string; hint: string }[] = [
  { id: "coding", label: "Coding", hint: "Fix bugs, ship features, review changes" },
  { id: "research", label: "Research", hint: "Read the web and report back" },
  { id: "messages", label: "Messages", hint: "Reach it from your messaging apps" },
  { id: "automation", label: "Automations", hint: "Work that runs on a schedule" },
  { id: "assistant", label: "Personal assistant", hint: "One agent for everyday work" },
];

/** A first task: a title to pick it by, and the words to give the agent.
 * Angle brackets mark what the owner fills in. */
export interface CatalogStarter {
  title: string;
  prompt: string;
}

export interface CatalogEntry {
  /** The jobs it does, the main one first. Computers have none. */
  jobs: readonly CatalogJobId[];
  /** Extra words people search by, beyond its name, description and jobs. */
  keywords: readonly string[];
  /** How you talk to it, in one line. Null for a computer you use yourself. */
  talk: string | null;
  /** Where its maker publishes it. */
  sourceUrl: string | null;
  firstTasks: readonly CatalogStarter[];
  /** A picture of it, under /public. Without one the page draws its icon. */
  cover: { src: string; alt: string; width: number; height: number } | null;
}

const CODING_STARTERS: readonly CatalogStarter[] = [
  {
    title: "Explain a repository",
    prompt: "Clone <repository URL> and explain how it is organised: the main parts, how they fit together, and where to start reading.",
  },
  {
    title: "Fix a failing test",
    prompt: "Run the tests in this repository. Pick one that fails, find the cause, fix it, and show me the change.",
  },
  {
    title: "Review the latest change",
    prompt: "Review the most recent commit on this branch. Point out bugs, risky parts and anything that needs a test.",
  },
];

const HERMES_STARTERS: readonly CatalogStarter[] = [
  {
    title: "Research a topic",
    prompt: "Research <topic> on the web and write me a short report with the sources you used.",
  },
  {
    title: "A morning briefing",
    prompt: "Every weekday at 8am, send me a short briefing on <the topics I follow>.",
  },
  {
    title: "Watch a page",
    prompt: "Check <page URL> once a day and tell me when it changes.",
  },
];

const HERMES_SOURCE = "https://github.com/NousResearch/hermes-agent";

const computerCover = (name: "ubuntu" | "omarchy" | "windows", alt: string) => ({
  src: `/images/computers/${name}-workspace.webp`,
  alt,
  width: 1536,
  height: 1024,
});

export const LAUNCH_CATALOG: Record<LaunchProfileId, CatalogEntry> = {
  "claude-code": {
    jobs: ["coding"],
    keywords: ["claude", "anthropic", "code", "programming", "developer", "repository", "pull request", "terminal"],
    talk: "In Hivra's chat. It also has a terminal on its own computer.",
    sourceUrl: "https://github.com/anthropics/claude-code",
    firstTasks: CODING_STARTERS,
    cover: null,
  },
  codex: {
    jobs: ["coding"],
    keywords: ["openai", "chatgpt", "gpt", "code", "programming", "developer", "repository", "pull request", "terminal"],
    talk: "In Hivra's chat. It also has a terminal on its own computer.",
    sourceUrl: "https://github.com/openai/codex",
    firstTasks: CODING_STARTERS,
    cover: null,
  },
  hermes: {
    jobs: ["assistant", "research", "automation"],
    keywords: ["nous", "general", "schedule", "briefing", "browse", "skills", "memory"],
    talk: "In Hermes's chat, with a terminal, files and skills beside it.",
    sourceUrl: HERMES_SOURCE,
    firstTasks: HERMES_STARTERS,
    cover: null,
  },
  "hermes-computer": {
    jobs: ["assistant", "research", "automation"],
    keywords: ["nous", "general", "schedule", "briefing", "browse", "skills", "memory"],
    talk: "In Hermes's own web app.",
    sourceUrl: HERMES_SOURCE,
    firstTasks: HERMES_STARTERS,
    cover: null,
  },
  openclaw: {
    jobs: ["messages", "assistant"],
    keywords: ["messaging", "message", "telegram", "whatsapp", "discord", "slack", "phone", "chat", "inbox", "reply"],
    talk: "From your messaging apps, once you connect them in OpenClaw's Control UI.",
    sourceUrl: "https://github.com/openclaw/openclaw",
    firstTasks: [
      {
        title: "Connect a messaging app",
        prompt: "Walk me through connecting the messaging app I use most, so I can reach you from my phone.",
      },
      {
        title: "A daily check-in",
        prompt: "Every morning at 8am, message me a short summary of <what I want to keep track of>.",
      },
      {
        title: "Remember something",
        prompt: "Remember that <something to keep in mind>, and remind me about it on <day>.",
      },
    ],
    cover: null,
  },
  "agent-zero": {
    jobs: ["assistant", "research"],
    keywords: ["autonomous", "general", "browser", "goal", "plan", "dashboard", "tasks"],
    talk: "In Agent Zero's own dashboard.",
    sourceUrl: "https://github.com/agent0ai/agent-zero",
    firstTasks: [
      {
        title: "Research and compare",
        prompt: "Research <topic>, compare the three best options, and give me a report with sources.",
      },
      {
        title: "Do a task on the web",
        prompt: "Open <website> in your browser and <what I want done>. Tell me what you did.",
      },
      {
        title: "Build a small tool",
        prompt: "Write and run a script that <what it should do>, then show me the result.",
      },
    ],
    cover: null,
  },
  openbot: {
    jobs: ["assistant", "research"],
    keywords: ["copilotkit", "coworkers", "coworker", "team", "browser", "files", "workspace"],
    talk: "In OpenBot's own workspace.",
    sourceUrl: null,
    firstTasks: [
      {
        title: "Set up a coworker",
        prompt: "Create a coworker that <its role, such as researching competitors> and tell me what it needs from me.",
      },
      {
        title: "Research and summarise",
        prompt: "Research <topic> and save a one-page summary to your files.",
      },
      {
        title: "Work through a list",
        prompt: "Here is a list of <things>. Go through them one by one and report back on each.",
      },
    ],
    cover: null,
  },
  aeon: {
    jobs: ["automation"],
    keywords: ["github", "actions", "schedule", "framework", "cron", "skills"],
    talk: "In Aeon's dashboard. Its tasks run on your GitHub after you connect it.",
    sourceUrl: "https://github.com/aaronjmars/aeon",
    // Aeon is set up in its dashboard, not asked in a chat.
    firstTasks: [],
    cover: null,
  },
  "deepseek-harness": {
    jobs: ["coding"],
    keywords: ["deepseek", "code", "programming", "developer", "repository"],
    talk: "In DeepSeek's own interface.",
    sourceUrl: "https://github.com/deepseek-ai/deepseek-harness",
    firstTasks: CODING_STARTERS,
    cover: null,
  },
  "ubuntu-desktop": {
    jobs: [],
    keywords: ["linux", "ubuntu", "desktop", "gui", "apps", "browser", "files"],
    talk: null,
    sourceUrl: null,
    firstTasks: [],
    cover: computerCover("ubuntu", "An Ubuntu desktop on a monitor"),
  },
  "ubuntu-server": {
    jobs: [],
    keywords: ["linux", "ubuntu", "server", "terminal", "shell", "command line", "files"],
    talk: null,
    sourceUrl: null,
    firstTasks: [],
    cover: null,
  },
  "linux-terminal": {
    jobs: [],
    keywords: ["linux", "sandbox", "terminal", "shell", "command line", "isolated", "ubuntu"],
    talk: null,
    sourceUrl: null,
    firstTasks: [],
    cover: null,
  },
  omarchy: {
    jobs: [],
    keywords: ["linux", "arch", "desktop", "hyprland", "gui"],
    talk: null,
    sourceUrl: "https://github.com/omacom/omarchy",
    firstTasks: [],
    cover: computerCover("omarchy", "An Omarchy desktop on a monitor"),
  },
  windows: {
    jobs: [],
    keywords: ["microsoft", "windows", "desktop", "iso", "gui"],
    talk: null,
    sourceUrl: null,
    firstTasks: [],
    cover: computerCover("windows", "A Windows desktop on a monitor"),
  },
};

export function catalogJob(id: CatalogJobId) {
  return CATALOG_JOBS.find(job => job.id === id) ?? CATALOG_JOBS[0];
}

/** The job an agent is filed under, or null for a computer. */
export function primaryCatalogJob(profileId: LaunchProfileId) {
  const first = LAUNCH_CATALOG[profileId].jobs[0];
  return first ? catalogJob(first) : null;
}

export type CatalogKind = "all" | "agent" | "computer";

export interface CatalogFilter {
  query: string;
  kind: CatalogKind;
  job: CatalogJobId | null;
}

export const NO_CATALOG_FILTER: CatalogFilter = { query: "", kind: "all", job: null };

export function isCatalogFiltered(filter: CatalogFilter): boolean {
  return filter.kind !== "all" || filter.job !== null || searchWords(filter.query).length > 0;
}

/** What a search can match on: the tile as the owner sees it. */
export interface CatalogItem {
  id: LaunchProfileId;
  name: string;
  description: string;
}

// Words that say nothing about what someone is looking for.
const FILLER = new Set([
  "a", "an", "and", "can", "do", "does", "for", "i", "in", "is", "it", "me", "my", "need", "of", "on", "or",
  "please", "something", "that", "the", "to", "want", "with",
]);

/** The words of a search that carry meaning, lower-cased, plurals trimmed. */
export function searchWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 1 && !FILLER.has(word))
    .map(word => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word));
}

function searchText(item: CatalogItem): string {
  const entry = LAUNCH_CATALOG[item.id];
  const jobs = entry.jobs.map(catalogJob).flatMap(job => [job.label, job.hint]);
  const kind = PROFILE_DETAILS[item.id].resourceKind;
  return [item.name, item.description, kind, ...entry.keywords, ...jobs].join(" ").toLowerCase();
}

/** The items a filter keeps, in the order given. Every word of the search has
 * to appear somewhere in an item's name, description, jobs or search words. */
export function filterCatalog<T extends CatalogItem>(items: readonly T[], filter: CatalogFilter): T[] {
  const words = searchWords(filter.query);
  return items.filter(item => {
    if (filter.kind !== "all" && PROFILE_DETAILS[item.id].resourceKind !== filter.kind) return false;
    if (filter.job && !LAUNCH_CATALOG[item.id].jobs.includes(filter.job)) return false;
    if (words.length === 0) return true;
    const text = searchText(item);
    return words.every(word => text.includes(word));
  });
}

/** The jobs that have something to show, with how many items each holds. */
export function catalogJobCounts(items: readonly CatalogItem[]): { id: CatalogJobId; label: string; hint: string; count: number }[] {
  return CATALOG_JOBS
    .map(job => ({ ...job, count: items.filter(item => LAUNCH_CATALOG[item.id].jobs.includes(job.id)).length }))
    .filter(job => job.count > 0);
}

/** Up to `limit` other items that do the same main job, in the order given. */
export function relatedCatalogItems<T extends CatalogItem>(profileId: LaunchProfileId, items: readonly T[], limit = 2): T[] {
  const job = LAUNCH_CATALOG[profileId].jobs[0];
  if (!job) return [];
  return items
    .filter(item => item.id !== profileId && LAUNCH_CATALOG[item.id].jobs.includes(job))
    .slice(0, limit);
}
