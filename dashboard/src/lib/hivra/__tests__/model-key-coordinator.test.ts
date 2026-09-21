import { randomUUID, createHash } from "node:crypto";
import { createModelKeyCoordinator } from "../model-key-coordinator";
import { modelKeyBinding, type ModelKeyAgent, type ModelKeyOperation, type ModelKeyStore } from "../model-key-store";
import { expectedGuestLlmReceipt, type GuestLlmApplication, type GuestLlmDelivery } from "../guest-llm-transport";
import { ensureManagedVeniceWalletAccount } from "@/lib/billing/managed-venice-wallets";
import { generateManagedVenicePlaintextKey, hashManagedVeniceProxyKey } from "@/lib/venice/proxy-keys";
import { grantManagedVeniceStarterCredit, isManagedVeniceStarterCreditEnabled } from "@/lib/venice/managed-venice-starter-credit";
import { log } from "@/lib/logger";
import { ssrfSafeFetch } from "@/lib/ssrf-safe-fetch";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/crypto", () => ({ encryptSecret: jest.fn(), decryptSecret: jest.fn() }));
jest.mock("@/lib/billing/managed-venice-wallets", () => ({ ensureManagedVeniceWalletAccount: jest.fn() }));
jest.mock("@/lib/venice/proxy-keys", () => ({ generateManagedVenicePlaintextKey: jest.fn(), hashManagedVeniceProxyKey: jest.fn() }));
jest.mock("@/lib/venice/managed-venice-starter-credit", () => ({ grantManagedVeniceStarterCredit: jest.fn(), isManagedVeniceStarterCreditEnabled: jest.fn() }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/ssrf-safe-fetch", () => ({ ssrfSafeFetch: jest.fn() }));

const owner = "fixture-owner", secret = "synthetic-model-key";
const byok = { provider: "venice", mode: "byok", apiKey: secret, model: "test-model" };
const managed = { provider: "venice", mode: "managed", walletType: "card", model: "test-model" };
function fixture() {
  const a: ModelKeyAgent = { id: randomUUID(), user_id: owner, type: "codex", status: "running", desired_state: "running",
    operation_id: null, deployment_mode: "managed", computer_substrate: "proxmox-kvm", allocation_operation_id: randomUUID(),
    proxmox_host: "fixture-host", vmid: 501, infrastructure_connection_id: null, infrastructure_connection_revision: null,
    deployment_target_id: null, provider_capacity_order_id: null, provider_enrollment_attempt_id: null, provider_server_id: null,
    cf_hostname: "model.hivra.test", cf_tunnel_id: randomUUID(), chat_url: "https://model.hivra.test", ip: null,
    api_token: "a".repeat(64), llm_config: null, llm_api_key_encrypted: null };
  const rows = new Map<string, ModelKeyOperation>();
  const store: jest.Mocked<ModelKeyStore> = {
    agent: jest.fn(async (user, id) => user === owner && id === a.id ? { ...a } : null),
    operation: jest.fn(async (user, id, op) => user !== owner || id !== a.id ? null
      : op ? rows.get(op) ?? null : [...rows.values()].find(row => row.phase === "pending") ?? null),
    admit: jest.fn(async (_user, _id, op, binding, request) => {
      rows.set(op, { operation_id: op, agent_id: a.id, user_id: owner, binding,
        request_digest: request.requestDigest as string, admission_connection_revision: null,
        config: request.config, payload: request.payload as ModelKeyOperation["payload"],
        encrypted_key: request.encryptedKey as string | null, cipher_digest: null,
        expected_state_digest: request.expectedStateDigest as string, expected_receipt: request.expectedReceipt as ModelKeyOperation["expected_receipt"],
        managed_key_id: (request.managedKey as { id: string } | null)?.id ?? null,
        phase: "pending", is_current: false, lease_id: null, lease_expires_at: null, dispatch_intent_at: null,
        created_at: new Date().toISOString(), applied_at: null, deleted_at: null });
      return "pending";
    }),
    claim: jest.fn(async (_user, _id, op) => {
      const j = rows.get(op)!;
      return { ...j, lease_id: randomUUID(), lease_expires_at: new Date(Date.now() + 20_000).toISOString() };
    }),
    settle: jest.fn(async (_user, _id, op, leaseId, receipt): Promise<boolean> => {
      const j = rows.get(op)!;
      expect(typeof leaseId).toBe("string"); expect(receipt).toEqual(j.expected_receipt);
      for (const row of rows.values()) row.is_current = false;
      a.llm_config = j.config; a.llm_api_key_encrypted = j.encrypted_key;
      Object.assign(j, { phase: "applied", is_current: true, encrypted_key: null });
      return true;
    }),
  };
  const inspect = jest.fn(async () => ({ ok: true as const, receipt: { protocol: "hivra-llm-apply-v1" as const,
    stateDigest: "0".repeat(64), operationId: null, payloadDigest: null, provider: null, model: null } }));
  const deliver = jest.fn(async (input: GuestLlmApplication, signal: AbortSignal, notAfter: number): Promise<GuestLlmDelivery> => {
    expect(signal.aborted).toBe(false); expect(notAfter).toBeGreaterThan(performance.now());
    return { status: "applied", receipt: expectedGuestLlmReceipt(input), writeAttempted: true };
  });
  const encrypt = jest.fn((key: string) => "sealed:" + key), decrypt = jest.fn((key: string) => key.slice(7));
  const prepareManaged = jest.fn(async () => ({ plaintext: secret, encryptedKey: "sealed:" + secret,
    record: { id: randomUUID(), accountId: randomUUID(), hash: createHash("sha256").update(secret).digest("hex"), prefix: "fixture-prefix" } }));
  const deps = { store, inspect, deliver, encrypt, decrypt, prepareManaged, managedBaseUrl: () => "https://dashboard.hivra.test/api/managed-venice/v1" };
  return { a, rows, store, inspect, deliver, encrypt, decrypt, prepareManaged, deps,
    coordinator: createModelKeyCoordinator(deps), op: randomUUID() };
}

afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

it("does not show native sign-in when a pending change settles between summary reads", async () => {
  const f = fixture();
  f.store.operation.mockImplementationOnce(async () => {
    // The same commit clears pending and updates the saved agent setting.
    // An agent snapshot read before this point would incorrectly remain null.
    f.a.llm_config = { provider: "venice", mode: "byok", model: "test-model" };
    return null;
  });
  const summary = await f.coordinator.summary(owner, f.a.id);
  expect(summary.llm).toMatchObject({ provider: "venice", mode: "byok", model: "test-model" });
  expect(summary.pending).toBeNull();
  expect(f.store.admit).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
});

it.each([byok, managed, null])("admits, reloads and settles only the original server-delivered setting: %j", async selection => {
  const f = fixture();
  await expect(f.coordinator.start(owner, f.a.id, f.op, selection)).resolves.toEqual({ operationId: f.op, status: "applied" });
  const request = f.store.admit.mock.calls[0][4];
  if (request.payload) expect(request.payload).not.toHaveProperty("apiKey");
  expect(JSON.stringify(request)).not.toContain(f.a.api_token!);
  expect(f.store.admit.mock.calls[0].slice(0, 4)).toEqual([owner, f.a.id, f.op, modelKeyBinding(f.a)]);
  expect(f.deliver).toHaveBeenCalledTimes(1);
  expect(f.deliver.mock.calls[0][0]).toMatchObject({ operationId: f.op, target: { hostname: f.a.cf_hostname, apiToken: f.a.api_token } });
  expect(f.deliver.mock.calls[0][1].aborted).toBe(true);
  expect(f.store.settle).toHaveBeenCalledWith(owner, f.a.id, f.op, expect.any(String), request.expectedReceipt);
  const summary = await f.coordinator.summary(owner, f.a.id);
  expect(summary.pending).toBeNull();
  if (selection) expect(summary.llm).toMatchObject({ provider: "venice", mode: selection.mode, model: "test-model" });
  else expect(summary.llm).toBeNull();
  for (const privateValue of [secret, f.a.api_token!, "proxyKeyId", "binding", "cipher", "sealed:"]) {
    expect(JSON.stringify(summary)).not.toContain(privateValue);
  }
  expect(f.prepareManaged).toHaveBeenCalledTimes(selection?.mode === "managed" ? 1 : 0);
});

it("delivers a standalone BYOK setting through the bound public HTTPS endpoint", async () => {
  const f = fixture();
  Object.assign(f.a, { computer_substrate: "provider-vm", ip: "203.0.113.10",
    chat_url: "https://203-0-113-10.sslip.io", cf_hostname: null, cf_tunnel_id: null });
  await expect(f.coordinator.start(owner, f.a.id, f.op, byok)).resolves.toMatchObject({ status: "applied" });
  expect(f.deliver.mock.calls[0][0].target).toEqual({ hostname: "203-0-113-10.sslip.io", apiToken: f.a.api_token, runtime: "codex" });
});

it.each([{ computer_substrate: "proxmox-kvm" }, { cf_tunnel_id: "conflict" }, { ip: "203.0.113.11" },
  { ip: "127.0.0.1", chat_url: "https://127-0-0-1.sslip.io" }])("rejects invalid direct recipient state before reading or sending keys: %j", async changes => {
  const f = fixture();
  Object.assign(f.a, { computer_substrate: "provider-vm", ip: "203.0.113.10",
    chat_url: "https://203-0-113-10.sslip.io", cf_hostname: null, cf_tunnel_id: null }, changes);
  await expect(f.coordinator.start(owner, f.a.id, f.op, byok)).rejects.toMatchObject({ code: "computer_not_ready" });
  expect(f.inspect).not.toHaveBeenCalled(); expect(f.encrypt).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
});

it.each([{}, [], undefined, { ...byok, apiKey: "tiny" }, { ...byok, apiKey: "a b c key" },
  { ...byok, model: "not a model" }, { ...byok, host: "different.hivra.test" }, { ...managed, walletType: "other" },
  { ...managed, apiKey: secret }, { ...byok, provider: "unknown" }])("rejects malformed selections before reads or side effects: %j", async input => {
  const f = fixture();
  await expect(f.coordinator.start(owner, f.a.id, f.op, input)).rejects.toMatchObject({ code: "invalid_request" });
  expect(f.store.agent).not.toHaveBeenCalled(); expect(f.inspect).not.toHaveBeenCalled();
  expect(f.prepareManaged).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
});

it("normalizes model defaults and whitespace without changing the selected wallet", async () => {
  const f = fixture();
  await f.coordinator.start(owner, f.a.id, f.op, { ...managed, model: "  " });
  expect(f.store.admit.mock.calls[0][4].config).toMatchObject({ model: "deepseek-v4-pro", walletType: "card" });
});

it.each([{ type: "hermes" }, { status: "provisioning" }, { desired_state: "deleted" }, { operation_id: randomUUID() },
  { api_token: "short" }, { chat_url: "https://other.hivra.test" }, { cf_tunnel_id: null }])("refuses unsupported or unready recipients: %j", async changes => {
  const f = fixture(); Object.assign(f.a, changes);
  await expect(f.coordinator.start(owner, f.a.id, f.op, managed)).rejects.toHaveProperty("code");
  expect(f.inspect).not.toHaveBeenCalled(); expect(f.store.admit).not.toHaveBeenCalled();
  expect(f.prepareManaged).not.toHaveBeenCalled();
});

it.each(["start", "summary", "resume"] as const)("keeps %s scoped to the original owner", async method => {
  const f = fixture();
  await expect(f.coordinator[method]("foreign", f.a.id, f.op, byok)).rejects.toMatchObject({ code: "not_found" });
  expect(f.store.admit).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
});

it("does not generate a candidate or touch a wallet when the guest is incompatible", async () => {
  const f = fixture(); f.inspect.mockResolvedValue({ ok: false, reason: "unsupported_guest" } as never);
  await expect(f.coordinator.start(owner, f.a.id, f.op, managed)).rejects.toMatchObject({ code: "guest_upgrade_required" });
  expect(f.prepareManaged).not.toHaveBeenCalled(); expect(f.store.admit).not.toHaveBeenCalled();
});

it("validates the server-selected endpoint before guest access or managed preparation", async () => {
  const f = fixture(), c = createModelKeyCoordinator({ ...f.deps, managedBaseUrl: () => "https://user:secret@other.test" });
  await expect(c.start(owner, f.a.id, f.op, managed)).rejects.toMatchObject({ code: "configuration_unavailable" });
  expect(f.inspect).not.toHaveBeenCalled(); expect(f.prepareManaged).not.toHaveBeenCalled();
});

it("retains pending metadata and resumes the same managed request without minting again", async () => {
  const f = fixture(); f.deliver.mockResolvedValueOnce({ status: "unconfirmed", reason: "delivery_unconfirmed" });
  await expect(f.coordinator.start(owner, f.a.id, f.op, managed)).resolves.toMatchObject({ status: "pending" });
  expect(f.a.llm_config).toBeNull(); expect(f.store.settle).not.toHaveBeenCalled();
  expect(await f.coordinator.summary(owner, f.a.id)).toMatchObject({ llm: null, pending: { operationId: f.op, requested: { mode: "managed" } } });
  await expect(f.coordinator.start(owner, f.a.id, f.op, managed)).resolves.toMatchObject({ status: "applied" });
  expect(f.store.admit).toHaveBeenCalledTimes(1); expect(f.prepareManaged).toHaveBeenCalledTimes(1);
  expect(f.deliver.mock.calls[1][0]).toEqual(f.deliver.mock.calls[0][0]);
  await expect(f.coordinator.resume(owner, f.a.id, f.op)).resolves.toMatchObject({ status: "applied" });
  expect(f.deliver).toHaveBeenCalledTimes(2);
});

it("rejects conflicting reuse and another pending change without generating keys", async () => {
  const f = fixture(); f.deliver.mockResolvedValue({ status: "unconfirmed", reason: "delivery_unconfirmed" });
  await f.coordinator.start(owner, f.a.id, f.op, managed);
  await expect(f.coordinator.start(owner, f.a.id, f.op, { ...managed, model: "different" })).rejects.toMatchObject({ code: "operation_conflict" });
  await expect(f.coordinator.start(owner, f.a.id, randomUUID(), managed)).rejects.toMatchObject({ code: "pending_change" });
  expect(f.prepareManaged).toHaveBeenCalledTimes(1); expect(f.store.admit).toHaveBeenCalledTimes(1);
});

it.each(["hostname", "encrypted_key", "expected_receipt"])("rejects corrupted or retargeted custody before a lease: %s", async change => {
  const f = fixture(); f.deliver.mockResolvedValue({ status: "unconfirmed", reason: "delivery_unconfirmed" });
  await f.coordinator.start(owner, f.a.id, f.op, byok);
  const row = f.rows.get(f.op)!;
  if (change === "hostname") row.binding.hostname = "other.hivra.test";
  else if (change === "encrypted_key") row.encrypted_key = "sealed:other-synthetic-key";
  else row.expected_receipt = { ...row.expected_receipt, stateDigest: "f".repeat(64) };
  f.store.claim.mockClear(); f.deliver.mockClear();
  await expect(f.coordinator.resume(owner, f.a.id, f.op)).rejects.toMatchObject({ code: "stored_setting_unavailable" });
  expect(f.store.claim).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
});

it.each(["busy", "expired", "slow_claim", "corrupt_claim"])("does not deliver using an unsafe lease: %s", async mode => {
  const f = fixture();
  const claim = f.store.claim.getMockImplementation()!;
  f.store.claim.mockImplementation(async (...args) => {
    const row = await claim(...args);
    if (mode === "busy") return null;
    if (mode === "expired") return { ...row!, lease_expires_at: new Date(Date.now() - 1).toISOString() };
    if (mode === "corrupt_claim") return { ...row!, binding: {} };
    jest.advanceTimersByTime(16_000); return row;
  });
  if (mode === "slow_claim") jest.useFakeTimers();
  if (mode === "corrupt_claim") await expect(f.coordinator.start(owner, f.a.id, f.op, byok)).rejects.toMatchObject({ code: "stored_setting_unavailable" });
  else await expect(f.coordinator.start(owner, f.a.id, f.op, byok)).resolves.toMatchObject({ status: "pending" });
  expect(f.deliver).not.toHaveBeenCalled(); expect(f.store.settle).not.toHaveBeenCalled();
});

it.each(["false", "throw"])("retains unconfirmed settlement (%s) and reuses the same operation", async mode => {
  const f = fixture();
  if (mode === "false") f.store.settle.mockResolvedValueOnce(false);
  else f.store.settle.mockRejectedValueOnce(new Error("PRIVATE " + secret));
  await expect(f.coordinator.start(owner, f.a.id, f.op, managed)).resolves.toEqual({ operationId: f.op, status: "pending", reason: "settlement_unconfirmed" });
  expect(f.a.llm_config).toBeNull();
  await expect(f.coordinator.resume(owner, f.a.id, f.op)).resolves.toMatchObject({ status: "applied" });
  expect(f.prepareManaged).toHaveBeenCalledTimes(1);
});

it("does not settle a mismatched guest receipt", async () => {
  const f = fixture(); f.deliver.mockImplementation(async input => ({ status: "applied", writeAttempted: true,
    receipt: { ...expectedGuestLlmReceipt(input), stateDigest: "f".repeat(64) } }));
  await expect(f.coordinator.start(owner, f.a.id, f.op, byok)).resolves.toMatchObject({ status: "pending", reason: "delivery_unconfirmed" });
  expect(f.store.settle).not.toHaveBeenCalled();
});

it("rechecks absolute lease expiry before the next network boundary after wall-only suspension", async () => {
  const f = fixture(), c = createModelKeyCoordinator({ ...f.deps, deliver: undefined });
  const now = Date.now();
  const wall = jest.spyOn(Date, "now").mockReturnValue(now);
  jest.mocked(ssrfSafeFetch).mockImplementation(async () => {
    // No timer callback or monotonic time advance: emulate waking before the
    // queued timeout runs on a platform whose monotonic clock pauses in sleep.
    wall.mockReturnValue(now + 60_000);
    return Response.json({ agentKind: "codex", surfaceAuth: "post-cookie-v1", llmApplication: "hivra-llm-apply-v1" });
  });
  await expect(c.start(owner, f.a.id, f.op, byok)).resolves.toMatchObject({ status: "pending" });
  expect(ssrfSafeFetch).toHaveBeenCalledTimes(1);
  expect(jest.mocked(ssrfSafeFetch).mock.calls[0][1]?.method).toBe("GET");
  expect(f.store.settle).not.toHaveBeenCalled();
});

it("retains admitted state after a lost admission acknowledgement and can discover it without the browser key", async () => {
  const f = fixture(), admit = f.store.admit.getMockImplementation()!;
  f.store.admit.mockImplementationOnce(async (...args) => { await admit(...args); throw new Error("PRIVATE " + secret); });
  await expect(f.coordinator.start(owner, f.a.id, f.op, managed)).rejects.toMatchObject({ code: "save_unconfirmed" });
  expect(f.deliver).not.toHaveBeenCalled();
  expect(await f.coordinator.summary(owner, f.a.id)).toMatchObject({ pending: { operationId: f.op } });
  await expect(f.coordinator.resume(owner, f.a.id, f.op)).resolves.toMatchObject({ status: "applied" });
  expect(f.prepareManaged).toHaveBeenCalledTimes(1);
});

it("reports an already applied operation even when the computer has since stopped", async () => {
  const f = fixture(); await f.coordinator.start(owner, f.a.id, f.op, byok);
  f.a.status = "stopped"; f.a.desired_state = "stopped";
  await expect(f.coordinator.resume(owner, f.a.id, f.op)).resolves.toMatchObject({ status: "applied" });
  expect(f.deliver).toHaveBeenCalledTimes(1);
});

it("never reapplies historical operations after a newer setting or deletion", async () => {
  const f = fixture(); await f.coordinator.start(owner, f.a.id, f.op, byok);
  await f.coordinator.start(owner, f.a.id, randomUUID(), null);
  await expect(f.coordinator.resume(owner, f.a.id, f.op)).rejects.toMatchObject({ code: "operation_conflict" });
  f.rows.get(f.op)!.phase = "deleted";
  await expect(f.coordinator.resume(owner, f.a.id, f.op)).rejects.toMatchObject({ code: "operation_conflict" });
  expect(f.deliver).toHaveBeenCalledTimes(2);
});

it.each(["pepper", "encryption"])("fails before wallet/credit effects when %s is unavailable", async failure => {
  const f = fixture(), c = createModelKeyCoordinator({ ...f.deps, prepareManaged: undefined });
  jest.mocked(generateManagedVenicePlaintextKey).mockReturnValue(secret);
  jest.mocked(hashManagedVeniceProxyKey).mockImplementation(() => {
    if (failure === "pepper") throw new Error("private configuration");
    return "b".repeat(64);
  });
  f.encrypt.mockImplementation(() => { throw new Error("private configuration"); });
  await expect(c.start(owner, f.a.id, f.op, managed)).rejects.toMatchObject({ code: "configuration_unavailable" });
  expect(ensureManagedVeniceWalletAccount).not.toHaveBeenCalled();
  expect(grantManagedVeniceStarterCredit).not.toHaveBeenCalled(); expect(f.store.admit).not.toHaveBeenCalled();
});

it("preserves the existing best-effort starter policy without leaking raw errors", async () => {
  const f = fixture(), c = createModelKeyCoordinator({ ...f.deps, prepareManaged: undefined });
  jest.mocked(generateManagedVenicePlaintextKey).mockReturnValue(secret);
  jest.mocked(hashManagedVeniceProxyKey).mockReturnValue("b".repeat(64));
  jest.mocked(ensureManagedVeniceWalletAccount).mockResolvedValue({ id: randomUUID() } as never);
  jest.mocked(isManagedVeniceStarterCreditEnabled).mockReturnValue(true);
  jest.mocked(grantManagedVeniceStarterCredit).mockRejectedValue(new Error("PRIVATE " + secret));
  await expect(c.start(owner, f.a.id, f.op, managed)).resolves.toMatchObject({ status: "applied" });
  expect(grantManagedVeniceStarterCredit).toHaveBeenCalledWith({ userId: owner });
  expect(JSON.stringify(jest.mocked(log.warn).mock.calls)).not.toContain(secret);
});
