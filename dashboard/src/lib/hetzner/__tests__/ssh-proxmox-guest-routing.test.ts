/** @jest-environment node */

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: jest.fn(),
  resolveProxmoxHostEnv: jest.fn((hostConfig, env) => ({ ...env, STUB_TARGET_HOST: hostConfig?.hostSlug ?? "" })),
}));

import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import {
  GENUINE_GUEST_HOST_KEY,
  createStubProxmoxGuestHost,
  type StubGuestVm,
  type StubProxmoxGuestHost,
  type StubRunResult,
} from "@/test-utils/stub-proxmox-guest-host";

import { sshExec } from "../ssh";

// Placeholder, not a real Bankr key.
const CONFIG_YAML = "bankr:\n  api_key: bk_placeholder_wallet_key_not_real\n";
// Guest IP = start + VMID - VMID_START on every host, so boxes on different
// hosts that share a private prefix get the same IP.
const SHARED_IP = "10.70.20.55";
const INSTANCE_ID = "5e0c7a1b-2f3d-4c5e-8a9b-0c1d2e3f4a5b";
const NEIGHBOUR_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const pve12Box: StubGuestVm = { vmid: 1205, ip: SHARED_IP, name: `hermes-alice-${INSTANCE_ID.slice(0, 8)}` };
const pve11Neighbour: StubGuestVm = { vmid: 1105, ip: SHARED_IP, name: `hermes-bob-${NEIGHBOUR_ID.slice(0, 8)}` };

describe("sshExec to a Proxmox guest: which host and VM it reaches", () => {
  const hosts: Record<string, StubProxmoxGuestHost> = {};
  const savedEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    hosts.pve11 = createStubProxmoxGuestHost();
    hosts.pve12 = createStubProxmoxGuestHost();
    delete process.env.PROXMOX_SSH_HOST;
    delete process.env.PROXMOX_PRIVATE_SUBNET_PREFIX;
    process.env.HERMES_PROXMOX_TARGETS = "pve11,pve12";
    process.env.PROXMOX_PVE11_PRIVATE_SUBNET_PREFIX = "10.70.20";
    process.env.PROXMOX_PVE12_PRIVATE_SUBNET_PREFIX = "10.70.20";
    process.env.PROXMOX_VM_SSH_USER = "hermes";
    // Both stub hosts share one key path layout; the first host's file is enough for the prelude's -f check.
    process.env.PROXMOX_VM_SSH_KEY_PATH = hosts.pve11.vmKeyPath;
  });

  afterEach(() => {
    for (const host of Object.values(hosts)) host.cleanup();
    process.env = { ...savedEnv };
  });

  /** Run whatever host script sshExec produced on the stub host it was routed to. */
  async function exec(
    options: Parameters<typeof sshExec>[2]
  ): Promise<{ routedTo: string | null; result: StubRunResult | null; error?: string }> {
    (runProxmoxHostScript as jest.Mock).mockResolvedValueOnce({ ok: true, stdout: "", stderr: "" });
    const outcome = await sshExec(SHARED_IP, "cat > /tmp/config.yaml", { timeoutMs: 8_000, stdin: CONFIG_YAML, ...options });
    const call = (runProxmoxHostScript as jest.Mock).mock.calls[0];
    if (!call) return { routedTo: null, result: null, error: outcome.error };
    const routedTo = String(call[1].STUB_TARGET_HOST || "");
    const result = hosts[routedTo].run(String(call[0]), {
      vms: routedTo === "pve11" ? [pve11Neighbour] : [pve12Box],
      serverHostKey: GENUINE_GUEST_HOST_KEY,
      sshStdout: "ok",
    });
    return { routedTo, result };
  }

  /**
   * Regression: with no host config, sshExec took the FIRST HERMES_PROXMOX_TARGETS
   * entry whose private prefix matched the IP. Prod's pve11/12/13/19 all use
   * 10.70.20, so a pve12 box's config.yaml (Bankr block, OAuth tokens) went to
   * pve11 and the IP-resolved VMID there: another tenant's VM.
   */
  it("refuses an ip that more than one Proxmox target's private prefix matches, before reaching any host", async () => {
    const { routedTo, error } = await exec({});

    expect(routedTo).toBeNull();
    expect(runProxmoxHostScript).not.toHaveBeenCalled();
    expect(error).toMatch(/^VMID-bound SSH refused: 10\.70\.20\.55 is in the private subnet of more than one Proxmox target \(pve11, pve12\)/);
  });

  it("reaches the instance's own VM on its own host when the instance target is passed", async () => {
    const { routedTo, result } = await exec({
      proxmoxHostConfig: { hostSlug: "pve12", failClosed: true, vmid: 1205, instanceId: INSTANCE_ID },
    });

    expect(routedTo).toBe("pve12");
    expect(result).toMatchObject({ status: 0 });
    expect(result!.delivered).toBe(CONFIG_YAML);
    expect(result!.sshArgs[0]).toContain("HostKeyAlias=hivra-vmid-1205");
  });

  it("refuses when the stored VMID now holds another instance's VM (recycled VMID)", async () => {
    const { routedTo, result } = await exec({
      proxmoxHostConfig: { hostSlug: "pve11", failClosed: true, vmid: 1105, instanceId: INSTANCE_ID },
    });

    expect(routedTo).toBe("pve11");
    expect(result!.status).not.toBe(0);
    expect(result!.stderr).toMatch(/VMID-bound SSH refused: VM 1105 is named hermes-bob-9a8b7c6d, not this instance's VM/);
    expect(result!.sshArgs).toEqual([]);
    expect(result!.delivered).toBe("");
  });

  it("does not reach a host for an instance target whose ids are malformed", async () => {
    const { routedTo, error } = await exec({
      proxmoxHostConfig: { hostSlug: "pve12", failClosed: true, vmid: 1205, instanceId: "not-a-uuid" },
    });

    expect(routedTo).toBeNull();
    expect(error).toMatch(/VMID-bound SSH refused: .*instance id/);
  });
});
