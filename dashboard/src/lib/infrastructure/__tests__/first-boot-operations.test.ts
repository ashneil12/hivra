import {
  abandonFirstBootOperation, claimFirstBootOperation, claimEnrolledGuestOperation, FIRST_BOOT_ABANDON_CONFIRMATION, loadFirstBootOperation, loadFirstBootOperationForOrder,
  markFirstBootFirewallDispatch, markFirstBootPowerDispatch, recordFirstBootFirewallVerified,
  releaseFirstBootOperation, saveFirstBootFirewallReceipt, saveFirstBootPowerAction,
} from "../first-boot-operations";
import { FIRST_BOOT_LEGACY_RECIPE_VERSION, FIRST_BOOT_RECIPE_VERSION } from "../first-boot-enrollment";

const mockRpc = jest.fn();
const mockQuery = { select: jest.fn(), eq: jest.fn(), maybeSingle: jest.fn() };
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: {
  rpc: (...args: unknown[]) => mockRpc(...args), from: jest.fn(() => mockQuery),
} }));
const binding = { userId: "fixture-owner", connectionId: "11111111-1111-4111-8111-111111111111",
  connectionRevision: 7, orderId: "22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333", quoteFingerprint: "a".repeat(64), recipeVersion: FIRST_BOOT_RECIPE_VERSION };
const scope = { binding, providerServerId: "42" };
// Order-only callers know neither the attempt nor its recipe.
const orderScope = { binding: { userId: binding.userId, connectionId: binding.connectionId,
  connectionRevision: binding.connectionRevision, orderId: binding.orderId,
  quoteFingerprint: binding.quoteFingerprint }, providerServerId: "42" };
