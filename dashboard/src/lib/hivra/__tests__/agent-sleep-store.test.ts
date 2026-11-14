/** @jest-environment node */

const mockRpc = jest.fn();
const mockInsert = jest.fn();
const mockUpdate = jest.fn();
const mockUpdateFilters: Array<[string, ...unknown[]]> = [];
const mockUpdateResult: { value: unknown } = { value: { data: [{ id: "x" }], error: null } };
const mockFrom = jest.fn(() => {
  const chain: Record<string, unknown> = {};
  chain.insert = (...args: unknown[]) => mockInsert(...args);
  chain.update = (patch: unknown) => { mockUpdate(patch); return chain; };
  for (const op of ["eq", "is"]) chain[op] = (...args: unknown[]) => { mockUpdateFilters.push([op, ...args]); return chain; };
  chain.select = () => Promise.resolve(mockUpdateResult.value);
  return chain;
});
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: (...args: unknown[]) => mockRpc(...args), from: (...args: unknown[]) => (mockFrom as (...a: unknown[]) => unknown)(...args) },
}));
jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));

import {
  claimAgentSleep,
  claimAgentWake,
  finishAgentSleep,
  finishAgentWake,
  isAgentAwake,
  logAgentSleepEvent,
  parseSleepGeneration,
  reconcileAgentSleepState,
} from "../agent-sleep-store";

const agentId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";

