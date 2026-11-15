import { IMPORTABLE_TYPES, IMPORT_GUIDES, buildImportPrompt, importGuideFor } from "../agent-import";

// The move-an-agent contract: which kinds the box can restore, what the Manage
// panel tells the owner transfers, and the prompt the local agent follows.

describe("IMPORTABLE_TYPES", () => {
  it("covers the stateful agents only", () => {
    expect([...IMPORTABLE_TYPES].sort()).toEqual(["agent-zero", "claude-code", "codex", "openclaw"]);
    expect(IMPORTABLE_TYPES.has("aeon")).toBe(false); // state lives on the user's GitHub
    expect(IMPORTABLE_TYPES.has("linux-desktop")).toBe(false);
  });

  it("has a guide for every importable type", () => {
    for (const type of IMPORTABLE_TYPES) {
      const guide = importGuideFor(type);
      expect(guide).not.toBeNull();
      expect(guide!.transfers.length).toBeGreaterThan(0);
      expect(guide!.misses.length).toBeGreaterThan(0);
      expect(guide!.bundle).toContain("hivra-transfer.tar.gz");
    }
    expect(importGuideFor("aeon")).toBeNull();
  });
});

describe("buildImportPrompt", () => {
  const base = { boxUrl: "https://box-abc.trycloudflare.com", token: "hit_abc123", expiresAt: "2026-11-15T14:30:00.000Z" };

  it("points the local agent at the box's import endpoint with its token", () => {
    const prompt = buildImportPrompt({ ...base, agentType: "claude-code" });
    expect(prompt).toContain('POST "https://box-abc.trycloudflare.com/api/import"');
    expect(prompt).toContain("Authorization: Bearer hit_abc123");
    expect(prompt).toContain("--data-binary");
    expect(prompt).toContain("application/octet-stream");
  });

  it("carries the claude state paths and the work/ convention", () => {
    const prompt = buildImportPrompt({ ...base, agentType: "claude-code" });
    expect(prompt).toContain(".claude");
    expect(prompt).toContain(".claude.json");
    expect(prompt).toContain("/tmp/hivra-stage/work");
  });

  it("tells agent-zero to bundle its /a0/usr volume contents, not dotdirs", () => {
    const prompt = buildImportPrompt({ ...base, agentType: "agent-zero" });
    expect(prompt).toContain("/a0/usr");
    expect(prompt).toContain("docker inspect");
    expect(prompt).not.toContain(".claude");
  });

  it("tells the agent to explain the move and clean up", () => {
    const prompt = buildImportPrompt({ ...base, agentType: "codex" });
    expect(prompt).toContain("Tell them that in one sentence");
    expect(prompt).toContain("rm -f ~/hivra-transfer.tar.gz");
    expect(prompt).toContain(".codex");
  });

  it("still produces a usable prompt for an unknown type", () => {
    const prompt = buildImportPrompt({ ...base, agentType: "something-new" });
    expect(prompt).toContain("/api/import");
    expect(prompt).toContain("work/");
  });
});
