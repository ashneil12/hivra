import { decideFreeSandbox, type SandboxSignals } from "../policy";

const clocks = { sleepAfterIdleMinutes: 10, storeAfterIdleHours: 24 };
const placedAt = new Date("2026-11-17T00:00:00Z");
const at = (minutes: number) => new Date(placedAt.getTime() + minutes * 60_000);
const signals = (over: Partial<SandboxSignals> = {}): SandboxSignals => ({
  state: "awake",
  personActivityAt: null,
  placedAt,
  personRunActive: false,
  ...over,
});

describe("decideFreeSandbox", () => {
  it("stops an awake sandbox once the person has been quiet for the sleep time, and not a moment before", () => {
    expect(decideFreeSandbox(signals(), clocks, at(9.99))).toMatchObject({ action: "none", reason: "recent" });
    expect(decideFreeSandbox(signals(), clocks, at(10))).toEqual({ action: "stop", reason: "idle" });
  });

  it("counts from the person's last use, and says when to look again", () => {
    const decision = decideFreeSandbox(signals({ personActivityAt: at(30) }), clocks, at(35));
    expect(decision).toEqual({ action: "none", reason: "recent", nextCheckAt: at(40) });
  });

  it("never stops under a run the person started", () => {
    expect(decideFreeSandbox(signals({ personRunActive: true }), clocks, at(600))).toMatchObject({
      action: "none",
      reason: "busy",
    });
  });

  it("packs a stopped sandbox after the storage time with no person use", () => {
    const stopped = signals({ state: "stopped", personActivityAt: at(0) });
    expect(decideFreeSandbox(stopped, clocks, at(24 * 60 - 1))).toMatchObject({ action: "none" });
    expect(decideFreeSandbox(stopped, clocks, at(24 * 60))).toEqual({ action: "pack", reason: "idle_long" });
  });

  it("has no input for scheduled jobs, so they can never keep it awake or reset the storage clock", () => {
    expect(Object.keys(signals()).sort()).toEqual(["personActivityAt", "personRunActive", "placedAt", "state"]);
  });

  it("leaves packed, restoring and flagged sandboxes to their own steps, and never deletes", () => {
    for (const state of ["packed", "restoring", "flagged"] as const) {
      expect(decideFreeSandbox(signals({ state }), clocks, at(1e6))).toMatchObject({
        action: "none",
        reason: "not_managed_here",
      });
    }
  });

  it("follows a paid plan's longer storage clock", () => {
    const stopped = signals({ state: "stopped" });
    expect(
      decideFreeSandbox(stopped, { sleepAfterIdleMinutes: 10, storeAfterIdleHours: 168 }, at(24 * 60)),
    ).toMatchObject({
      action: "none",
    });
  });
});
