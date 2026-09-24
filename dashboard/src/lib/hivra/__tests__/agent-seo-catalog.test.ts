import {
  AGENTS_HUB_AFFILIATION,
  AGENTS_HUB_DEPLOY_HREF,
  AGENT_COPY_BANNED_PATTERNS,
  AGENT_OFFER_PRICE_USD,
  AGENT_PAGES_LAST_MODIFIED,
  AGENT_SEO_ENTRIES,
  AGENT_SEO_SLUGS,
  TAB_BOUND_AGENT_SLUGS,
  agentDeployHref,
  getAgentSeoEntry,
  unqualifiedKeepRunningClaims,
  type AgentSeoEntry,
} from "../agent-seo-catalog";
import { AGENTS, BROWSER_ADD, getAgent, isPoolExempt, resizeFloor } from "../agent-catalog";
import { BLOG_ARTICLES } from "@/lib/blog-data";
import { resolveWelcomeAgentTypeKey } from "@/lib/welcome-agent-catalog";
import { ACTIVE_PLAN_KEYS, PLANS } from "@/lib/subscription";
import { HOSTED_MACHINES } from "@/lib/subscription/hosted-ladder";

// Every user-facing string in an entry, walked recursively.
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

function copyOf(entry: AgentSeoEntry): string {
  return collectStrings(entry).join("\n");
}

