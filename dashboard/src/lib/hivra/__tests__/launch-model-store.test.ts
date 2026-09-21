jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/crypto", () => ({
  getLaunchFingerprintKeyCandidates: () => process.env.LAUNCH_FINGERPRINT_KEY
    ? [{ key: Buffer.alloc(32, 2), version: 2 }]
    : [{ key: Buffer.alloc(32, 1), version: 1 }],
  encryptSecret: jest.fn(() => "c3ludGhldGljLWVuY3J5cHRlZC1maXh0dXJlLWtleS1vbmx5"),
}));

import { encryptSecret } from "@/lib/crypto";
import { createLaunchModelStore, launchModelFingerprints, LaunchModelIntentSchema, matchesLaunchModelRequest,
  type LaunchModelRequest } from "../launch-model-store";
import { ModelKeyStoreError } from "../model-key-store";

const requestId = "11111111-1111-4111-8111-111111111111", agentId = "22222222-2222-4222-8222-222222222222";
const provisionId = "33333333-3333-4333-8333-333333333333", modelId = "44444444-4444-4444-8444-444444444444";
const intent = { type: "codex", name: "My computer", cpu: 2, ram: 4, browser: false, goal: null, context: null,
  personality: null, emoji: null, templateSkills: [], deployment: { mode: "hivra-managed" },
  llm: { provider: "venice", mode: "byok", apiKey: "synthetic-launch-key", model: "test-model" } };
const fingerprint = launchModelFingerprints("owner", requestId, intent);
const row: LaunchModelRequest = { user_id: "owner", request_id: requestId, agent_id: agentId, provision_operation_id: provisionId,
  model_operation_id: modelId, fingerprint_version: 1, fingerprint_key_tag: fingerprint[0].keyTag, request_digest: fingerprint[0].digest,
  binding: {}, selection: { provider: "venice", mode: "byok", model: "test-model" }, encrypted_key: "synthetic-cipher",
  phase: "waiting", attempted_at: null, attempt_id: null, attempt_expires_at: null, created_at: "2026-08-28T12:00:00Z", promoted_at: null, closed_at: null };
const reservation = { id: agentId, type: "codex" as const, name: "My computer", cpu: 2, ram: 4, proxmox_host: "fixture",
  deployment_mode: "hivra-managed" as const, computer_substrate: "proxmox-kvm" as const, operation_id: provisionId,
  managed_provisioner_channel: "default" as const,
  infrastructure_binding_token_hash: "a".repeat(64) };
function fixture() {
  const query = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn().mockResolvedValue({ data: row, error: null }) };
  query.select.mockReturnValue(query); query.eq.mockReturnValue(query);
  const db = { from: jest.fn().mockReturnValue(query), rpc: jest.fn().mockResolvedValue({ data: { status: "reserved", agentId, phase: "waiting" }, error: null }) };
  const store = createLaunchModelStore(db as never);
  const input = { userId: "owner", requestId, modelOperationId: modelId, fingerprints: fingerprint, agent: reservation, llm: intent.llm };
  return { db, query, store, input };
}

beforeEach(() => jest.clearAllMocks());
afterEach(() => { delete process.env.LAUNCH_FINGERPRINT_KEY; });

