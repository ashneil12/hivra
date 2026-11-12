import { existsSync } from "node:fs";
import path from "node:path";

import { LAUNCH_PROFILE_IDS, PROFILE_DETAILS, type LaunchProfileId } from "../contracts";
import {
  CATALOG_JOBS,
  catalogJobCounts,
  catalogSourceRepo,
  filterCatalog,
  isCatalogFiltered,
  isLaunchCatalogEnabled,
  LAUNCH_CATALOG,
  NO_CATALOG_FILTER,
  orderCatalogByUse,
  primaryCatalogJob,
  relatedCatalogItems,
  searchWords,
  tryNextSuggestions,
  type CatalogItem,
} from "../launch-catalog";

const item = (id: LaunchProfileId, description = ""): CatalogItem => ({ id, name: PROFILE_DETAILS[id].name, description });

const ITEMS: CatalogItem[] = [
  item("claude-code", "Anthropic's coding agent."),
  item("codex", "OpenAI's coding agent."),
  item("hermes-computer", "The official Hermes Agent, in its own web UI, on its own computer."),
  item("openclaw", "An agent you reach from your messaging apps, on a computer that stays on."),
  item("agent-zero", "An autonomous agent with its own dashboard and browser."),
  item("aeon", "An agent framework that runs its work on your GitHub."),
  item("ubuntu-server", "A light Linux computer with a terminal and files. No desktop."),
  item("ubuntu-desktop", "A desktop, terminal and files you open in your browser."),
];

const ids = (items: readonly CatalogItem[]) => items.map(entry => entry.id);
const search = (query: string) => ids(filterCatalog(ITEMS, { ...NO_CATALOG_FILTER, query }));

describe("the Launch catalog switch", () => {
  it("is off unless it is set to 1 or true", () => {
    expect(isLaunchCatalogEnabled(undefined)).toBe(false);
    expect(isLaunchCatalogEnabled("")).toBe(false);
    expect(isLaunchCatalogEnabled("0")).toBe(false);
    expect(isLaunchCatalogEnabled("1")).toBe(true);
    expect(isLaunchCatalogEnabled(" TRUE ")).toBe(true);
  });
});

describe("catalog entries", () => {
  it("files every agent under a job and no computer under one", () => {
    const jobIds = CATALOG_JOBS.map(job => job.id);
    for (const id of LAUNCH_PROFILE_IDS) {
      const entry = LAUNCH_CATALOG[id];
      expect(entry.jobs.every(job => jobIds.includes(job))).toBe(true);
      if (PROFILE_DETAILS[id].resourceKind === "agent") {
        expect(entry.jobs.length).toBeGreaterThan(0);
        expect(entry.talk).toBeTruthy();
        expect(primaryCatalogJob(id)?.id).toBe(entry.jobs[0]);
      } else {
        expect(entry.jobs).toEqual([]);
        expect(entry.talk).toBeNull();
        expect(entry.firstTasks).toEqual([]);
        expect(primaryCatalogJob(id)).toBeNull();
      }
    }
  });

  it("links makers over https and points pictures at files that exist", () => {
    for (const id of LAUNCH_PROFILE_IDS) {
      const { sourceUrl, cover } = LAUNCH_CATALOG[id];
      if (sourceUrl) expect(sourceUrl).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
      if (cover) {
        expect(existsSync(path.join(process.cwd(), "public", cover.src))).toBe(true);
        expect(cover.alt).not.toBe("");
      }
    }
  });

  it("names a repository to prove a claim in for agents only", () => {
    expect(catalogSourceRepo("codex")).toBe("openai/codex");
    expect(catalogSourceRepo("openbot")).toBeNull();
    for (const id of LAUNCH_PROFILE_IDS) {
      if (PROFILE_DETAILS[id].resourceKind === "computer") expect(catalogSourceRepo(id)).toBeNull();
    }
  });

  it("writes each first task as a title and words to give the agent", () => {
    for (const id of LAUNCH_PROFILE_IDS) {
      const titles = LAUNCH_CATALOG[id].firstTasks.map(task => task.title);
      expect(new Set(titles).size).toBe(titles.length);
      for (const task of LAUNCH_CATALOG[id].firstTasks) {
        expect(task.title.length).toBeGreaterThan(3);
        expect(task.prompt).toMatch(/[.]$/);
      }
    }
  });
});

