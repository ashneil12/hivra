import {
  AGENTS_HUB_AFFILIATION,
  AGENTS_HUB_DEPLOY_HREF,
  AGENT_COPY_BANNED_PATTERNS,
  AGENT_OFFER_PRICE_USD,
  AGENT_PAGES_LAST_MODIFIED,
  AGENT_SEO_ENTRIES,
  AGENT_SEO_SLUGS,
  CLI_RUN_AGENT_SLUGS,
  agentDeployHref,
  agentPageTitle,
  getAgentSeoEntry,
  unqualifiedKeepRunningClaims,
} from "../agent-seo-catalog";
import { AGENTS, BROWSER_ADD, getAgent, isPoolExempt, resizeFloor } from "../agent-catalog";
import { unknownDashboardNames } from "@/lib/blog/runtime-facts";
import { resolveWelcomeAgentTypeKey } from "@/lib/welcome-agent-catalog";
import { PLANS } from "@/lib/subscription";
import { HOSTED_MACHINES } from "@/lib/subscription/hosted-ladder";
import { PUBLIC_START_HREF } from "@/lib/public-start";
import { launchProfileForAgentType } from "@/lib/hivra/launch-navigation";
import { AGENT_PAGE_CONTENT, HUB_CONTENT, getAgentPageContent } from "@/app/agents/content";
import { agentPageCopy, hubCopy } from "@/app/agents/content/copy-text";

// A title or description that says the agent itself is always on, or keeps working with the laptop off. The
// computer staying on is the only run-level promise that holds on every computer (lib/blog/runtime-facts.ts).
const AGENT_ALWAYS_ON_CLAIM = /\balways[- ]?(?:on|available)\b|\blaptop (?:is |being )?(?:off|closed|shut)\b|\bnever (?:off|offline)\b/i;

// The words of a page are in app/agents/content; the catalog holds the registry and the metadata.
// Everything a reader can see, as plain text, plus the metadata a crawler reads.
function copyOf(slug: string): string {
  const entry = getAgentSeoEntry(slug)!;
  return [...agentPageCopy(getAgentPageContent(slug)!), entry.metaTitle, entry.metaDescription].join("\n");
}

