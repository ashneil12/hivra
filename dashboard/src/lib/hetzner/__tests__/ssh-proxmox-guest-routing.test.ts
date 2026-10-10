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
const SHARED_IP = "10.250.20.55";
const INSTANCE_ID = "00000000-0000-4000-8000-b396cad19098";

const hostbBox: StubGuestVm = { vmid: 1205, ip: SHARED_IP, name: `hermes-alice-${INSTANCE_ID.slice(0, 8)}` };
const hostaNeighbour: StubGuestVm = { vmid: 1105, ip: SHARED_IP, name: "hermes-bob-9a8b7c6d" };

describe("sshExec to a Proxmox guest: which host and VM it reaches", () => {
  const hosts: Record<string, StubProxmoxGuestHost> = {};
  const savedEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    hosts.hosta = createStubProxmoxGuestHost();
    hosts.hostb = createStubProxmoxGuestHost();
    delete process.env.PROXMOX_SSH_HOST;
    delete process.env.PROXMOX_PRIVATE_SUBNET_PREFIX;
    process.env.HERMES_PROXMOX_TARGETS = "hosta,hostb";
    process.env.PROXMOX_HOSTA_PRIVATE_SUBNET_PREFIX = "10.250.20";
    process.env.PROXMOX_HOSTB_PRIVATE_SUBNET_PREFIX = "10.250.20";
    process.env.PROXMOX_VM_SSH_USER = "hermes";
    // Both stub hosts share one key path layout; the first host's file is enough for the prelude's -f check.
    process.env.PROXMOX_VM_SSH_KEY_PATH = hosts.hosta.vmKeyPath;
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
      vms: routedTo === "hosta" ? [hostaNeighbour] : [hostbBox],
      serverHostKey: GENUINE_GUEST_HOST_KEY,
      sshStdout: "ok",
    });
    return { routedTo, result };
  }

  /**
   * Regression: with no host config, sshExec took the FIRST HERMES_PROXMOX_TARGETS
   * entry whose private prefix matched the IP. When hosts share a prefix (as
   * the prod fleet does), a hostb box's config.yaml (Bankr block, OAuth tokens) went to
   * hosta and the IP-resolved VMID there: another tenant's VM.
   */
  it("refuses an ip that more than one Proxmox target's private prefix matches, before reaching any host", async () => {
    const { routedTo, error } = await exec({});

    expect(routedTo).toBeNull();
    expect(runProxmoxHostScript).not.toHaveBeenCalled();
    expect(error).toMatch(/^VMID-bound SSH refused: 10\.250\.20\.55 is in the private subnet of more than one Proxmox target \(hosta, hostb\)/);
  });

  it("reaches the instance's own VM on its own host when the instance target is passed", async () => {
    const { routedTo, result } = await exec({
      proxmoxHostConfig: { hostSlug: "hostb", failClosed: true, vmid: 1205, instanceId: INSTANCE_ID },
    });

    expect(routedTo).toBe("hostb");
    expect(result).toMatchObject({ status: 0 });
    expect(result!.delivered).toBe(CONFIG_YAML);
    expect(result!.sshArgs[0]).toContain("HostKeyAlias=hivra-vmid-1205");
  });

  it("refuses when the stored VMID now holds another instance's VM (recycled VMID)", async () => {
    const { routedTo, result } = await exec({
      proxmoxHostConfig: { hostSlug: "hosta", failClosed: true, vmid: 1105, instanceId: INSTANCE_ID },
    });

    expect(routedTo).toBe("hosta");
    expect(result!.status).not.toBe(0);
    expect(result!.stderr).toMatch(/VMID-bound SSH refused: VM 1105 is named hermes-bob-9a8b7c6d, not this instance's VM/);
    expect(result!.sshArgs).toEqual([]);
    expect(result!.delivered).toBe("");
  });

  it("does not reach a host for an instance target whose ids are malformed", async () => {
    const { routedTo, error } = await exec({
      proxmoxHostConfig: { hostSlug: "hostb", failClosed: true, vmid: 1205, instanceId: "not-a-uuid" },
    });

    expect(routedTo).toBeNull();
    expect(error).toMatch(/VMID-bound SSH refused: .*instance id/);
  });
});
