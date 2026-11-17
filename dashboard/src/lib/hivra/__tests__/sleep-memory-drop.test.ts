/** @jest-environment node */

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

const mockRunScript = jest.fn();
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: (...args: unknown[]) => mockRunScript(...args),
}));

const mockReadRow = jest.fn();
const mockTarget = jest.fn();
jest.mock("../agent-wake", () => ({
  readHivraAgentRow: (...args: unknown[]) => mockReadRow(...args),
  resolveSleepTarget: (...args: unknown[]) => mockTarget(...args),
}));

import { sleepMemoryDropAfterDays } from "../agent-sleep-policy";
import {
  MEMORY_DROP_COOLDOWN_MS,
  MEMORY_DROP_MAX_PER_RUN,
  resetSleepMemoryDropCooldowns,
  runSleepMemoryDrops,
  type SleepMemoryDropInput,
} from "../sleep-memory-drop";

const TAG = `hivra-bind-${"a".repeat(32)}`;
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function makeDb(candidates: Array<{ id: string; proxmox_host: string | null }>, rpcError: unknown = null) {
  const rpc = jest.fn(async () => ({ data: rpcError ? null : candidates, error: rpcError }));
  const updates: Array<{ values: Record<string, unknown>; filters: Array<[string, unknown]> }> = [];
  const from = jest.fn(() => ({
    update(values: Record<string, unknown>) {
      const entry = { values, filters: [] as Array<[string, unknown]> };
      updates.push(entry);
      const chain = {
        eq(column: string, value: unknown) {
          entry.filters.push([column, value]);
          return chain;
        },
        then(resolve: (value: { error: null }) => unknown) {
          return Promise.resolve({ error: null }).then(resolve);
        },
      };
      return chain;
    },
  }));
  return { db: { rpc, from } as unknown as SleepMemoryDropInput["db"], rpc, updates };
}

const input = (db: SleepMemoryDropInput["db"], over: Partial<SleepMemoryDropInput> = {}): SleepMemoryDropInput => ({
  db,
  env: { HIVRA_SLEEP_DROP_MEMORY_AFTER_DAYS: "7" },
  now: () => NOW,
  deadline: NOW + 250_000,
  hostActs: () => true,
  ...over,
});

const receipt = (vmid: number, ok: boolean, reason: string) =>
  ({ ok: true, stdout: `HIVRA_MEMORY_DROP_RESULT {"ok":${ok},"vmid":${vmid},"reason":"${reason}"}\n` });

beforeEach(() => {
  jest.clearAllMocks();
  resetSleepMemoryDropCooldowns();
  mockReadRow.mockImplementation(async (agentId: string) => ({ id: agentId, status: "running", sleep_state: "hibernated", operation_id: null, user_id: "u" }));
  mockTarget.mockImplementation(async () => ({ ok: true, target: { vmid: 1234, bindingTag: TAG, env: {} } }));
  mockRunScript.mockImplementation(async () => receipt(1234, true, "dropped"));
});

describe("sleepMemoryDropAfterDays", () => {
  it("is off unless it holds a whole number of days from 1 to 365", () => {
    for (const value of [undefined, null, "", "0", "366", "7.5", "-1", "on", "1e2", "0007d"]) {
      expect(sleepMemoryDropAfterDays(value)).toBeNull();
    }
    expect(sleepMemoryDropAfterDays("7")).toBe(7);
    expect(sleepMemoryDropAfterDays(" 30 ")).toBe(30);
    expect(sleepMemoryDropAfterDays("365")).toBe(365);
  });
});

