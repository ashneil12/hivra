/** @jest-environment node */

import fs from "node:fs";

import { SupabaseClient } from "@supabase/supabase-js";

import { decryptApiKey } from "@/lib/crypto";
import { getProxmoxInfrastructure, runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { getProfileDeploymentState } from "@/lib/profile-deployment";
import { validateProviderApiKey } from "@/lib/services/provider-validation";
import { buildWebUIBootstrapScript, buildWebUIProvisioningArtifacts } from "@/lib/services/webui-instance-builder";
import { getAutoUpdateConfig, getRuntimeAgentSettings } from "@/lib/instance-settings";
import { buildInstanceBankrAgentConfig, getBankrWalletForInstance } from "@/lib/billing/bankr-instance-wallets";
import { isProTierUser } from "@/lib/billing/pro-tier";
import { USER_LIVE_UPDATE } from "@/lib/services/live-update-initiator";
import {
  GENUINE_GUEST_HOST_KEY,
  SPOOFED_GUEST_HOST_KEY,
  createStubProxmoxGuestHost,
  ed25519KeyBlob,
  type StubGuestVm,
  type StubProxmoxGuestHost,
} from "@/test-utils/stub-proxmox-guest-host";

import { applyLiveUpdate, type InstanceRowForOrchestration } from "../instance-orchestrator";

jest.mock("@/lib/hetzner/ssh", () => ({ sshExec: jest.fn() }));
jest.mock("@/lib/crypto", () => ({ decryptApiKey: jest.fn() }));
jest.mock("@/lib/codex-oauth", () => ({ resolveCodexDeploymentSecret: jest.fn() }));
jest.mock("@/lib/nous-oauth", () => ({ resolveNousDeploymentSecret: jest.fn() }));
jest.mock("@/lib/profile-deployment", () => ({ getProfileDeploymentState: jest.fn() }));
jest.mock("@/lib/services/provider-validation", () => ({ validateProviderApiKey: jest.fn() }));
jest.mock("@/lib/services/hetzner-instance-service", () => ({
  buildAgentDeployScript: jest.fn(),
  getHetznerInstanceStatus: jest.fn(),
  resolveGatewayConfiguration: jest.fn(),
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  buildProxmoxTenantIsolationGuard: jest.fn(() => ""),
  getProxmoxInfrastructure: jest.fn(),
  resolveProxmoxHostEnv: jest.fn((_config, baseEnv) => ({ ...baseEnv })),
  runProxmoxHostScript: jest.fn(),
  getProxmoxHostRoutingConfigFromInfrastructure: jest.fn(() => null),
  resolveProxmoxGatewayUrlFromSubdomain: jest.fn(() => null),
}));
jest.mock("@/lib/services/webui-instance-builder", () => ({
  buildWebUIBootstrapScript: jest.fn(),
  buildWebUIProvisioningArtifacts: jest.fn(),
}));
jest.mock("@/lib/services/provider-config", () => ({
  PROVIDER_ID_MAP: { openai: "openai" },
  resolveProviderBaseUrl: jest.fn(),
}));
jest.mock("@/lib/instance-settings", () => ({
  decryptMemorySystemSecrets: jest.fn(),
  getAutoUpdateConfig: jest.fn(),
  getRuntimeAgentSettings: jest.fn(),
}));
jest.mock("@/lib/billing/bankr-instance-wallets", () => {
  const actual = jest.requireActual("@/lib/billing/bankr-instance-wallets");
  return {
    buildInstanceBankrAgentConfig: jest.fn(),
    getBankrWalletForInstance: jest.fn(),
    bankrRuntimeWalletAddressHistory: actual.bankrRuntimeWalletAddressHistory,
    isRevokedUserConnectedWallet: actual.isRevokedUserConnectedWallet,
    isUserConnectedWalletRecord: actual.isUserConnectedWalletRecord,
  };
});
jest.mock("@/lib/billing/pro-tier", () => ({ isProTierUser: jest.fn() }));

// Placeholder, not a real Bankr key.
const WALLET_KEY = "bk_placeholder_wallet_key_not_real";
const VMID = 201;
const GUEST_IP = "10.250.20.51";

const INSTANCE: InstanceRowForOrchestration = {
  id: "inst-proxmox",
  user_id: "user-123",
  provider: "openai",
  hetzner_server_id: null,
  host_id: null,
  api_key_encrypted: "enc-api-key",
  api_server_key_encrypted: "enc-gateway",
  config: {
    infrastructure: { provider: "proxmox", vmid: VMID, privateIpv4: GUEST_IP, gatewayHost: "agent.example.com" },
  },
};

function supabaseStub(): SupabaseClient {
  return {
    from: jest.fn().mockReturnValue({
      update: jest.fn().mockReturnValue({ eq: jest.fn().mockResolvedValue({ error: null }) }),
    }),
  } as unknown as SupabaseClient;
}

/** The host script applyLiveUpdate hands to the Proxmox host. */
async function liveUpdateHostScript(): Promise<string> {
  await applyLiveUpdate(INSTANCE, "", {}, supabaseStub(), { initiator: USER_LIVE_UPDATE });
  const call = (runProxmoxHostScript as jest.Mock).mock.calls[0];
  expect(call).toBeDefined();
  return String(call[0]);
}

/** The agent deploy script carried inside the stream the guest received. */
function deliveredAgentScript(delivered: string): string {
  const b64 = delivered.match(/printf '%s' '([^']+)' \| base64 -d > \/tmp\/hermes-update-inst-proxmox\.sh/)?.[1];
  return b64 ? Buffer.from(b64, "base64").toString("utf8") : "";
}

