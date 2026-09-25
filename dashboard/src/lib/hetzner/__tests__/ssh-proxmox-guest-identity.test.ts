/** @jest-environment node */

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: jest.fn(),
  resolveProxmoxHostEnv: jest.fn((_hostConfig, env) => ({ ...env })),
}));

import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import {
  GENUINE_GUEST_HOST_KEY,
  SPOOFED_GUEST_HOST_KEY,
  createStubProxmoxGuestHost,
  type StubGuestVm,
  type StubProxmoxGuestHost,
} from "@/test-utils/stub-proxmox-guest-host";

import { sshExec } from "../ssh";

// Placeholder, not a real Bankr key.
const WALLET_KEY = "bk_placeholder_wallet_key_not_real";
const GUEST_IP = "10.250.20.50";
const CONFIG_YAML = `bankr:\n  api_key: ${WALLET_KEY}\n`;

/** The host script sshExec hands to the Proxmox host for a private guest IP. */
async function guestHostScript(command: string, stdin?: string): Promise<string> {
  (runProxmoxHostScript as jest.Mock).mockResolvedValueOnce({ ok: true, stdout: "ok\n", stderr: "" });
  await sshExec(GUEST_IP, command, { timeoutMs: 8_000, ...(stdin === undefined ? {} : { stdin }) });
  const call = (runProxmoxHostScript as jest.Mock).mock.calls[0];
  expect(call).toBeDefined();
  return String(call[0]);
}

describe("sshExec to a Proxmox guest: VMID-bound identity", () => {
  let host: StubProxmoxGuestHost;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    host = createStubProxmoxGuestHost();
    process.env.PROXMOX_SSH_HOST = "203.0.113.10";
    process.env.PROXMOX_PRIVATE_SUBNET_PREFIX = "10.250.20";
    process.env.PROXMOX_VM_SSH_USER = "hermes";
    process.env.PROXMOX_VM_SSH_KEY_PATH = host.vmKeyPath;
    delete process.env.HERMES_PROXMOX_TARGETS;
  });

  afterEach(() => {
    host.cleanup();
    process.env = { ...savedEnv };
  });

  const guest = (overrides: Partial<StubGuestVm> = {}): StubGuestVm => ({ vmid: 1234, ip: GUEST_IP, ...overrides });

  /**
   * Regression (pre-launch review H4): secret-carrying writes such as
   * hermes-config-write's config.yaml (which holds the Bankr block) went to the
   * stored guest IP with a fresh known_hosts and StrictHostKeyChecking=accept-new,
   * so whoever answered at that IP received them.
   */
  it.each([
    ["stdin", "cat > /tmp/config.yaml", CONFIG_YAML],
    ["the command", `printf '%s' '${Buffer.from(CONFIG_YAML).toString("base64")}' | base64 -d > /tmp/config.yaml`, undefined],
  ])("sends nothing when the machine at the guest IP is not the VM configured with it (secret in %s)", async (_where, command, stdin) => {
    const result = host.run(await guestHostScript(command, stdin), {
      vms: [guest()],
      serverHostKey: SPOOFED_GUEST_HOST_KEY,
    });

    expect(result.status).not.toBe(0);
    expect(result.delivered).toBe("");
    expect(result.sshCalls).toEqual([]);
    expect(result.stderr).toMatch(/Host key verification failed/);
  });

  it("delivers to the VM configured with the ip, pinned to the host key its guest agent attests", async () => {
    const result = host.run(await guestHostScript("cat > /tmp/config.yaml", CONFIG_YAML), {
      vms: [guest(), guest({ vmid: 1300, ip: "10.250.20.60" })],
      serverHostKey: GENUINE_GUEST_HOST_KEY,
      sshStdout: "ok",
    });

    expect(result).toMatchObject({ status: 0, stdout: "ok\n" });
    expect(result.delivered).toBe(CONFIG_YAML);
    expect(result.sshArgs).toHaveLength(1);
    expect(result.sshArgs[0]).toEqual(expect.arrayContaining([
      "StrictHostKeyChecking=yes",
      "HostKeyAlias=hivra-vmid-1234",
      "GlobalKnownHostsFile=/dev/null",
      "LogLevel=ERROR",
      `hermes@${GUEST_IP}`,
    ]));
    expect(result.sshCalls).toEqual([`hermes@${GUEST_IP} sudo bash -c cat\\ \\>\\ /tmp/config.yaml`]);
  });

  it("ignores a stopped VM that shares the ip and pins the running one", async () => {
    const result = host.run(await guestHostScript("true"), {
      vms: [guest({ vmid: 1100, status: "stopped", attestedHostKey: SPOOFED_GUEST_HOST_KEY }), guest()],
      serverHostKey: GENUINE_GUEST_HOST_KEY,
      sshStdout: "ok",
    });

    expect(result.status).toBe(0);
    expect(result.sshArgs[0]).toContain("HostKeyAlias=hivra-vmid-1234");
  });

  it.each<[string, StubGuestVm[], RegExp]>([
    ["no VM on the host is configured with the ip", [guest({ ip: "10.250.20.77" })], /no running VM on this host is configured with 10\.250\.20\.50/],
    ["two running VMs are configured with the ip", [guest(), guest({ vmid: 1300 })], /more than one running VM on this host is configured with 10\.250\.20\.50/],
    ["the only VM with the ip is stopped", [guest({ status: "stopped" })], /no running VM on this host is configured with 10\.250\.20\.50/],
    ["the VM's guest agent is down", [guest({ agentUp: false })], /SSH host key could not be read through QEMU Guest Agent/],
    ["the VM is a Hivra computer", [guest({ tags: "hivra-bind-0123456789abcdef0123456789abcdef" })], /VM 1234 is a Hivra computer/],
  ])("refuses and sends nothing when %s", async (_label, vms, reason) => {
    const result = host.run(await guestHostScript("cat > /tmp/config.yaml", CONFIG_YAML), {
      vms,
      serverHostKey: GENUINE_GUEST_HOST_KEY,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(reason);
    expect(result.stderr).toMatch(/VMID-bound SSH refused: .*nothing was sent to the guest/);
    expect(result.sshArgs).toEqual([]);
    expect(result.delivered).toBe("");
  });

  it("does not reach the host for a guest ssh user that is not a plain login name", async () => {
    process.env.PROXMOX_VM_SSH_USER = "hermes@10.250.20.99";

    const result = await sshExec(GUEST_IP, "true", { timeoutMs: 8_000 });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/guest ssh user/i);
    expect(runProxmoxHostScript).not.toHaveBeenCalled();
  });
});
