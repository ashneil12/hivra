/** @jest-environment node */

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { isWakeMakesRoomEnabled, makeRoomForWake, MAKE_ROOM_BUDGET_MS, MAKE_ROOM_MAX_NAPPERS } from "../wake-make-room";

const input = (fits: () => Promise<boolean>) => ({ agentId: "waker", hostId: "host-a", fits });

describe("making room for a wake", () => {
  it("is off unless switched on", () => {
    expect(isWakeMakesRoomEnabled({})).toBe(false);
    expect(isWakeMakesRoomEnabled({ HIVRA_WAKE_MAKES_ROOM: "off" })).toBe(false);
    expect(isWakeMakesRoomEnabled({ HIVRA_WAKE_MAKES_ROOM: "on" })).toBe(true);
  });

  it("deepens the longest-idle nappers in order and stops as soon as the wake fits", async () => {
    const deepened: string[] = [];
    let asks = 0;
    const result = await makeRoomForWake(input(async () => { asks += 1; return asks >= 2; }), {
      loadNappers: async () => ["oldest", "older", "newer"],
      deepen: async (id) => { deepened.push(id); return true; },
    });
    expect(deepened).toEqual(["oldest", "older"]);
    expect(result).toMatchObject({ fits: true, deepened: 2, tried: 2 });
  });

  it("skips a napper that would not sleep and does not ask again for it", async () => {
    const fits = jest.fn(async () => true);
    const result = await makeRoomForWake(input(fits), {
      loadNappers: async () => ["busy", "idle"],
      deepen: async (id) => id === "idle",
    });
    expect(fits).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ fits: true, deepened: 1, tried: 2 });
  });

  it("never deepens more than its limit", async () => {
    const deepen = jest.fn(async () => true);
    const result = await makeRoomForWake(input(async () => false), {
      loadNappers: async () => Array.from({ length: 20 }, (_, i) => `n${i}`),
      deepen,
    });
    expect(deepen).toHaveBeenCalledTimes(MAKE_ROOM_MAX_NAPPERS);
    expect(result.fits).toBe(false);
  });

  it("stops when its time is used up", async () => {
    let t = 0;
    const deepen = jest.fn(async () => { t += MAKE_ROOM_BUDGET_MS; return true; });
    const result = await makeRoomForWake(input(async () => false), {
      loadNappers: async () => ["a", "b", "c"],
      deepen,
      now: () => t,
    });
    expect(deepen).toHaveBeenCalledTimes(1);
    expect(result.deepened).toBe(1);
  });

  it("does nothing on a server with no nappers, or when they cannot be read", async () => {
    const fits = jest.fn(async () => true);
    expect(await makeRoomForWake(input(fits), { loadNappers: async () => [] })).toMatchObject({ fits: false, deepened: 0 });
    expect(await makeRoomForWake(input(fits), { loadNappers: async () => { throw new Error("db"); } })).toMatchObject({ fits: false, deepened: 0 });
    expect(fits).not.toHaveBeenCalled();
  });
});
