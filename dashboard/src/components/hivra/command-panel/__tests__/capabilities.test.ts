import { commandPanelCapabilities } from "../capabilities";
import { agentRow, tabsFor } from "./fixtures";
import { AGENTS } from "@/lib/hivra/agent-catalog";

const ids = (type: string, extra = {}) => {
  const agent = agentRow(type, extra);
  return commandPanelCapabilities(agent, tabsFor(agent))?.actions.map((a) => a.id) ?? null;
};

describe("commandPanelCapabilities", () => {
  it("is only for agents whose catalog entry says their screen is their own web UI", () => {
    for (const def of AGENTS) {
      const agent = agentRow(def.id);
      const caps = commandPanelCapabilities(agent, tabsFor(agent));
      expect(caps !== null).toBe(def.surface === "dashboard");
    }
    for (const type of ["hermes", "claude-code", "codex", "linux-desktop"]) expect(ids(type)).toBeNull();
  });

  it("gives OpenClaw every action it supports, with the chat apps tile hidden by default", () => {
    const agent = agentRow("openclaw");
    const caps = commandPanelCapabilities(agent, tabsFor(agent))!;
    expect(caps.actions.map((a) => a.id)).toEqual(["update", "restart", "terminal", "browser", "files", "model", "size", "channels"]);
    expect(caps.actions.filter((a) => a.defaultShown).map((a) => a.id)).toEqual(["update", "restart", "terminal", "browser", "files", "model", "size"]);
    expect(caps.actions[0].label).toBe("Update OpenClaw");
    expect(caps.actions.find((a) => a.id === "terminal")?.target).toEqual({ kind: "surface", surface: "box", opening: "Opening Terminal" });
    expect(caps.actions.find((a) => a.id === "model")?.target).toMatchObject({ kind: "manage", section: "model" });
    expect(caps.actions.find((a) => a.id === "size")?.target).toMatchObject({ kind: "manage", section: "resources" });
  });

  it("gives Agent Zero no Browser tile (it ships its own inside) and keeps Model", () => {
    const list = ids("agent-zero")!;
    expect(list).toEqual(["update", "restart", "terminal", "files", "model", "size"]);
  });

  it("names Aeon's hosted dashboard, and offers no Model because Aeon has none to change here", () => {
    const agent = agentRow("aeon", { cpu: 0.5, ram: 1 });
    const caps = commandPanelCapabilities(agent, tabsFor(agent))!;
    expect(caps.actions.find((a) => a.id === "update")?.label).toBe("Update Aeon dashboard");
    expect(caps.actions.map((a) => a.id)).not.toContain("model");
  });

  it("gives DeepSeek Harness no Update or Model: Hivra has neither flow for it today", () => {
    expect(ids("deepseek-harness")).toEqual(["restart", "terminal", "files", "size"]);
  });

  it("drops what the computer cannot do", () => {
    const agent = agentRow("openclaw");
    const noRestart = { ...agent, manage: { ...agent.manage!, power: { ...agent.manage!.power, restart: null } } };
    expect(commandPanelCapabilities(noRestart, tabsFor(noRestart))!.actions.map((a) => a.id)).not.toContain("restart");
    const noUpdate = { ...agent, manage: { ...agent.manage!, connectionServiceUpdate: { state: "unavailable" as const, code: "x", reason: "x" } } };
    expect(commandPanelCapabilities(noUpdate, tabsFor(noUpdate))!.actions.map((a) => a.id)).not.toContain("update");
    // No terminal or files tab, no tiles for them.
    expect(commandPanelCapabilities(agent, ["aeon", "manage"])!.actions.map((a) => a.id)).not.toEqual(expect.arrayContaining(["terminal"]));
    // An older server that sends no capability map offers only the page's own surfaces.
    const legacy = { ...agent, manage: undefined };
    expect(commandPanelCapabilities(legacy, tabsFor(legacy))!.actions.map((a) => a.id)).toEqual(["terminal", "browser", "files", "channels"]);
  });

  it("suggests chat apps only where the agent has a real place to set them up", () => {
    const openclaw = agentRow("openclaw");
    const suggestion = commandPanelCapabilities(openclaw, tabsFor(openclaw))!.suggestions;
    expect(suggestion.map((s) => s.id)).toEqual(["channels"]);
    expect(suggestion[0].target).toMatchObject({ kind: "surface", surface: "aeon" });
    // No dashboard tab to open: no suggestion.
    expect(commandPanelCapabilities(openclaw, ["box", "files", "manage"])!.suggestions).toEqual([]);
    for (const type of ["agent-zero", "aeon", "deepseek-harness"]) {
      const agent = agentRow(type);
      expect(commandPanelCapabilities(agent, tabsFor(agent))!.suggestions).toEqual([]);
    }
  });
});
