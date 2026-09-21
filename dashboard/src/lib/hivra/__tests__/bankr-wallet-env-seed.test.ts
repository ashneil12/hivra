import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";

import {
  buildBankrEnvFileContent,
  buildBankrEnvGuestScript,
  buildBankrEnvHostScript,
  seedBankrWalletEnvOntoBox,
} from "../bankr-wallet-env-seed";

jest.mock("@/lib/services/proxmox-instance-service", () => ({
  __esModule: true,
  runProxmoxHostScript: jest.fn(),
}));

const mockedRunScript = runProxmoxHostScript as jest.MockedFunction<typeof runProxmoxHostScript>;

const cfg = {
  walletAddress: "0x000000000000000000000000000000000000ba5e",
  apiKey: "bk_agent_secret",
  walletId: "wlt_123",
  withdrawalDestination: null,
};

describe("buildBankrEnvFileContent", () => {
  it("emits the primary key + every alias both lanes' skills read", () => {
    const content = buildBankrEnvFileContent(cfg);
    expect(content).toContain("BANKR_API_KEY=bk_agent_secret");
    expect(content).toContain("BANKR_AGENT_API_KEY=bk_agent_secret");
    expect(content).toContain("WALLET_ADDRESS=0x000000000000000000000000000000000000ba5e");
    expect(content).toContain("BANKR_WALLET_ADDRESS=");
    expect(content).toContain("BANKR_AGENT_WALLET_ID=wlt_123");
    expect(content).not.toContain("BANKR_AGENT_WITHDRAWAL_DESTINATION");
  });

  it("includes the withdrawal destination when set", () => {
    const content = buildBankrEnvFileContent({
      ...cfg,
      withdrawalDestination: "0x000000000000000000000000000000000000feed",
    });
    expect(content).toContain(
      "BANKR_AGENT_WITHDRAWAL_DESTINATION=0x000000000000000000000000000000000000feed"
    );
  });
});

describe("buildBankrEnvGuestScript", () => {
  const script = buildBankrEnvGuestScript("BANKR_API_KEY=secret'with'quotes\n");

  it("writes ~/.hivra/bankr.env with owner-only permissions", () => {
    expect(script).toContain('> "$BUX/.hivra/bankr.env"');
    expect(script).toContain("umask 077");
    expect(script).toContain('chmod 0600 "$BUX/.hivra/bankr.env"');
  });

  it("base64-wraps the credentials so no secret reaches the shell", () => {
    expect(script).not.toContain("secret'with'quotes");
    const b64 = Buffer.from("BANKR_API_KEY=secret'with'quotes\n", "utf8").toString("base64");
    expect(b64).not.toContain("'");
    expect(script).toContain(`printf '%s' '${b64}' | base64 -d`);
  });

  it("emits the success marker the caller greps for", () => {
    expect(script.trim().endsWith("echo HIVRA_BANKR_ENV_OK")).toBe(true);
  });
});

describe("buildBankrEnvHostScript", () => {
  it("streams over stdin with the provisioner's host->guest key", () => {
    const host = buildBankrEnvHostScript("10.250.20.42", "echo hi");
    expect(host).toContain("KEY=/etc/hivra/keys/vm-orchestrator");
    expect(host).toMatch(/printf '%s' '[A-Za-z0-9+/=]+' \| ssh /);
    expect(host).toContain('"base64 -d | sudo bash"');
  });
});

describe("seedBankrWalletEnvOntoBox", () => {
  beforeEach(() => mockedRunScript.mockReset());

  it("skips non-CLI agent types without touching SSH", async () => {
    const res = await seedBankrWalletEnvOntoBox({ id: "a", type: "aeon", ip: "10.240.0.1" }, cfg, {});
    expect(res).toEqual({ ok: false, skipped: "unsupported_type" });
    expect(mockedRunScript).not.toHaveBeenCalled();
  });

  it("rejects a missing box ip", async () => {
    const res = await seedBankrWalletEnvOntoBox({ id: "a", type: "codex", ip: null }, cfg, {});
    expect(res.ok).toBe(false);
    expect(mockedRunScript).not.toHaveBeenCalled();
  });

  it("returns ok when the box reports the success marker", async () => {
    mockedRunScript.mockResolvedValue({
      ok: true,
      stdout: "HIVRA_BANKR_ENV_OK\n",
      stderr: "",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);
    const res = await seedBankrWalletEnvOntoBox({ id: "a", type: "claude-code", ip: "10.250.20.42" }, cfg, {});
    expect(res.ok).toBe(true);
  });

  it("reports failure when the marker is absent", async () => {
    mockedRunScript.mockResolvedValue({
      ok: false,
      stdout: "",
      stderr: "boom",
      error: "ssh failed",
    } as Awaited<ReturnType<typeof runProxmoxHostScript>>);
    const res = await seedBankrWalletEnvOntoBox({ id: "a", type: "codex", ip: "10.250.20.42" }, cfg, {});
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});
