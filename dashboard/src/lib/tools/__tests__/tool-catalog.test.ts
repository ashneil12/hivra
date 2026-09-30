import fs from "fs";
import path from "path";
import {
  TOOLS_CTA,
  TOOLS_HUB,
  TOOL_ENTRIES,
  getToolEntry,
  nonAffiliationLine,
  toolOgImage,
  toolPath,
  type ToolComponentKey,
} from "../tool-catalog";
import { findBannedClaims } from "../copy-rules";
import { agentDeployHref, getAgentSeoEntry, unqualifiedKeepRunningClaims } from "@/lib/hivra/agent-seo-catalog";
import { unknownDashboardNames } from "@/lib/blog/runtime-facts";
import { PUBLIC_START_HREF } from "@/lib/public-start";

// componentKey -> the client component file the /tools/[slug] template maps it
// to (src/app/tools/[slug]/page.tsx). Keep both maps in sync.
const COMPONENT_FILES: Record<ToolComponentKey, string> = {
  "plan-calculator": "PlanCalculatorTool.tsx",
  "agent-survival-check": "AgentSurvivalCheckTool.tsx",
  "hosting-cost-calculator": "HostingCostCalculatorTool.tsx",
  "limit-reset-calculator": "LimitResetCalculatorTool.tsx",
  "keep-mac-awake": "KeepMacAwakeTool.tsx",
  "tmux-cheat-sheet": "TmuxCheatSheetTool.tsx",
};

const COMPONENTS_DIR = path.join(__dirname, "..", "..", "..", "components", "tools");

// Destinations a tools page may link to. /pricing and the two /agents pages
// are ported from the retired site alongside /tools; nothing else is linked
// because several older blog posts still carry stale prices. The one blog post
// allowed is the plan hub the plan calculator backs: it was written on
// 2026-09-30 from the same facts module (lib/tools/claude-plan-facts.ts), so it
// cannot carry a stale Anthropic figure.
const PLAN_HUB_POST = "/blog/claude-max-vs-pro-for-claude-code";
const ALLOWED_RELATED = new Set([
  "/pricing",
  "/agents/claude-code",
  "/agents/codex",
  PLAN_HUB_POST,
  ...TOOL_ENTRIES.map((entry) => toolPath(entry.slug)),
]);

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

