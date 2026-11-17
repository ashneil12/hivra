import { freeSandboxSettings, readPlanLadder } from "../settings";
import { turnGateConfig } from "../turn-gate";

const hosts = { turnHosts: ["ai.example"], allowHosts: ["pkgs.example"] };
const runtime = {
  listenHost: "10.0.0.1",
  listenPort: 3128,
  queueWaitSeconds: 60,
  idleCloseSeconds: 120,
  stateFile: "/var/lib/hivra-gvisor/turn-gate.json",
};

describe("turn gate config", () => {
  it("carries the turn limit and the daily cap, 0 meaning off for both", () => {
    const on = turnGateConfig({ maxConcurrentTurns: 4, dailyReplySecondsCap: 900 }, hosts, {}, runtime);
    expect(on).toMatchObject({ maxConcurrentTurns: 4, dailyReplySecondsCap: 900 });
    const off = turnGateConfig({ maxConcurrentTurns: 0, dailyReplySecondsCap: null }, hosts, {}, runtime);
    expect(off).toMatchObject({ maxConcurrentTurns: 0, dailyReplySecondsCap: 0 });
  });

  it("names sandboxes by address and id only, and refuses anything that is not a host or an address", () => {
    const sandboxes = { "172.20.0.2": "00000000-0000-4000-8000-000000000001" };
    expect(
      turnGateConfig({ maxConcurrentTurns: 1, dailyReplySecondsCap: null }, hosts, sandboxes, runtime).sandboxes,
    ).toEqual(sandboxes);
    expect(() =>
      turnGateConfig(
        { maxConcurrentTurns: 1, dailyReplySecondsCap: null },
        { ...hosts, allowHosts: ["*.x"] },
        {},
        runtime,
      ),
    ).toThrow();
    expect(() =>
      turnGateConfig({ maxConcurrentTurns: 1, dailyReplySecondsCap: null }, hosts, { "300.1.1.1": "x" }, runtime),
    ).toThrow();
  });

  it("reads 0 in the settings as off, not as the feature off", () => {
    const base = JSON.parse(
      JSON.stringify({
        sleepAfterIdleMinutes: 10,
        storeAfterIdleHours: 24,
        memoryMb: 1024,
        cpus: 0.5,
        storageMb: 1024,
        freePlacesPerServer: 2,
        freeModels: ["opencode/model-a"],
        paidReserveComputers: 1,
        cpuOvercommit: 2,
        agents: 1,
        scheduledJobs: 1,
        scheduledJobMinHours: 24,
        placesOpenPerServer: 50,
        refusedShareStop: 0.2,
        refusedShareMinReplies: 20,
      }),
    );
    const read = freeSandboxSettings(
      readPlanLadder({
        HIVRA_PLAN_LADDER_CONFIG: JSON.stringify({ free: { ...base, maxConcurrentTurns: 0, dailyReplySecondsCap: 0 } }),
      }),
    );
    expect(read).toMatchObject({ maxConcurrentTurns: 0, dailyReplySecondsCap: null });
  });
});
