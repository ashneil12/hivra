import { freePlacementAdmission, refusedShare, freeRunningCap, freeWakeAdmission } from "../placement";
import type { FreeSandboxSettings } from "../settings";

const settings: FreeSandboxSettings = {
  sleepAfterIdleMinutes: 10,
  storeAfterIdleHours: 24,
  memoryMb: 300,
  cpus: 0.5,
  storageMb: 900,
  freePlacesPerServer: 3,
  hermesPlacesPerServer: 0,
  freeModels: ["prov/model-a"],
  paidReserveComputers: 1,
  cpuOvercommit: 2,
  maxConcurrentTurns: 2,
  dailyReplySecondsCap: null,
  agents: 2,
  scheduledJobs: 3,
  scheduledJobMinHours: 5,
  placesOpenPerServer: 50,
  refusedShareStop: 0.2,
  refusedShareMinReplies: 10,
  failedBurstWorkspaces: 3,
  failedBurstMinutes: 10,
};
const ok = { freePlaced: 0, paidReserveIntact: true, paidWaiting: false };

describe("free placement", () => {
  it("takes people until the server's places are full", () => {
    expect(freePlacementAdmission({ ...ok, freePlaced: 2 }, settings)).toEqual({ admit: true });
    expect(freePlacementAdmission({ ...ok, freePlaced: 3 }, settings)).toEqual({ admit: false, reason: "places_full" });
  });

  it("never takes the room kept for paid, and waits while a paid computer waits", () => {
    expect(freePlacementAdmission({ ...ok, paidReserveIntact: false }, settings)).toEqual({
      admit: false,
      reason: "paid_reserve",
    });
    expect(freePlacementAdmission({ ...ok, paidWaiting: true }, settings)).toEqual({
      admit: false,
      reason: "paid_waiting",
    });
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

describe("free AI refusals and steps", () => {
  it("counts the refused share only once a server has enough replies, and stops placing above it", () => {
    expect(refusedShare({ answered: 1, refused: 2, failed: 0 }, settings)).toBeNull();
    expect(refusedShare({ answered: 8, refused: 2, failed: 5 }, settings)).toBe(0.2);
    expect(freePlacementAdmission(ok, settings, { answered: 8, refused: 2, failed: 0 })).toEqual({ admit: true });
    expect(freePlacementAdmission(ok, settings, { answered: 7, refused: 3, failed: 0 })).toEqual({
      admit: false,
      reason: "free_ai_refusing",
    });
  });

  it("opens no more places than the current step", () => {
    const stepped = { ...settings, placesOpenPerServer: 1 };
    expect(freePlacementAdmission({ ...ok, freePlaced: 1 }, stepped)).toEqual({ admit: false, reason: "places_full" });
  });
});
