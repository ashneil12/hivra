import { freePlacementAdmission, freeRunningCap, freeWakeAdmission, selectTurns, type TurnRequest } from "../placement";
import type { FreeSandboxSettings } from "../settings";

const settings: FreeSandboxSettings = {
  sleepAfterIdleMinutes: 10,
  storeAfterIdleHours: 24,
  memoryMb: 300,
  cpus: 0.5,
  storageMb: 900,
  freePlacesPerServer: 3,
  paidReserveComputers: 1,
  cpuOvercommit: 2,
  maxConcurrentTurns: 2,
  dailyReplySecondsCap: null,
};
const ok = { freePlaced: 0, paidReserveIntact: true, paidWaiting: false };

describe("free placement", () => {
  it("takes people until the server's places are full", () => {
    expect(freePlacementAdmission({ ...ok, freePlaced: 2 }, settings)).toEqual({ admit: true });
    expect(freePlacementAdmission({ ...ok, freePlaced: 3 }, settings)).toEqual({ admit: false, reason: "places_full" });
  });

  it("never takes the room kept for paid, and waits while a paid computer waits", () => {
    expect(freePlacementAdmission({ ...ok, paidReserveIntact: false }, settings)).toEqual({ admit: false, reason: "paid_reserve" });
    expect(freePlacementAdmission({ ...ok, paidWaiting: true }, settings)).toEqual({ admit: false, reason: "paid_waiting" });
  });
});

describe("waking", () => {
  it("caps awake sandboxes by the pool's cores times the overcommit, over each sandbox's share", () => {
    expect(freeRunningCap(4, settings)).toBe(16);
    expect(freeRunningCap(0, settings)).toBe(0);
    expect(freeWakeAdmission(15, 4, settings)).toEqual({ admit: true });
    expect(freeWakeAdmission(16, 4, settings)).toEqual({ admit: false, reason: "running_cap" });
  });
});

describe("the turn line", () => {
  const turn = (id: string, paid: boolean, minute: number, used = 0): TurnRequest => ({
    id,
    paid,
    queuedAt: new Date(Date.UTC(2026, 10, 17, 0, minute)),
    replySecondsToday: used,
  });

  it("runs paid before free, then oldest first, up to the concurrent cap", () => {
    const queue = [turn("f1", false, 1), turn("p1", true, 3), turn("f2", false, 2)];
    expect(selectTurns(queue, 0, settings).start.map((t) => t.id)).toEqual(["p1", "f1"]);
    expect(selectTurns(queue, 1, settings).start.map((t) => t.id)).toEqual(["p1"]);
    expect(selectTurns(queue, 2, settings).start).toEqual([]);
  });

  it("refuses free people over the daily reply-time cap only when the cap is on", () => {
    const queue = [turn("f1", false, 1, 100), turn("p1", true, 2, 1000)];
    expect(selectTurns(queue, 0, settings).overCap).toEqual([]);
    const capped = selectTurns(queue, 0, { ...settings, dailyReplySecondsCap: 60 });
    expect(capped.overCap.map((t) => t.id)).toEqual(["f1"]);
    expect(capped.start.map((t) => t.id)).toEqual(["p1"]);
  });
});