const recipe = (recipeVersion: string = FIRST_BOOT_RECIPE_VERSION) => ({ data: { recipe_version: recipeVersion }, error: null });
const lease = { ...scope, leaseId: "44444444-4444-4444-8444-444444444444" };
const date = "2026-08-27T19:00:00.000Z";
const firewall = { version: 1, scope: { orderId: binding.orderId, attemptId: binding.attemptId,
  quoteFingerprint: binding.quoteFingerprint, serverId: 42 }, firewallId: 91, createdAt: date,
setRulesActionId: 601, applyActionId: 602 };
const power = { id: 603, command: "start_server", status: "running", resources: [{ id: 42, type: "server" }] };
function row(change = {}) {
  return { order_id: binding.orderId, attempt_id: binding.attemptId, user_id: binding.userId,
    connection_id: binding.connectionId, connection_revision: 7, quote_fingerprint_sha256: binding.quoteFingerprint,
    provider_server_id: "42", lease_id: lease.leaseId, lease_expires_at: "2026-08-27T19:02:00.000Z",
    firewall_post_attempted_at: null, firewall_receipt: null, firewall_verified_at: null,
    power_on_post_attempted_at: null, power_on_action: null, abandoned_at: null, created_at: date, updated_at: date, ...change };
}
describe("private first-boot operation adapter", () => {
  beforeEach(() => {
    mockRpc.mockReset(); mockQuery.select.mockReset().mockReturnValue(mockQuery);
    mockQuery.eq.mockReset().mockReturnValue(mockQuery); mockQuery.maybeSingle.mockReset();
  });
  it("claims the exact owner, connection revision, order, attempt, quote and server", async () => {
    mockRpc.mockResolvedValue({ data: { outcome: "claimed", record: row() }, error: null });
    await expect(claimFirstBootOperation(scope)).resolves.toMatchObject({ outcome: "claimed", lease });
    expect(mockRpc.mock.calls[0]).toEqual(["claim_hetzner_first_boot_operation", {
      p_user_id: binding.userId, p_connection_id: binding.connectionId, p_revision: 7, p_order_id: binding.orderId,
      p_attempt_id: binding.attemptId, p_quote: binding.quoteFingerprint, p_server: "42",
    }]);
  });
  it("uses the separate enrolled-only RPC with the same strict scope and lease projection",async()=>{
    mockRpc.mockResolvedValue({data:{outcome:"claimed",record:row()},error:null});
    await expect(claimEnrolledGuestOperation(scope)).resolves.toMatchObject({outcome:"claimed",lease});
    expect(mockRpc.mock.calls[0][0]).toBe("claim_hetzner_enrolled_guest_operation");
    expect(mockRpc.mock.calls[0][1]).toEqual({p_user_id:binding.userId,p_connection_id:binding.connectionId,p_revision:7,
      p_order_id:binding.orderId,p_attempt_id:binding.attemptId,p_quote:binding.quoteFingerprint,p_server:"42"});
    mockRpc.mockResolvedValue({data:{outcome:"claimed",record:row({provider_server_id:"43"})},error:null});
    await expect(claimEnrolledGuestOperation(scope)).rejects.toThrow("invalid_record");
  });
  it.each(["busy", "rejected"])("returns %s without leaking a private record or assigning a lease", async outcome => {
    mockRpc.mockResolvedValue({ data: { outcome, record: { encrypted_token: "must-not-leak" } }, error: null });
    await expect(claimFirstBootOperation(scope)).resolves.toEqual({ outcome });
  });
  it.each([
    { user_id: "foreign" }, { connection_revision: 8 }, { provider_server_id: "43" },
    { quote_fingerprint_sha256: "b".repeat(64) }, { attempt_id: lease.leaseId },
    { lease_id: null }, { lease_expires_at: null }, { abandoned_at: date },
    { firewall_receipt: firewall }, { firewall_verified_at: date }, { power_on_post_attempted_at: date },
    { power_on_action: power },
  ])("rejects inconsistent or scope-mismatched claim evidence: %j", async change => {
    mockRpc.mockResolvedValue({ data: { outcome: "claimed", record: row(change) }, error: null });
    await expect(claimFirstBootOperation(scope)).rejects.toThrow("invalid_record");
  });
  it("snapshots the caller binding before asynchronous DB work", async () => {
    const input = { ...scope, binding: { ...binding } };
    let resolve!: (value: unknown) => void;
    mockRpc.mockReturnValue(new Promise(done => { resolve = done; }));
    const result = claimFirstBootOperation(input);
    input.binding.quoteFingerprint = "b".repeat(64);
    input.providerServerId = "43";
    resolve({ data: { outcome: "claimed", record: row() }, error: null });
    await expect(result).resolves.toMatchObject({ lease });
  });
  it("reads only the private mutation projection; does not load tokens, keys or resume work", async () => {
    mockQuery.maybeSingle.mockResolvedValue({ data: row({ encrypted_token: "secret", encrypted_bundle: "private" }), error: null });
    const result = await loadFirstBootOperation(scope);
    expect(JSON.stringify(result)).not.toMatch(/secret|private|encrypted/);
    expect(mockQuery.select.mock.calls[0][0]).not.toMatch(/token|encrypted|key/);
    expect(mockQuery.eq.mock.calls).toEqual([["user_id", binding.userId], ["connection_id", binding.connectionId],
      ["connection_revision", 7], ["order_id", binding.orderId], ["attempt_id", binding.attemptId],
      ["quote_fingerprint_sha256", binding.quoteFingerprint], ["provider_server_id", "42"]]);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it("returns null for an absent operation", async () => {
    mockQuery.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(loadFirstBootOperation(scope)).resolves.toBeNull();
  });
  it("discovers an attempt for cleanup only within its full original order binding", async () => {
    mockQuery.maybeSingle.mockResolvedValueOnce({ data: row({ encrypted_token: "secret", encrypted_bundle: "private" }), error: null })
      .mockResolvedValueOnce(recipe());
    const result = await loadFirstBootOperationForOrder(orderScope);
    expect(result?.binding.attemptId).toBe(binding.attemptId);
    expect(mockQuery.eq.mock.calls.slice(0, 6)).toEqual([["user_id", binding.userId], ["connection_id", binding.connectionId],
      ["connection_revision", 7], ["order_id", binding.orderId],
      ["quote_fingerprint_sha256", binding.quoteFingerprint], ["provider_server_id", "42"]]);
    expect(mockQuery.select.mock.calls[0][0]).not.toMatch(/token|encrypted|key/);
    expect(JSON.stringify(result)).not.toMatch(/secret|private|encrypted/);
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it.each([FIRST_BOOT_LEGACY_RECIPE_VERSION, FIRST_BOOT_RECIPE_VERSION])("binds the discovered attempt's own recipe %s, never an assumed one", async version => {
    mockQuery.maybeSingle.mockResolvedValueOnce({ data: row(), error: null }).mockResolvedValueOnce(recipe(version));
    const result = await loadFirstBootOperationForOrder(orderScope);
    expect(result?.binding).toEqual({ ...binding, recipeVersion: version });
    // The recipe comes from this exact attempt's enrollment, inside its full binding.
    expect(mockQuery.select.mock.calls[1][0]).toBe("recipe_version");
    expect(mockQuery.eq.mock.calls.slice(6)).toEqual([["order_id", binding.orderId], ["attempt_id", binding.attemptId],
      ["user_id", binding.userId], ["connection_id", binding.connectionId], ["connection_revision", 7],
      ["quote_fingerprint_sha256", binding.quoteFingerprint]]);
  });
  it("fails closed when the attempt's recipe cannot be read", async () => {
    mockQuery.maybeSingle.mockResolvedValueOnce({ data: row(), error: null }).mockResolvedValueOnce({ data: null, error: null });
    await expect(loadFirstBootOperationForOrder(orderScope)).rejects.toThrow("invalid_record");
    mockQuery.maybeSingle.mockResolvedValueOnce({ data: row(), error: null }).mockResolvedValueOnce(recipe("2026.09.99.1"));
    await expect(loadFirstBootOperationForOrder(orderScope)).rejects.toThrow("invalid_record");
    mockQuery.maybeSingle.mockResolvedValueOnce({ data: row(), error: null }).mockResolvedValueOnce({ data: null, error: { message: "private" } });
    await expect(loadFirstBootOperationForOrder(orderScope)).rejects.toThrow("database_error");
  });
  it("keeps the recipe the caller's full scope names", async () => {
    const legacy = { binding: { ...binding, recipeVersion: FIRST_BOOT_LEGACY_RECIPE_VERSION }, providerServerId: "42" };
    mockQuery.maybeSingle.mockResolvedValue({ data: row(), error: null });
    await expect(loadFirstBootOperation(legacy)).resolves.toMatchObject(legacy);
    await expect(loadFirstBootOperation({ ...scope, binding: { ...binding, recipeVersion: "later" } } as never)).rejects.toThrow("invalid_scope");
  });
  it.each([{ user_id: "foreign" }, { connection_id: lease.leaseId }, { connection_revision: 8 },
    { order_id: lease.leaseId }, { quote_fingerprint_sha256: "b".repeat(64) }, { provider_server_id: "43" },
    { attempt_id: "not-a-uuid" }])("rejects mismatched cleanup lookup evidence: %j", async change => {
    mockQuery.maybeSingle.mockResolvedValueOnce({ data: row(change), error: null }).mockResolvedValueOnce(recipe());
    await expect(loadFirstBootOperationForOrder(orderScope)).rejects.toThrow("invalid_record");
  });
  it("returns no attempt for an absent record and snapshots cleanup input before awaiting the database", async () => {
    const input = structuredClone(orderScope);
    mockQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(loadFirstBootOperationForOrder(input)).resolves.toBeNull();
    let resolve!: (value: unknown) => void;
    mockQuery.maybeSingle.mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValueOnce(recipe());
    const pending = loadFirstBootOperationForOrder(input);
    input.binding.quoteFingerprint = "b".repeat(64); input.providerServerId = "43";
    resolve({ data: row(), error: null });
    await expect(pending).resolves.toMatchObject({ binding, providerServerId: "42" });
  });
  it("rejects supplied attempts, an assumed recipe or extra scope fields and redacts cleanup lookup failures", async () => {
    await expect(loadFirstBootOperationForOrder(scope)).rejects.toThrow("invalid_scope");
    const input = structuredClone(orderScope);
    await expect(loadFirstBootOperationForOrder({ ...input, binding: { ...input.binding, recipeVersion: FIRST_BOOT_RECIPE_VERSION } } as never)).rejects.toThrow("invalid_scope");
    await expect(loadFirstBootOperationForOrder({ ...input, token: "extra" } as never)).rejects.toThrow("invalid_scope");
    expect(mockQuery.maybeSingle).not.toHaveBeenCalled();
    mockQuery.maybeSingle.mockRejectedValue(new Error("private token detail"));
    await expect(loadFirstBootOperationForOrder(input)).rejects.toThrow("First-boot operation failed: database_error");
  });
  it("reads scoped original receipts and completed actions without treating them as readiness", async () => {
    mockQuery.maybeSingle.mockResolvedValue({ data: row({ lease_id: null, lease_expires_at: null,
      firewall_post_attempted_at: date, firewall_receipt: firewall, firewall_verified_at: date,
      power_on_post_attempted_at: date, power_on_action: { ...power, status: "success" } }), error: null });
    const result = await loadFirstBootOperation(scope);
    expect(result).toMatchObject({ firewallReceipt: firewall, powerOnAction: { ...power, status: "success" } });
    expect(result).not.toHaveProperty("ready");
  });
  it("sends only named checkpoints with the exact lease and complete resource binding", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    await expect(markFirstBootFirewallDispatch(lease)).resolves.toBe(true);
    await expect(saveFirstBootFirewallReceipt(lease, firewall)).resolves.toBe(true);
    await expect(recordFirstBootFirewallVerified(lease, firewall, new Date(date))).resolves.toBe(true);
    await expect(markFirstBootPowerDispatch(lease)).resolves.toBe(true);
    await expect(saveFirstBootPowerAction(lease, { ...power, provider_extra: "not-stored" })).resolves.toBe(true);
    expect(mockRpc.mock.calls.map(([, params]) => params.p_event)).toEqual([
      "firewall_dispatch", "firewall_receipt", "firewall_verified", "power_dispatch", "power_receipt",
    ]);
    for (const [name, params] of mockRpc.mock.calls) {
      expect(name).toBe("checkpoint_hetzner_first_boot_operation");
      expect(params).toMatchObject({ p_lease_id: lease.leaseId, p_quote: binding.quoteFingerprint, p_server: "42",
        p_user_id: binding.userId, p_connection_id: binding.connectionId, p_revision: 7,
        p_order_id: binding.orderId, p_attempt_id: binding.attemptId });
    }
    expect(mockRpc.mock.calls[0][1]).toMatchObject({ p_evidence: null, p_observed_at: null });
    expect(mockRpc.mock.calls[2][1].p_observed_at).toBe(date);
    expect(mockRpc.mock.calls[4][1].p_evidence).toEqual(power);
  });
  it("rejects invalid bindings, receipts, dates and action identities before any RPC", async () => {
    await expect(claimFirstBootOperation({ ...scope, providerServerId: "04" })).rejects.toThrow("invalid_scope");
    expect(() => markFirstBootFirewallDispatch({ ...lease, leaseId: "invalid" })).toThrow("invalid_scope");
    expect(() => saveFirstBootFirewallReceipt(lease, { ...firewall, scope: { ...firewall.scope, serverId: 43 } })).toThrow("invalid_evidence");
    expect(() => recordFirstBootFirewallVerified(lease, firewall, new Date("bad"))).toThrow("invalid_evidence");
    expect(() => saveFirstBootPowerAction(lease, { ...power, command: "poweron" })).toThrow("invalid_evidence");
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it("distinguishes rejected authority from database failure, never reflecting server details", async () => {
    mockRpc.mockResolvedValue({ data: false, error: null });
    await expect(markFirstBootFirewallDispatch(lease)).resolves.toBe(false);
    mockRpc.mockResolvedValue({ data: null, error: { message: "provider-token-private-database-detail" } });
    await expect(markFirstBootPowerDispatch(lease)).rejects.toThrow("First-boot operation failed: database_error");
    mockQuery.maybeSingle.mockResolvedValue({ data: null, error: { message: "private-key" } });
    await expect(loadFirstBootOperation(scope)).rejects.toThrow("First-boot operation failed: database_error");
    mockRpc.mockRejectedValue(new Error("network secret"));
    await expect(markFirstBootPowerDispatch(lease)).rejects.toThrow("First-boot operation failed: database_error");
    mockQuery.maybeSingle.mockRejectedValue(new Error("request private key"));
    await expect(loadFirstBootOperation(scope)).rejects.toThrow("First-boot operation failed: database_error");
  });
  it("releases only its lease and requires explicit typed abandonment without claiming provider deletion", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    await expect(releaseFirstBootOperation(lease)).resolves.toBe(true);
    expect(mockRpc.mock.calls[0]).toEqual(["release_hetzner_first_boot_operation", {
      p_user_id: binding.userId, p_connection_id: binding.connectionId, p_revision: 7,
      p_order_id: binding.orderId, p_attempt_id: binding.attemptId, p_lease_id: lease.leaseId,
      p_quote: binding.quoteFingerprint, p_server: "42",
    }]);
    const name = "hivra-22222222222242228222";
    await expect(abandonFirstBootOperation(scope, name, "not confirmed" as never)).rejects.toThrow("invalid_evidence");
    expect(mockRpc).toHaveBeenCalledTimes(1);
    await expect(abandonFirstBootOperation(scope, name, FIRST_BOOT_ABANDON_CONFIRMATION)).resolves.toBe(true);
    expect(mockRpc.mock.calls[1]).toEqual(["abandon_hetzner_first_boot_operation", {
      p_user_id: binding.userId, p_connection_id: binding.connectionId, p_revision: 7,
      p_order_id: binding.orderId, p_attempt_id: binding.attemptId, p_server_name: name,
      p_confirmation: FIRST_BOOT_ABANDON_CONFIRMATION, p_quote: binding.quoteFingerprint, p_server: "42",
    }]);
  });
});
