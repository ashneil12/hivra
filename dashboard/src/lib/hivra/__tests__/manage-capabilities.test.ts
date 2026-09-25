import { manageCapabilitiesFor, type ManageCapabilitiesRow } from "../manage-capabilities";
import { manageAwaitsOperation } from "../manage-sections";
import { AGENT_CLI_VERSIONS } from "@/lib/infrastructure/portable-provisioner-contract";

// The Manage capability map for every kind of computer and agent: its
// sections, each control's state and reason, and that it never carries a
// private field to the browser.

const BINDING_HASH = "b".repeat(64);
const base = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Fixture",
  status: "running",
  desired_state: "running",
  cpu: 2,
  ram: 4,
  vmid: 1113,
  ip: "10.250.20.63",
  proxmox_host: "fixturenode11",
  created_at: "2026-09-01T10:00:00.000Z",
  provisioned_at: "2026-09-01T10:05:00.000Z",
  deployment_mode: "hivra-managed",
  computer_substrate: "proxmox-kvm",
  infrastructure_binding_token_enforced: true,
  infrastructure_binding_token_hash: BINDING_HASH,
  operation_id: null,
  operation_kind: null,
  operation_payload: { secret: "never-sent" },
  managed_provisioner_channel: "default",
  api_token: "fixture-bearer",
} satisfies ManageCapabilitiesRow & Record<string, unknown>;

const rows: Record<string, ManageCapabilitiesRow & Record<string, unknown>> = {
  ubuntu: { ...base, type: "linux-desktop", computer_profile: "ubuntu-desktop" },
  ubuntuUnbound: { ...base, type: "linux-desktop", computer_profile: "ubuntu-desktop", infrastructure_binding_token_enforced: false },
  ubuntuMyServer: { ...base, type: "linux-desktop", computer_profile: "ubuntu-desktop", deployment_mode: "self-managed", ip: "192.0.2.44" },
  preparedWindows: { ...base, type: "linux-desktop", computer_profile: "windows", cpu: 4, ram: 8, managed_provisioner_channel: "canary" },
  preparedOmarchy: { ...base, type: "linux-desktop", computer_profile: "omarchy", cpu: 4, ram: 8, managed_provisioner_channel: "canary" },
  windowsMyServer: { ...base, type: "linux-desktop", computer_profile: "windows", deployment_mode: "self-managed" },
  hetznerUbuntu: { ...base, type: "linux-desktop", computer_profile: "ubuntu-desktop", computer_substrate: "provider-vm", deployment_mode: "self-managed", vmid: null, ip: "192.0.2.80" },
  gvisor: { ...base, type: "linux-desktop", computer_profile: "linux-terminal", computer_substrate: "gvisor", deployment_mode: "self-managed", vmid: null, ip: null },
  digitalocean: { ...base, type: "codex", computer_substrate: "do-managed-session", deployment_mode: "self-managed", vmid: null, ip: null },
  codex: { ...base, type: "codex" },
  codexUnbound: { ...base, type: "codex", infrastructure_binding_token_enforced: false },
  claude: { ...base, type: "claude-code" },
  deepseek: { ...base, type: "deepseek-harness" },
  aeon: { ...base, type: "aeon", cpu: 0.5, ram: 1 },
  codexMyCloud: { ...base, type: "codex", computer_substrate: "provider-vm", deployment_mode: "self-managed", vmid: null },
};

const map = (name: keyof typeof rows, preparedMatch = true) => manageCapabilitiesFor(rows[name], { preparedMatch });

