import {
  AGENT_JOBS,
  AGENT_JOB_FACTS,
  APPROVAL_PATTERN,
  CATEGORIES,
  CATEGORY_IDS,
  CONNECTION_IDS,
  DEFAULT_FILTER,
  JOB_CLAIM_PATTERNS,
  UNATTENDED_ACTION_PATTERN,
  UNTRUSTED,
  canRun,
  countByCategory,
  filterJobs,
  groupByCategory,
  matchesQuery,
  parseJobParams,
  placeholdersIn,
  serializeJobParams,
} from "../agent-job-library";
import { AGENT_JOB_LIBRARY_ENTRY } from "../agent-job-library-entry";
import { findBannedClaims } from "../../copy-rules";
import { unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";
import { unknownDashboardNames } from "@/lib/blog/runtime-facts";

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => strings(v, out));
  return out;
}

const ids = (jobs: readonly { id: string }[]) => jobs.map((j) => j.id);

describe("the job data", () => {
  it("has about forty jobs with unique ids", () => {
    expect(AGENT_JOBS).toHaveLength(40);
    expect(new Set(ids(AGENT_JOBS)).size).toBe(AGENT_JOBS.length);
  });

  it("gives every job a prompt, a known category, known connections and all the text fields", () => {
    for (const job of AGENT_JOBS) {
      expect(CATEGORY_IDS).toContain(job.category);
      expect(job.prompt.trim().length).toBeGreaterThan(120);
      for (const field of [job.title, job.outcome, job.schedule, job.setup, job.risk]) expect(field.trim().length).toBeGreaterThanOrEqual(8);
      for (const need of job.needs) expect(CONNECTION_IDS).toContain(need);
      expect(new Set(job.needs).size).toBe(job.needs.length);
    }
  });

  it("covers every category with at least four jobs", () => {
    const counts = countByCategory();
    for (const id of CATEGORY_IDS) expect(counts[id]).toBeGreaterThanOrEqual(4);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(AGENT_JOBS.length);
  });

  it("has no two jobs with the same title or the same prompt", () => {
    expect(new Set(AGENT_JOBS.map((j) => j.title)).size).toBe(AGENT_JOBS.length);
    expect(new Set(AGENT_JOBS.map((j) => j.prompt)).size).toBe(AGENT_JOBS.length);
  });

  it("uses at least one [BRACKET] placeholder in every prompt that asks for the reader's input", () => {
    const withBrackets = AGENT_JOBS.filter((j) => placeholdersIn(j.prompt).length > 0);
    expect(withBrackets.length).toBeGreaterThanOrEqual(35);
    expect(placeholdersIn("Do [this] for [that]")).toEqual(["this", "that"]);
  });

  it("puts an approval line in every prompt that drafts or writes, and never lets a job act unattended", () => {
    for (const job of AGENT_JOBS) {
      if (job.action !== "reads") expect({ id: job.id, ok: APPROVAL_PATTERN.test(job.prompt) }).toEqual({ id: job.id, ok: true });
      expect({ id: job.id, hit: UNATTENDED_ACTION_PATTERN.test(job.prompt) }).toEqual({ id: job.id, hit: false });
      // A read-only job says it does not send or change anything, or it spends nothing.
      if (job.action === "reads") expect({ id: job.id, ok: /do not|don't|never/i.test(job.prompt) || job.category === "learning" || job.category === "content" || job.category === "research" || job.category === "code" }).toEqual({ id: job.id, ok: true });
    }
  });

  it("makes every job that touches email, money or shopping say it will not send or spend", () => {
    for (const job of AGENT_JOBS) {
      if (job.needs.includes("email")) expect({ id: job.id, ok: /do not send|do not forward|wait for my approval/i.test(job.prompt) }).toEqual({ id: job.id, ok: true });
      if (job.category === "money") expect({ id: job.id, ok: /do not (?:buy|cancel|open|move|add)|do not .*pay/i.test(job.prompt) }).toEqual({ id: job.id, ok: true });
    }
  });

  it("tells every job that reads email or web pages to treat that text as data, not instructions", () => {
    const readers = AGENT_JOBS.filter((j) => j.needs.includes("email") || j.needs.includes("browser"));
    expect(readers.length).toBeGreaterThanOrEqual(15);
    for (const job of readers) expect({ id: job.id, ok: job.prompt.endsWith(UNTRUSTED) }).toEqual({ id: job.id, ok: true });
    for (const id of ["inbox-morning-triage", "inbox-reply-drafts", "inbox-newsletter-digest", "sales-followup-nudge", "admin-bill-dates", "money-purchase-research"]) {
      expect(AGENT_JOBS.find((j) => j.id === id)!.prompt).toContain(UNTRUSTED);
    }
    expect(AGENT_JOBS.filter((j) => j.needs.length === 0).every((j) => !j.prompt.includes(UNTRUSTED))).toBe(true);
  });

  it("makes no banned claim, and no claim of saved time or money, in any job", () => {
    for (const job of AGENT_JOBS) {
      for (const text of strings(job)) {
        expect({ id: job.id, text, hits: findBannedClaims(text) }).toEqual({ id: job.id, text, hits: [] });
        for (const { pattern, why } of JOB_CLAIM_PATTERNS) expect({ id: job.id, text, why, hit: pattern.test(text) }).toEqual({ id: job.id, text, why, hit: false });
        expect(text).not.toMatch(/[–—]/);
      }
    }
  });

  it("flags banned claims when they are present", () => {
    for (const bad of ["This saves you time every week.", "It will save money.", "Effortless inbox", "Guaranteed results", "automatically send the reply", "without asking me"]) {
      const flagged = JOB_CLAIM_PATTERNS.some((c) => c.pattern.test(bad)) || UNATTENDED_ACTION_PATTERN.test(bad);
      expect({ bad, flagged }).toEqual({ bad, flagged: true });
    }
    expect(findBannedClaims("Free trial, no card")).not.toEqual([]);
  });

  it("describes every schedule in plain words", () => {
    for (const job of AGENT_JOBS) expect(job.schedule).toMatch(/^(Every|On |Daily|Once)/);
  });
});

describe("filters", () => {
  it("returns every job for the default filter", () => {
    expect(filterJobs(DEFAULT_FILTER)).toHaveLength(40);
  });

  it("filters by category", () => {
    const out = filterJobs({ ...DEFAULT_FILTER, category: "money" });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((j) => j.category === "money")).toBe(true);
  });

  it("canRun is true only when every need is connected, and always for jobs that need nothing", () => {
    const needsBoth = AGENT_JOBS.find((j) => j.needs.length === 2)!;
    expect(canRun(needsBoth, [needsBoth.needs[0]])).toBe(false);
    expect(canRun(needsBoth, [...needsBoth.needs])).toBe(true);
    const none = AGENT_JOBS.find((j) => j.needs.length === 0)!;
    expect(canRun(none, [])).toBe(true);
  });

  it("with nothing ticked and 'only runnable' on, shows exactly the jobs that need nothing", () => {
    const out = filterJobs({ ...DEFAULT_FILTER, onlyRunnable: true });
    expect(out.length).toBeGreaterThanOrEqual(6);
    expect(out.every((j) => j.needs.length === 0)).toBe(true);
  });

  it("ignores the connections when 'only runnable' is off", () => {
    expect(filterJobs({ ...DEFAULT_FILTER, have: ["email"], onlyRunnable: false })).toHaveLength(40);
  });

  it("searches title, outcome, prompt and connection names, all words required, case-insensitively", () => {
    expect(ids(filterJobs({ ...DEFAULT_FILTER, query: "INVOICE" })).length).toBeGreaterThan(0);
    expect(filterJobs({ ...DEFAULT_FILTER, query: "zzzz-no-such-word" })).toEqual([]);
    const both = filterJobs({ ...DEFAULT_FILTER, query: "calendar email" });
    expect(both.length).toBeGreaterThan(0);
    for (const j of both) expect(matchesQuery(j, "calendar email")).toBe(true);
    expect(matchesQuery(AGENT_JOBS[0], "   ")).toBe(true);
  });

  it("combines filters", () => {
    const out = filterJobs({ category: "code", have: ["files"], onlyRunnable: true, query: "" });
    expect(ids(out).sort()).toEqual(["code-dependency-audit", "code-diff-summary", "code-log-triage", "code-readme-draft"].sort());
  });

  it("groups in the fixed category order and skips empty groups", () => {
    const groups = groupByCategory(filterJobs({ ...DEFAULT_FILTER, query: "dinners" }));
    expect(groups.map((g) => g.id)).toEqual(["admin"]);
    const all = groupByCategory(AGENT_JOBS);
    expect(all.map((g) => g.id)).toEqual([...CATEGORY_IDS]);
  });
});

describe("share links", () => {
  it("serialises only the category and connections, and omits defaults", () => {
    expect(serializeJobParams(DEFAULT_FILTER)).toBe("");
    expect(serializeJobParams({ category: "sales", have: ["email", "browser"], onlyRunnable: true, query: "secret search" })).toBe("jobs=sales&have=email%2Cbrowser&runnable=1");
    expect(serializeJobParams({ category: "all", have: ["email"], onlyRunnable: false, query: "" })).toBe("have=email");
  });

  it("round-trips each combination of connections and 'only runnable'", () => {
    for (const have of [[], ["email" as const], ["email" as const, "files" as const]]) {
      for (const onlyRunnable of [false, true]) {
        const f = { category: "all" as const, have, onlyRunnable, query: "" };
        expect(parseJobParams(`?${serializeJobParams(f)}`)).toEqual(f);
      }
    }
    // Ticked and nothing connected: the box survives. Unticked with connections: the connections survive.
    expect(serializeJobParams({ ...DEFAULT_FILTER, onlyRunnable: true })).toBe("runnable=1");
    expect(parseJobParams("?runnable=1")).toEqual({ ...DEFAULT_FILTER, onlyRunnable: true });
    expect(parseJobParams("?have=email")).toEqual({ ...DEFAULT_FILTER, have: ["email"] });
    expect(parseJobParams("?runnable=yes").onlyRunnable).toBe(false);
  });

  it("never carries the search text", () => {
    expect(serializeJobParams({ ...DEFAULT_FILTER, query: "my private thing" })).not.toMatch(/private/);
  });

  it("round-trips and ignores unknown values", () => {
    const f = { category: "code" as const, have: ["files" as const, "browser" as const], onlyRunnable: true, query: "" };
    const back = parseJobParams(`?${serializeJobParams(f)}`);
    expect(back.category).toBe("code");
    expect([...back.have].sort()).toEqual(["browser", "files"]);
    expect(back.onlyRunnable).toBe(true);
    expect(parseJobParams("?jobs=<script>&have=email,evil")).toEqual({ category: "all", have: ["email"], onlyRunnable: false, query: "" });
    expect(parseJobParams("")).toEqual(DEFAULT_FILTER);
  });
});

describe("facts table", () => {
  it("is dated and lists https sources", () => {
    expect(AGENT_JOB_FACTS.lastVerified).toBe("2026-11-12");
    expect(AGENT_JOB_FACTS.sources.length).toBeGreaterThanOrEqual(2);
    for (const s of AGENT_JOB_FACTS.sources) expect(s.url).toMatch(/^https:\/\//);
  });
});

describe("catalog entry", () => {
  const entry = AGENT_JOB_LIBRARY_ENTRY;

  it("carries the names the task fixed", () => {
    expect(entry.slug).toBe("ai-agent-use-cases");
    expect(entry.componentKey).toBe("agent-job-library");
    expect(entry.primaryKeyword).toBe("ai agent examples");
    expect(entry.h1).toBe("AI agent jobs: 40 things to hand your agent");
  });

  it("keeps titles and the description within limits", () => {
    expect(entry.metaTitle.length).toBeLessThanOrEqual(55);
    expect(entry.metaTitle).not.toMatch(/Hivra/);
    expect(entry.browserTitle).toBe(`${entry.metaTitle} | Hivra`);
    expect(entry.metaDescription.length).toBeGreaterThanOrEqual(120);
    expect(entry.metaDescription.length).toBeLessThanOrEqual(155);
  });

  it("has the blocks the page renders", () => {
    expect(entry.faqs.length).toBeGreaterThanOrEqual(5);
    expect(entry.method!.paragraphs.length).toBeGreaterThanOrEqual(4);
    expect(entry.method!.paragraphs.flatMap((p) => p.sources ?? []).length).toBeGreaterThanOrEqual(2);
    expect(entry.method!.lastVerified).toBe(AGENT_JOB_FACTS.lastVerified);
    expect(entry.examples!.length).toBeGreaterThanOrEqual(1);
    expect(entry.vendors.length).toBeGreaterThan(0);
    expect(entry.intro.lede).toContain("40 jobs in 8 groups");
  });

  it("links only to routes the existing catalog tests allow", () => {
    const allowed = new Set(["/pricing", "/agents/hermes", "/agents/openclaw", "/compare/openclaw-to-hermes", "/compare/vs-self-hosted", "/agents/claude-code", "/agents/codex", "/tools/ai-agent-hosting-cost-calculator", "/tools/agent-survival-check", "/blog/claude-max-vs-pro-for-claude-code", "/blog/codex-resume-session"]);
    expect(entry.relatedLinks.length).toBeGreaterThanOrEqual(2);
    for (const link of entry.relatedLinks) expect(allowed.has(link.href)).toBe(true);
  });

  it("states what its worked examples show, checked against the data", () => {
    const email = filterJobs({ category: "all", have: ["email"], onlyRunnable: true, query: "" });
    expect(ids(email)).toEqual(
      expect.arrayContaining(["inbox-morning-triage", "inbox-reply-drafts", "inbox-newsletter-digest", "sales-followup-nudge", "admin-bill-dates", "money-receipt-table"]),
    );
    expect(email.filter((j) => j.needs.length > 0)).toHaveLength(6);
    const none = filterJobs({ ...DEFAULT_FILTER, onlyRunnable: true });
    expect(ids(none)).toEqual(
      expect.arrayContaining(["content-idea-bank", "content-edit-pass", "learn-daily-lesson", "learn-language-practice", "admin-meal-plan", "code-diff-summary"]),
    );
    const dev = filterJobs({ category: "code", have: ["files"], onlyRunnable: true, query: "" });
    expect(ids(dev)).toEqual(expect.arrayContaining(["code-dependency-audit", "code-log-triage", "code-readme-draft"]));
    expect(dev.filter((j) => j.action === "writes-file").map((j) => j.id)).toEqual(["code-readme-draft"]);
  });

  it("makes no banned claim in any string of the entry", () => {
    const all = strings(entry);
    for (const s of all) {
      expect({ s, hits: findBannedClaims(s) }).toEqual({ s, hits: [] });
      expect(unqualifiedKeepRunningClaims(s)).toEqual([]);
      expect(unknownDashboardNames(s)).toEqual([]);
      for (const { pattern } of JOB_CLAIM_PATTERNS) expect({ s, hit: pattern.test(s) }).toEqual({ s, hit: false });
    }
  });

  it("states the entry plan with its size and never calls anything hosted free", () => {
    const text = strings(entry).join("\n");
    for (const mention of text.match(/\$9\.99[^.]*\./g) ?? []) expect(mention).toMatch(/2 vCPU and 4 GB/);
    expect(text).not.toMatch(/free (?:plan|tier|trial)|\$0/i);
  });

  it("states plain-language scheduling for Hermes only, and cites the OpenClaw CLI", () => {
    const text = strings(entry).join("\n");
    expect(text).not.toMatch(/Hermes and OpenClaw both have a built-in scheduler/);
    expect(text).toMatch(/openclaw automations/);
    expect(text).not.toMatch(/keeps memory/);
  });

  it("describes categories without a group having an empty blurb", () => {
    for (const id of CATEGORY_IDS) expect(CATEGORIES[id].blurb.length).toBeGreaterThan(10);
  });
});