describe("runSleepMemoryDrops", () => {
  it("does nothing at all when the setting is off", async () => {
    const { db, rpc } = makeDb([{ id: id(1), proxmox_host: "h1" }]);
    expect(await runSleepMemoryDrops(input(db, { env: {} }))).toBeNull();
    expect(await runSleepMemoryDrops(input(db, { env: { HIVRA_SLEEP_DROP_MEMORY_AFTER_DAYS: "soon" } }))).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
    expect(mockRunScript).not.toHaveBeenCalled();
  });

  it("asks for agents asleep since before the cutoff and drops a few per run", async () => {
    const { db, rpc, updates } = makeDb([1, 2, 3, 4].map((n) => ({ id: id(n), proxmox_host: "h1" })));
    const result = await runSleepMemoryDrops(input(db));
    expect(rpc).toHaveBeenCalledWith("hivra_sleep_memory_drop_candidates", {
      p_cutoff: new Date(NOW - 7 * 86_400_000).toISOString(),
      p_limit: 20,
    });
    expect(result).toEqual({ counts: { candidates: 4, dropped: MEMORY_DROP_MAX_PER_RUN, refused: 0, failed: 0 }, errors: 0 });
    expect(mockRunScript).toHaveBeenCalledTimes(MEMORY_DROP_MAX_PER_RUN);
    const script = String(mockRunScript.mock.calls[0][0]);
    expect(script).toContain("VMID=1234");
    expect(script).toContain(TAG);
    // Recorded only for a row still in the same deep sleep.
    expect(updates[0].values).toEqual({ sleep_memory_dropped_at: new Date(NOW).toISOString() });
    expect(updates[0].filters).toEqual([["id", id(1)], ["sleep_state", "hibernated"]]);
    // The ones already looked at wait; the next run takes the next ones.
    const next = await runSleepMemoryDrops(input(db));
    expect(next?.counts).toMatchObject({ candidates: 2, dropped: 2 });
    const later = await runSleepMemoryDrops(input(db, { now: () => NOW + MEMORY_DROP_COOLDOWN_MS + 1, deadline: NOW + MEMORY_DROP_COOLDOWN_MS + 250_000 }));
    expect(later?.counts.candidates).toBe(4);
  });

  it("leaves hosts where sleep does not act, and rows that moved on", async () => {
    const { db, updates } = makeDb([{ id: id(1), proxmox_host: "h1" }, { id: id(2), proxmox_host: "h2" }, { id: id(3), proxmox_host: "h2" }]);
    mockReadRow.mockImplementation(async (agentId: string) =>
      agentId === id(2)
        ? { id: agentId, status: "running", sleep_state: "waking", operation_id: "op" }
        : { id: agentId, status: "running", sleep_state: "hibernated", operation_id: null });
    const result = await runSleepMemoryDrops(input(db, { hostActs: (host) => host === "h2" }));
    expect(result?.counts).toEqual({ candidates: 2, dropped: 1, refused: 1, failed: 0 });
    expect(mockRunScript).toHaveBeenCalledTimes(1);
    expect(updates.length).toBe(1);
  });

  it("counts a refusal apart from a failure and records neither", async () => {
    const { db, updates } = makeDb([{ id: id(1), proxmox_host: "h1" }, { id: id(2), proxmox_host: "h1" }]);
    mockRunScript
      .mockImplementationOnce(async () => receipt(1234, false, "not_hibernated"))
      .mockImplementationOnce(async () => ({ ok: false, stdout: "" }));
    const result = await runSleepMemoryDrops(input(db));
    expect(result).toEqual({ counts: { candidates: 2, dropped: 0, refused: 1, failed: 1 }, errors: 1 });
    expect(updates).toEqual([]);
  });

  it("starts no host call it cannot finish, and reports a failed query", async () => {
    const { db } = makeDb([{ id: id(1), proxmox_host: "h1" }]);
    const result = await runSleepMemoryDrops(input(db, { deadline: NOW + 10_000 }));
    expect(result?.counts).toMatchObject({ candidates: 1, dropped: 0 });
    expect(mockRunScript).not.toHaveBeenCalled();
    const broken = makeDb([], { message: "boom" });
    expect(await runSleepMemoryDrops(input(broken.db))).toEqual({ counts: { candidates: 0, dropped: 0, refused: 0, failed: 0 }, errors: 1 });
  });
});
