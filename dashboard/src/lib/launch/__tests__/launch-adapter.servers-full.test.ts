/** @jest-environment jsdom */
// When every server is out of room, a launch waits in line and is sent again
// instead of showing an error (Ash, 2026-11-18).

import { HivraLaunchCorrectableError } from "@/lib/hivra/agent-api";
import { isServersFullLaunchError, waitForRoom, type LaunchObservation } from "../launch-adapter";

const full = () => new HivraLaunchCorrectableError("Our servers are full right now.", 503, "servers_full");

function clock() {
  let t = 1_000;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
  };
}

describe("waitForRoom", () => {
  it("sends again while servers are full and returns the launch once one has room", async () => {
    const c = clock();
    const send = jest.fn()
      .mockRejectedValueOnce(full())
      .mockRejectedValueOnce(full())
      .mockResolvedValueOnce({ id: "a1" });
    const seen: LaunchObservation[] = [];
    const result = await waitForRoom(send, o => seen.push(o), { retryMs: 30_000, limitMs: 600_000, ...c });
    expect(result).toEqual({ id: "a1" });
    expect(send).toHaveBeenCalledTimes(3);
    expect(seen.map(o => o.kind)).toEqual(["waiting-for-room", "waiting-for-room"]);
    expect(seen.every(o => o.kind === "waiting-for-room" && o.since === 1_000)).toBe(true);
  });

  it("gives the refusal back after the wait limit", async () => {
    const c = clock();
    const send = jest.fn().mockRejectedValue(full());
    await expect(waitForRoom(send, undefined, { retryMs: 30_000, limitMs: 90_000, ...c })).rejects.toMatchObject({ code: "servers_full" });
    expect(send).toHaveBeenCalledTimes(4);
  });

  it("never sends again on any other refusal", async () => {
    const c = clock();
    const other = new HivraLaunchCorrectableError("Pick a smaller size.", 409, "placement_unavailable");
    const send = jest.fn().mockRejectedValue(other);
    await expect(waitForRoom(send, undefined, c)).rejects.toBe(other);
    expect(send).toHaveBeenCalledTimes(1);
    expect(isServersFullLaunchError(other)).toBe(false);
    expect(isServersFullLaunchError(new Error("servers_full"))).toBe(false);
  });
});
