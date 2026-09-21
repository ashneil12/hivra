import {
  CURATED_TOOLS,
  getToolById,
  isInstallableToolEntry,
  TOOL_MCP_NAME_RE,
  type ToolEntry,
} from "@/data/curated-tools";
import { CURATED_SKILLS } from "@/data/curated-skills";

describe("curated-tools catalog integrity", () => {
  it("has unique tool ids", () => {
    const ids = CURATED_TOOLS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique, box-safe MCP server names", () => {
    const names = CURATED_TOOLS.map((t) => t.mcp.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of CURATED_TOOLS) {
      expect(t.mcp.name).toMatch(TOOL_MCP_NAME_RE);
    }
  });

  it("every referenced skillId exists in the curated skills catalog", () => {
    const skillIds = new Set(CURATED_SKILLS.map((s) => s.id));
    for (const t of CURATED_TOOLS) {
      for (const sid of t.skillIds ?? []) {
        expect(skillIds.has(sid)).toBe(true);
      }
    }
  });

  it("every installable tool is a runnable stdio command OR an https hosted url", () => {
    for (const t of CURATED_TOOLS.filter(isInstallableToolEntry)) {
      const transport = t.mcp.transport ?? "stdio";
      expect(["stdio", "http"]).toContain(transport);
      if (transport === "stdio") {
        expect(typeof t.mcp.command).toBe("string");
        expect((t.mcp.command as string).length).toBeGreaterThan(0);
        expect((t.mcp.command as string).startsWith("-")).toBe(false);
      } else {
        expect(t.mcp.url).toMatch(/^https:\/\//);
      }
    }
  });

  it("every env field declares label + flags", () => {
    for (const t of CURATED_TOOLS) {
      for (const f of t.env ?? []) {
        expect(f.key).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
        expect(typeof f.label).toBe("string");
        expect(typeof f.secret).toBe("boolean");
        expect(typeof f.required).toBe("boolean");
      }
    }
  });
});

describe("isInstallableToolEntry", () => {
  const base: ToolEntry = {
    id: "x",
    name: "X",
    description: "d",
    category: "research",
    trust: "trusted",
    mcp: { transport: "stdio", name: "x", command: "npx", args: ["-y", "pkg"] },
  };

  it("accepts a well-formed stdio tool", () => {
    expect(isInstallableToolEntry(base)).toBe(true);
  });

  it("rejects a tool with an unbuilt `requires`", () => {
    expect(isInstallableToolEntry({ ...base, requires: { docker: { image: "i", port: 1 } } })).toBe(false);
  });

  it("accepts an https hosted (http) tool, rejects a non-https or url-less one", () => {
    expect(isInstallableToolEntry({ ...base, mcp: { transport: "http", name: "x", url: "https://x/mcp" } })).toBe(true);
    expect(isInstallableToolEntry({ ...base, mcp: { transport: "http", name: "x", url: "http://insecure/mcp" } })).toBe(false);
    expect(isInstallableToolEntry({ ...base, mcp: { transport: "http", name: "x" } })).toBe(false);
  });

  it("rejects an unsafe MCP server name", () => {
    expect(isInstallableToolEntry({ ...base, mcp: { ...base.mcp, name: "bad name!" } })).toBe(false);
    expect(isInstallableToolEntry({ ...base, mcp: { ...base.mcp, name: "" } })).toBe(false);
  });

  it("rejects a missing or flag-like command", () => {
    expect(isInstallableToolEntry({ ...base, mcp: { ...base.mcp, command: "" } })).toBe(false);
    expect(isInstallableToolEntry({ ...base, mcp: { ...base.mcp, command: "-y" } })).toBe(false);
  });
});

describe("getToolById", () => {
  it("round-trips a real catalog id", () => {
    const first = CURATED_TOOLS[0];
    expect(getToolById(first.id)).toBe(first);
  });
  it("returns undefined for an unknown id", () => {
    expect(getToolById("nope-not-real")).toBeUndefined();
  });
});