describe("agent SEO catalog", () => {
  it("has one entry per launchable agent, with unique slugs", () => {
    const slugs = AGENT_SEO_ENTRIES.map((entry) => entry.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(AGENT_SEO_SLUGS).toEqual(slugs);
    // The hub's ItemList is the full launchable lineup: a new launchable agent
    // needs a page, and a page never outlives its agent.
    expect([...slugs].sort()).toEqual(AGENTS.map((agent) => agent.id).sort());
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: maps to an available agent, not a computer profile", (entry) => {
    const agent = getAgent(entry.slug);
    expect(agent?.available).toBe(true);
    expect(agent?.resourceKind ?? "agent").toBe("agent");
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: title fits before the ' | Hivra' suffix and never repeats the brand", (entry) => {
    expect(entry.metaTitle.length).toBeLessThanOrEqual(55);
    expect(entry.metaTitle).not.toMatch(/\|\s*Hivra/i);
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: meta description is 110-155 characters", (entry) => {
    expect(entry.metaDescription.length).toBeGreaterThanOrEqual(110);
    expect(entry.metaDescription.length).toBeLessThanOrEqual(155);
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: has the structural copy blocks the page renders", (entry) => {
    expect(entry.h1.trim().length).toBeGreaterThan(0);
    expect(entry.subhead.trim().length).toBeGreaterThan(0);
    expect(entry.cardSummary.length).toBeLessThanOrEqual(100);
    expect(entry.longDescription.length).toBeGreaterThanOrEqual(2);
    expect(entry.longDescription.length).toBeLessThanOrEqual(3);
    expect(entry.heroBullets).toHaveLength(3);
    expect(entry.howItWorks.length).toBeGreaterThanOrEqual(3);
    expect(entry.howItWorks.length).toBeLessThanOrEqual(4);
    expect(entry.vsSelfHosted.length).toBeGreaterThanOrEqual(3);
    expect(entry.vsSelfHosted.length).toBeLessThanOrEqual(4);
    expect(entry.faqs.length).toBeGreaterThanOrEqual(5);
    for (const faq of entry.faqs) {
      expect(faq.q.trim().length).toBeGreaterThan(0);
      expect(faq.a.trim().length).toBeGreaterThan(0);
    }
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: makes none of the banned claims", (entry) => {
    const copy = copyOf(entry);
    for (const { pattern, reason } of AGENT_COPY_BANNED_PATTERNS) {
      const match = copy.match(pattern);
      if (match) throw new Error(`/agents/${entry.slug} says "${match[0]}" (${reason})`);
    }
  });

  it("scans the literal phrases the owner ruled out", () => {
    const copy = [...AGENT_SEO_ENTRIES.map(copyOf), AGENTS_HUB_AFFILIATION].join("\n").toLowerCase();
    for (const phrase of ["free trial", "card required", "never sleeps"]) {
      expect(copy).not.toContain(phrase);
    }
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: names its vendor in an explicit non-affiliation line", (entry) => {
    const agent = getAgent(entry.slug)!;
    expect(entry.affiliation).toMatch(/^Hivra is independent and is not affiliated with /);
    // Hermes's catalog vendor is Nous Research; the projects are named as projects.
    expect(entry.affiliation).toContain(agent.vendor);
    expect(AGENTS_HUB_AFFILIATION).toContain(agent.vendor);
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: related blog slugs exist in blog-data", (entry) => {
    for (const slug of entry.relatedBlogSlugs) {
      const known = Boolean(BLOG_ARTICLES[slug]);
      if (!known) throw new Error(`Unknown related blog slug "${slug}" on /agents/${entry.slug}`);
    }
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: deploy CTA is the signed-out sign-up funnel with an accepted plan and agentType", (entry) => {
    const href = agentDeployHref(entry);
    expect(href.startsWith("/get-started?")).toBe(true);
    const query = new URLSearchParams(href.split("?")[1]);
    expect((ACTIVE_PLAN_KEYS as readonly string[]).includes(query.get("plan") ?? "")).toBe(true);
    expect(query.get("plan")).toBe("operator");
    // /get-started drops unknown agentType keys silently, so an unaccepted key
    // would lose the runtime preselection.
    expect(resolveWelcomeAgentTypeKey(query.get("agentType"))).toBe(entry.agentType);
  });

  it("launches Hermes as the general agent type and every other runtime under its own id", () => {
    for (const entry of AGENT_SEO_ENTRIES) {
      expect(entry.agentType).toBe(entry.slug === "hermes" ? "general" : entry.slug);
    }
    expect(AGENTS_HUB_DEPLOY_HREF).toBe("/get-started?plan=operator");
  });

  it("prices the offer at checkout's $9.99 plan, which is also the public ladder's entry price", () => {
    expect(AGENT_OFFER_PRICE_USD).toBe((PLANS.operator.price / 100).toFixed(2));
    expect(`$${AGENT_OFFER_PRICE_USD}`).toBe(HOSTED_MACHINES[0].price);
  });

  it("describes the $9.99 and $19.99 sizes the way checkout and the public ladder both sell them", () => {
    // Copy says "$9.99 ... 2 vCPU and 4 GB" and "$19.99 ... 4 vCPU and 8 GB".
    expect(PLANS.operator.price).toBe(999);
    expect(PLANS.operator.totalCpu).toBe(2);
    expect(PLANS.operator.totalRam).toBe(4096);
    expect(PLANS.fleet.price).toBe(1999);
    expect(PLANS.fleet.totalCpu).toBe(4);
    expect(PLANS.fleet.totalRam).toBe(8192);
    const [entrySize, nextSize] = HOSTED_MACHINES;
    expect([entrySize.price, entrySize.cpu, entrySize.ram]).toEqual(["$9.99", "2", "4 GB"]);
    expect([nextSize.price, nextSize.cpu, nextSize.ram]).toEqual(["$19.99", "4", "8 GB"]);

    for (const entry of AGENT_SEO_ENTRIES) {
      const copy = copyOf(entry);
      expect(copy).toContain("$9.99");
      for (const match of copy.matchAll(/\$(\d+\.\d\d)[^.]*?(\d) vCPU and (\d) GB/g)) {
        const [, price, cpu, ram] = match;
        if (price === "9.99") expect([cpu, ram]).toEqual(["2", "4"]);
        if (price === "19.99") expect([cpu, ram]).toEqual(["4", "8"]);
      }
    }
  });

  it("states paid-plan requirements only for agents that need one", () => {
    for (const entry of AGENT_SEO_ENTRIES) {
      const needsPaid = getAgent(entry.slug)?.minPlan !== "free";
      expect(/needs a paid plan/i.test(copyOf(entry))).toBe(needsPaid);
    }
  });

  it("matches the resource claims to the agent catalog floors", () => {
    expect(BROWSER_ADD).toEqual({ cpu: 1, ram: 2 });
    // OpenClaw: 1 vCPU / 2 GB, or 2 / 4 with the browser on.
    expect(resizeFloor("openclaw", false)).toEqual({ cpu: 1, ram: 2 });
    expect(resizeFloor("openclaw", true)).toEqual({ cpu: 2, ram: 4 });
    // Agent Zero: 1 vCPU / 2 GB minimum, never a fixed 2 / 4.
    expect(resizeFloor("agent-zero", false)).toEqual({ cpu: 1, ram: 2 });
    expect(copyOf(getAgentSeoEntry("agent-zero")!)).not.toMatch(/fixed 2 vCPU/i);
    // "Fits within the $9.99 plan" for the coding agents with the browser on.
    for (const id of ["claude-code", "codex"]) {
      expect(getAgent(id)?.browser).toBe(true);
      const floor = resizeFloor(id, true);
      expect(floor.cpu).toBeLessThanOrEqual(PLANS.operator.totalCpu);
      expect(floor.ram * 1024).toBeLessThanOrEqual(PLANS.operator.totalRam);
    }
    // Aeon "does not draw on your plan's shared CPU and RAM".
    expect(isPoolExempt("aeon")).toBe(true);
  });

  it("resolves entries by slug and rejects unknown slugs", () => {
    for (const slug of ["hermes", "claude-code", "codex", "aeon", "openclaw", "agent-zero"]) {
      expect(getAgentSeoEntry(slug)?.slug).toBe(slug);
    }
    expect(getAgentSeoEntry("not-an-agent")).toBeUndefined();
    expect(getAgentSeoEntry("deepseek-harness")).toBeUndefined();
  });

  // On Claude Code and Codex boxes the browser chat kills the CLI when the tab
  // disconnects and the agent terminal runs without tmux, so "close your laptop,
  // it keeps working" is false unless the run was started inside tmux (or, for
  // Claude Code, from Telegram). The computer itself stays on.
  it("lists exactly the agents whose runs are tied to the browser tab", () => {
    expect([...TAB_BOUND_AGENT_SLUGS].sort()).toEqual(["claude-code", "codex"]);
  });

  it.each(TAB_BOUND_AGENT_SLUGS.map((slug) => [slug]))(
    "%s: every keeps-working claim says how, and the tab-close limit is stated",
    (slug) => {
      const entry = getAgentSeoEntry(slug)!;
      const copy = copyOf(entry);
      expect(unqualifiedKeepRunningClaims(copy)).toEqual([]);
      expect(copy).toMatch(/\btmux\b/);
      expect(copy).toMatch(/stops when you close that tab/);
      // The subhead sits right under the "24/7" / "stays on" H1, so it has to say how.
      expect(entry.subhead).toMatch(/\btmux\b/);
      const closeLaptop = entry.faqs.find((faq) => /close my laptop/i.test(faq.q));
      expect(closeLaptop?.a).toMatch(/\btmux\b/);
      expect(closeLaptop?.a).toMatch(/stops when you close that tab/);
    },
  );

  it("keeps the H1 search intent for Claude Code in the cloud", () => {
    expect(getAgentSeoEntry("claude-code")!.h1).toMatch(/Claude Code, running 24\/7 in the cloud/);
  });

  it("flags the retired keeps-working claims and accepts the qualified ones", () => {
    for (const claim of [
      "Close your laptop. It keeps working.",
      "Start a task from chat or the terminal. It keeps running after you close the tab.",
      "Nothing stops. Codex runs on a managed cloud VM, not your machine.",
      "Kick off a task, close the tab, come back to finished work.",
      "Paid plans are never paused for inactivity, so close the laptop and the work keeps going.",
    ]) {
      expect(unqualifiedKeepRunningClaims(claim).length).toBeGreaterThan(0);
    }
    expect(unqualifiedKeepRunningClaims("Start a run inside tmux and it keeps going after you close the tab.")).toEqual([]);
    expect(unqualifiedKeepRunningClaims("Start it from Telegram and it keeps going.")).toEqual([]);
    // Scoped to sentences about the tab-bound agents when the copy covers others too.
    expect(unqualifiedKeepRunningClaims("Hermes keeps working with the laptop closed.", /Claude Code|Codex/)).toEqual([]);
    for (const claim of ["no SIGHUP", "No tmux required.", "Survives laptop sleep: Yes"]) {
      expect(AGENT_COPY_BANNED_PATTERNS.some(({ pattern }) => pattern.test(claim))).toBe(true);
    }
  });

  it("says what the Aeon GitHub token is used for and which permissions it needs", () => {
    // provisioner/hivra-chat/server.js finalizeAeonConnect: forks or syncs the
    // user's Aeon repo, enables its Actions, repoints the box clone, and fails
    // the connect unless the token can write Actions secrets there.
    const copy = copyOf(getAgentSeoEntry("aeon")!);
    expect(copy).not.toMatch(/sign in to GitHub and start the dashboard/);
    expect(copy).toMatch(/Aeon fork/);
    expect(copy).toMatch(/turn on (its )?Actions|turn on Actions/);
    expect(copy).toMatch(/task secrets/);
    expect(copy).toMatch(/Secrets, Actions, Contents and Workflows/);
  });

  it("exposes a real sitemap lastmod date", () => {
    expect(AGENT_PAGES_LAST_MODIFIED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(new Date(AGENT_PAGES_LAST_MODIFIED).getTime())).toBe(false);
  });
});