describe("searching the catalog", () => {
  it("keeps the words that carry meaning and trims plurals", () => {
    expect(searchWords("I need something to answer my Messages, please")).toEqual(["answer", "message"]);
    expect(searchWords("  ")).toEqual([]);
  });

  it("finds a thing by its name, its maker's words or its job", () => {
    expect(search("codex")).toEqual(["codex"]);
    expect(search("chatgpt")).toEqual(["codex"]);
    expect(search("coding")).toEqual(["claude-code", "codex"]);
    expect(search("telegram")).toEqual(["openclaw"]);
    expect(search("research")).toEqual(["hermes-computer", "agent-zero"]);
  });

  it("needs every word of the search to match", () => {
    expect(search("coding agent openai")).toEqual(["codex"]);
    expect(search("ubuntu gui")).toEqual(["ubuntu-desktop"]);
    expect(search("spreadsheet")).toEqual([]);
  });

  it("filters by kind and by job, keeping the order given", () => {
    expect(ids(filterCatalog(ITEMS, { ...NO_CATALOG_FILTER, kind: "computer" }))).toEqual(["ubuntu-server", "ubuntu-desktop"]);
    expect(ids(filterCatalog(ITEMS, { ...NO_CATALOG_FILTER, job: "automation" }))).toEqual(["hermes-computer", "aeon"]);
    expect(ids(filterCatalog(ITEMS, { query: "github", kind: "agent", job: "automation" }))).toEqual(["aeon"]);
    expect(filterCatalog(ITEMS, NO_CATALOG_FILTER)).toEqual(ITEMS);
  });

  it("knows when a filter is narrowing the list", () => {
    expect(isCatalogFiltered(NO_CATALOG_FILTER)).toBe(false);
    expect(isCatalogFiltered({ ...NO_CATALOG_FILTER, query: " the " })).toBe(false);
    expect(isCatalogFiltered({ ...NO_CATALOG_FILTER, query: "code" })).toBe(true);
    expect(isCatalogFiltered({ ...NO_CATALOG_FILTER, kind: "agent" })).toBe(true);
    expect(isCatalogFiltered({ ...NO_CATALOG_FILTER, job: "coding" })).toBe(true);
  });

  it("counts only the jobs that have something to show", () => {
    expect(catalogJobCounts(ITEMS).map(job => [job.id, job.count])).toEqual([
      ["coding", 2], ["research", 2], ["messages", 1], ["automation", 2], ["assistant", 3],
    ]);
    expect(catalogJobCounts([item("ubuntu-desktop")])).toEqual([]);
  });

  it("suggests others that do the same main job", () => {
    expect(ids(relatedCatalogItems("claude-code", ITEMS))).toEqual(["codex"]);
    expect(ids(relatedCatalogItems("hermes-computer", ITEMS))).toEqual(["openclaw", "agent-zero"]);
    expect(relatedCatalogItems("ubuntu-desktop", ITEMS)).toEqual([]);
  });
});

describe("ordering by use", () => {
  it("puts the types more people use first and keeps the rest in their places", () => {
    expect(ids(orderCatalogByUse(ITEMS, ["openclaw", "hermes", "codex"]))).toEqual([
      "openclaw", "hermes-computer", "codex", "claude-code", "agent-zero", "aeon", "ubuntu-server", "ubuntu-desktop",
    ]);
  });

  it("changes nothing when no use is known, or for a type the catalog does not offer", () => {
    expect(orderCatalogByUse(ITEMS, [])).toEqual(ITEMS);
    expect(orderCatalogByUse(ITEMS, ["unknown"])).toEqual(ITEMS);
  });
});

describe("what to try next", () => {
  const suggest = (running: string[], limit?: number) =>
    tryNextSuggestions(ITEMS, running, limit).map(entry => [entry.item.id, entry.because]);

  it("leads with agents that do a job the owner already uses one for", () => {
    expect(suggest(["codex"])).toEqual([["claude-code", "Codex"], ["hermes-computer", null]]);
    expect(suggest(["hermes"])).toEqual([["openclaw", "Hermes"], ["agent-zero", "Hermes"]]);
    expect(suggest(["hermes"], 3)).toEqual([["openclaw", "Hermes"], ["agent-zero", "Hermes"], ["aeon", "Hermes"]]);
  });

  it("never suggests what they run, a computer, or anything to someone with no agent", () => {
    expect(suggest(["codex", "claude-code"], 10).map(([id]) => id)).toEqual(["hermes-computer", "openclaw", "agent-zero", "aeon"]);
    expect(suggest([])).toEqual([]);
    expect(suggest(["linux-desktop"])).toEqual([]);
  });
});
