import {
  agentComputerPair,
  agentComputerPairLabel,
  agentLaunchWatchRow,
  agentSurfaceGroupOf,
  agentSurfaceGroups,
  agentSurfaceLabel,
  agentSurfacesFor,
  computerPlacementFor,
  computerSizeLabel,
} from "../agent-surfaces";
import { getAgent } from "@/lib/hivra/agent-catalog";

const RUNNING = { status: "running", chat_url: "https://box.example.com" };

describe("agentSurfacesFor", () => {
  it("pins every chat agent's tabs, Browser only for agents that ship one", () => {
    const full = ["chat", "terminal", "browser", "box", "files", "git", "skills", "telegram", "tasks", "manage"];
    expect(agentSurfacesFor({ type: "claude-code", ...RUNNING })).toEqual(full);
    expect(agentSurfacesFor({ type: "codex", ...RUNNING })).toEqual(full);
    // Browser stays discoverable while it is toggled off; the tab says so.
    expect(agentSurfacesFor({ type: "codex", status: "stopped" })).toEqual(full);
    expect(agentSurfacesFor({ type: "hermes" })).toEqual(full.filter((id) => id !== "browser"));
  });

  it("never gives an agent a Desktop, and gives dashboard runtimes their dashboard", () => {
    expect(agentSurfacesFor({ type: "aeon", ...RUNNING })).toEqual(["aeon", "box", "files", "manage"]);
    expect(agentSurfacesFor({ type: "openclaw", ...RUNNING })).toEqual(["aeon", "browser", "box", "files", "manage"]);
    for (const type of ["claude-code", "codex", "aeon", "openclaw", "agent-zero"]) {
      expect(agentSurfacesFor({ type, ...RUNNING })).not.toContain("desktop");
    }
  });

  it("gates a computer's workspace tabs on a running, connected, non-Windows computer", () => {
    expect(agentSurfacesFor({ type: "linux-desktop", computer_profile: "ubuntu-desktop", ...RUNNING })).toEqual(["desktop", "box", "files", "manage"]);
    expect(agentSurfacesFor({ type: "linux-desktop", computer_profile: "ubuntu-desktop", status: "running" })).toEqual(["desktop", "manage"]);
    expect(agentSurfacesFor({ type: "linux-desktop", computer_profile: "windows", ...RUNNING })).toEqual(["desktop", "manage"]);
    expect(agentSurfacesFor({ type: "linux-terminal", computer_substrate: "gvisor", ...RUNNING })).toEqual(["manage"]);
  });

  it("gives a DigitalOcean session Chat and its read-only Files", () => {
    expect(agentSurfacesFor({ type: "codex", computer_substrate: "do-managed-session", ...RUNNING })).toEqual(["chat", "files"]);
  });
});

describe("agent page groups", () => {
  it("groups a chat agent as Agent (Chat, its session) · Computer (Terminal, Files, Browser, Git) · Manage", () => {
    const def = getAgent("codex");
    expect(agentSurfaceGroups(agentSurfacesFor({ type: "codex" }), def)).toEqual([
      { id: "work", label: "Agent", surfaces: ["chat", "terminal"] },
      { id: "computer", label: "Computer", surfaces: ["box", "files", "browser", "git"] },
      { id: "manage", label: "Manage", surfaces: ["manage", "skills", "tasks", "telegram"] },
    ]);
  });

  it("never gives a chat agent's group the name of a tab inside it", () => {
    // "Chat" under "Chat" read as two bars for the same thing (owner feedback).
    for (const type of ["codex", "claude-code", "hermes"]) {
      const def = getAgent(type);
      for (const group of agentSurfaceGroups(agentSurfacesFor({ type }), def)) {
        if (group.id === "manage") continue; // Its own tab reads "Settings" inside the group.
        expect(group.surfaces.map((id) => agentSurfaceLabel(id, def))).not.toContain(group.label);
      }
    }
  });

  it("leads a dashboard runtime with its dashboard and drops empty groups", () => {
    const def = getAgent("aeon");
    expect(agentSurfaceGroups(agentSurfacesFor({ type: "aeon" }), def)).toEqual([
      { id: "work", label: "Dashboard", surfaces: ["aeon"] },
      { id: "computer", label: "Computer", surfaces: ["box", "files"] },
      { id: "manage", label: "Manage", surfaces: ["manage"] },
    ]);
    expect(agentSurfaceGroups(["manage"], def)).toEqual([{ id: "manage", label: "Manage", surfaces: ["manage"] }]);
  });

  it("calls the shell Terminal everywhere and the agent's own CLI its session", () => {
    expect(agentSurfaceLabel("box", getAgent("codex"))).toBe("Terminal");
    expect(agentSurfaceLabel("terminal", getAgent("codex"))).toBe("Codex session");
    expect(agentSurfaceLabel("terminal", getAgent("claude-code"))).toBe("Claude Code session");
    expect(agentSurfaceGroupOf("git")).toBe("computer");
    expect(agentSurfaceGroupOf("telegram")).toBe("manage");
  });
});

