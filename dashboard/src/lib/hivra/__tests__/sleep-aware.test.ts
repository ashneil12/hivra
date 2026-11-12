/** @jest-environment node */

const mockEnsure = jest.fn();
jest.mock("../agent-wake", () => ({ ensureHivraAgentAwake: (...args: unknown[]) => mockEnsure(...args) }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const mockMaybeSingle = jest.fn();
const mockUpdateSelect = jest.fn();
const updates: Array<{ patch: unknown; filters: Array<[string, unknown]> }> = [];
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => {
      const filters: Array<[string, unknown]> = [];
      let patch: unknown = null;
      const q: Record<string, unknown> = {};
      q.select = (columns?: string) => (patch ? mockUpdateSelect(columns, patch, filters) : q);
      q.update = (value: unknown) => { patch = value; updates.push({ patch: value, filters }); return q; };
      q.eq = (column: string, value: unknown) => { filters.push([column, value]); return q; };
      q.maybeSingle = () => mockMaybeSingle();
      return q;
    },
  },
}));

import {
  ASLEEP_LAPSED_MESSAGE,
  markAgentAwake,
  STILL_WAKING_MESSAGE,
  wakeAgentForUserAction,
  wakeForUserAction,
  WAKE_FAILED_MESSAGE,
} from "../sleep-aware";

const ID = "11111111-1111-4111-8111-111111111111";
const napping = { id: ID, status: "running", sleep_state: "napping" };

beforeEach(() => {
  updates.length = 0;
  mockEnsure.mockResolvedValue({ state: "awake", wakeMs: 900 });
});

describe("wakeForUserAction", () => {
  it.each([
    ["an awake agent", { id: ID, status: "running", sleep_state: "awake" }],
    ["a row that has no sleep state", { id: ID, status: "running" }],
    ["a computer that is not running", { id: ID, status: "stopped", sleep_state: "napping" }],
    ["no row at all", null],
  ])("does no work for %s", async (_name, row) => {
    expect(await wakeForUserAction(row)).toEqual({ ok: true, woke: false, cold: false });
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it.each(["napping", "hibernated", "waking", "draining", "hibernating", "wake_failed", "something_new"])(
    "wakes an agent that is %s, as an action the owner took", async (state) => {
      const result = await wakeForUserAction({ ...napping, sleep_state: state });
      expect(result).toEqual({ ok: true, woke: true, cold: false });
      expect(mockEnsure).toHaveBeenCalledWith(ID, expect.objectContaining({ trigger: "action", waitMs: 45_000 }));
    });

  it("says plainly that the computer is still waking", async () => {
    mockEnsure.mockResolvedValue({ state: "waking", reason: "in_progress" });
    expect(await wakeForUserAction(napping)).toEqual({
      ok: false, reason: "waking", status: 503, code: "computer_asleep", message: STILL_WAKING_MESSAGE,
    });
  });

  it("reports a wake that did not work, without blaming the computer being gone", async () => {
    mockEnsure.mockResolvedValue({ state: "failed", reason: "public_healthz_timeout" });
    expect(await wakeForUserAction(napping)).toEqual({
      ok: false, reason: "failed", status: 503, code: "computer_asleep", message: WAKE_FAILED_MESSAGE,
    });
  });

  it("treats a wake that throws as not awake", async () => {
    mockEnsure.mockRejectedValue(new Error("boom"));
    expect(await wakeForUserAction(napping)).toMatchObject({ ok: false, reason: "failed", status: 503 });
  });

  it("refuses a lapsed owner, unless the action switches the computer off", async () => {
    mockEnsure.mockResolvedValue({ state: "failed", reason: "lapsed" });
    expect(await wakeForUserAction(napping)).toEqual({
      ok: false, reason: "lapsed", status: 402, code: "instance_entitlement_suspended", message: ASLEEP_LAPSED_MESSAGE,
    });
    expect(await wakeForUserAction(napping, { allowLapsed: true })).toEqual({ ok: true, woke: false, cold: false });
  });

  it("hands the caller a computer that was off with nothing saved", async () => {
    mockEnsure.mockResolvedValue({ state: "cold", reason: "cold" });
    expect(await wakeForUserAction(napping)).toEqual({ ok: true, woke: true, cold: true });
  });

  it("passes the wait and the background hook through", async () => {
    const onBackground = jest.fn();
    await wakeForUserAction(napping, { waitMs: 5_000, onBackground });
    expect(mockEnsure).toHaveBeenCalledWith(ID, { trigger: "action", waitMs: 5_000, onBackground });
  });

  it("keeps copy free of dashes", () => {
    for (const message of [STILL_WAKING_MESSAGE, WAKE_FAILED_MESSAGE, ASLEEP_LAPSED_MESSAGE]) {
      expect(message).not.toMatch(/[-–—]/);
    }
  });
});

describe("wakeAgentForUserAction", () => {
  it("asks about the live row, for a caller that holds only the id", async () => {
    expect(await wakeAgentForUserAction(ID)).toEqual({ ok: true, woke: true, cold: false });
    expect(mockEnsure).toHaveBeenCalledWith(ID, expect.objectContaining({ trigger: "action" }));
  });
});

describe("markAgentAwake", () => {
  it("does nothing when the record already says awake", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { sleep_state: "awake", sleep_generation: 3 }, error: null });
    expect(await markAgentAwake(ID)).toBe(true);
    expect(updates).toHaveLength(0);
  });

  it("sets awake with a new generation, only if the generation has not moved, and never touches status", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { sleep_state: "hibernated", sleep_generation: "7" }, error: null });
    mockUpdateSelect.mockResolvedValue({ data: [{ id: ID }], error: null });
    expect(await markAgentAwake(ID)).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toEqual(expect.objectContaining({ sleep_state: "awake", sleep_generation: 8, next_wake_at: null }));
    expect(updates[0].patch).not.toHaveProperty("status");
    expect(updates[0].filters).toEqual([["id", ID], ["sleep_generation", 7]]);
  });

  it("reports false when a newer change won", async () => {
    mockMaybeSingle.mockResolvedValue({ data: { sleep_state: "napping", sleep_generation: 1 }, error: null });
    mockUpdateSelect.mockResolvedValue({ data: [], error: null });
    expect(await markAgentAwake(ID)).toBe(false);
  });

  it("never throws", async () => {
    mockMaybeSingle.mockRejectedValue(new Error("down"));
    expect(await markAgentAwake(ID)).toBe(false);
    mockMaybeSingle.mockResolvedValue({ data: { sleep_state: "napping", sleep_generation: 1 }, error: null });
    mockUpdateSelect.mockResolvedValue({ data: null, error: { message: "x" } });
    expect(await markAgentAwake(ID)).toBe(false);
  });
});
