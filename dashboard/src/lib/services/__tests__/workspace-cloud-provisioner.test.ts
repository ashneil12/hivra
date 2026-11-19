import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  provisionWorkspaceCloudAgent,
  applyWorkspaceCloudModelConfig,
  buildApplyModelScript,
  buildOAuthStartScript,
  buildOAuthStatusScript,
  buildProvisionScript,
} from "@/lib/services/workspace-cloud-provisioner";
import {
  resolveProxmoxTargetConfiguration,
  runProxmoxHostScript,
} from "@/lib/services/proxmox-instance-service";
import {
  GENUINE_GUEST_HOST_KEY,
  SPOOFED_GUEST_HOST_KEY,
  createStubProxmoxGuestHost,
} from "@/test-utils/stub-proxmox-guest-host";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;
jest.mock("@/lib/crypto", () => ({
  encryptApiKey: (s: string) => s,
  formatKeyPreview: () => "xxxx",
}));
jest.mock("@/lib/services/cloudflare-dns", () => ({ createDnsRecord: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: jest.fn(),
  resolveProxmoxTargetConfiguration: jest.fn(),
}));

describe("provisionWorkspaceCloudAgent config guards", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
  });

  it("fails 503 when the wrk1 host env is not configured", async () => {
    (resolveProxmoxTargetConfiguration as jest.Mock).mockReturnValue({ env: {} });
    const r = await provisionWorkspaceCloudAgent({ userId: "u", name: "n" });
    expect(r).toMatchObject({ ok: false, status: 503 });
  });

  it("fails 503 when Cloudflare DNS is not configured", async () => {
    (resolveProxmoxTargetConfiguration as jest.Mock).mockReturnValue({
      env: { PROXMOX_PUBLIC_IP: "198.51.100.76" },
    });
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_ZONE_ID;
    const r = await provisionWorkspaceCloudAgent({ userId: "u", name: "n" });
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect((r as { error: string }).error).toContain("Cloudflare");
  });
});

describe("OAuth device-login scripts", () => {
  function decodeGuest(hostScript: string): string {
    const b64 = hostScript.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/)?.[1] ?? "";
    return Buffer.from(b64, "base64").toString("utf8");
  }

  it("start launches the agent CLI device-flow for the provider, detached", () => {
    const s = buildOAuthStartScript({ ip: "10.250.30.50", provider: "openai-codex" });
    expect(s).toContain("10.250.30.50");
    const guest = decodeGuest(s);
    expect(guest).toContain("auth add openai-codex --type oauth --no-browser");
    expect(guest).toContain("setsid");
    expect(guest).toContain("Enter this code");
  });

  it("status reports PENDING from the live device-flow process, not from log text", () => {
    const s = buildOAuthStatusScript({ ip: "10.250.30.50", provider: "nous" });
    const guest = decodeGuest(s);
    expect(guest).toContain('pgrep -f "auth add nous ');
    expect(guest).toContain("auth status nous");
    expect(guest).toContain("WC_OAUTH_STATUS:PENDING");
    expect(guest).toContain("WC_OAUTH_STATUS:AUTHED");
    expect(guest).toContain("WC_OAUTH_STATUS:FAILED");
    expect(guest).not.toContain("cancel");
  });
});