describe("where the computer runs", () => {
  it("names placement from the stored binding", () => {
    expect(computerPlacementFor({ deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm" })).toBe("hivra-cloud");
    expect(computerPlacementFor({})).toBe("hivra-cloud");
    expect(computerPlacementFor({ deployment_mode: "self-managed", computer_substrate: "proxmox-kvm" })).toBe("my-server");
    expect(computerPlacementFor({ deployment_mode: "self-managed", computer_substrate: "gvisor" })).toBe("my-server");
    expect(computerPlacementFor({ deployment_mode: "self-managed", computer_substrate: "provider-vm" })).toBe("my-cloud");
    expect(computerPlacementFor({ deployment_mode: "self-managed", computer_substrate: "do-managed-session" })).toBe("digitalocean");
  });

  it("shows the linked pair from the agent's side", () => {
    expect(agentComputerPairLabel({ deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", cpu: 1.5, ram: 3 }))
      .toBe("on its own computer (Hivra Cloud · 1.5 CPU / 3 GB)");
    expect(agentComputerPairLabel({ deployment_mode: "self-managed", computer_substrate: "do-managed-session", cpu: 2, ram: 4 }))
      .toBe("on its own computer (My cloud · DigitalOcean · 2 CPU / 4 GB)");
    expect(agentComputerPairLabel({ deployment_mode: "self-managed", computer_substrate: "provider-vm", cpu: null, ram: null }))
      .toBe("on its own computer (My cloud)");
    expect(computerSizeLabel({ cpu: 0.5, ram: 1 })).toBe("0.5 CPU / 1 GB");
    expect(computerSizeLabel({ cpu: 0, ram: 1 })).toBeNull();
  });
});

describe("agentLaunchWatchRow (ATT-15)", () => {
  const codex = { type: "codex", deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm" };

  it("lists where the owner watches the agent, and leaves out a browser that is off", () => {
    expect(agentLaunchWatchRow(codex, { browser: true })).toBe("Chat, Codex session, Terminal, Files, Browser (view-only) and Git");
    // Off at launch: the Browser tab only explains how to turn it on.
    expect(agentLaunchWatchRow(codex, { browser: false })).toBe("Chat, Codex session, Terminal, Files and Git");
  });

  it("describes a computer in the owner's own cloud with the same tabs", () => {
    expect(agentLaunchWatchRow({ ...codex, computer_substrate: "provider-vm", deployment_mode: "self-managed" }, { browser: true }))
      .toBe("Chat, Codex session, Terminal, Files, Browser (view-only) and Git");
  });

  it("describes a DigitalOcean session honestly", () => {
    expect(agentLaunchWatchRow({ ...codex, computer_substrate: "do-managed-session" }, { browser: false })).toBe("Chat and Files");
  });
});

describe("agentComputerPair (ATT-11)", () => {
  it("names placement and size from the stored binding", () => {
    expect(agentComputerPair({ computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed", cpu: 1.5, ram: 3 }))
      .toEqual({ relation: "On its own computer", placement: "Hivra Cloud", size: "1.5 CPU / 3 GB" });
    expect(agentComputerPairLabel({ computer_substrate: "provider-vm", deployment_mode: "self-managed", cpu: 2, ram: 4 }))
      .toBe("on its own computer (My cloud · 2 CPU / 4 GB)");
  });

  it("claims no placement a row doesn't carry", () => {
    expect(agentComputerPair({ cpu: 2, ram: 4 }).placement).toBeNull();
    expect(agentComputerPairLabel({ cpu: 2, ram: 4 })).toBe("on its own computer (2 CPU / 4 GB)");
    expect(agentComputerPairLabel({})).toBe("on its own computer");
  });
});
