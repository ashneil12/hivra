// The agent tools as a set: with the flag on they are all in the catalog with unique slugs, mapped
// to a component file that exists, free of banned claims, and linked to only real tool pages.
// Entries are read straight from entries.ts so the test does not depend on the build-time flag.

import fs from "fs";
import path from "path";
import { AGENT_TOOL_ENTRIES } from "../entries";
import { isAgentToolsEnabled } from "../../agent-tools-flag";
import { findBannedClaims } from "../../copy-rules";

function everyString(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => everyString(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => everyString(item, out));
  return out;
}

const COMPONENTS_DIR = path.join(__dirname, "..", "..", "..", "..", "components", "tools");
const PAGE_MAP = fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "app", "tools", "[slug]", "page.tsx"), "utf8");

describe("agent tools flag", () => {
  it("is off unless the value is 1 or true", () => {
    expect(isAgentToolsEnabled("")).toBe(false);
    expect(isAgentToolsEnabled("0")).toBe(false);
    expect(isAgentToolsEnabled("1")).toBe(true);
    expect(isAgentToolsEnabled(" TRUE ")).toBe(true);
  });
});

describe("agent tool entries", () => {
  it("has seven entries with unique slugs and component keys", () => {
    expect(AGENT_TOOL_ENTRIES).toHaveLength(7);
    expect(new Set(AGENT_TOOL_ENTRIES.map((e) => e.slug)).size).toBe(7);
    expect(new Set(AGENT_TOOL_ENTRIES.map((e) => e.componentKey)).size).toBe(7);
  });

  it.each(AGENT_TOOL_ENTRIES.map((e) => [e.slug, e] as const))("%s: component exists and is mapped in the page template", (_slug, entry) => {
    expect(PAGE_MAP).toContain(`"${entry.componentKey}"`);
    const files = fs.readdirSync(COMPONENTS_DIR).filter((f) => f.endsWith("Tool.tsx"));
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it.each(AGENT_TOOL_ENTRIES.map((e) => [e.slug, e] as const))("%s: copy has no banned claims, dashes or partner language", (_slug, entry) => {
    const text = everyString(entry);
    for (const s of text.filter((t) => !/^https?:\/\//.test(t))) {
      expect(findBannedClaims(s)).toEqual([]);
    }
    expect(text.join("\n")).not.toMatch(/\b(LOI|letter of intent|Innovators|credits? agreed)\b/i);
  });

  it.each(AGENT_TOOL_ENTRIES.map((e) => [e.slug, e] as const))("%s: titles and description are within limits and the FAQ has real depth", (_slug, entry) => {
    expect(entry.metaTitle.length).toBeLessThanOrEqual(55);
    expect(entry.metaDescription.length).toBeGreaterThanOrEqual(120);
    expect(entry.metaDescription.length).toBeLessThanOrEqual(155);
    expect(entry.faqs.length).toBeGreaterThanOrEqual(4);
    expect(entry.method?.paragraphs.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("related links point only at real tool pages or known site pages", () => {
    const slugs = new Set(AGENT_TOOL_ENTRIES.map((e) => e.slug));
    const known = new Set(["claude-code-plan-calculator", "agent-survival-check", "ai-agent-hosting-cost-calculator", "claude-code-limit-reset-calculator", "keep-mac-awake", "tmux-cheat-sheet"]);
    for (const entry of AGENT_TOOL_ENTRIES) {
      for (const link of entry.relatedLinks) {
        const m = /^\/tools\/(.+)$/.exec(link.href);
        if (m) expect(slugs.has(m[1]) || known.has(m[1])).toBe(true);
      }
    }
  });
});