describe("tools catalog", () => {
  it("has six entries with unique slugs", () => {
    expect(TOOL_ENTRIES.map((entry) => entry.slug)).toEqual([
      "claude-code-plan-calculator",
      "agent-survival-check",
      "ai-agent-hosting-cost-calculator",
      "claude-code-limit-reset-calculator",
      "keep-mac-awake",
      "tmux-cheat-sheet",
    ]);
  });

  it.each(TOOL_ENTRIES)("$slug: title fits before the root suffix and never repeats the brand", (entry) => {
    expect(entry.metaTitle.length).toBeLessThanOrEqual(55);
    expect(entry.metaTitle).not.toMatch(/\|\s*Hivra|Hivra\s*$/);
  });

  it.each(TOOL_ENTRIES)("$slug: metaDescription is 120-155 characters", (entry) => {
    expect(entry.metaDescription.length).toBeGreaterThanOrEqual(120);
    expect(entry.metaDescription.length).toBeLessThanOrEqual(155);
  });

  it("gives the hub a short title and a description within limits", () => {
    expect(TOOLS_HUB.metaTitle.length).toBeLessThanOrEqual(55);
    expect(TOOLS_HUB.metaTitle).not.toMatch(/Hivra/);
    expect(TOOLS_HUB.metaDescription.length).toBeGreaterThanOrEqual(120);
    expect(TOOLS_HUB.metaDescription.length).toBeLessThanOrEqual(155);
  });

  it.each(TOOL_ENTRIES)("$slug: has at least 4 FAQs with non-empty answers", (entry) => {
    expect(entry.faqs.length).toBeGreaterThanOrEqual(4);
    for (const faq of entry.faqs) {
      expect(faq.q.trim().length).toBeGreaterThan(0);
      expect(faq.a.trim().length).toBeGreaterThan(0);
    }
  });

  it.each(TOOL_ENTRIES)("$slug: makes none of the banned claims in any copy string", (entry) => {
    for (const text of collectStrings(entry)) {
      expect({ text, hits: findBannedClaims(text) }).toEqual({ text, hits: [] });
    }
  });

  it("keeps the hub copy free of banned claims", () => {
    for (const text of collectStrings(TOOLS_HUB)) {
      expect(findBannedClaims(text)).toEqual([]);
    }
  });

  it("describes Hivra's own plan by price and size, at the $9.99 checkout plan", () => {
    const copy = TOOL_ENTRIES.flatMap((entry) => collectStrings(entry)).join("\n");
    for (const mention of copy.match(/\$9\.99[^.]*\./g) ?? []) {
      expect(mention).toMatch(/2 vCPU and 4 GB|not paused for inactivity|installs and runs the agent/);
    }
    expect(copy).toMatch(/\$9\.99 a month for 2 vCPU and 4 GB/);
  });

  it.each(TOOL_ENTRIES)("$slug: has the structural copy blocks the page renders", (entry) => {
    expect(entry.name.trim().length).toBeGreaterThan(0);
    expect(entry.h1.trim().length).toBeGreaterThan(0);
    expect(entry.subhead.trim().length).toBeGreaterThan(0);
    expect(entry.primaryKeyword.trim().length).toBeGreaterThan(0);
    expect(entry.longIntro).toHaveLength(2);
    expect(entry.vendors.length).toBeGreaterThan(0);
  });

  it.each(TOOL_ENTRIES)("$slug: every componentKey has a component file", (entry) => {
    const file = COMPONENT_FILES[entry.componentKey];
    expect(file).toBeDefined();
    expect(fs.existsSync(path.join(COMPONENTS_DIR, file))).toBe(true);
  });

  it.each(TOOL_ENTRIES)("$slug: related links stay on routes that exist after the cutover", (entry) => {
    expect(entry.relatedLinks.length).toBeGreaterThanOrEqual(2);
    for (const link of entry.relatedLinks) {
      expect(ALLOWED_RELATED.has(link.href)).toBe(true);
      expect(link.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("sends the calls to action to sign-up, the $9.99 plan button to that plan, and to pricing", () => {
    expect(TOOLS_CTA).toEqual({
      primaryHref: PUBLIC_START_HREF,
      claudeCodeHref: `${PUBLIC_START_HREF}?agentType=claude-code`,
      codexHref: `${PUBLIC_START_HREF}?agentType=codex`,
      entryPlanHref: "/get-started?plan=operator",
      secondaryHref: "/pricing",
    });
    // "Run Claude Code on Hivra" and "Run Codex on Hivra" buttons preselect the
    // agent exactly the way the /agents pages do.
    expect(TOOLS_CTA.claudeCodeHref).toBe(agentDeployHref(getAgentSeoEntry("claude-code")!));
    expect(TOOLS_CTA.codexHref).toBe(agentDeployHref(getAgentSeoEntry("codex")!));
  });

  it("states the $19.99 size inline and never sends readers to /pricing for sizes", () => {
    const copy = TOOL_ENTRIES.flatMap((entry) => collectStrings(entry)).join("\n");
    expect(copy).toMatch(/\$19\.99 a month for 4 vCPU and 8 GB/);
    for (const mention of copy.match(/\$19\.99[^.]*\./g) ?? []) {
      expect(mention).toMatch(/4 vCPU and 8 GB/);
    }
    expect(copy).not.toMatch(/pricing page/i);
    // The rules themselves: a bare $19.99 or a pointer to /pricing for sizes is banned.
    expect(findBannedClaims("Hivra charges $9.99 a month, with larger sizes on the pricing page.")).not.toEqual([]);
    expect(findBannedClaims("Compare sizes on the pricing page.")).not.toEqual([]);
    expect(findBannedClaims("the $19.99 plan")).not.toEqual([]);
    expect(findBannedClaims("$19.99 a month for 4 vCPU and 8 GB.")).toEqual([]);
  });

  it("only says Hivra keeps a run going when the run is started inside tmux or from Telegram", () => {
    const copy = TOOL_ENTRIES.flatMap((entry) => collectStrings(entry)).join("\n");
    expect(unqualifiedKeepRunningClaims(copy, /Hivra|always-on (?:box|computer)|managed (?:box|computer)/i)).toEqual([]);
    expect(copy).toMatch(/inside tmux in the computer's Terminal tab, or send it from Telegram/);
    expect(copy).not.toMatch(/Box Terminal|browser chat|\b(?:the|a|managed|cloud|always-on) box\b/i);
    expect(unknownDashboardNames(copy)).toEqual([]);
    for (const claim of [
      // Retired survives-anything claims.
      "no lid, no SIGHUP",
      "No tmux required.",
      "Survives laptop sleep: Yes",
      // False on computers with the 2026.09.24.1 runtime.
      "A run in the browser chat stops when you close that tab.",
      "On Hivra, close the tab or let the laptop sleep and that Claude Code or Codex run stops.",
      "Closing the tab ends a browser run",
      // False on computers without it.
      "A run in the browser chat keeps going after you close the tab.",
    ]) {
      expect({ claim, banned: findBannedClaims(claim).length > 0 }).toEqual({ claim, banned: true });
    }
    expect(findBannedClaims("Start the run inside tmux in the computer's Terminal tab and it keeps going with your laptop closed.")).toEqual([]);
  });

  it("does not imply the Hivra side of the cost calculator includes backups", () => {
    const intro = getToolEntry("ai-agent-hosting-cost-calculator")!.longIntro.join(" ");
    expect(intro).not.toMatch(/the server, backups, setup time/);
    expect(intro).toMatch(/Hivra's price does not include backups/);
  });

  it("names the vendors each page discusses in its non-affiliation line", () => {
    expect(nonAffiliationLine(["Anthropic"])).toBe("Hivra is independent and is not affiliated with Anthropic.");
    expect(nonAffiliationLine(["Anthropic", "OpenAI"])).toBe("Hivra is independent and is not affiliated with Anthropic or OpenAI.");
    expect(nonAffiliationLine(["A", "B", "C"])).toBe("Hivra is independent and is not affiliated with A, B or C.");
  });

  it("points social cards at the tools image routes", () => {
    expect(toolOgImage().url).toBe("/tools/opengraph-image");
    expect(toolOgImage("agent-survival-check").url).toBe("/tools/agent-survival-check/opengraph-image");
  });

  it("resolves entries by slug and 404s unknown slugs", () => {
    expect(getToolEntry("claude-code-plan-calculator")?.slug).toBe("claude-code-plan-calculator");
    expect(getToolEntry("not-a-tool")).toBeUndefined();
  });
  // The optional page-level method section and worked examples. The plan
  // calculator and the two newer tools carry both; the other three are upgraded
  // in a later slice.
  describe("method section and worked examples", () => {
    const WITH_METHOD = TOOL_ENTRIES.filter((entry) => entry.method);

    it("is carried by the plan calculator, the keep-awake builder and the tmux cheat sheet", () => {
      expect(WITH_METHOD.map((entry) => entry.slug)).toEqual(["claude-code-plan-calculator", "keep-mac-awake", "tmux-cheat-sheet"]);
    });

    it.each(WITH_METHOD)("$slug: method has a heading, an ISO verified date and linked https sources", (entry) => {
      const method = entry.method!;
      expect(method.heading.trim().length).toBeGreaterThan(0);
      expect(method.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(method.lastVerified))).toBe(false);
      expect(method.paragraphs.length).toBeGreaterThanOrEqual(4);
      const sources = method.paragraphs.flatMap((paragraph) => paragraph.sources ?? []);
      expect(sources.length).toBeGreaterThanOrEqual(2);
      for (const source of sources) {
        expect(source.url).toMatch(/^https:\/\//);
        expect(source.label.trim().length).toBeGreaterThan(0);
      }
    });

    it.each(WITH_METHOD)("$slug: has at least three worked examples with inputs, the exact output and a stated result", (entry) => {
      expect(entry.examples!.length).toBeGreaterThanOrEqual(3);
      for (const example of entry.examples!) {
        expect(example.title.trim().length).toBeGreaterThan(0);
        expect(example.inputs.trim().length).toBeGreaterThan(0);
        expect(example.command.trim().length).toBeGreaterThan(0);
        expect(example.result.trim().length).toBeGreaterThan(0);
      }
    });

    it.each(WITH_METHOD)("$slug: method and examples make none of the banned claims", (entry) => {
      for (const text of collectStrings({ method: entry.method, examples: entry.examples })) {
        expect({ text, hits: findBannedClaims(text) }).toEqual({ text, hits: [] });
      }
    });

    it("targets the head queries the pipeline names, without the brand in the title", () => {
      const awake = getToolEntry("keep-mac-awake")!;
      expect(awake.primaryKeyword).toBe("caffeinate mac");
      expect(awake.h1).toMatch(/^Caffeinate on Mac/);
      const tmux = getToolEntry("tmux-cheat-sheet")!;
      expect(tmux.primaryKeyword).toBe("tmux cheat sheet");
      expect(tmux.h1).toBe("tmux cheat sheet");
    });

    it("never names the operating system the public copy rules ban, in any catalog string", () => {
      for (const slug of ["claude-code-plan-calculator", "keep-mac-awake", "tmux-cheat-sheet"]) {
        for (const text of collectStrings(getToolEntry(slug))) {
          expect(text).not.toMatch(/\bWindows\b/);
        }
      }
    });

    it("links the plan calculator to the plan hub post it backs, once", () => {
      const links = getToolEntry("claude-code-plan-calculator")!.relatedLinks.map((link) => link.href);
      expect(links.filter((href) => href === PLAN_HUB_POST)).toHaveLength(1);
    });

    it("links the two new tools to each other and to the survival check", () => {
      const awake = getToolEntry("keep-mac-awake")!.relatedLinks.map((link) => link.href);
      const tmux = getToolEntry("tmux-cheat-sheet")!.relatedLinks.map((link) => link.href);
      expect(awake).toEqual(expect.arrayContaining(["/tools/agent-survival-check", "/tools/tmux-cheat-sheet"]));
      expect(tmux).toEqual(expect.arrayContaining(["/tools/keep-mac-awake", "/tools/agent-survival-check"]));
    });
  });
});
