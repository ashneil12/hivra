import fs from "fs";
import path from "path";

import {
  HIVRA_WALLET_AGENT_COLUMNS,
  loadOwnedHivraWalletAgent,
  reconcileBankrEnvAfterHivraBoot,
  type HivraBootWalletAgent,
} from "../hivra-lane";
import {
  getBankrWalletForHivraAgent,
  type InstanceBankrWalletRecord,
} from "@/lib/billing/bankr-instance-wallets";
import { decryptApiKey } from "@/lib/crypto";
import {
  resolveHivraAgentExecutionContext,
  type HivraAgentExecutionContext,
} from "@/lib/hivra/agent-execution-context";
import { removeBankrWalletEnvFromBox, seedBankrWalletEnvOntoBox } from "@/lib/hivra/bankr-wallet-env-seed";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/crypto", () => ({ ...jest.requireActual("@/lib/crypto"), decryptApiKey: jest.fn() }));
jest.mock("@/lib/billing/bankr-instance-wallets", () => ({
  ...jest.requireActual("@/lib/billing/bankr-instance-wallets"),
  getBankrWalletForHivraAgent: jest.fn(),
}));
jest.mock("@/lib/hivra/agent-execution-context", () => ({ resolveHivraAgentExecutionContext: jest.fn() }));
jest.mock("@/lib/hivra/bankr-wallet-env-seed", () => ({
  seedBankrWalletEnvOntoBox: jest.fn(),
  removeBankrWalletEnvFromBox: jest.fn(),
}));

/**
 * Regression: the wallet routes loaded agents with a hand-picked column list
 * that predated binding tokens, provisioner channels and substrates, so the
 * execution-context resolver refused every Hivra agent ("invalid
 * infrastructure binding") and no wallet key could reach a box. Found live on
 * Canary on 2026-09-24 with a freshly launched agent.
 */
describe("Hivra wallet agent loader", () => {
  it("selects every field the execution-context resolver reads", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../hivra/agent-execution-context.ts"),
      "utf8"
    );
    const bindingType = source.match(/export type HivraAgentInfrastructureBinding = \{([\s\S]*?)\};/);
    expect(bindingType).not.toBeNull();
    const resolverFields = [...bindingType![1].matchAll(/^\s*(\w+)\?:/gm)].map((m) => m[1]);
    expect(resolverFields.length).toBeGreaterThan(5);
    for (const field of resolverFields) {
      expect(HIVRA_WALLET_AGENT_COLUMNS).toContain(field);
    }
  });

  it("queries hivra_agents with that column list, scoped to the owner", async () => {
    const eq = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnValue({ eq, maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }) });
    eq.mockReturnValue({ eq, maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }) });
    (supabaseAdmin!.from as jest.Mock).mockReturnValue({ select });

    await loadOwnedHivraWalletAgent("agent_1", "user_123");

    expect(supabaseAdmin!.from).toHaveBeenCalledWith("hivra_agents");
    expect(select).toHaveBeenCalledWith(HIVRA_WALLET_AGENT_COLUMNS.join(","));
    expect(eq).toHaveBeenCalledWith("id", "agent_1");
    expect(eq).toHaveBeenCalledWith("user_id", "user_123");
  });
});

/**
 * Regression (Gap C): the wallet routes only sync bankr.env onto a running box.
 * A connect made while the box was stopped never reached it, and a disconnect
 * made while stopped left the old key on disk, read again at the next start.
 * Nothing re-applied the wallet row when the box came back up.
 */
