import { createHmac, randomUUID } from "node:crypto";
import { createLaunchModelCoordinator } from "../launch-model-coordinator";
import { modelKeyBinding, type ModelKeyAgent, type ModelKeyOperation, type ModelKeyStore } from "../model-key-store";
import type { LaunchModelRequest, LaunchModelStore } from "../launch-model-store";
import { expectedGuestLlmReceipt, type GuestLlmApplication } from "../guest-llm-transport";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/crypto", () => ({ encryptSecret: jest.fn(), decryptSecret: jest.fn() }));
jest.mock("@/lib/billing/managed-venice-wallets", () => ({ ensureManagedVeniceWalletAccount: jest.fn() }));
jest.mock("@/lib/venice/proxy-keys", () => ({ generateManagedVenicePlaintextKey: jest.fn(), hashManagedVeniceProxyKey: jest.fn() }));
jest.mock("@/lib/venice/managed-venice-starter-credit", () => ({ grantManagedVeniceStarterCredit: jest.fn(), isManagedVeniceStarterCreditEnabled: jest.fn() }));
jest.mock("@/lib/ssrf-safe-fetch", () => ({ ssrfSafeFetch: jest.fn() }));

/** Both coordinators and receipt validation are real. Fake stores and clocks
 * force the suspended-worker interleaving; real SQL is covered separately. */
function fixture() {
  const secret = "synthetic-launch-key";
  const a: ModelKeyAgent = { id: randomUUID(), user_id: "owner", type: "codex", status: "running", desired_state: "running",
    operation_id: null, deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", allocation_operation_id: randomUUID(),
    proxmox_host: "fixture", vmid: 601, infrastructure_connection_id: null, infrastructure_connection_revision: null,
    deployment_target_id: null, provider_capacity_order_id: null, provider_enrollment_attempt_id: null, provider_server_id: null,
    cf_hostname: "fixture.hivra.test", cf_tunnel_id: randomUUID(), chat_url: "https://fixture.hivra.test", ip: null, api_token: "a".repeat(64),
    llm_config: null, llm_api_key_encrypted: null };
  const q: LaunchModelRequest = { user_id: "owner", request_id: randomUUID(), agent_id: a.id, provision_operation_id: a.allocation_operation_id!,
    model_operation_id: randomUUID(), fingerprint_version: 1, fingerprint_key_tag: "b".repeat(64), request_digest: "c".repeat(64),
    binding: modelKeyBinding(a), selection: { provider: "venice", mode: "byok", model: "fixture-model" }, encrypted_key: "synthetic-cipher",
    phase: "waiting", attempted_at: null, attempt_id: null, attempt_expires_at: null, created_at: new Date().toISOString(), promoted_at: null, closed_at: null };
  const lease = { ...q, attempted_at: new Date().toISOString(), attempt_id: randomUUID(), attempt_expires_at: new Date(Date.now() + 30_000).toISOString() };
  const selection = { provider: "venice", mode: "byok", apiKey: secret, model: "fixture-model" };
  const application: GuestLlmApplication = { target: { hostname: a.cf_hostname!, apiToken: a.api_token!, runtime: "codex" },
    operationId: q.model_operation_id, expectedStateDigest: "0".repeat(64),
    payload: { provider: "venice", baseUrl: "https://api.venice.ai/api/v1", model: selection.model, apiKey: secret } };
  const receipt = expectedGuestLlmReceipt(application);
  if (!receipt.operationId || !receipt.payloadDigest) throw new Error("Fixture must describe an applied operation");
  const journal: ModelKeyOperation = { operation_id: q.model_operation_id, agent_id: a.id, user_id: "owner", binding: modelKeyBinding(a),
    request_digest: createHmac("sha256", a.api_token!).update("hivra-model-request-v1\0" + q.model_operation_id + "\0" + JSON.stringify(selection)).digest("hex"),
    admission_connection_revision: null, config: q.selection,
    payload: { provider: "venice", baseUrl: application.payload!.baseUrl, model: selection.model }, encrypted_key: q.encrypted_key, cipher_digest: null,
    expected_state_digest: application.expectedStateDigest,
    expected_receipt: { ...receipt, operationId: receipt.operationId, payloadDigest: receipt.payloadDigest }, managed_key_id: null,
    phase: "pending", is_current: false, lease_id: null, lease_expires_at: null, dispatch_intent_at: null,
    created_at: q.created_at, applied_at: null, deleted_at: null };
  const store: jest.Mocked<ModelKeyStore> = {
    agent: jest.fn<ReturnType<ModelKeyStore["agent"]>, Parameters<ModelKeyStore["agent"]>>(async () => ({ ...a })),
    operation: jest.fn<ReturnType<ModelKeyStore["operation"]>, Parameters<ModelKeyStore["operation"]>>(async () => q.phase === "promoted" ? { ...journal } : null),
    admit: jest.fn<ReturnType<ModelKeyStore["admit"]>, Parameters<ModelKeyStore["admit"]>>(async () => { throw new Error("Must use atomic launch promotion"); }),
    claim: jest.fn<ReturnType<ModelKeyStore["claim"]>, Parameters<ModelKeyStore["claim"]>>(async () => ({ ...journal, lease_id: randomUUID(), lease_expires_at: new Date(Date.now() + 20_000).toISOString() })),
    settle: jest.fn<ReturnType<ModelKeyStore["settle"]>, Parameters<ModelKeyStore["settle"]>>(async () => true),
  };
  const launches: jest.Mocked<LaunchModelStore> = {
    byAgent: jest.fn<ReturnType<LaunchModelStore["byAgent"]>, Parameters<LaunchModelStore["byAgent"]>>(async () => ({ ...q })),
    byRequest: jest.fn<ReturnType<LaunchModelStore["byRequest"]>, Parameters<LaunchModelStore["byRequest"]>>(async () => ({ ...q })),
    existing: jest.fn(), reserve: jest.fn(),
    claim: jest.fn<ReturnType<LaunchModelStore["claim"]>, Parameters<LaunchModelStore["claim"]>>(async () => ({ ...lease })),
    cancel: jest.fn<ReturnType<LaunchModelStore["cancel"]>, Parameters<LaunchModelStore["cancel"]>>(async () => true),
    promote: jest.fn(async (_user, _agent, _request, _attempt, binding, body) => {
      expect(binding).toEqual(journal.binding); expect(body.requestDigest).toBe(journal.request_digest);
      expect(body.expectedReceipt).toEqual(journal.expected_receipt);
      q.phase = "promoted"; return "pending";
    }),
  };
  const inspect = jest.fn(async () => ({ ok: true as const, receipt: { protocol: "hivra-llm-apply-v1" as const,
    stateDigest: "0".repeat(64), operationId: null, payloadDigest: null, provider: null, model: null } }));
  const deliver = jest.fn(async (input: GuestLlmApplication) => ({ status: "applied" as const, receipt: expectedGuestLlmReceipt(input), writeAttempted: true }));
  const coordinator = createLaunchModelCoordinator({ store, launches, inspect, deliver, decrypt: () => secret,
    encrypt: () => { throw new Error("Must retain original ciphertext"); } });
  return { a, q, journal, store, launches, inspect, deliver, run: (automatic = true) => coordinator.continue("owner", a.id, q.request_id, automatic) };
}

afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

it.each(["agent", "operation"] as const)("fences a suspended %s read before automatic delivery can adopt another attempt's journal", async read => {
  const f = fixture(), now = Date.now(), wall = jest.spyOn(Date, "now").mockReturnValue(now);
  if (read === "agent") {
    f.store.agent.mockResolvedValueOnce({ ...f.a }).mockImplementation(async () => {
      wall.mockReturnValue(now + 61_000); f.q.phase = "promoted"; return { ...f.a };
    });
  } else {
    f.store.operation.mockImplementation(async () => {
      wall.mockReturnValue(now + 61_000); f.q.phase = "promoted"; return { ...f.journal };
    });
  }
  await expect(f.run()).rejects.toMatchObject({ code: "computer_not_ready" });
  expect(f.store.claim).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
  expect(f.launches.promote).not.toHaveBeenCalled();
});

it.each([true, false])("does not adopt a concurrently promoted journal from a waiting predecessor (automatic=%s)", async automatic => {
  const f = fixture();
  f.store.operation.mockImplementation(async () => { f.q.phase = "promoted"; return { ...f.journal }; });
  await expect(f.run(automatic)).rejects.toMatchObject({ code: "pending_change" });
  expect(f.store.claim).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
  expect(f.launches.promote).not.toHaveBeenCalled();
});

it("retains the separate delivery window after this attempt's confirmed atomic promotion", async () => {
  const f = fixture(), now = Date.now(), wall = jest.spyOn(Date, "now").mockReturnValue(now);
  const promote = f.launches.promote.getMockImplementation()!;
  f.launches.promote.mockImplementation(async (...args) => {
    const result = await promote(...args); wall.mockReturnValue(now + 31_000); return result;
  });
  expect(await f.run()).toMatchObject({ status: "applied" });
  expect(f.launches.promote).toHaveBeenCalledTimes(1); expect(f.store.claim).toHaveBeenCalledTimes(1);
  expect(f.deliver).toHaveBeenCalledTimes(1);
});

it("does not reinterpret another attempt's promotion acknowledgement as its own delivery authority", async () => {
  const f = fixture(); f.launches.promote.mockImplementation(async () => { f.q.phase = "promoted"; return "already_promoted"; });
  await expect(f.run()).rejects.toMatchObject({ code: "operation_conflict" });
  expect(f.store.claim).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
});

it("leaves a lost promotion reply pending for an explicit resume", async () => {
  const f = fixture(); f.launches.promote.mockImplementation(async () => { f.q.phase = "promoted"; throw new Error("Synthetic lost reply"); });
  await expect(f.run()).rejects.toMatchObject({ code: "save_unconfirmed" });
  expect(await f.run()).toMatchObject({ status: "pending", reason: "resume_required" });
  expect(f.store.claim).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
  expect(await f.run(false)).toMatchObject({ status: "applied" });
  expect(f.store.claim).toHaveBeenCalledTimes(1); expect(f.deliver).toHaveBeenCalledTimes(1);
});
