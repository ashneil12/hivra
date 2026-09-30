/** @jest-environment node */
jest.mock("server-only", () => ({}));
const mockRead = jest.fn(), mockRpc = jest.fn();
const mockQuery = { select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), maybeSingle: (...args: unknown[]) => mockRead(...args) };
const mockFrom = jest.fn((table: unknown) => { void table; return mockQuery; });
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (table: unknown) => mockFrom(table), rpc: (...args: unknown[]) => mockRpc(...args) } }));

import { beginProviderDesktopCleanup, beginProviderDesktopInstall, completeProviderDesktopRunning, loadProviderDesktopInstallOperation,
  recordProviderDesktopCleanup, recordProviderDesktopInstallStopped } from "../provider-desktop-install-store";
import { loadProviderAgentInstallOperation, beginProviderAgentInstall, recordProviderAgentInstallStopped } from "../provider-agent-install-store";
import { desktopInstallFixture } from "./provider-desktop-install.fixtures";

const h = desktopInstallFixture(), { op, identity, clock, grant } = h;
const access = { mode: "cloudflare-named" as const, hostname: h.context.hostname!, tunnelId: h.context.tunnelId! };
const receipt = { version: 3 as const, identity, state: "failed" as const, stopped: true,
  desktopCleanup: { state: "verified_stopped" as const, bootId: clock.bootId } };
function row() { return { id: op.agentId, user_id: op.userId, operation_id: op.operationId, allocation_operation_id: op.operationId,
  operation_kind: "provision", status: "provisioning", desired_state: "running", computer_substrate: "provider-vm", deployment_mode: "self-managed",
  vmid: null, type: "linux-desktop", computer_profile: "ubuntu-desktop", infrastructure_connection_id: h.f.binding.connectionId,
  infrastructure_connection_revision: h.f.binding.connectionRevision, deployment_target_id: h.context.targetId,
  provider_capacity_order_id: h.f.binding.orderId, provider_enrollment_attempt_id: h.f.binding.attemptId, provider_server_id: "42",
  cf_tunnel_id: h.context.tunnelId, cf_hostname: h.context.hostname, chat_url: null, ip: null,
  provider_install_identity: identity, provider_install_not_after: "2026-08-31T20:00:45Z",
  provider_install_stopped_at: "2026-08-31T20:00:20Z", provider_install_outcome: "failed" }; }
function journal() { return { agent_id: op.agentId, user_id: op.userId, operation_id: op.operationId, identity }; }
function load(data: unknown) {
  mockRead.mockResolvedValueOnce({ data: row(), error: null })
    .mockResolvedValueOnce({ data: { quote_fingerprint_sha256: h.f.binding.quoteFingerprint }, error: null })
    .mockResolvedValueOnce({ data: { recipe_version: h.f.binding.recipeVersion }, error: null })
    .mockResolvedValueOnce({ data, error: null });
}