describe("applyWorkspaceCloudModelConfig (per-user key push)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    (resolveProxmoxTargetConfiguration as jest.Mock).mockReturnValue({ env: {} });
  });

  function decodeGuest(hostScript: string): string {
    const b64 = hostScript.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/)?.[1] ?? "";
    return Buffer.from(b64, "base64").toString("utf8");
  }

  it("rejects an injection-y API key without touching the host", async () => {
    const r = await applyWorkspaceCloudModelConfig({
      ip: "10.250.30.51",
      apiKey: "abc'; rm -rf / #",
      model: "google/gemini-2.5-flash-lite",
    });
    expect(r).toMatchObject({ ok: false });
    expect(runProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("rejects an injection-y model name without touching the host", async () => {
    const r = await applyWorkspaceCloudModelConfig({
      ip: "10.250.30.51",
      apiKey: "sk-or-v1-" + "a".repeat(40),
      model: "foo; reboot",
    });
    expect(r).toMatchObject({ ok: false });
    expect(runProxmoxHostScript).not.toHaveBeenCalled();
  });

  it("selects provider + model via config set and writes the key (key-based)", async () => {
    (runProxmoxHostScript as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "APPLY_OK\n",
      stderr: "",
    });
    const apiKey = "sk-or-v1-" + "b".repeat(40);
    const r = await applyWorkspaceCloudModelConfig({
      ip: "10.250.30.51",
      provider: "openrouter",
      apiKey,
      model: "google/gemini-2.5-flash-lite",
    });
    expect(r).toMatchObject({ ok: true });
    const guest = decodeGuest((runProxmoxHostScript as jest.Mock).mock.calls[0][0] as string);
    // model + provider go through `hermes config set` (config.yaml), not .env
    expect(guest).toContain("config set model.provider 'openrouter'");
    expect(guest).toContain("config set model.default 'google/gemini-2.5-flash-lite'");
    // the key is written to the matching .env var
    expect(guest).toContain(`OPENROUTER_API_KEY=${apiKey}`);
    expect(guest).toContain("restart hermes-gateway");
  });

  it("selects an OAuth provider + model without writing any key", async () => {
    (runProxmoxHostScript as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "APPLY_OK\n",
      stderr: "",
    });
    const r = await applyWorkspaceCloudModelConfig({
      ip: "10.250.30.51",
      provider: "openai-codex",
      model: "gpt-5.5",
    });
    expect(r).toMatchObject({ ok: true });
    const guest = decodeGuest((runProxmoxHostScript as jest.Mock).mock.calls[0][0] as string);
    expect(guest).toContain("config set model.provider 'openai-codex'");
    expect(guest).toContain("config set model.default 'gpt-5.5'");
    // OAuth providers hold a token on the agent — no API key is written
    expect(guest).not.toContain("API_KEY=");
  });

  it("fails when the host script does not confirm APPLY_OK", async () => {
    (runProxmoxHostScript as jest.Mock).mockResolvedValue({
      ok: true,
      stdout: "something else",
      stderr: "",
    });
    const r = await applyWorkspaceCloudModelConfig({
      ip: "10.250.30.51",
      apiKey: "sk-or-v1-" + "c".repeat(40),
      model: "",
    });
    expect(r).toMatchObject({ ok: false });
  });
});

// ── Host-to-guest SSH on Workspace Cloud VMs (F009) ─────────────────────────────
// The agent API key and the customer's model key travel over these calls, so
// every generated host script must reach the guest only through the VMID-bound,
// QEMU-Guest-Agent-attested prelude, never with host-key checking disabled.

const PROVISION_SCRIPT = buildProvisionScript({
  templateVmid: 9100,
  vmid: 2000,
  ip: "10.250.30.50",
  subdomain: "wsc-0123456789abcdef",
  fqdn: "wsc-0123456789abcdef.hermesos.cloud",
  apiKey: "a".repeat(64),
});
const APPLY_MODEL_SCRIPT = buildApplyModelScript({
  ip: "10.250.30.51",
  provider: "openrouter",
  model: "google/gemini-2.5-flash-lite",
  apiKey: "sk-or-v1-" + "b".repeat(40),
  keyEnvVar: "OPENROUTER_API_KEY",
});
const OAUTH_START_SCRIPT = buildOAuthStartScript({ ip: "10.250.30.52", provider: "openai-codex" });
const OAUTH_STATUS_SCRIPT = buildOAuthStatusScript({ ip: "10.250.30.52", provider: "nous" });

const GENERATED_HOST_SCRIPTS: Array<[string, string]> = [
  ["provision", PROVISION_SCRIPT],
  ["apply model", APPLY_MODEL_SCRIPT],
  ["oauth start", OAUTH_START_SCRIPT],
  ["oauth status", OAUTH_STATUS_SCRIPT],
];

const bashSyntax = (script: string) => spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });

/** The guest command body a host script ships in its `echo '<b64>' | base64 -d | bash` line. */
function guestBodyOf(hostScript: string): string | null {
  const b64 = hostScript.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/)?.[1];
  return b64 ? Buffer.from(b64, "base64").toString("utf8") : null;
}

