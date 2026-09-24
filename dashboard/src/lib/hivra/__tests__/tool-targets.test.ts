/** @jest-environment node */

const mockRows: Record<string, unknown[]> = {};

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = jest.fn(self);
      chain.eq = jest.fn(self);
      chain.neq = jest.fn(self);
      chain.order = jest.fn(async () => ({ data: mockRows[table] ?? [], error: null }));
      return chain;
    },
  },
}));

import { listToolTargets } from "../tool-targets";

function cliRow(overrides: Record<string, unknown>) {
  return { id: "a1", name: "Agent", type: "codex", status: "running", ip: "192.0.2.5", computer_substrate: "proxmox-kvm", ...overrides };
}

describe("listToolTargets", () => {
  beforeEach(() => {
    mockRows.hivra_agents = [];
    mockRows.hermes_instances = [];
  });

  it("keeps running Proxmox CLI boxes installable, including rows from before the substrate column", async () => {
    mockRows.hivra_agents = [
      cliRow({ id: "kvm" }),
      cliRow({ id: "legacy", computer_substrate: null }),
    ];
    const targets = await listToolTargets("user-a");
    expect(targets.map((t) => [t.id, t.installable, t.blockedReason])).toEqual([
      ["kvm", true, undefined],
      ["legacy", true, undefined],
    ]);
  });

  it("marks CLI agents off Proxmox not installable with a plain reason", async () => {
    mockRows.hivra_agents = [
      cliRow({ id: "provider", computer_substrate: "provider-vm" }),
      cliRow({ id: "do", type: "claude-code", computer_substrate: "do-managed-session" }),
    ];
    const targets = await listToolTargets("user-a");
    expect(targets).toEqual([
      expect.objectContaining({
        id: "provider",
        installable: false,
        blockedReason: "unsupported_substrate",
        blockedMessage: "Catalog tools aren't available on computers in your own cloud yet. Use Advanced MCP.",
      }),
      expect.objectContaining({
        id: "do",
        installable: false,
        blockedReason: "unsupported_substrate",
        blockedMessage: "Catalog tools aren't available on DigitalOcean agents yet.",
      }),
    ]);
  });

  it("reports the permanent substrate block ahead of transient running state", async () => {
    mockRows.hivra_agents = [cliRow({ id: "provider", status: "stopped", ip: null, computer_substrate: "provider-vm" })];
    const [target] = await listToolTargets("user-a");
    expect(target).toEqual(expect.objectContaining({ installable: false, blockedReason: "unsupported_substrate" }));
  });

  it("keeps the type gate first for agents with no MCP config path", async () => {
    mockRows.hivra_agents = [cliRow({ id: "terminal", type: "linux-terminal", computer_substrate: "gvisor" })];
    const [target] = await listToolTargets("user-a");
    expect(target).toEqual(expect.objectContaining({ installable: false, blockedReason: "unsupported_type" }));
    expect(target.blockedMessage).toBeUndefined();
  });
});
