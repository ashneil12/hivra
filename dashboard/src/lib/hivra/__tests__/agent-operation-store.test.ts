/** @jest-environment node */

jest.mock("server-only", () => ({}));

const mockRpc = jest.fn();
const mockRead = jest.fn();
const mockCleanup = jest.fn();
const mockQuery = { update: jest.fn().mockReturnThis(), is: jest.fn().mockReturnThis(), contains: jest.fn().mockReturnThis(), select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), in: jest.fn().mockReturnThis(), maybeSingle: (...args: unknown[]) => mockRead(...args) };
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: (...args: unknown[]) => mockRpc(...args), from: () => mockQuery },
}));
jest.mock("../agent-delete-cleanup", () => ({
  ...jest.requireActual("../agent-delete-cleanup"),
  cleanupHivraAgentAccess: (...args: unknown[]) => mockCleanup(...args),
}));

import {
  beginHivraAgentVmAllocation,
  checkpointHivraAgentOperation,
  claimHivraAgentOperation,
  claimHivraAgentOperationRecovery,
  completeHivraAgentDelete,
  completeHivraAgentOperation,
  completeHivraAgentRunning,
  continueHivraAgentOperation,
  continueHivraAgentResizeOperation,
  failHivraAgentBeforeAllocation,
  persistHivraAgentProvisionIdentity,
  recordHivraAgentOperationFailure,
  releaseHivraAgentOperation,
  requestHivraAgentDelete,
} from "../agent-operation-store";

const input = {
  userId: "user_1",
  agentId: "11111111-1111-4111-8111-111111111111",
  operationId: "22222222-2222-4222-8222-222222222222",
};

