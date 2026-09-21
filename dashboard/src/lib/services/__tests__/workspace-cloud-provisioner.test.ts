import {
  provisionWorkspaceCloudAgent,
  applyWorkspaceCloudModelConfig,
  buildOAuthStartScript,
  buildOAuthStatusScript,
} from "@/lib/services/workspace-cloud-provisioner";
import {
  resolveProxmoxTargetConfiguration,
  runProxmoxHostScript,
} from "@/lib/services/proxmox-instance-service";

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