describe("agent sleep store", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockInsert.mockReset().mockResolvedValue({ error: null });
  });

  describe("isAgentAwake", () => {
    it("treats only awake, or a row without the column, as awake", () => {
      expect(isAgentAwake({ sleep_state: "awake" })).toBe(true);
      expect(isAgentAwake({})).toBe(true);
      expect(isAgentAwake({ sleep_state: null })).toBe(true);
      for (const state of ["draining", "napping", "hibernating", "hibernated", "waking", "wake_failed", "sleeping", "weird"]) {
        expect(isAgentAwake({ sleep_state: state })).toBe(false);
      }
      expect(isAgentAwake(null)).toBe(false);
    });
  });

  describe("parseSleepGeneration", () => {
    it("accepts whole numbers and digit strings only", () => {
      expect(parseSleepGeneration(3)).toBe(3);
      expect(parseSleepGeneration("12")).toBe(12);
      for (const bad of [null, undefined, -1, 1.5, "x", "", "-2", true, {}]) expect(parseSleepGeneration(bad)).toBeNull();
    });
  });

  describe("claimAgentSleep", () => {
    it("passes the exact arguments and returns the new generation", async () => {
      mockRpc.mockResolvedValue({ data: 4, error: null });
      await expect(claimAgentSleep({ agentId, operationId, tier: "nap", expectedGeneration: 3 })).resolves.toBe(4);
      expect(mockRpc).toHaveBeenCalledWith("claim_hivra_agent_sleep", {
        p_agent_id: agentId, p_operation_id: operationId, p_tier: "nap", p_expected_generation: 3,
      });
    });

    it("reads a bigint that arrives as a string", async () => {
      mockRpc.mockResolvedValue({ data: "9", error: null });
      await expect(claimAgentSleep({ agentId, operationId, tier: "hibernate", expectedGeneration: 8 })).resolves.toBe(9);
    });

    it("is null when refused, on a database error, on a thrown call and on nonsense", async () => {
      for (const response of [{ data: null, error: null }, { data: null, error: { code: "x" } }, { data: "yes", error: null }, undefined]) {
        mockRpc.mockResolvedValueOnce(response);
        await expect(claimAgentSleep({ agentId, operationId, tier: "nap", expectedGeneration: 0 })).resolves.toBeNull();
      }
      mockRpc.mockRejectedValueOnce(new Error("network"));
      await expect(claimAgentSleep({ agentId, operationId, tier: "nap", expectedGeneration: 0 })).resolves.toBeNull();
    });
  });

  describe("finish calls", () => {
    it("return true only for a true answer", async () => {
      mockRpc.mockResolvedValueOnce({ data: true, error: null });
      await expect(finishAgentSleep({ agentId, operationId, result: "napping" })).resolves.toBe(true);
      expect(mockRpc).toHaveBeenLastCalledWith("finish_hivra_agent_sleep", { p_agent_id: agentId, p_operation_id: operationId, p_result: "napping" });
      mockRpc.mockResolvedValueOnce({ data: false, error: null });
      await expect(finishAgentSleep({ agentId, operationId, result: "awake" })).resolves.toBe(false);
      mockRpc.mockRejectedValueOnce(new Error("network"));
      await expect(finishAgentSleep({ agentId, operationId, result: "hibernated" })).resolves.toBe(false);

      mockRpc.mockResolvedValueOnce({ data: true, error: null });
      await expect(finishAgentWake({ agentId, operationId, result: "wake_failed" })).resolves.toBe(true);
      expect(mockRpc).toHaveBeenLastCalledWith("finish_hivra_agent_wake", { p_agent_id: agentId, p_operation_id: operationId, p_result: "wake_failed" });
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: "x" } });
      await expect(finishAgentWake({ agentId, operationId, result: "awake" })).resolves.toBe(false);
    });
  });

  describe("claimAgentWake", () => {
    it("returns each known answer", async () => {
      for (const answer of ["claimed", "awake", "busy", "refused"]) {
        mockRpc.mockResolvedValueOnce({ data: answer, error: null });
        await expect(claimAgentWake({ agentId, operationId })).resolves.toBe(answer);
      }
      expect(mockRpc).toHaveBeenLastCalledWith("claim_hivra_agent_wake", { p_agent_id: agentId, p_operation_id: operationId });
    });

    it("is refused on an unknown answer or an error, so nothing is assumed", async () => {
      for (const response of [{ data: "go", error: null }, { data: true, error: null }, { data: null, error: { code: "x" } }]) {
        mockRpc.mockResolvedValueOnce(response);
        await expect(claimAgentWake({ agentId, operationId })).resolves.toBe("refused");
      }
      mockRpc.mockRejectedValueOnce(new Error("network"));
      await expect(claimAgentWake({ agentId, operationId })).resolves.toBe("refused");
    });
  });

  describe("logAgentSleepEvent", () => {
    it("writes one row with the timings and counts", async () => {
      await expect(logAgentSleepEvent({
        agentId, kind: "nap", trigger: "sweep", fromState: "awake", toState: "napping",
        generation: 2, durationMs: 840.4, reason: "idle", detail: { suspendMs: 800, probeMs: 40 },
      })).resolves.toBe(true);
      expect(mockFrom).toHaveBeenCalledWith("hivra_agent_sleep_events");
      expect(mockInsert).toHaveBeenCalledWith({
        agent_id: agentId, kind: "nap", trigger: "sweep", from_state: "awake", to_state: "napping",
        generation: 2, duration_ms: 840, reason: "idle", detail: { suspendMs: 800, probeMs: 40 },
      });
    });

    it("fills the optional fields with null and clamps the duration", async () => {
      await logAgentSleepEvent({ agentId, kind: "abort", trigger: "manual", durationMs: 1e12 });
      expect(mockInsert).toHaveBeenCalledWith({
        agent_id: agentId, kind: "abort", trigger: "manual", from_state: null, to_state: null,
        generation: null, duration_ms: 2_147_483_647, reason: null, detail: null,
      });
    });

    it("never throws when the insert fails", async () => {
      mockInsert.mockResolvedValueOnce({ error: { code: "x" } });
      await expect(logAgentSleepEvent({ agentId, kind: "fail", trigger: "open" })).resolves.toBe(false);
      mockInsert.mockRejectedValueOnce(new Error("network"));
      await expect(logAgentSleepEvent({ agentId, kind: "fail", trigger: "open" })).resolves.toBe(false);
    });
  });

  describe("reconcileAgentSleepState", () => {
    beforeEach(() => {
      mockUpdate.mockReset();
      mockUpdateFilters.length = 0;
      mockUpdateResult.value = { data: [{ id: agentId }], error: null };
    });

    it("applies only while the agent is still as it was read, and bumps the generation", async () => {
      await expect(reconcileAgentSleepState({ agentId, expectedGeneration: 7, to: "napping" })).resolves.toBe(true);
      expect(mockFrom).toHaveBeenCalledWith("hivra_agents");
      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ sleep_state: "napping", sleep_generation: 8, sleep_tier_changed_at: expect.any(String) }));
      expect(mockUpdate.mock.calls[0][0]).not.toHaveProperty("next_wake_at");
      expect(mockUpdateFilters).toEqual(expect.arrayContaining([
        ["eq", "id", agentId],
        ["eq", "sleep_generation", 7],
        ["eq", "status", "running"],
        ["eq", "desired_state", "running"],
        ["is", "operation_id", null],
      ]));
    });

    it("never writes status, and clears the scheduled wake only when the result is awake", async () => {
      await reconcileAgentSleepState({ agentId, expectedGeneration: 1, to: "awake" });
      const patch = mockUpdate.mock.calls[0][0] as Record<string, unknown>;
      expect(patch).toMatchObject({ sleep_state: "awake", next_wake_at: null });
      expect(patch).not.toHaveProperty("status");
      expect(patch).not.toHaveProperty("error");
    });

    it("is false when the compare and set matched nothing, the database errors, or the generation is unusable", async () => {
      mockUpdateResult.value = { data: [], error: null };
      await expect(reconcileAgentSleepState({ agentId, expectedGeneration: 1, to: "hibernated" })).resolves.toBe(false);
      mockUpdateResult.value = { data: null, error: { code: "x" } };
      await expect(reconcileAgentSleepState({ agentId, expectedGeneration: 1, to: "hibernated" })).resolves.toBe(false);
      mockUpdate.mockClear();
      await expect(reconcileAgentSleepState({ agentId, expectedGeneration: -1, to: "awake" })).resolves.toBe(false);
      await expect(reconcileAgentSleepState({ agentId, expectedGeneration: 1.5, to: "awake" })).resolves.toBe(false);
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });
});