describe("Workspace Cloud guest SSH never disables host-key checking (F009)", () => {
  it("the provisioner source no longer carries the StrictHostKeyChecking=no bypass", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../workspace-cloud-provisioner.ts"),
      "utf8",
    );
    expect(source).not.toContain("StrictHostKeyChecking=no");
  });

  it.each(GENERATED_HOST_SCRIPTS)("%s script pins the guest through the VMID-bound prelude", (_label, script) => {
    expect(script).not.toContain("StrictHostKeyChecking=no");
    expect(script).toContain("StrictHostKeyChecking=yes");
    expect(script).toContain('"hermes@$GUEST_IP"');
    expect(script).toContain("qm guest exec");
    // Guest calls use the prelude's array, never the old string form.
    // (The prelude's own GUEST_SSH_* variables are not the bare array name.)
    expect(script).not.toMatch(/\$\{?GUEST_SSH\}?(?![\w[])/);
    expect(script.indexOf("GUEST_SSH=(ssh ")).toBeGreaterThan(0);
    expect(script.indexOf("GUEST_SSH=(ssh ")).toBeLessThan(script.indexOf('"${GUEST_SSH[@]}"'));
  });

  it.each(GENERATED_HOST_SCRIPTS)("%s script is accepted by bash -n", (_label, script) => {
    expect(bashSyntax(script)).toMatchObject({ status: 0, stderr: "" });
  });

  it.each([
    ["apply model", APPLY_MODEL_SCRIPT],
    ["oauth start", OAUTH_START_SCRIPT],
    ["oauth status", OAUTH_STATUS_SCRIPT],
  ])("the guest body %s ships is accepted by bash -n and has no host-key bypass", (_label, script) => {
    const guest = guestBodyOf(script);
    expect(guest).not.toBeNull();
    expect(guest).not.toContain("StrictHostKeyChecking=no");
    expect(bashSyntax(guest ?? "")).toMatchObject({ status: 0, stderr: "" });
  });

  it("refuses a guest whose IP is configured on a different VM", () => {
    const host = createStubProxmoxGuestHost();
    try {
      const script = APPLY_MODEL_SCRIPT.replace(
        "VM_SSH_KEY_PATH=/etc/hivra/keys/vm-orchestrator",
        `VM_SSH_KEY_PATH=${host.vmKeyPath}`,
      );
      const result = host.run(script, {
        vms: [{ vmid: 2001, ip: "10.250.30.99" }],
        serverHostKey: GENUINE_GUEST_HOST_KEY,
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("VMID-bound SSH refused");
      expect(result.sshCalls).toEqual([]);
      expect(result.delivered).toBe("");
    } finally {
      host.cleanup();
    }
  });

  it("sends the guest command only to the VM whose attested host key answers", () => {
    const host = createStubProxmoxGuestHost();
    try {
      const script = APPLY_MODEL_SCRIPT.replace(
        "VM_SSH_KEY_PATH=/etc/hivra/keys/vm-orchestrator",
        `VM_SSH_KEY_PATH=${host.vmKeyPath}`,
      );
      const result = host.run(script, {
        vms: [{ vmid: 2001, ip: "10.250.30.51" }],
        serverHostKey: GENUINE_GUEST_HOST_KEY,
      });
      expect(result.status).toBe(0);
      expect(result.sshCalls).toHaveLength(1);
      expect(result.sshCalls[0]).toMatch(/^hermes@10\.250\.30\.51 /);
      expect(result.sshArgs[0]).toEqual(expect.arrayContaining(["-i", host.vmKeyPath]));
    } finally {
      host.cleanup();
    }
  });

  it("sends nothing when the machine answering at the guest IP presents another host key", () => {
    const host = createStubProxmoxGuestHost();
    try {
      const script = APPLY_MODEL_SCRIPT.replace(
        "VM_SSH_KEY_PATH=/etc/hivra/keys/vm-orchestrator",
        `VM_SSH_KEY_PATH=${host.vmKeyPath}`,
      );
      // The VM's agent attests the genuine key, but a spoofing neighbour answers at the IP.
      const result = host.run(script, {
        vms: [{ vmid: 2001, ip: "10.250.30.51", attestedHostKey: GENUINE_GUEST_HOST_KEY }],
        serverHostKey: SPOOFED_GUEST_HOST_KEY,
      });
      expect(result.status).not.toBe(0);
      expect(result.sshCalls).toEqual([]);
      expect(result.delivered).toBe("");
    } finally {
      host.cleanup();
    }
  });
});
