/** @jest-environment node */
import type * as AgentsDeployed from "../agents-deployed";

const mockStats = jest.fn();
jest.mock("@/lib/agents-deployed-stats", () => ({ getAgentsDeployedStats: () => mockStats() }));
// next/cache needs a running Next server; the callback is what is under test.
jest.mock("next/cache", () => ({ unstable_cache: (callback: (...args: unknown[]) => unknown) => callback }));

/** A fresh copy of the module, so its one-minute pause after a failure starts clear. */
async function load(): Promise<typeof AgentsDeployed> {
  let loaded!: typeof AgentsDeployed;
  await jest.isolateModulesAsync(async () => {
    loaded = await import("../agents-deployed");
  });
  return loaded;
}

beforeEach(() => mockStats.mockReset());

describe("toSnapshot", () => {
  it("keeps a real count with the UTC day it was read", async () => {
    const { toSnapshot } = await load();
    expect(toSnapshot({ total: 2517, generatedAt: "2026-10-20T23:59:59.000Z" })).toEqual({ total: 2517, asOf: "2026-10-20" });
  });

  it("is null for the zero the lookup returns on any failure, and for anything that is not a count", async () => {
    const { toSnapshot } = await load();
    expect(toSnapshot({ total: 0, generatedAt: "2026-10-20T10:00:00.000Z" })).toBeNull();
    expect(toSnapshot({ total: -1, generatedAt: "2026-10-20T10:00:00.000Z" })).toBeNull();
    expect(toSnapshot({ total: Number.NaN, generatedAt: "2026-10-20T10:00:00.000Z" })).toBeNull();
  });

  it("falls back to today when the lookup gives no usable time", async () => {
    const { toSnapshot } = await load();
    expect(toSnapshot({ total: 5, generatedAt: "not a date" }, new Date("2026-10-21T08:00:00Z"))).toEqual({ total: 5, asOf: "2026-10-21" });
  });
});

describe("getHomeAgentsDeployed", () => {
  it("returns the count from the same lookup /stats uses", async () => {
    mockStats.mockResolvedValue({ total: 2517, last24h: 3, last7d: 20, generatedAt: "2026-10-20T10:00:00.000Z" });
    await expect((await load()).getHomeAgentsDeployed()).resolves.toEqual({ total: 2517, asOf: "2026-10-20" });
  });

  it("returns null, never 0, when the lookup reports nothing, and leaves the database alone for a minute", async () => {
    mockStats.mockResolvedValue({ total: 0, last24h: 0, last7d: 0, generatedAt: "2026-10-20T10:00:00.000Z" });
    const { getHomeAgentsDeployed } = await load();
    await expect(getHomeAgentsDeployed(1_000)).resolves.toBeNull();
    expect(mockStats).toHaveBeenCalledTimes(1);

    mockStats.mockResolvedValue({ total: 2517, last24h: 0, last7d: 0, generatedAt: "2026-10-20T10:00:30.000Z" });
    await expect(getHomeAgentsDeployed(1_000 + 59_000)).resolves.toBeNull();
    expect(mockStats).toHaveBeenCalledTimes(1);
    await expect(getHomeAgentsDeployed(1_000 + 61_000)).resolves.toEqual({ total: 2517, asOf: "2026-10-20" });
  });

  it("returns null when the lookup throws", async () => {
    mockStats.mockRejectedValue(new Error("database is down"));
    await expect((await load()).getHomeAgentsDeployed()).resolves.toBeNull();
  });
});