describe("launch request identity", () => {
  it("normalizes selection and field ordering before HMAC without using randomized ciphertext", () => {
    const reversed = Object.fromEntries(Object.entries(intent).reverse());
    expect(launchModelFingerprints("owner", requestId, reversed)).toEqual(fingerprint);
    expect(launchModelFingerprints("owner", requestId, { ...intent, llm: { ...intent.llm, apiKey: " synthetic-launch-key " } })).toEqual(fingerprint);
    expect(JSON.stringify(fingerprint)).not.toContain("synthetic-launch-key");
    expect(encryptSecret).not.toHaveBeenCalled();
  });
  it("uses domain-separated, keyed fingerprints and supports an explicitly configured legacy key", () => {
    const rotated = launchModelFingerprints("owner", requestId, intent, [Buffer.alloc(32, 2), Buffer.alloc(32, 1)]);
    expect(rotated[0].digest).not.toEqual(fingerprint[0].digest);
    expect(rotated[1]).toEqual(fingerprint[0]);
    expect(matchesLaunchModelRequest(row, rotated)).toBe(true);
    expect(matchesLaunchModelRequest(row, rotated.slice(0, 1))).toBe(false);
  });
  it("uses the dedicated v2 launch key when configured", () => {
    process.env.LAUNCH_FINGERPRINT_KEY = "configured-in-test";
    const dedicated = launchModelFingerprints("owner", requestId, intent);
    expect(dedicated).toHaveLength(1);
    expect(dedicated[0].version).toBe(2);
    expect(dedicated[0].digest).not.toEqual(fingerprint[0].digest);
  });
  it.each([
    { ...intent, name: "Another computer" }, { ...intent, cpu: 4 }, { ...intent, browser: true },
    { ...intent, llm: { ...intent.llm, apiKey: "different-synthetic-key" } },
    { ...intent, llm: { provider: "venice", mode: "managed", walletType: "card", model: "test-model" } },
    { ...intent, templateSkills: ["different-skill"] }, { ...intent, context: "different context" },
    { ...intent, maximumCpu: 4, maximumRam: 8 },
  ])("binds every material launch choice", changed => {
    expect(launchModelFingerprints("owner", requestId, changed)[0].digest).not.toEqual(fingerprint[0].digest);
  });
  it("binds owner and request ID", () => {
    expect(launchModelFingerprints("other", requestId, intent)[0].digest).not.toEqual(fingerprint[0].digest);
    expect(launchModelFingerprints("owner", agentId, intent)[0].digest).not.toEqual(fingerprint[0].digest);
  });
  it.each([0.5, 1.5])("preserves the existing fractional CPU cap %s", cpu => {
    expect(LaunchModelIntentSchema.parse({ ...intent, cpu }).cpu).toBe(cpu);
  });
  it.each([null, {}, { ...intent, llm: null }, { ...intent, recipient: "forged" }, { ...intent, type: "hermes" },
    { ...intent, llm: { ...intent.llm, baseUrl: "https://unknown.example" } }])("rejects noncanonical inputs", input => {
    expect(LaunchModelIntentSchema.safeParse(input).success).toBe(false);
    expect(() => launchModelFingerprints("owner", requestId, input)).toThrow();
  });
});

