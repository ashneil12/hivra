import { applyBankrWalletChangeToWebfreeInstance } from "../hermes-webfree-wallet-sync";
import { loadGlobalHermesSettingsForUser } from "@/lib/clerk-hermes-settings";
import { log } from "@/lib/logger";
import { applyLiveUpdate, resolveInstanceIpv4 } from "@/lib/services/instance-orchestrator";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => {
  const chain: Record<string, jest.Mock> = {};
  for (const method of ["select", "eq", "neq"]) chain[method] = jest.fn(() => chain);
  chain.maybeSingle = jest.fn();
  return { supabaseAdmin: { from: jest.fn(() => chain), __chain: chain } };
});
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/services/instance-orchestrator", () => ({
  applyLiveUpdate: jest.fn(),
  resolveInstanceIpv4: jest.fn(),
}));
jest.mock("@/lib/clerk-hermes-settings", () => ({ loadGlobalHermesSettingsForUser: jest.fn() }));

const chain = (supabaseAdmin as unknown as { __chain: Record<string, jest.Mock> }).__chain;
const mockedApply = applyLiveUpdate as jest.MockedFunction<typeof applyLiveUpdate>;
const mockedIpv4 = resolveInstanceIpv4 as jest.MockedFunction<typeof resolveInstanceIpv4>;
const mockedSettings = loadGlobalHermesSettingsForUser as jest.MockedFunction<typeof loadGlobalHermesSettingsForUser>;

const settings = { memory: { enabled: true } } as unknown as Awaited<ReturnType<typeof loadGlobalHermesSettingsForUser>>;

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "inst_123",
    user_id: "user_123",
    name: "Scout",
    status: "running",
    lifecycle_state: "active",
    entitlement_state: "ok",
    backend: "gateway",
    provider: "openai",
    api_key_encrypted: "enc",
    config: {},
    created_at: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function run() {
  return applyBankrWalletChangeToWebfreeInstance({ instanceId: "inst_123", userId: "user_123" });
}

describe("applyBankrWalletChangeToWebfreeInstance", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    chain.maybeSingle.mockResolvedValue({ data: row(), error: null });
    mockedIpv4.mockResolvedValue("10.250.20.55");
    mockedSettings.mockResolvedValue(settings);
    mockedApply.mockResolvedValue({ applied: true });
  });

  it("runs one live update of a running, active webfree box from a fresh owned row", async () => {
    await expect(run()).resolves.toEqual({ status: "update_started" });

    expect(supabaseAdmin!.from).toHaveBeenCalledWith("hermes_instances");
    expect(chain.eq).toHaveBeenCalledWith("id", "inst_123");
    expect(chain.eq).toHaveBeenCalledWith("user_id", "user_123");
    expect(chain.neq).toHaveBeenCalledWith("status", "deleted");
    expect(mockedIpv4).toHaveBeenCalledWith(expect.objectContaining({ id: "inst_123" }), supabaseAdmin);
    expect(mockedSettings).toHaveBeenCalledWith("user_123", { instanceId: "inst_123" });
    expect(mockedApply).toHaveBeenCalledTimes(1);
    // Same call as the Update button, and never the terminal-backend override.
    expect(mockedApply.mock.calls[0]).toEqual([
      expect.objectContaining({ id: "inst_123", backend: "gateway" }),
      "10.250.20.55",
      settings,
      supabaseAdmin,
    ]);
  });

  it("also updates a legacy backend='webui' box", async () => {
    chain.maybeSingle.mockResolvedValue({ data: row({ backend: "webui" }), error: null });
    await expect(run()).resolves.toEqual({ status: "update_started" });
  });

  it.each([
    ["an update is already running", { status: "redeploying", lifecycle_state: "provisioning" }, "update_in_progress"],
    ["the box is provisioning", { status: "provisioning" }, "not_running"],
    ["the box is stopped", { status: "stopped" }, "not_running"],
    ["the box is paused", { lifecycle_state: "paused" }, "not_active_lifecycle"],
    ["the last launch failed", { lifecycle_state: "failed" }, "not_active_lifecycle"],
    ["compute is suspended", { entitlement_state: "suspended" }, "entitlement_suspended"],
    ["the backend is not webfree", { backend: null }, "not_webfree"],
  ])("skips without updating when %s", async (_label, overrides, reason) => {
    chain.maybeSingle.mockResolvedValue({ data: row(overrides), error: null });

    await expect(run()).resolves.toEqual({ status: "skipped", reason });
    expect(mockedApply).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      "agent wallet runtime update skipped",
      expect.objectContaining({ failureType: "agent_wallet_runtime_update_skipped", reason })
    );
  });

  it("skips when the box has no reachable address", async () => {
    mockedIpv4.mockResolvedValue("");
    await expect(run()).resolves.toEqual({ status: "skipped", reason: "no_address" });
    expect(mockedApply).not.toHaveBeenCalled();
  });

  it("reports a launch failure with a redacted log", async () => {
    mockedApply.mockResolvedValue({ applied: false, error: 'ssh failed {"client_secret":"super-secret"}' });

    await expect(run()).resolves.toEqual({ status: "failed" });
    expect(log.warn).toHaveBeenCalledWith(
      "agent wallet runtime update failed",
      expect.objectContaining({ failureType: "agent_wallet_runtime_update_failed", instanceId: "inst_123" })
    );
    expect(JSON.stringify((log.warn as jest.Mock).mock.calls)).not.toContain("super-secret");
  });

  it("never throws: the wallet change has already committed", async () => {
    mockedApply.mockRejectedValue(new Error("proxmox host env missing"));
    await expect(run()).resolves.toEqual({ status: "failed" });

    chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(run()).resolves.toEqual({ status: "failed" });

    chain.maybeSingle.mockResolvedValue({ data: null, error: { message: "db down" } });
    await expect(run()).resolves.toEqual({ status: "failed" });
    expect(mockedApply).toHaveBeenCalledTimes(1);
  });
});
