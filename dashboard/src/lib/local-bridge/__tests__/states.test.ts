import { BRIDGE_STATUSES, BRIDGE_TRANSITIONS, canMoveBridgeRequest, isFinalBridgeStatus } from "../states";

describe("bridge request states", () => {
  it("only moves forward", () => {
    expect(canMoveBridgeRequest("pending", "approved")).toBe(true);
    expect(canMoveBridgeRequest("approved", "running")).toBe(true);
    expect(canMoveBridgeRequest("running", "done")).toBe(true);
    expect(canMoveBridgeRequest("pending", "done")).toBe(false);
    expect(canMoveBridgeRequest("pending", "running")).toBe(false);
    expect(canMoveBridgeRequest("done", "pending")).toBe(false);
    expect(canMoveBridgeRequest("expired", "approved")).toBe(false);
  });

  it("finished requests stay finished", () => {
    for (const status of ["done", "denied", "expired", "failed"] as const) expect(isFinalBridgeStatus(status)).toBe(true);
  });

  it("matches the database trigger's list", () => {
    const fs = jest.requireActual("fs") as typeof import("fs");
    const path = jest.requireActual("path") as typeof import("path");
    const sql = fs.readFileSync(path.join(__dirname, "../../../../supabase/migrations/20261112130000_explicit_state_transitions.sql"), "utf8");
    for (const from of BRIDGE_STATUSES) {
      for (const to of BRIDGE_TRANSITIONS[from]) expect(sql).toContain(`('${from}','${to}')`);
    }
  });
});