describe("private desktop install and cleanup store", () => {
  beforeEach(() => { jest.clearAllMocks(); mockRead.mockReset(); mockRpc.mockReset(); });
  it.each([false, true])("reads cancellation intent without returning cached cleanup authority: %s", async cancelled => {
    load(cancelled ? journal() : null);
    await expect(loadProviderDesktopInstallOperation(op)).resolves.toMatchObject({ runtime: "linux-desktop", identity,
      operation: op, scope: h.scope, cancellationRequested: cancelled });
    expect(mockFrom.mock.calls.map(c => c[0])).toEqual(["hivra_agents", "infrastructure_capacity_orders", "infrastructure_first_boot_enrollments", "hivra_provider_desktop_cleanup"]);
    expect(mockQuery.select.mock.calls.at(-1)).toEqual(["agent_id,user_id,operation_id,identity"]);
    for (const pair of [["agent_id", op.agentId], ["user_id", op.userId], ["operation_id", op.operationId]]) expect(mockQuery.eq).toHaveBeenCalledWith(...pair);
    expect(mockQuery.select.mock.calls.map(c => c[0]).join(",")).not.toMatch(/private_key|encrypted|api_token|llm_config/);
  });
  it("keeps the default public operation loader closed to desktop before reading credentials or order", async () => {
    mockRead.mockResolvedValue({ data: row(), error: null });
    await expect(loadProviderAgentInstallOperation(op)).rejects.toThrow("could not be verified");
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
  it("keeps a v1 record out of the desktop loader", async () => {
    mockRead.mockResolvedValue({ data: { ...row(), type: "codex" }, error: null });
    await expect(loadProviderDesktopInstallOperation(op)).rejects.toThrow("could not be verified");
    expect(mockFrom).toHaveBeenCalledTimes(1);
  });
  it.each(["agent_id", "user_id", "operation_id", "identity", "undefined", "extra"])("rejects unbound cancellation journal %s", async field => {
    const value = journal();
    if (field === "identity") value.identity = { ...identity, operationId: op.agentId };
    else if (field !== "undefined") Object.assign(value, { [field]: field === "extra" ? true : "foreign" });
    load(field === "undefined" ? undefined : value);
    await expect(loadProviderDesktopInstallOperation(op)).rejects.toThrow("could not be verified");
  });
  it("does not lose a cancellation latch because its journal read failed", async () => {
    load(null); mockRead.mockReset();
    mockRead.mockResolvedValueOnce({ data: row(), error: null })
      .mockResolvedValueOnce({ data: { quote_fingerprint_sha256: h.f.binding.quoteFingerprint }, error: null })
    .mockResolvedValueOnce({ data: { recipe_version: h.f.binding.recipeVersion }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "private query failure" } });
    await expect(loadProviderDesktopInstallOperation(op)).rejects.toThrow("could not be verified");
  });
  it.each([{ outcome: "dispatch", dispatchBudgetMs: 30000 }, { outcome: "observe" }, { outcome: "rejected" }])("preserves desktop one-use dispatch result %j", async data => {
    mockRpc.mockResolvedValue({ data, error: null });
    await expect(beginProviderDesktopInstall(op, identity, access)).resolves.toEqual(data);
    expect(mockRpc).toHaveBeenCalledWith("begin_hivra_provider_desktop_install", { p_user_id: op.userId, p_agent_id: op.agentId,
      p_operation_id: op.operationId, p_identity: identity, p_access: access });
  });
  it.each([null, true, { outcome: "dispatch" }, { outcome: "dispatch", dispatchBudgetMs: 31000 }])("rejects malformed dispatch grant %j", async data => {
    mockRpc.mockResolvedValue({ data, error: null });
    await expect(beginProviderDesktopInstall(op, identity, access)).rejects.toThrow("could not be verified");
  });
  it.each([grant, null])("preserves cleanup grant or rejection %j", async data => {
    mockRpc.mockResolvedValue({ data, error: null });
    await expect(beginProviderDesktopCleanup(op, identity)).resolves.toEqual(data);
    expect(mockRpc).toHaveBeenCalledWith("begin_hivra_provider_desktop_cleanup", { p_user_id: op.userId, p_agent_id: op.agentId,
      p_operation_id: op.operationId, p_identity: identity });
  });
  it.each([true, {}, { ...grant, budgetMs: 60000 }, { ...grant, observationId: "foreign" }, { ...grant, receipt }])("does not invent a cleanup grant from %j", async data => {
    mockRpc.mockResolvedValue({ data, error: null });
    await expect(beginProviderDesktopCleanup(op, identity)).rejects.toThrow("could not be verified");
  });
  it.each(["agent", "operation", "bundle", "closure", "version"])("rejects changed desktop %s before any RPC", async field => {
    const changed = structuredClone(identity);
    if (field === "agent") changed.agentId = op.operationId;
    if (field === "operation") changed.operationId = op.agentId;
    if (field === "bundle") Object.assign(changed.bundle, { bundleSha256: "f".repeat(64) });
    if (field === "closure") Object.assign(changed.desktopCleanup, { closureSha256: "f".repeat(64) });
    if (field === "version") Object.assign(changed, { version: 1 });
    await expect(beginProviderDesktopInstall(op, changed, access)).rejects.toThrow();
    await expect(beginProviderDesktopCleanup(op, changed)).rejects.toThrow();
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it("rejects v3 identities/receipts at the unchanged v1 store entrypoints", async () => {
    await expect(beginProviderAgentInstall(op, identity as never)).rejects.toThrow();
    await expect(recordProviderAgentInstallStopped(op, receipt as never)).rejects.toThrow();
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it.each([null, { ...access, hostname: "https://foreign.example.test" }, { ...access, tunnelId: null },
    { ...access, mode: "direct-https" }, { ...access, secret: "not-allowed" }])("rejects malformed desktop access before dispatch RPC %j", async value => {
    await expect(beginProviderDesktopInstall(op, identity, value as never)).rejects.toThrow("could not be verified");
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it.each([true, false])("records exact immutable stopped outcome separately from cleanup: %s", async data => {
    mockRpc.mockResolvedValue({ data, error: null });
    const pending = { ...receipt, desktopCleanup: { state: "pending" as const } };
    await expect(recordProviderDesktopInstallStopped(op, pending, clock)).resolves.toBe(data);
    expect(mockRpc).toHaveBeenCalledWith("record_hivra_provider_install_stopped", { p_user_id: op.userId, p_agent_id: op.agentId,
      p_operation_id: op.operationId, p_receipt: pending });
  });
  it.each([true, false])("records against the captured grant and preserves SQL decision %s", async data => {
    mockRpc.mockResolvedValue({ data, error: null });
    await expect(recordProviderDesktopCleanup(op, grant, receipt, clock)).resolves.toBe(data);
    expect(mockRpc).toHaveBeenCalledWith("record_hivra_provider_desktop_cleanup", { p_user_id: op.userId, p_agent_id: op.agentId,
      p_operation_id: op.operationId, p_observation_id: grant.observationId, p_receipt: receipt });
    expect(mockFrom).not.toHaveBeenCalled(); // Never retrieve the newest grant after seeing a receipt.
  });
  it.each([true, false])("uses the desktop terminal CAS without a database bearer: %s", async data => {
    mockRpc.mockResolvedValue({ data, error: null });
    const input = { ...op, chatUrl: "https://fixture.hivra.test", ip: "93.184.216.34",
      provisionedAt: "2026-08-31T21:02:00.000Z" };
    await expect(completeProviderDesktopRunning(input)).resolves.toBe(data);
    expect(mockRpc).toHaveBeenCalledWith("complete_hivra_provider_desktop_running", {
      p_user_id: op.userId, p_agent_id: op.agentId, p_operation_id: op.operationId,
      p_chat_url: input.chatUrl, p_ip: input.ip, p_provisioned_at: input.provisionedAt,
    });
    expect(JSON.stringify(mockRpc.mock.calls)).not.toMatch(/api.token|sessionCookie|__Host-hivra_auth/);
  });
  it.each(["pending", "nonterminal", "stale-boot", "missing-clock", "foreign", "missing-grant"])("does not record invalid cleanup %s", async fault => {
    const value = structuredClone(receipt);
    if (fault === "pending") Object.assign(value, { desktopCleanup: { state: "pending" } });
    if (fault === "nonterminal") Object.assign(value, { state: "running", stopped: false });
    if (fault === "stale-boot") value.desktopCleanup.bootId = op.agentId;
    if (fault === "foreign") value.identity.operationId = op.agentId;
    await expect(recordProviderDesktopCleanup(op, fault === "missing-grant" ? null as never : grant,
      value, fault === "missing-clock" ? undefined as never : clock)).rejects.toThrow("could not be verified");
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it("cannot record a stopped desktop observation using a stale boot either", async () => {
    await expect(recordProviderDesktopInstallStopped(op, receipt, { ...clock, bootId: op.agentId })).rejects.toThrow();
    expect(mockRpc).not.toHaveBeenCalled();
  });
  it("snapshots receipt and grant before the RPC awaits, and redacts database errors", async () => {
    const mutableReceipt = structuredClone(receipt), mutableGrant = { ...grant };
    mockRpc.mockImplementation(async () => {
      mutableReceipt.desktopCleanup.bootId = op.agentId; mutableGrant.observationId = op.agentId;
      return { data: null, error: { message: "private database detail" } };
    });
    await expect(recordProviderDesktopCleanup(op, mutableGrant, mutableReceipt, clock)).rejects.toThrow("could not be verified");
    expect(mockRpc).toHaveBeenCalledWith("record_hivra_provider_desktop_cleanup", expect.objectContaining({ p_observation_id: grant.observationId,
      p_receipt: receipt }));
  });
});
