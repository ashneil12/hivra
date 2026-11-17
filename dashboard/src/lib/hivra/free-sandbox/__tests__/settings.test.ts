import { freeSandboxEnabled, freeSandboxSettings, lifecycleSettings, readPlanLadder } from "../settings";

const free = {
  sleepAfterIdleMinutes: 7,
  storeAfterIdleHours: 11,
  memoryMb: 300,
  cpus: 0.25,
  storageMb: 900,
  freePlacesPerServer: 3,
  hermesPlacesPerServer: 0,
  freeModels: ["prov/model-a", "prov/model-b"],
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
};
const env = (ladder: unknown) => ({ HIVRA_PLAN_LADDER_CONFIG: JSON.stringify(ladder) });

describe("free sandbox settings", () => {
  it("reads every value from the ladder, with no defaults of its own", () => {
    expect(freeSandboxSettings(readPlanLadder(env({ free })))).toEqual(free);
  });

  it("turns the feature off when the ladder or any setting is missing or out of shape", () => {
    expect(freeSandboxSettings(readPlanLadder({}))).toBeNull();
    expect(freeSandboxSettings(readPlanLadder({ HIVRA_PLAN_LADDER_CONFIG: "not json" }))).toBeNull();
    for (const key of Object.keys(free).filter((k) => k !== "dailyReplySecondsCap" && k !== "hermesPlacesPerServer")) {
      const broken = { ...free, [key]: undefined };
      expect(freeSandboxSettings(readPlanLadder(env({ free: broken })))).toBeNull();
    }
    expect(freeSandboxSettings(readPlanLadder(env({ free: { ...free, memoryMb: 300.5 } })))).toBeNull();
    expect(freeSandboxSettings(readPlanLadder(env({ free: { ...free, cpus: -1 } })))).toBeNull();
  });

  it("keeps the reply-time cap off unless it is a whole number of seconds", () => {
    const withoutCap: Record<string, unknown> = { ...free };
    delete withoutCap.dailyReplySecondsCap;
    expect(freeSandboxSettings(readPlanLadder(env({ free: withoutCap })))?.dailyReplySecondsCap).toBeNull();
    expect(
      freeSandboxSettings(readPlanLadder(env({ free: { ...free, dailyReplySecondsCap: 60 } })))?.dailyReplySecondsCap,
    ).toBe(60);
    expect(freeSandboxSettings(readPlanLadder(env({ free: { ...free, dailyReplySecondsCap: "60" } })))).toBeNull();
  });

  it("reads a missing reply-time cap as the cap off, never as the feature off", () => {
    const withoutCap: Record<string, unknown> = { ...free };
    delete withoutCap.dailyReplySecondsCap;
    const read = freeSandboxSettings(readPlanLadder(env({ free: withoutCap })));
    expect(read).not.toBeNull();
    expect(read?.dailyReplySecondsCap).toBeNull();
    expect(read?.maxConcurrentTurns).toBe(free.maxConcurrentTurns);
  });

  it("reads a missing second class of place as none, and needs at least one well-formed free model", () => {
    const withoutHermes: Record<string, unknown> = { ...free };
    delete withoutHermes.hermesPlacesPerServer;
    expect(freeSandboxSettings(readPlanLadder(env({ free: withoutHermes }))))?.toMatchObject({
      hermesPlacesPerServer: 0,
    });
    expect(freeSandboxSettings(readPlanLadder(env({ free: { ...free, hermesPlacesPerServer: -1 } })))).toBeNull();
    expect(freeSandboxSettings(readPlanLadder(env({ free: { ...free, freeModels: [] } })))).toBeNull();
    expect(freeSandboxSettings(readPlanLadder(env({ free: { ...free, freeModels: ["no-provider"] } })))).toBeNull();
    expect(
      freeSandboxSettings(readPlanLadder(env({ free: { ...free, freeModels: ["prov/x; rm -rf /"] } }))),
    ).toBeNull();
  });

  it("reads a paid plan's clocks from its own section", () => {
    const ladder = readPlanLadder(env({ free, somePaidPlan: { sleepAfterIdleMinutes: 5, storeAfterIdleHours: 99 } }));
    expect(lifecycleSettings(ladder, "somePaidPlan")).toEqual({ sleepAfterIdleMinutes: 5, storeAfterIdleHours: 99 });
    expect(lifecycleSettings(ladder, "unknownPlan")).toBeNull();
  });

  it("is off unless the switch is exactly true", () => {
    expect(freeSandboxEnabled({})).toBe(false);
    expect(freeSandboxEnabled({ FREE_SANDBOX_ENABLED: "1" })).toBe(false);
    expect(freeSandboxEnabled({ FREE_SANDBOX_ENABLED: "true" })).toBe(true);
  });
});