describe("agent SEO catalog", () => {
  it("has one entry per launchable agent, with unique slugs", () => {
    const slugs = AGENT_SEO_ENTRIES.map((entry) => entry.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(AGENT_SEO_SLUGS).toEqual(slugs);
    // The hub's ItemList is the full launchable lineup: a new launchable agent
    // needs a page, and a page never outlives its agent.
    expect([...slugs].sort()).toEqual(AGENTS.map((agent) => agent.id).sort());
    // Every entry has its words, and the directory lists the same agents in the same order.
    expect(Object.keys(AGENT_PAGE_CONTENT).sort()).toEqual([...slugs].sort());
    expect(HUB_CONTENT.directory.cards.map((card) => card.slug)).toEqual(slugs);
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: maps to an available agent, not a computer profile", (entry) => {
    const agent = getAgent(entry.slug);
    expect(agent?.available).toBe(true);
    expect(agent?.resourceKind ?? "agent").toBe("agent");
  });

  // The pages publish `${metaTitle} | Hivra` as an absolute title, which is the finished title (Ash's, bar the
  // three run-level titles reworded on 2026-10-21). The budget is 60 bare characters, the length of the longest
  // of Ash's six original titles: the bare title must not carry the brand and has to fit before the suffix.
  it.each(AGENT_SEO_ENTRIES)("$slug: the bare title fits before the ' | Hivra' suffix and never repeats the brand", (entry) => {
    expect(entry.metaTitle.length).toBeLessThanOrEqual(60);
    expect(entry.metaTitle).not.toMatch(/\|\s*Hivra/i);
    expect(agentPageTitle(entry)).toBe(`${entry.metaTitle} | Hivra`);
    expect(agentPageTitle(entry).match(/\|\s*Hivra/gi)).toHaveLength(1);
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: meta description is 110-160 characters", (entry) => {
    expect(entry.metaDescription.length).toBeGreaterThanOrEqual(110);
    expect(entry.metaDescription.length).toBeLessThanOrEqual(160);
  });

  // Ash's titles and descriptions are the source; this pins the Codex description the lane had once shortened to
  // fit its own caps, so a later edit cannot quietly trim it again. Three titles are the exception (2026-10-21):
  // his said the agent itself is "Always-On" (Codex), "Always Available" (OpenClaw) or runs "Even When Your Laptop
  // Is Off" (Claude Code). Only the computer staying on is promised on every computer, so each now says that.
  it("keeps Ash's finished Codex description word for word and the three run-level titles on the computer", () => {
    expect(agentPageTitle(getAgentSeoEntry("claude-code")!)).toBe("Run Claude Code in the Cloud, on a Computer That Stays On | Hivra");
    expect(agentPageTitle(getAgentSeoEntry("codex")!)).toBe("Run OpenAI Codex on a Cloud Computer That Stays On | Hivra");
    expect(agentPageTitle(getAgentSeoEntry("openclaw")!)).toBe("OpenClaw Hosting: Message It on a Computer That Stays On | Hivra");
    expect(getAgentSeoEntry("codex")!.metaDescription).toBe(
      "Host the official OpenAI Codex CLI on a private cloud VM. Sign in with ChatGPT or an OpenAI API key and keep your coding workspace available. From $9.99/mo.",
    );
  });

  // lib/blog/runtime-facts.ts: the computer stays on (paid plans), and a run started inside tmux, or on Claude Code
  // one sent through Telegram, keeps going. Neither the Claude Code or Codex CLI is itself promised to be "always
  // on". The OpenClaw gateway does run on the computer itself, but the 2026-10-21 copy fix list moved its claim to
  // the computer as well, so no title or description says any agent is "always on".
  it.each(AGENT_SEO_ENTRIES)("$slug: the title, description and h1 never say the agent is always on or runs with the laptop off", (entry) => {
    const text = `${entry.metaTitle}\n${entry.metaDescription}\n${getAgentPageContent(entry.slug)!.h1}`;
    expect(text).not.toMatch(AGENT_ALWAYS_ON_CLAIM);
  });

  it.each(AGENT_SEO_ENTRIES.filter((entry) => ["claude-code", "codex", "openclaw"].includes(entry.slug)))(
    "$slug: a stays-on title makes the claim about the computer",
    (entry) => {
      expect(entry.metaTitle).toMatch(/\bcomputer that stays on$/i);
    },
  );

  it("scans for the retired title wording, so the check above can fail", () => {
    for (const title of [
      "Run Claude Code in the Cloud, Even When Your Laptop Is Off",
      "Run Claude Code in the Cloud, Even With Your Laptop Off",
      "Run OpenAI Codex on an Always-On Cloud Computer",
      "Run OpenAI Codex on an Always On Cloud Computer",
      "OpenClaw Hosting: An Agent You Can Message, Always Available",
    ]) {
      expect({ title, retired: AGENT_ALWAYS_ON_CLAIM.test(title) }).toEqual({ title, retired: true });
    }
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: makes none of the banned claims", (entry) => {
    const copy = copyOf(entry.slug);
    for (const { pattern, reason } of AGENT_COPY_BANNED_PATTERNS) {
      const match = copy.match(pattern);
      if (match) throw new Error(`/agents/${entry.slug} says "${match[0]}" (${reason})`);
    }
  });

  it("makes none of the banned claims on the directory page", () => {
    const copy = hubCopy(HUB_CONTENT).join("\n");
    for (const { pattern, reason } of AGENT_COPY_BANNED_PATTERNS) {
      const match = copy.match(pattern);
      if (match) throw new Error(`/agents says "${match[0]}" (${reason})`);
    }
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: says computer, not box, and names only tabs the agent page shows", (entry) => {
    const copy = copyOf(entry.slug);
    expect(copy.match(/Box Terminal|\bbox(?:es)?\b|\b(?:runtimes?|instances?)\b/gi)).toBeNull();
    expect(unknownDashboardNames(copy)).toEqual([]);
  });

  it("scans the literal phrases the owner ruled out", () => {
    const copy = [...AGENT_SEO_ENTRIES.map((entry) => copyOf(entry.slug)), ...hubCopy(HUB_CONTENT), AGENTS_HUB_AFFILIATION].join("\n").toLowerCase();
    for (const phrase of ["free trial", "card required", "never sleeps", "seven-day", "starter plan"]) {
      expect(copy).not.toContain(phrase);
    }
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: names its vendor in an explicit non-affiliation line", (entry) => {
    const agent = getAgent(entry.slug)!;
    const { affiliation } = getAgentPageContent(entry.slug)!;
    expect(affiliation).toMatch(/^Hivra (?:is independent|independently hosts [A-Za-z ]+) and is not affiliated with (?:or endorsed by )?/);
    // Hermes's catalog vendor is Nous Research; the projects are named as projects.
    expect(affiliation).toContain(agent.vendor);
    expect(AGENTS_HUB_AFFILIATION).toContain(agent.vendor);
    expect(HUB_CONTENT.affiliation).toBe(AGENTS_HUB_AFFILIATION);
  });

  it.each(AGENT_SEO_ENTRIES)("$slug: deploy CTA is sign-up with an accepted agentType and no plan", (entry) => {
    const href = agentDeployHref(entry);
    expect(href.startsWith(`${PUBLIC_START_HREF}?`)).toBe(true);
    const query = new URLSearchParams(href.split("?")[1]);
    // A plan here would send a new account to checkout before Launch (FTUE-16).
    expect(query.has("plan")).toBe(false);
    // An agentType sign-up does not know opens a generic Launch, losing the
    // agent this page is about.
    expect(resolveWelcomeAgentTypeKey(query.get("agentType"))).toBe(entry.agentType);
  });

  it("launches Hermes as the general agent type and every other runtime under its own id", () => {
    for (const entry of AGENT_SEO_ENTRIES) {
      expect(entry.agentType).toBe(entry.slug === "hermes" ? "general" : entry.slug);
    }
    expect(AGENTS_HUB_DEPLOY_HREF).toBe(PUBLIC_START_HREF);
  });

  it("sends every agent page's deploy button to sign-up, which opens Launch on that agent", () => {
    for (const entry of AGENT_SEO_ENTRIES) {
      const href = new URL(agentDeployHref(entry), "https://hivra.test");
      expect(href.pathname).toBe(PUBLIC_START_HREF);
      expect(launchProfileForAgentType(href.searchParams.get("agentType"))).toBe(entry.slug);
    }
  });

  it("describes the steps in terms of Launch, never the old plan page", () => {
    for (const entry of AGENT_SEO_ENTRIES) {
      expect(copyOf(entry.slug)).not.toMatch(/get-started|get started page/i);
    }
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

    let sized = 0;
    for (const entry of AGENT_SEO_ENTRIES) {
      const copy = copyOf(entry.slug);
      expect(copy).toContain("$9.99");
      for (const match of copy.matchAll(/\$(\d+\.\d\d)[^.]*?(\d) vCPU and (\d) GB/g)) {
        const [, price, cpu, ram] = match;
        sized += 1;
        if (price === "9.99") expect([cpu, ram]).toEqual(["2", "4"]);
        if (price === "19.99") expect([cpu, ram]).toEqual(["4", "8"]);
      }
      // Whenever $19.99 appears, its size is in the same sentence (lib/tools/copy-rules.ts).
      for (const sentence of copy.split(/(?<=[.!?])\s+|\n+/).filter((line) => line.includes("$19.99"))) {
        expect(sentence).toMatch(/4 vCPU and 8 GB/);
      }
    }
    expect(sized).toBeGreaterThan(0);
  });

  // Owner decision 2026-10-21: every computer Hivra Cloud runs for you is paid, for every agent alike. The old
  // test expected "needs a paid size" on exactly the agents whose retired minPlan floor was not "free", which made
  // OpenClaw and Agent Zero look like the only paid ones.
  it("states the same paid-computer rule on every agent page, and no description names one agent as the paid one", () => {
    for (const entry of AGENT_SEO_ENTRIES) {
      const copy = copyOf(entry.slug);
      expect(copy).toMatch(/needs a paid plan/);
      expect(copy).not.toMatch(/needs a paid size/i);
      expect(entry.metaDescription).not.toMatch(/\bpaid\b/i);
    }
  });

  it("matches the resource claims to the agent catalog floors", () => {
    expect(BROWSER_ADD).toEqual({ cpu: 1, ram: 2 });
    // OpenClaw: 1 vCPU / 2 GB, or 2 / 4 with the browser on.
    expect(resizeFloor("openclaw", false)).toEqual({ cpu: 1, ram: 2 });
    expect(resizeFloor("openclaw", true)).toEqual({ cpu: 2, ram: 4 });
    // Agent Zero: 1 vCPU / 2 GB minimum, never a fixed 2 / 4.
    expect(resizeFloor("agent-zero", false)).toEqual({ cpu: 1, ram: 2 });
    expect(copyOf("agent-zero")).not.toMatch(/fixed 2 vCPU/i);
    // "Fits within the $9.99 plan" for the coding agents with the browser on.
    for (const id of ["claude-code", "codex"]) {
      expect(getAgent(id)?.browser).toBe(true);
      const floor = resizeFloor(id, true);
      expect(floor.cpu).toBeLessThanOrEqual(PLANS.operator.totalCpu);
      expect(floor.ram * 1024).toBeLessThanOrEqual(PLANS.operator.totalRam);
    }
    // OpenClaw's browser also fits the $9.99 size ("The entry plan's 2 vCPU and 4 GB of RAM is enough").
    expect(resizeFloor("openclaw", true).cpu).toBeLessThanOrEqual(PLANS.operator.totalCpu);
    expect(resizeFloor("openclaw", true).ram * 1024).toBeLessThanOrEqual(PLANS.operator.totalRam);
    // Aeon "does not draw on your plan's shared CPU and RAM".
    expect(isPoolExempt("aeon")).toBe(true);
    // The pages print these numbers from the same functions; pin the words.
    expect(copyOf("openclaw")).toContain("minimum of 1 vCPU and 2 GB of RAM");
    expect(copyOf("openclaw")).toContain("increases its allocation to 2 vCPU and 4 GB of RAM");
    expect(copyOf("agent-zero")).toContain("minimum footprint is 1 vCPU and 2 GB of RAM");
    for (const slug of ["claude-code", "codex", "openclaw"]) expect(copyOf(slug)).toContain("1 vCPU and 2 GB of RAM");
  });

  it("resolves entries by slug and rejects unknown slugs", () => {
    for (const slug of ["hermes", "claude-code", "codex", "aeon", "openclaw", "agent-zero"]) {
      expect(getAgentSeoEntry(slug)?.slug).toBe(slug);
      expect(getAgentPageContent(slug)?.slug).toBe(slug);
    }
    expect(getAgentSeoEntry("not-an-agent")).toBeUndefined();
    expect(getAgentSeoEntry("deepseek-harness")).toBeUndefined();
    expect(getAgentPageContent("not-an-agent")).toBeUndefined();
    expect(getAgentPageContent("constructor")).toBeUndefined();
  });

  // What a browser chat or session-tab run does after the tab closes depends on
  // whether the computer has the 2026.09.24.1 runtime (detached chat runs, the
  // session tab inside tmux). Existing computers get it only through an
  // owner-approved rollout, so the pages make neither claim. They promise what
  // holds on every computer: it stays on, and a run inside tmux in the Terminal
  // tab (or, for Claude Code, one sent through Telegram) keeps going.
  it("lists exactly the agents whose keep-running promises must say how the run starts", () => {
    expect([...CLI_RUN_AGENT_SLUGS].sort()).toEqual(["claude-code", "codex"]);
  });

  it.each(CLI_RUN_AGENT_SLUGS.map((slug) => [slug]))(
    "%s: every keeps-working claim says how, and no claim depends on the computer's runtime version",
    (slug) => {
      const content = getAgentPageContent(slug)!;
      const copy = copyOf(slug);
      // The question "Will Claude Code keep running when I shut my laptop?" is a question, not a promise;
      // its answer is scanned below. Everything else must be qualified.
      const questions = new Set(content.faqs.map((faq) => faq.q));
      const withoutQuestions = copy
        .split("\n")
        .filter((line) => !questions.has(line))
        .join("\n");
      expect(unqualifiedKeepRunningClaims(withoutQuestions)).toEqual([]);
      expect(copy).toMatch(/\b(?:inside|within) tmux in (?:the computer's|the|Hivra's) Terminal tab/);
      expect(copy).not.toMatch(/Box Terminal|\bthe box\b/i);
      // Neither "stops when you close the tab" nor "the browser chat keeps going".
      for (const { pattern } of AGENT_COPY_BANNED_PATTERNS) expect(copy).not.toMatch(pattern);
      // The answer to the laptop question names tmux and keeps its paid qualifier.
      const laptop = content.faqs.find((faq) => /laptop|log off/i.test(faq.q));
      expect(laptop?.a).toMatch(/`tmux`/);
      expect(laptop?.a).not.toMatch(/browser chat|stops when you close/i);
    },
  );

  it("offers Telegram for Claude Code only, where the Telegram tab is verified", () => {
    const claude = copyOf("claude-code");
    expect(claude).toMatch(/\bTelegram\b/);
    expect(claude).toMatch(/Telegram tab, under Manage/);
    expect(copyOf("codex")).not.toMatch(/Telegram/);
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
    // Scoped to sentences about Claude Code and Codex when the copy covers others too.
    expect(unqualifiedKeepRunningClaims("Hermes keeps working with the laptop closed.", /Claude Code|Codex/)).toEqual([]);
  });

  it("bans the old false claims and both version-dependent tab claims", () => {
    const banned = (claim: string) => AGENT_COPY_BANNED_PATTERNS.some(({ pattern }) => pattern.test(claim));
    for (const claim of [
      // Retired survives-anything claims.
      "no SIGHUP",
      "No tmux required.",
      "Survives laptop sleep: Yes",
      "Close your laptop. It keeps working.",
      // The copy these pages carried before the 2026.09.24.1 runtime: false on
      // updated computers.
      "A run you start in the browser chat or the Claude Code Terminal stops when you close that tab.",
      "A run in the browser chat or the Codex Terminal stops when you close that tab.",
      "Claude Code and Codex runs started in the browser chat or agent terminal stop when that tab closes.",
      // The opposite promise: false on computers without the runtime update.
      "A run you start in the browser chat keeps going after you close the tab.",
      // Invented setup time (2026-09-30 copy audit, F-15).
      "A DIY setup costs a VPS bill plus the weekend you spend configuring it.",
      "Setting it up yourself takes 4-8 hours.",
      "Budget 1-2 hours per month for upkeep.",
      // Copy-overhaul rules (2026-10-20): plan names, refund wording, implementer references.
      "The starter plan is $9.99 a month.",
      "Card payments include a seven-day money-back guarantee.",
      "Refunds apply if you are eligible.",
      "The source deployment notes give the minimum footprint.",
      "As described in the current site export.",
    ]) {
      expect({ claim, banned: banned(claim) }).toEqual({ claim, banned: true });
    }
    for (const claim of [
      "Start long work inside tmux in the computer's Terminal tab and it keeps going after you log off.",
      "Hermes is useful because it doesn't stop when you close a browser tab.",
      "On Hivra it lives on a private virtual machine that stays on, so nothing resets when you close the tab.",
      "A DIY setup costs a VPS bill plus the time you spend configuring and updating it.",
      "There is a 7-day money-back guarantee on card payments, subject to the published terms.",
      "The entry plan is $9.99 a month for 2 vCPU and 4 GB of RAM.",
    ]) {
      expect({ claim, banned: banned(claim) }).toEqual({ claim, banned: false });
    }
  });

  it("says what the Aeon GitHub token is used for and which permissions it needs", () => {
    // provisioner/hivra-chat/server.js finalizeAeonConnect: forks or syncs the
    // user's Aeon repo, enables its Actions, repoints the box clone, and fails
    // the connect unless the token can write Actions secrets there.
    const copy = copyOf("aeon");
    expect(copy).not.toMatch(/sign in to GitHub and start the dashboard/);
    expect(copy).toMatch(/creates or synchronises your fork/);
    expect(copy).toMatch(/enables Actions/);
    expect(copy).toMatch(/task secrets/);
    expect(copy).toMatch(/Secrets, Actions, Contents and Workflows/);
    // The connect stops with the fix in its message; the page says so as a fact, not as an instruction.
    expect(copy).toMatch(/the connection stops and tells you what needs changing/);
    expect(copy).not.toMatch(/\bshould identify\b/);
  });

  it("exposes a real sitemap lastmod date", () => {
    expect(AGENT_PAGES_LAST_MODIFIED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(new Date(AGENT_PAGES_LAST_MODIFIED).getTime())).toBe(false);
    // The copy overhaul (Ash's batch 02) landed on 2026-10-20.
    expect(AGENT_PAGES_LAST_MODIFIED >= "2026-10-20").toBe(true);
  });
});