describe("manageCapabilitiesFor", () => {
  it.each([
    ["ubuntu", "ubuntu-proxmox", ["overview", "agents", "resources", "recovery", "network", "updates", "advanced"]],
    ["ubuntuUnbound", "ubuntu-proxmox", ["overview", "agents", "resources", "updates", "advanced"]],
    ["ubuntuMyServer", "ubuntu-proxmox", ["overview", "agents", "resources", "recovery", "network", "updates", "advanced"]],
    ["preparedWindows", "prepared", ["overview", "agents", "resources", "advanced"]],
    ["preparedOmarchy", "prepared", ["overview", "agents", "resources", "advanced"]],
    ["windowsMyServer", "windows-my-server", ["overview", "agents", "resources", "advanced"]],
    ["hetznerUbuntu", "my-cloud", ["overview", "agents", "resources", "advanced"]],
    ["gvisor", "linux-sandbox", ["overview", "resources", "command", "advanced"]],
    ["digitalocean", "digitalocean", ["overview", "resources", "advanced"]],
    ["codex", "chat-agent", ["overview", "model", "resources", "recovery", "updates", "advanced"]],
    ["codexUnbound", "chat-agent", ["overview", "model", "resources", "updates", "advanced"]],
    ["claude", "chat-agent", ["overview", "model", "resources", "recovery", "updates", "advanced"]],
    ["deepseek", "dashboard-agent", ["overview", "resources", "recovery", "advanced"]],
    ["aeon", "dashboard-agent", ["overview", "resources", "recovery", "updates", "advanced"]],
    ["codexMyCloud", "my-cloud-agent", ["overview", "model", "resources", "advanced"]],
  ] as const)("%s is a %s with sections %j", (name, variant, sections) => {
    const result = map(name);
    expect(result.variant).toBe(variant);
    expect(result.sections).toEqual(sections);
  });

  it("names where the computer runs from its placement, never a region", () => {
    expect(map("ubuntu").placement).toEqual({ id: "hivra-cloud", label: "Hivra Cloud" });
    expect(map("ubuntuMyServer").placement).toEqual({ id: "my-server", label: "My server" });
    expect(map("hetznerUbuntu").placement).toEqual({ id: "my-cloud", label: "My cloud" });
    expect(map("digitalocean").placement).toEqual({ id: "digitalocean", label: "My cloud · DigitalOcean" });
    expect(JSON.stringify(Object.values(rows).map((row) => manageCapabilitiesFor(row, { preparedMatch: true })))).not.toMatch(/\bEU\b/);
  });

  it("never carries a host name, binding, operation payload, bearer or Hivra Cloud address", () => {
    for (const row of Object.values(rows)) {
      const text = JSON.stringify(manageCapabilitiesFor(row, { preparedMatch: true }));
      expect(text).not.toContain("fixturenode11");
      expect(text).not.toContain(BINDING_HASH);
      expect(text).not.toContain("never-sent");
      expect(text).not.toContain("fixture-bearer");
      // A Hivra Cloud computer's address is on Hivra's private host network.
      if (row.deployment_mode === "hivra-managed") expect(text).not.toContain("10.250.20.63");
    }
  });

  it("shows an address only where it is the owner's own network", () => {
    const ip = (name: keyof typeof rows) => map(name).details.find((detail) => detail.id === "ip");
    expect(ip("ubuntu")).toBeUndefined();
    expect(ip("codex")).toBeUndefined();
    expect(ip("ubuntuMyServer")).toMatchObject({ label: "Address on your host network", value: "192.0.2.44" });
    expect(ip("hetznerUbuntu")).toMatchObject({ label: "Server IP", value: "192.0.2.80" });
  });

  it("lists support details: Hivra ID, VM ID on Proxmox, dates", () => {
    const details = map("ubuntu").details;
    expect(details.map((detail) => detail.label)).toEqual(["Hivra ID", "Operating system", "Where it runs", "VM ID (for support)", "Created", "First ready"]);
    expect(details.find((detail) => detail.id === "kind")?.value).toBe("Ubuntu Desktop");
    expect(map("hetznerUbuntu").details.some((detail) => detail.id === "vmid")).toBe(false);
    expect(map("gvisor").details.find((detail) => detail.id === "kind")?.value).toBe("Linux Sandbox");
  });

  describe("restore points", () => {
    it("are available on an owner-bound Proxmox computer", () => {
      expect(map("ubuntu").restorePoints).toEqual({ state: "available", maximum: 5 });
      expect(map("codex").restorePoints).toMatchObject({ state: "available" });
    });

    it("are unavailable, with the reason, on an older computer without ownership checks", () => {
      expect(map("codexUnbound").restorePoints).toMatchObject({ state: "unavailable", code: "not_bound",
        reason: "Restore points aren't available for this computer. It was created before Hivra recorded ownership checks." });
      expect(map("codexUnbound").notAvailable).toContainEqual({ capability: "Restore points",
        reason: "Restore points aren't available for this computer. It was created before Hivra recorded ownership checks." });
    });

    it.each([
      ["preparedWindows", "prepared"], ["windowsMyServer", "windows_my_server"], ["hetznerUbuntu", "my_cloud"],
      ["gvisor", "linux_sandbox"], ["digitalocean", "digitalocean"],
    ] as const)("are unavailable on %s (%s)", (name, code) => {
      expect(map(name).restorePoints).toMatchObject({ state: "unavailable", code });
    });

    it("wait while an operation is in progress, and while an agent is attached", () => {
      expect(manageCapabilitiesFor({ ...rows.ubuntu, status: "provisioning", operation_id: "op", operation_kind: "restart" }, { preparedMatch: true }).restorePoints)
        .toMatchObject({ state: "blocked", code: "operation_in_progress" });
      expect(manageCapabilitiesFor(rows.ubuntu, { preparedMatch: true, agentAttached: true }).restorePoints)
        .toMatchObject({ state: "blocked", code: "agent_attached" });
    });
  });

  describe("power", () => {
    it("offers Stop and Restart on a running computer, Start on a stopped one", () => {
      expect(map("ubuntu").power).toMatchObject({ start: { state: "blocked" }, stop: { state: "available" }, restart: { state: "available" } });
      const stopped = manageCapabilitiesFor({ ...rows.ubuntu, status: "stopped", desired_state: "stopped" }, { preparedMatch: true });
      expect(stopped.power).toMatchObject({ start: { state: "available" }, stop: { state: "blocked" }, restart: { state: "blocked", reason: "Start this computer first." } });
    });

    it("waits while an operation is in progress", () => {
      const busy = manageCapabilitiesFor({ ...rows.ubuntu, status: "provisioning", operation_id: "op", operation_kind: "provision" }, { preparedMatch: true });
      expect(busy.power.stop).toEqual({ state: "blocked", code: "operation_in_progress", reason: "Wait for the current operation to finish." });
    });

    it("says a Windows computer on My server has no power controls yet, instead of offering and refusing them", () => {
      const power = map("windowsMyServer", false).power;
      expect(power.start).toMatchObject({ state: "unavailable", code: "windows_my_server" });
      expect(power.stop.state).toBe("unavailable");
      expect(power.restart?.state).toBe("unavailable");
      expect(JSON.stringify(map("windowsMyServer", false))).not.toMatch(/preview/i);
    });

    it("offers power on a prepared computer only when its slot still matches", () => {
      expect(map("preparedWindows", true).power.stop.state).toBe("available");
      expect(map("preparedWindows", false).power.stop).toMatchObject({ state: "unavailable", code: "prepared_mismatch" });
    });

    it("has no restart for a Linux Sandbox or a DigitalOcean session, which pauses and resumes", () => {
      expect(map("gvisor").power.restart).toBeNull();
      expect(map("digitalocean").power).toMatchObject({ restart: null, labels: { start: "Resume", stop: "Pause" } });
    });
  });

  describe("force off and force restart", () => {
    it("are offered wherever Stop and Restart are, on Proxmox computers and prepared ones", () => {
      for (const name of ["ubuntu", "ubuntuMyServer", "codex", "codexUnbound", "claude", "deepseek", "aeon", "preparedWindows", "preparedOmarchy"] as const) {
        const power = map(name).power;
        expect(power.forceStop).toEqual(power.stop);
        expect(power.forceRestart).toEqual(power.restart);
      }
      const stopped = manageCapabilitiesFor({ ...rows.ubuntu, status: "stopped", desired_state: "stopped" }, { preparedMatch: true }).power;
      expect(stopped.forceStop).toMatchObject({ state: "blocked", code: "already_stopped" });
      expect(stopped.forceRestart).toMatchObject({ state: "blocked", reason: "Start this computer first." });
    });

    it("wait for another operation instead of breaking its lease", () => {
      const busy = manageCapabilitiesFor({ ...rows.ubuntu, status: "running", operation_id: "op", operation_kind: "restart" }, { preparedMatch: true });
      expect(busy.power.forceStop).toEqual({ state: "blocked", code: "operation_in_progress", reason: "Wait for the current operation to finish." });
    });

    it("send a My cloud computer to its provider's console", () => {
      for (const name of ["hetznerUbuntu", "codexMyCloud"] as const) {
        expect(map(name).power.forceStop).toEqual({ state: "unavailable", code: "my_cloud",
          reason: "Hivra can't force a My cloud computer off. Use your provider's console to force it off." });
        expect(map(name).notAvailable).toContainEqual({ capability: "Force off",
          reason: "Hivra can't force a My cloud computer off. Use your provider's console to force it off." });
      }
    });

    it("have no control on a Linux Sandbox or a DigitalOcean session", () => {
      expect(map("gvisor").power).toMatchObject({ forceStop: null, forceRestart: null });
      expect(map("digitalocean").power).toMatchObject({ forceStop: null, forceRestart: null });
    });

    it("are off, without repeating the reason, where no power control works", () => {
      expect(map("windowsMyServer", false).power.forceStop).toMatchObject({ state: "unavailable", code: "windows_my_server" });
      expect(map("preparedWindows", false).power.forceStop).toMatchObject({ state: "unavailable", code: "prepared_mismatch" });
      expect(map("windowsMyServer", false).notAvailable.map((item) => item.capability)).not.toContain("Force off");
    });
  });

  describe("live usage", () => {
    it("is read from the host for Proxmox computers, prepared ones and Windows on My server", () => {
      for (const name of ["ubuntu", "ubuntuMyServer", "codex", "codexUnbound", "preparedWindows", "windowsMyServer"] as const) {
        expect(map(name).usage).toEqual({ state: "available" });
      }
    });

    it("waits for a computer that isn't set up yet", () => {
      expect(manageCapabilitiesFor({ ...rows.ubuntu, status: "provisioning", vmid: null }, { preparedMatch: true }).usage)
        .toEqual({ state: "blocked", code: "not_ready", reason: "Usage appears once this computer is set up." });
    });

    it.each([
      ["hetznerUbuntu", "my_cloud", "Live usage isn't available for My cloud computers yet. Your provider's console shows it."],
      ["gvisor", "linux_sandbox", "Live usage isn't available for Linux Sandboxes yet."],
      ["digitalocean", "digitalocean", "Live usage isn't available for DigitalOcean sessions. Status and last activity come from DigitalOcean."],
    ] as const)("says where to look instead on %s", (name, code, reason) => {
      expect(map(name).usage).toEqual({ state: "unavailable", code, reason });
      expect(map(name).notAvailable).toContainEqual({ capability: "Live usage", reason });
    });

    it("isn't read for a prepared computer whose slot no longer matches, or a My server computer without ownership checks", () => {
      expect(map("preparedWindows", false).usage).toMatchObject({ state: "unavailable", code: "prepared_mismatch" });
      expect(manageCapabilitiesFor({ ...rows.ubuntuMyServer, infrastructure_binding_token_enforced: false }, { preparedMatch: true }).usage)
        .toMatchObject({ state: "unavailable", code: "not_bound" });
    });
  });

  describe("resources", () => {
    it("fixes a prepared computer's size and says so with its real size", () => {
      expect(map("preparedWindows").resize).toEqual({ kind: "fixed", cap: { state: "unavailable", code: "prepared_fixed",
        reason: "This Windows preview has a fixed size of 4 CPU / 8 GB. Hivra can't resize prepared computers yet." } });
      expect(map("preparedOmarchy").resize.cap).toMatchObject({ reason: expect.stringContaining("This Omarchy preview has a fixed size of 4 CPU / 8 GB.") });
    });

    it.each([
      ["ubuntu", "proxmox-envelope"], ["codex", "proxmox-envelope"], ["hetznerUbuntu", "hetzner-server-type"],
      ["gvisor", "gvisor-limits"], ["windowsMyServer", "fixed"], ["digitalocean", "fixed"],
    ] as const)("%s resizes as %s", (name, kind) => {
      expect(map(name).resize.kind).toBe(kind);
    });
  });

  describe("private network", () => {
    it("is offered on an owner-bound Ubuntu computer on Proxmox", () => {
      expect(map("ubuntu").privateNetwork).toEqual({ state: "available" });
      expect(map("ubuntuMyServer").privateNetwork).toEqual({ state: "available" });
    });

    it("waits for a stopped computer to start instead of refusing it", () => {
      const stopped = manageCapabilitiesFor({ ...rows.ubuntu, status: "stopped", desired_state: "stopped" }, { preparedMatch: true });
      expect(stopped.privateNetwork).toEqual({ state: "blocked", code: "not_running", reason: "Start this computer to connect it." });
      expect(stopped.sections).toContain("network");
    });

    it.each(["hetznerUbuntu", "preparedWindows", "gvisor"] as const)("is unavailable, with the reason, on %s", (name) => {
      expect(map(name).privateNetwork).toMatchObject({ state: "unavailable", code: "not_eligible" });
      expect(map(name).notAvailable).toContainEqual({ capability: "Private network",
        reason: "A private network is available on Ubuntu computers on Hivra Cloud and My server." });
    });

    it("is not listed for agents at all", () => {
      expect(map("codex").privateNetwork).toBeNull();
      expect(map("codex").notAvailable.map((item) => item.capability)).not.toContain("Private network");
    });
  });

  describe("updates", () => {
    it("names the agent software and the version Hivra tested for Claude Code and Codex", () => {
      expect(map("codex").agentCli).toEqual({ name: "codex", vetted: AGENT_CLI_VERSIONS.codex });
      expect(map("claude").agentCli).toEqual({ name: "claude-code", vetted: AGENT_CLI_VERSIONS["claude-code"] });
      expect(map("aeon").agentCli).toBeNull();
      expect(map("codexMyCloud").agentCli).toBeNull();
    });

    it("needs a running computer to update the connection service", () => {
      expect(map("codex").connectionServiceUpdate).toEqual({ state: "available" });
      const stopped = manageCapabilitiesFor({ ...rows.codex, status: "stopped", desired_state: "stopped" }, { preparedMatch: true });
      expect(stopped.connectionServiceUpdate).toMatchObject({ state: "blocked", reason: "Start this computer to update it." });
    });

    it.each([
      ["deepseek", "deepseek"], ["preparedWindows", "prepared"], ["hetznerUbuntu", "my_cloud"], ["windowsMyServer", "windows_my_server"],
    ] as const)("is unavailable on %s (%s)", (name, code) => {
      expect(map(name).connectionServiceUpdate).toMatchObject({ state: "unavailable", code });
    });
  });

  it("keeps deleting available in every state, with the provider warning for My cloud", () => {
    for (const row of Object.values(rows)) {
      expect(manageCapabilitiesFor({ ...row, status: "provisioning", operation_id: "op", operation_kind: "provision" }, { preparedMatch: true }).destroy.cap)
        .toEqual({ state: "available" });
    }
    expect(map("hetznerUbuntu").destroy.extraWarning).toBe("provider-resources");
    expect(map("ubuntu").destroy.extraWarning).toBeNull();
  });

  it("lists Agents for every computer Manage shows, never for agents or Linux Sandboxes", () => {
    // ComputerAgentsPanel decides between "Add an agent" and the honest Agent slot.
    expect(map("ubuntu").sections).toContain("agents");
    expect(map("preparedWindows").sections).toContain("agents");
    expect(map("codex").sections).not.toContain("agents");
    expect(map("gvisor").sections).not.toContain("agents");
    expect(map("ubuntu").attachAgents).toBe(false);
    expect(manageCapabilitiesFor(rows.ubuntu, { preparedMatch: true, attachAgents: true }).attachAgents).toBe(true);
    expect(manageCapabilitiesFor(rows.codex, { preparedMatch: true, attachAgents: true }).attachAgents).toBe(false);
  });

  it("offers Export data for agents only, once running", () => {
    expect(map("codex").export).toEqual({ state: "available" });
    expect(manageCapabilitiesFor({ ...rows.codex, status: "stopped" }, { preparedMatch: true }).export).toMatchObject({ state: "blocked" });
    expect(map("ubuntu").export).toBeNull();
    expect(map("digitalocean").export).toBeNull();
  });

  it("keeps folder recovery to enrolled Ubuntu desktops", () => {
    expect(map("ubuntu").folderRecovery).toEqual({ state: "available" });
    expect(map("ubuntuUnbound").folderRecovery).toMatchObject({ state: "unavailable", code: "not_bound" });
    expect(map("codex").folderRecovery).toBeNull();
    expect(map("preparedWindows").folderRecovery).toBeNull();
  });
});

// The agent page reads a computer again while its map says another operation
// holds it, so the controls that operation blocks come back without a reload.
describe("manageAwaitsOperation", () => {
  // Windows on My server has no control an operation could block.
  const blockable = Object.keys(rows).filter((name) => name !== "windowsMyServer");
  it.each(blockable)("is true for %s while an operation it didn't start holds it", (name) => {
    const row = { ...rows[name], operation_id: "op-1", operation_kind: "desktop_prepare" };
    expect(manageAwaitsOperation(manageCapabilitiesFor(row, { preparedMatch: true }))).toBe(true);
  });

  it.each(Object.keys(rows))("is false for %s when nothing holds it", (name) => {
    expect(manageAwaitsOperation(manageCapabilitiesFor(rows[name], { preparedMatch: true }))).toBe(false);
  });

  it("is false for a stopped computer and for no map at all", () => {
    expect(manageAwaitsOperation(manageCapabilitiesFor({ ...rows.ubuntu, status: "stopped" }, { preparedMatch: true }))).toBe(false);
    expect(manageAwaitsOperation(undefined)).toBe(false);
  });
});
