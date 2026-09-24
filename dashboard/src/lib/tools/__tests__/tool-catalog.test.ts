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

// componentKey -> the client component file the /tools/[slug] template maps it
// to (src/app/tools/[slug]/page.tsx). Keep both maps in sync.
const COMPONENT_FILES: Record<ToolComponentKey, string> = {
  "plan-calculator": "PlanCalculatorTool.tsx",
  "agent-survival-check": "AgentSurvivalCheckTool.tsx",
  "hosting-cost-calculator": "HostingCostCalculatorTool.tsx",
  "limit-reset-calculator": "LimitResetCalculatorTool.tsx",
};

const COMPONENTS_DIR = path.join(__dirname, "..", "..", "..", "components", "tools");

// Destinations a tools page may link to. /pricing and the two /agents pages
// are ported from the retired site alongside /tools; nothing else is linked
// because several older blog posts still carry stale prices.
const ALLOWED_RELATED = new Set(["/pricing", "/agents/claude-code", "/agents/codex", ...TOOL_ENTRIES.map((entry) => toolPath(entry.slug))]);

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
  it("has four entries with unique slugs", () => {
    expect(TOOL_ENTRIES.map((entry) => entry.slug)).toEqual([
      "claude-code-plan-calculator",
      "agent-survival-check",
      "ai-agent-hosting-cost-calculator",
      "claude-code-limit-reset-calculator",
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

  it("sends the calls to action to the $9.99 checkout plan and to pricing", () => {
    expect(TOOLS_CTA).toEqual({
      primaryHref: "/get-started?plan=operator",
      claudeCodeHref: "/get-started?plan=operator&agentType=claude-code",
      secondaryHref: "/pricing",
    });
    // "Run Claude Code on Hivra" buttons preselect the runtime exactly the way
    // the /agents/claude-code page does.
    expect(TOOLS_CTA.claudeCodeHref).toBe(agentDeployHref(getAgentSeoEntry("claude-code")!));
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
    expect(unqualifiedKeepRunningClaims(copy, /Hivra|always-on box|managed box/i)).toEqual([]);
    for (const claim of ["no lid, no SIGHUP", "No tmux required.", "Survives laptop sleep: Yes"]) {
      expect(findBannedClaims(claim)).not.toEqual([]);
    }
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
});