describe("reconcileBankrEnvAfterHivraBoot", () => {
  const mockedGetWallet = getBankrWalletForHivraAgent as jest.MockedFunction<typeof getBankrWalletForHivraAgent>;
  const mockedDecrypt = decryptApiKey as jest.MockedFunction<typeof decryptApiKey>;
  const mockedResolve = resolveHivraAgentExecutionContext as jest.MockedFunction<typeof resolveHivraAgentExecutionContext>;
  const mockedSeed = seedBankrWalletEnvOntoBox as jest.MockedFunction<typeof seedBankrWalletEnvOntoBox>;
  const mockedRemove = removeBankrWalletEnvFromBox as jest.MockedFunction<typeof removeBankrWalletEnvFromBox>;
  const mockedLog = log as unknown as { info: jest.Mock; warn: jest.Mock };

  // Placeholder, not a real Bankr key.
  const FIXTURE_KEY = "bk_usr_fixture0_placeholdervalue0000";
  const WALLET = "0x00000000000000000000000000000000000c0ffe";
  const CONTEXT = {
    kind: "managed",
    host: "fixturenode10",
    env: { PROXMOX_NODE: "fixturenode10" },
  } as unknown as HivraAgentExecutionContext;
  const RESOLVED_CONTEXT = {
    kind: "managed",
    host: "fixturenode11",
    env: { PROXMOX_NODE: "fixturenode11" },
  } as unknown as HivraAgentExecutionContext;
  const BOX = { id: "agent_1", type: "claude-code", ip: "10.250.20.42", vmid: 1100 };

  function bootedAgent(overrides: Partial<HivraBootWalletAgent> = {}): HivraBootWalletAgent {
    return {
      ...BOX,
      status: "running",
      deployment_mode: "hivra-managed",
      proxmox_host: "fixturenode10",
      managed_provisioner_channel: "default",
      ...overrides,
    };
  }

  function walletRow(overrides: Record<string, unknown> = {}): InstanceBankrWalletRecord {
    return {
      id: "wallet_row_1",
      instanceId: null,
      hivraAgentId: "agent_1",
      userId: "user_123",
      bankrWalletId: `user:${WALLET}`,
      evmAddress: WALLET,
      normalizedEvmAddress: WALLET,
      apiKeyPreview: "bk_usr_fi...0000",
      apiKeyStatus: "active",
      withdrawalDestinationEvm: null,
      withdrawalDestinationSetAt: null,
      status: "active",
      metadata: { custodyModel: "user_owned_bankr_account" },
      createdAt: "2026-09-24T10:00:00.000Z",
      updatedAt: "2026-09-24T10:00:00.000Z",
      apiKeyEncrypted: "enc:fixture",
      ...overrides,
    } as InstanceBankrWalletRecord;
  }

  const disconnectedRow = (overrides: Record<string, unknown> = {}) => walletRow({
    status: "revoked",
    apiKeyStatus: "revoked",
    apiKeyPreview: null,
    apiKeyEncrypted: null,
    metadata: { custodyModel: "user_owned_bankr_account", disconnectedAt: "2026-09-24T11:00:00.000Z" },
    updatedAt: "2026-09-24T11:00:00.000Z",
    ...overrides,
  });

  beforeEach(() => {
    mockedGetWallet.mockReset();
    mockedDecrypt.mockReset().mockReturnValue(FIXTURE_KEY);
    mockedResolve.mockReset().mockResolvedValue(RESOLVED_CONTEXT);
    mockedSeed.mockReset().mockResolvedValue({ ok: true });
    mockedRemove.mockReset().mockResolvedValue({ ok: true });
  });

  it("writes a key connected while the box was stopped, with the caller's lifecycle context", async () => {
    mockedGetWallet.mockResolvedValue(walletRow());

    const result = await reconcileBankrEnvAfterHivraBoot({
      userId: "user_123",
      agent: bootedAgent(),
      executionContext: CONTEXT,
      trigger: "poll",
    });

    expect(result).toEqual({ status: "synced" });
    expect(mockedGetWallet).toHaveBeenCalledWith({ hivraAgentId: "agent_1" });
    expect(mockedDecrypt).toHaveBeenCalledWith("enc:fixture");
    expect(mockedSeed).toHaveBeenCalledTimes(1);
    // The whole context, not only its env: the seed needs the binding tag and
    // guest key to pin SSH to this VMID.
    expect(mockedSeed).toHaveBeenCalledWith(
      BOX,
      { walletAddress: WALLET, apiKey: FIXTURE_KEY, walletId: `user:${WALLET}`, withdrawalDestination: null },
      CONTEXT,
    );
    expect(mockedRemove).not.toHaveBeenCalled();
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it("deletes the file for a key disconnected while the box was stopped", async () => {
    mockedGetWallet.mockResolvedValue(disconnectedRow());

    const result = await reconcileBankrEnvAfterHivraBoot({
      userId: "user_123",
      agent: bootedAgent(),
      executionContext: CONTEXT,
      trigger: "poll",
    });

    expect(result).toEqual({ status: "synced" });
    expect(mockedRemove).toHaveBeenCalledWith(BOX, CONTEXT);
    expect(mockedSeed).not.toHaveBeenCalled();
    expect(mockedDecrypt).not.toHaveBeenCalled();
  });

  it("resolves a lifecycle context for the box when the caller has none", async () => {
    mockedGetWallet.mockResolvedValue(walletRow());
    const agent = bootedAgent();

    await reconcileBankrEnvAfterHivraBoot({ userId: "user_123", agent, trigger: "recovery" });

    expect(mockedResolve).toHaveBeenCalledWith("user_123", agent);
    expect(mockedSeed).toHaveBeenCalledWith(BOX, expect.anything(), RESOLVED_CONTEXT);
  });

  it.each([
    ["active", walletRow({ metadata: { custodyModel: "bankr_custodied_agent_wallet" } })],
    ["revoked", walletRow({ status: "revoked", metadata: { custodyModel: "bankr_custodied_agent_wallet" } })],
    ["legacy", walletRow({ metadata: {} })],
  ])("leaves a Hivra-provisioned wallet (%s) exactly as it is", async (_label, row) => {
    mockedGetWallet.mockResolvedValue(row);

    const result = await reconcileBankrEnvAfterHivraBoot({
      userId: "user_123",
      agent: bootedAgent(),
      executionContext: CONTEXT,
      trigger: "poll",
    });

    expect(result).toEqual({ status: "skipped" });
    expect(mockedSeed).not.toHaveBeenCalled();
    expect(mockedRemove).not.toHaveBeenCalled();
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(mockedDecrypt).not.toHaveBeenCalled();
  });

  it.each([
    ["no wallet row", null],
    ["another user's row", walletRow({ userId: "user_other" })],
  ])("makes no SSH call for %s", async (_label, row) => {
    mockedGetWallet.mockResolvedValue(row);

    const result = await reconcileBankrEnvAfterHivraBoot({ userId: "user_123", agent: bootedAgent(), trigger: "poll" });

    expect(result).toEqual({ status: "skipped" });
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(mockedSeed).not.toHaveBeenCalled();
    expect(mockedRemove).not.toHaveBeenCalled();
  });

  it.each([
    ["an agent type without wallets", { type: "linux-desktop" }],
    ["a box that is not running", { status: "stopped" }],
    ["a box still provisioning", { status: "provisioning" }],
    ["a box without an ip", { ip: "" }],
    ["a box with a null ip", { ip: null }],
  ])("skips %s without reading the wallet", async (_label, overrides) => {
    const result = await reconcileBankrEnvAfterHivraBoot({
      userId: "user_123",
      agent: bootedAgent(overrides as Partial<HivraBootWalletAgent>),
      executionContext: CONTEXT,
      trigger: "poll",
    });

    expect(result).toEqual({ status: "skipped" });
    expect(mockedGetWallet).not.toHaveBeenCalled();
    expect(mockedSeed).not.toHaveBeenCalled();
    expect(mockedRemove).not.toHaveBeenCalled();
  });

  it("never deletes the file when the stored key can't be decrypted", async () => {
    mockedGetWallet.mockResolvedValue(walletRow());
    mockedDecrypt.mockImplementation(() => {
      throw new Error("Unsupported state or unable to authenticate data");
    });

    const result = await reconcileBankrEnvAfterHivraBoot({
      userId: "user_123",
      agent: bootedAgent(),
      executionContext: CONTEXT,
      trigger: "poll",
    });

    expect(result).toEqual({ status: "failed", error: "Unsupported state or unable to authenticate data" });
    expect(mockedRemove).not.toHaveBeenCalled();
    expect(mockedSeed).not.toHaveBeenCalled();
    expect(mockedLog.warn).toHaveBeenCalledWith(
      "hivra agent wallet env sync failed after boot",
      expect.objectContaining({ failureType: "hivra_agent_wallet_boot_env_sync_failed", action: "write" }),
    );
  });

  it("reports an SSH failure without throwing or logging the key", async () => {
    mockedGetWallet.mockResolvedValue(walletRow());
    mockedSeed.mockResolvedValue({ ok: false, error: "ssh: connect to host 10.250.20.42 port 22: timed out" });

    const result = await reconcileBankrEnvAfterHivraBoot({
      userId: "user_123",
      agent: bootedAgent(),
      executionContext: CONTEXT,
      trigger: "recovery",
    });

    expect(result).toEqual({ status: "failed", error: "ssh: connect to host 10.250.20.42 port 22: timed out" });
    expect(mockedLog.warn).toHaveBeenCalledWith("hivra agent wallet env sync failed after boot", {
      source: "hivra-agent-wallet-boot-sync",
      agentId: "agent_1",
      trigger: "recovery",
      action: "write",
      failureType: "hivra_agent_wallet_boot_env_sync_failed",
      error: "ssh: connect to host 10.250.20.42 port 22: timed out",
    });
    const logged = JSON.stringify([mockedLog.warn.mock.calls, mockedLog.info.mock.calls]);
    expect(logged).not.toContain(FIXTURE_KEY);
    expect(logged).not.toContain("enc:fixture");
  });

  it("reports a context resolution failure without throwing or touching the box", async () => {
    mockedGetWallet.mockResolvedValue(walletRow());
    mockedResolve.mockRejectedValue(new Error("binding_invalid"));

    const result = await reconcileBankrEnvAfterHivraBoot({ userId: "user_123", agent: bootedAgent(), trigger: "recovery" });

    expect(result).toEqual({ status: "failed", error: "binding_invalid" });
    expect(mockedSeed).not.toHaveBeenCalled();
    expect(mockedRemove).not.toHaveBeenCalled();
  });

  it("reports a wallet read failure without throwing or touching the box", async () => {
    mockedGetWallet.mockRejectedValue(new Error("Failed to load Bankr instance wallet"));

    const result = await reconcileBankrEnvAfterHivraBoot({ userId: "user_123", agent: bootedAgent(), trigger: "poll" });

    expect(result).toEqual({ status: "failed", error: "Failed to load Bankr instance wallet" });
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(mockedSeed).not.toHaveBeenCalled();
    expect(mockedRemove).not.toHaveBeenCalled();
  });

  it("re-applies the fresh row when a disconnect lands while the key is being written", async () => {
    mockedGetWallet
      .mockResolvedValueOnce(walletRow())
      .mockResolvedValueOnce(disconnectedRow());

    const result = await reconcileBankrEnvAfterHivraBoot({
      userId: "user_123",
      agent: bootedAgent(),
      executionContext: CONTEXT,
      trigger: "poll",
    });

    expect(result).toEqual({ status: "synced" });
    expect(mockedSeed).toHaveBeenCalledTimes(1);
    expect(mockedRemove).toHaveBeenCalledTimes(1);
    expect(mockedSeed.mock.invocationCallOrder[0]).toBeLessThan(mockedRemove.mock.invocationCallOrder[0]);
  });

  it("syncs once when the row did not change while syncing", async () => {
    mockedGetWallet.mockResolvedValue(walletRow());

    await reconcileBankrEnvAfterHivraBoot({ userId: "user_123", agent: bootedAgent(), executionContext: CONTEXT, trigger: "poll" });

    expect(mockedGetWallet).toHaveBeenCalledTimes(2);
    expect(mockedSeed).toHaveBeenCalledTimes(1);
    expect(mockedRemove).not.toHaveBeenCalled();
  });
});