describe("applyLiveUpdate guest identity (Proxmox lane)", () => {
  let host: StubProxmoxGuestHost;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    host = createStubProxmoxGuestHost();
    process.env.PROXMOX_VM_SSH_USER = "hermes";
    process.env.PROXMOX_VM_SSH_KEY_PATH = host.vmKeyPath;
    (decryptApiKey as jest.Mock).mockReturnValue("plain-api-key");
    (getAutoUpdateConfig as jest.Mock).mockReturnValue({ enabled: false, time: "06:00" });
    (getRuntimeAgentSettings as jest.Mock).mockReturnValue({});
    (getBankrWalletForInstance as jest.Mock).mockResolvedValue(null);
    (buildInstanceBankrAgentConfig as jest.Mock).mockResolvedValue(null);
    (isProTierUser as jest.Mock).mockResolvedValue({ ok: true, tier: "operator" });
    (validateProviderApiKey as jest.Mock).mockResolvedValue({ valid: true });
    (getProfileDeploymentState as jest.Mock).mockResolvedValue({ profileRoutes: [], profilesToRestore: [] });
    (buildWebUIProvisioningArtifacts as jest.Mock).mockReturnValue({});
    // The deploy script carries the box's secrets, including its Bankr wallet key.
    (buildWebUIBootstrapScript as jest.Mock).mockReturnValue(`#!/bin/bash\nBANKR_API_KEY=${WALLET_KEY}\n`);
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue(INSTANCE.config!.infrastructure);
    (runProxmoxHostScript as jest.Mock).mockResolvedValue({ ok: true, stdout: "4242\n", stderr: "" });
  });

  afterEach(() => {
    host.cleanup();
    process.env = { ...savedEnv };
  });

  const vm = (overrides: Partial<StubGuestVm> = {}): StubGuestVm[] => [{ vmid: VMID, ip: GUEST_IP, ...overrides }];

  /**
   * Regression (pre-launch review H4): the update removed its known_hosts file
   * and connected with StrictHostKeyChecking=accept-new, so any machine
   * answering at the stored guest IP (an ARP-spoofing neighbour on the shared
   * bridge) was trusted and received the deploy script with the wallet key.
   */
  it("refuses and sends nothing when the machine at the guest IP presents a host key the VM did not attest", async () => {
    const result = host.run(await liveUpdateHostScript(), { vms: vm(), serverHostKey: SPOOFED_GUEST_HOST_KEY });

    expect(result.status).not.toBe(0);
    expect(result.delivered).toBe("");
    expect(result.sshCalls).toEqual([]);
    expect(result.stderr).toMatch(/did not present VM 201's attested SSH host key/);
    expect(result.stdout + result.stderr).not.toContain(WALLET_KEY);
  });

  it("pins the connection to the host key QEMU Guest Agent attests for the VMID and delivers the update", async () => {
    const result = host.run(await liveUpdateHostScript(), { vms: vm(), serverHostKey: GENUINE_GUEST_HOST_KEY });

    expect(result).toMatchObject({ status: 0, stdout: "4242\n" });
    expect(result.sshCalls).toEqual([`hermes@${GUEST_IP} sudo -n true`, `hermes@${GUEST_IP} sudo bash -s`]);
    for (const args of result.sshArgs) {
      expect(args).toEqual(expect.arrayContaining([
        "StrictHostKeyChecking=yes",
        `HostKeyAlias=hivra-vmid-${VMID}`,
        "GlobalKnownHostsFile=/dev/null",
        `hermes@${GUEST_IP}`,
      ]));
      expect(args).not.toContain("StrictHostKeyChecking=accept-new");
    }
    expect(deliveredAgentScript(result.delivered)).toContain(`BANKR_API_KEY=${WALLET_KEY}`);
    // The per-run pinned known_hosts directory is removed afterwards.
    expect(fs.readdirSync(`${host.root}/run`)).toEqual([]);
  });

  it.each<[string, Partial<StubGuestVm>, RegExp]>([
    ["the VM at the stored VMID is configured with a different ip", { ip: "10.250.20.99" }, /VM 201 is configured with ip 10\.250\.20\.99, not 10\.250\.20\.51/],
    ["the VM is not running", { status: "stopped" }, /VM 201 is not running/],
    ["the VM has no guest agent channel", { agent: null }, /VM 201 has no QEMU Guest Agent channel/],
    ["the VM's guest agent is disabled", { agent: "0" }, /VM 201 has no QEMU Guest Agent channel/],
    ["the guest agent never answers", { agentUp: false }, /QEMU Guest Agent in VM 201 did not answer/],
    ["the guest agent attests a malformed key", { attestedHostKeyLine: "ssh-ed25519 not-base64 root@guest" }, /did not attest a valid Ed25519 SSH host key/],
    ["the guest agent attests a non-Ed25519 key", { attestedHostKeyLine: `ssh-rsa ${ed25519KeyBlob(7)} root@guest` }, /did not attest a valid Ed25519 SSH host key/],
    ["the VM at the stored VMID is a Hivra computer", { tags: "hivra;hivra-bind-0123456789abcdef0123456789abcdef" }, /VM 201 is a Hivra computer/],
  ])("refuses and sends nothing when %s", async (_label, overrides, reason) => {
    const result = host.run(await liveUpdateHostScript(), { vms: vm(overrides), serverHostKey: GENUINE_GUEST_HOST_KEY });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(reason);
    expect(result.stderr).toMatch(/VMID-bound SSH refused: .*nothing was sent to the guest/);
    expect(result.sshArgs).toEqual([]);
    expect(result.delivered).toBe("");
  });

  it("reports a refused guest identity as a failed launch naming the reason", async () => {
    (runProxmoxHostScript as jest.Mock).mockResolvedValueOnce({
      ok: false,
      stdout: "",
      stderr: "VMID-bound SSH refused: VM 201 is not running; nothing was sent to the guest\n",
      error: "Command exited with code 1",
    });

    const result = await applyLiveUpdate(INSTANCE, "", {}, supabaseStub(), { initiator: USER_LIVE_UPDATE });

    expect(result).toEqual({
      applied: false,
      error: "VMID-bound SSH refused: VM 201 is not running; nothing was sent to the guest\n",
      initiator: USER_LIVE_UPDATE,
    });
  });

  it("refuses to build a host script for a malformed stored guest ip", async () => {
    (getProxmoxInfrastructure as jest.Mock).mockReturnValue({
      ...INSTANCE.config!.infrastructure as object,
      privateIpv4: "10.250.20.51; reboot",
    });

    const result = await applyLiveUpdate(INSTANCE, "", {}, supabaseStub(), { initiator: USER_LIVE_UPDATE });

    expect(result).toMatchObject({ applied: false });
    expect(runProxmoxHostScript).not.toHaveBeenCalled();
  });
});