describe("Hivra agent operation store", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRpc.mockReset();
    mockRead.mockReset().mockResolvedValue({ data: { cf_tunnel_id: "tunnel", cf_hostname: "host", llm_config: null }, error: null });
    mockCleanup.mockReset().mockResolvedValue(undefined);
  });

  it("claims lifecycle authority with an exact desired state", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    await expect(claimHivraAgentOperation({
      ...input,
      operationKind: "restart",
      desiredState: "running",
    })).resolves.toBe(true);
    expect(mockRpc).toHaveBeenCalledWith("claim_hivra_agent_operation", {
      p_user_id: input.userId,
      p_agent_id: input.agentId,
      p_operation_id: input.operationId,
      p_operation_kind: "restart",
      p_desired_state: "running",
      p_operation_payload: null,
    });
  });

  it("advances only the current running no-VM provision out of access setup", async () => {
    await expect(beginHivraAgentVmAllocation(input)).resolves.toBe(true);
    expect(mockQuery.update).toHaveBeenCalledWith({ operation_payload: null });
    expect(mockQuery.contains).toHaveBeenCalledWith("operation_payload", { stage: "pre_allocation_access" });
    for (const [key, value] of Object.entries({ user_id: input.userId, id: input.agentId, operation_id: input.operationId, operation_kind: "provision", desired_state: "running", status: "provisioning" })) {
      expect(mockQuery.eq).toHaveBeenCalledWith(key, value);
    }
    expect(mockQuery.is).toHaveBeenCalledWith("vmid", null);
  });

  it("terminalizes an access failure only with no remaining VM/tunnel identity and a running intent", async () => {
    await expect(failHivraAgentBeforeAllocation({ ...input, error: "Setup failed" })).resolves.toBe(true);
    expect(mockQuery.update).toHaveBeenCalledWith(expect.objectContaining({ status: "error", error: "Setup failed", operation_id: null }));
    expect(mockQuery.eq).toHaveBeenCalledWith("desired_state", "running");
    for (const field of ["vmid", "cf_tunnel_id", "cf_hostname"]) expect(mockQuery.is).toHaveBeenCalledWith(field, null);
    expect(mockQuery.contains).toHaveBeenCalledWith("operation_payload", { stage: "pre_allocation_access" });
  });

  it.each([beginHivraAgentVmAllocation, failHivraAgentBeforeAllocation])("does not claim success when pre-allocation CAS loses", async (transition) => {
    mockRead.mockResolvedValue({ data: null, error: null });
    await expect(transition({ ...input, error: "Setup failed" })).resolves.toBe(false);
  });

  it("persists resize intent before provider mutation", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    await claimHivraAgentOperation({
      ...input,
      operationKind: "resize",
      desiredState: "running",
      operationPayload: { cpu: 2.5, ram: 6 },
    });
    expect(mockRpc).toHaveBeenCalledWith("claim_hivra_agent_operation", {
      p_user_id: input.userId,
      p_agent_id: input.agentId,
      p_operation_id: input.operationId,
      p_operation_kind: "resize",
      p_desired_state: "running",
      p_operation_payload: { cpu: 2.5, ram: 6 },
    });
  });

  it("returns the durable delete arbitration result", async () => {
    mockRpc.mockResolvedValue({ data: "pending", error: null });
    await expect(requestHivraAgentDelete(input)).resolves.toBe("pending");
  });

  it.each([true, false])("preserves the exact boolean decision %s", async (data) => {
    mockRpc.mockResolvedValue({ data, error: null });
    await expect(checkpointHivraAgentOperation({ ...input, expectedDesiredState: "running" })).resolves.toBe(data);
  });

  it.each([null, undefined, "true", "false", 0, 1, [], [true], { claimed: true }].map(data => ({ data })))(
    "rejects malformed lifecycle decisions rather than reporting a lost claim: %j", async ({ data }) => {
      mockRpc.mockResolvedValue({ data, error: null });
      await expect(checkpointHivraAgentOperation({ ...input, expectedDesiredState: "running" }))
        .rejects.toMatchObject({ name: "HivraAgentOperationStoreError", code: "database_error" });
      expect(mockRpc).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["claimed", "pending", "deleted", "not_found"])("preserves the exact delete decision %s", async (data) => {
    mockRpc.mockResolvedValue({ data, error: null });
    await expect(requestHivraAgentDelete(input)).resolves.toBe(data);
  });

  it.each([["claimed"], ["pending"], ["deleted"], ["not_found"], null, true, {}].map(data => ({ data })))(
    "rejects malformed delete decisions without coercion: %j", async ({ data }) => {
      mockRpc.mockResolvedValue({ data, error: null });
      await expect(requestHivraAgentDelete(input)).rejects.toMatchObject({ code: "database_error" });
      expect(mockCleanup).not.toHaveBeenCalled();
    },
  );

  it.each(["checkpoint", "delete"])("redacts rejected %s RPC transport errors without retrying", async (kind) => {
    mockRpc.mockRejectedValue(new Error("SYNTHETIC_PRIVATE_DATABASE_DETAIL"));
    const result = kind === "delete" ? requestHivraAgentDelete(input)
      : checkpointHivraAgentOperation({ ...input, expectedDesiredState: "running" });
    await expect(result).rejects.toMatchObject({
      name: "HivraAgentOperationStoreError", code: "database_error",
      message: "Hivra agent operation store failed: database_error",
    });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockCleanup).not.toHaveBeenCalled();
  });

  it.each([null, undefined, [], "private unexpected response"].map(response => ({ response })))(
    "rejects malformed RPC envelopes with a stable error: %j", async ({ response }) => {
      mockRpc.mockResolvedValue(response);
      await expect(requestHivraAgentDelete(input)).rejects.toMatchObject({
        name: "HivraAgentOperationStoreError", code: "database_error",
      });
    },
  );

  it("does not revoke provider access when cleanup verification returns a malformed boolean", async () => {
    mockRead.mockResolvedValue({ data: { computer_substrate: "provider-vm", cf_tunnel_id: "tunnel" }, error: null });
    mockRpc.mockResolvedValue({ data: "true", error: null });
    await expect(completeHivraAgentDelete(input)).rejects.toMatchObject({ code: "database_error" });
    expect(mockCleanup).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it("uses operation id and desired state at every provision checkpoint", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    await checkpointHivraAgentOperation({ ...input, expectedDesiredState: "running" });
    await persistHivraAgentProvisionIdentity({ ...input, vmid: 401, ip: "10.251.20.51" });
    expect(mockRpc).toHaveBeenNthCalledWith(1, "checkpoint_hivra_agent_operation", {
      p_user_id: input.userId,
      p_agent_id: input.agentId,
      p_operation_id: input.operationId,
      p_expected_desired_state: "running",
    });
    expect(mockRpc).toHaveBeenNthCalledWith(2, "persist_hivra_agent_provision_identity", {
      p_user_id: input.userId,
      p_agent_id: input.agentId,
      p_operation_id: input.operationId,
      p_vmid: 401,
      p_ip: "10.251.20.51",
    });
  });

  it("claims abandoned-operation recovery with the exact old lease timestamp", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    await expect(claimHivraAgentOperationRecovery({
      ...input,
      expectedOperationStartedAt: "2026-08-26T11:00:00.000Z",
      recoveredAt: "2026-08-26T11:10:00.000Z",
    })).resolves.toBe(true);
    expect(mockRpc).toHaveBeenCalledWith("claim_hivra_agent_operation_recovery", {
      p_user_id: input.userId,
      p_agent_id: input.agentId,
      p_operation_id: input.operationId,
      p_expected_operation_started_at: "2026-08-26T11:00:00.000Z",
      p_recovered_at: "2026-08-26T11:10:00.000Z",
    });
  });

  it("completes or releases only the matching operation id", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    await completeHivraAgentOperation({
      ...input,
      expectedDesiredState: "stopped",
      status: "stopped",
    });
    await releaseHivraAgentOperation({ ...input, error: "provider failed", markError: true });
    await completeHivraAgentDelete(input);
    expect(mockRpc.mock.calls.map(([name]) => name)).toEqual([
      "complete_hivra_agent_operation",
      "release_hivra_agent_operation",
      "complete_hivra_agent_delete",
    ]);
  });

  it("retains async lifecycle authority until running convergence", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    await continueHivraAgentOperation({
      ...input,
      expectedDesiredState: "running",
      status: "provisioning",
      cpu: 2,
      ram: 4,
    });
    await completeHivraAgentRunning({
      ...input,
      operationKind: "resize",
      chatUrl: "https://agent.example.test",
      ip: "10.251.20.51",
      apiToken: null,
      provisionedAt: "2026-08-26T12:00:00.000Z",
    });
    expect(mockRpc).toHaveBeenNthCalledWith(1, "continue_hivra_agent_operation", {
      p_user_id: input.userId,
      p_agent_id: input.agentId,
      p_operation_id: input.operationId,
      p_expected_desired_state: "running",
      p_status: "provisioning",
      p_cpu: 2,
      p_ram: 4,
    });
    expect(mockRpc).toHaveBeenNthCalledWith(2, "complete_hivra_agent_running", {
      p_user_id: input.userId,
      p_agent_id: input.agentId,
      p_operation_id: input.operationId,
      p_operation_kind: "resize",
      p_chat_url: "https://agent.example.test",
      p_ip: "10.251.20.51",
      p_api_token: null,
      p_provisioned_at: "2026-08-26T12:00:00.000Z",
    });
  });

  it("commits a resize guarantee and maxima through one exact-operation RPC", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    await continueHivraAgentResizeOperation({
      ...input, expectedDesiredState: "running", status: "provisioning",
      cpu: 2, ram: 4, maximumCpu: 4, maximumRam: 8,
    });
    expect(mockRpc).toHaveBeenCalledWith("continue_hivra_agent_resize_operation", {
      p_user_id: input.userId,
      p_agent_id: input.agentId,
      p_operation_id: input.operationId,
      p_expected_desired_state: "running",
      p_status: "provisioning",
      p_cpu: 2,
      p_ram: 4,
      p_cpu_max: 4,
      p_ram_max: 8,
    });
  });

  it("records an ambiguous provider outcome without releasing its lease", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    await recordHivraAgentOperationFailure({ ...input, error: "allocation receipt lost" });
    expect(mockRpc).toHaveBeenCalledWith("record_hivra_agent_operation_failure", {
      p_user_id: input.userId,
      p_agent_id: input.agentId,
      p_operation_id: input.operationId,
      p_error: "allocation receipt lost",
    });
  });

  it("maps authority constraint errors to a stable conflict", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "55006" } });
    await expect(requestHivraAgentDelete(input)).rejects.toEqual(
      expect.objectContaining({ code: "conflict" }),
    );
  });

  it("checks the owner and operation before cleanup and only then finalizes", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    await completeHivraAgentDelete(input);
    for (const [key, value] of Object.entries({ user_id: input.userId, id: input.agentId, operation_id: input.operationId, desired_state: "deleted" })) {
      expect(mockQuery.eq).toHaveBeenCalledWith(key, value);
    }
    expect(mockQuery.in).toHaveBeenCalledWith("operation_kind", ["delete", "provision"]);
    expect(mockCleanup).toHaveBeenCalledWith({ userId: input.userId, agentId: input.agentId, operationId: input.operationId, tunnelId: "tunnel", hostname: "host", llmConfig: null });
    expect(mockCleanup.mock.invocationCallOrder[0]).toBeLessThan(mockRpc.mock.invocationCallOrder[0]);
  });

  it.each([false, null, "true"])("retains provider access when original computer absence is unverified: %j", async (proof) => {
    mockRead.mockResolvedValue({ data: { computer_substrate: "provider-vm", cf_tunnel_id: "tunnel", cf_hostname: "host", llm_config: null }, error: null });
    mockRpc.mockResolvedValue({ data: proof, error: null });
    await expect(completeHivraAgentDelete(input)).rejects.toMatchObject({ code: proof === false ? "conflict" : "database_error" });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("hivra_provider_cleanup_verified", {
      p_user_id: input.userId, p_agent_id: input.agentId, p_operation_id: input.operationId,
    });
    expect(mockCleanup).not.toHaveBeenCalled();
  });

  it("requires original provider absence before access cleanup and shared terminal CAS", async () => {
    mockRead.mockResolvedValue({ data: { computer_substrate: "provider-vm", cf_tunnel_id: "tunnel", cf_hostname: "host", llm_config: null }, error: null });
    mockRpc.mockResolvedValue({ data: true, error: null });
    await expect(completeHivraAgentDelete(input)).resolves.toBe(true);
    expect(mockRpc.mock.calls.map(call => call[0])).toEqual(["hivra_provider_cleanup_verified", "complete_hivra_agent_delete"]);
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(mockCleanup.mock.invocationCallOrder[0]);
    expect(mockCleanup.mock.invocationCallOrder[0]).toBeLessThan(mockRpc.mock.invocationCallOrder[1]);
  });

  it("does not reinterpret an unknown substrate as Proxmox absence", async () => {
    mockRead.mockResolvedValue({ data: { computer_substrate: "future" }, error: null });
    await expect(completeHivraAgentDelete(input)).rejects.toMatchObject({ code: "conflict" });
    expect(mockCleanup).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("does not clean up or finalize a superseded or foreign operation", async () => {
    mockRead.mockResolvedValue({ data: null, error: null });
    await expect(completeHivraAgentDelete(input)).resolves.toBe(false);
    expect(mockCleanup).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("retains all identities and records failure when access cleanup fails", async () => {
    mockCleanup.mockRejectedValue(new Error("cleanup failed"));
    mockRpc.mockResolvedValue({ data: true, error: null });
    await expect(completeHivraAgentDelete(input)).rejects.toThrow("cleanup failed");
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("record_hivra_agent_operation_failure", expect.objectContaining({
      p_user_id: input.userId, p_agent_id: input.agentId, p_operation_id: input.operationId,
    }));
  });

  it("does not interpret a failed authority read as provider absence", async () => {
    mockRead.mockResolvedValue({ data: null, error: { code: "50000" } });
    await expect(completeHivraAgentDelete(input)).rejects.toMatchObject({ code: "database_error" });
    expect(mockCleanup).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