describe("private launch custody store", () => {
  it("reserves encrypted BYOK and public selection without active credentials or a guest bearer", async () => {
    const { db, store, input } = fixture();
    expect(await store.reserve(input)).toEqual({ created: true, agentId, phase: "waiting" });
    expect(db.rpc).toHaveBeenCalledTimes(1);
    const [name, args] = db.rpc.mock.calls[0];
    expect(name).toBe("reserve_hivra_launch_model_request_v2");
    expect(args.p_selection).toEqual(row.selection);
    expect(args.p_agent).toEqual(reservation);
    expect(JSON.stringify(args)).not.toContain("synthetic-launch-key");
    expect(args.p_encrypted_key).toBe(encryptSecret("fixture"));
  });
  it("passes envelope maxima through the strict reservation whitelist", async () => {
    const { db, store, input } = fixture();
    await store.reserve({ ...input, agent: { ...reservation, cpu_max: 4, ram_max: 8 } });
    expect(db.rpc.mock.calls[0][1].p_agent).toEqual(expect.objectContaining({ cpu_max: 4, ram_max: 8 }));
  });
  it("keeps managed wallet choice without minting or storing a candidate key", async () => {
    const { db, store, input } = fixture();
    await store.reserve({ ...input, llm: { provider: "venice", mode: "managed", model: "test-model", walletType: "card" } });
    expect(db.rpc.mock.calls[0][1].p_selection).toEqual({ provider: "venice", mode: "managed", model: "test-model", walletType: "card" });
    expect(db.rpc.mock.calls[0][1].p_encrypted_key).toBeNull();
    expect(encryptSecret).not.toHaveBeenCalled();
  });
  it("uses exact owner and request filters for recovery", async () => {
    const { db, query, store } = fixture();
    expect(await store.existing("owner", requestId, fingerprint)).toEqual(row);
    expect(db.from).toHaveBeenCalledWith("hivra_launch_model_requests");
    expect(query.eq.mock.calls).toEqual([["user_id", "owner"], ["request_id", requestId]]);
  });
  it("reads the original request after lost reservation acknowledgement and never redispatches", async () => {
    const { db, store, input } = fixture(); db.rpc.mockRejectedValueOnce(new Error("synthetic-private-diagnostic"));
    expect(await store.reserve(input)).toEqual({ created: false, agentId, phase: "waiting" });
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });
  it("keeps an unresolved reservation uncertain rather than returning false success", async () => {
    const { db, query, store, input } = fixture();
    db.rpc.mockRejectedValueOnce(new Error("synthetic-private-diagnostic")); query.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(store.reserve(input)).rejects.toThrow(ModelKeyStoreError);
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });
  it.each([{ user_id: "foreign" }, { request_id: agentId }, { agent_id: "invalid" }, { selection: { apiKey: "unexpected-secret" } }])(
    "rejects malformed or wrong-owner storage replies", async changes => {
      const { query, store } = fixture(); query.maybeSingle.mockResolvedValue({ data: { ...row, ...changes }, error: null });
      await expect(store.byRequest("owner", requestId)).rejects.toThrow(ModelKeyStoreError);
    });
  it("rejects a reused request ID with different intent even after a lost acknowledgement", async () => {
    const { query, store, input, db } = fixture(); query.maybeSingle.mockResolvedValue({ data: { ...row, request_digest: "e".repeat(64) }, error: null });
    await expect(store.existing("owner", requestId, fingerprint)).rejects.toMatchObject({ code: "request_conflict" });
    db.rpc.mockRejectedValueOnce(new Error("lost acknowledgement"));
    await expect(store.reserve(input)).rejects.toMatchObject({ code: "request_conflict" });
  });
  it("verifies existing results and never returns a fresh allocation disposition", async () => {
    const { store, db, input } = fixture(); db.rpc.mockResolvedValue({ data: { status: "existing", agentId, phase: "waiting" }, error: null });
    expect(await store.reserve(input)).toEqual({ created: false, agentId, phase: "waiting" });
  });
  it.each([{ status: "reserved", agentId: requestId, phase: "waiting" }, { status: "reserved", agentId, phase: "promoted" },
    { status: "reserved", agentId, phase: "waiting", apiKey: "forged" }, null])("rejects unbound reservation replies", async reply => {
      const { db, store, input } = fixture(); db.rpc.mockResolvedValue({ data: reply, error: null });
      await expect(store.reserve(input)).rejects.toThrow(ModelKeyStoreError);
    });
  it("does not pass unexpected reservation fields or provider URLs into SQL", async () => {
    const { db, store, input } = fixture();
    await expect(store.reserve({ ...input, agent: { ...reservation, api_token: "forged" } } as never)).rejects.toMatchObject({ code: "invalid_request" });
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("rejects a Canary channel outside managed Proxmox before SQL", async () => {
    const { db, store, input } = fixture();
    await expect(store.reserve({
      ...input,
      agent: {
        ...reservation,
        deployment_mode: "self-managed",
        managed_provisioner_channel: "canary",
      },
    } as never)).rejects.toMatchObject({ code: "invalid_request" });
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("requires an owner-bound, finite attempt lease", async () => {
    const { db, store } = fixture();
    const leased = { ...row, attempt_id: provisionId, attempt_expires_at: "2026-08-28T12:00:30Z", attempted_at: "2026-08-28T12:00:00Z" };
    db.rpc.mockResolvedValue({ data: leased, error: null });
    expect(await store.claim("owner", agentId, requestId, true)).toEqual(leased);
    expect(db.rpc.mock.calls[0][1].p_automatic).toBe(true);
    for (const changes of [{ attempt_expires_at: "invalid" }, { attempt_id: null }, { user_id: "foreign" }, { phase: "promoted" }]) {
      db.rpc.mockResolvedValue({ data: { ...leased, ...changes }, error: null });
      await expect(store.claim("owner", agentId, requestId, false)).rejects.toThrow(ModelKeyStoreError);
    }
  });
  it("uses only the original IDs for promotion and cancellation", async () => {
    const { db, store } = fixture(); db.rpc.mockResolvedValueOnce({ data: "pending", error: null }).mockResolvedValueOnce({ data: true, error: null });
    expect(await store.promote("owner", agentId, requestId, provisionId, {}, { fixture: true })).toBe("pending");
    expect(db.rpc.mock.calls[0]).toEqual(["promote_hivra_launch_model_request", { p_user_id: "owner", p_agent_id: agentId,
      p_request_id: requestId, p_attempt_id: provisionId, p_binding: {}, p_request: { fixture: true } }]);
    expect(await store.cancel("owner", agentId, requestId)).toBe(true);
  });
  it("does not expose credential-bearing storage diagnostics", async () => {
    const { db, store } = fixture(); db.rpc.mockResolvedValue({ error: { message: "synthetic-private-diagnostic" } });
    await expect(store.cancel("owner", agentId, requestId)).rejects.not.toThrow("synthetic-private-diagnostic");
  });
});
