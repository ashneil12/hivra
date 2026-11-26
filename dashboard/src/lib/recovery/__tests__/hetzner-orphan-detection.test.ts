import {
  findHetznerDeployOrphans,
  HETZNER_ORPHAN_MIN_AGE_MS,
  runHetznerOrphanSweep,
  type HetznerDeployServer,
  type HetznerReferenceSnapshot,
} from "../hetzner-orphan-detection";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const OLD = "2026-10-29T08:00:00Z";
const YOUNG = "2026-10-29T11:30:00Z";

function server(id: number, created: string, labels: Record<string, string> = { app: "hermes-deploy" }): HetznerDeployServer {
  return { id, name: `host-${id}`, created, labels };
}

function references(partial: Partial<HetznerReferenceSnapshot> = {}): HetznerReferenceSnapshot {
  return {
    liveServerIds: new Set<number>(),
    unprovisionedServers: new Map<number, string | null>(),
    ...partial,
  };
}

describe("findHetznerDeployOrphans", () => {
  it("reports an old hermes-deploy server that no live row references", () => {
    const summary = findHetznerDeployOrphans({
      servers: [server(1, OLD)],
      references: references(),
      nowMs: NOW,
    });

    expect(summary.orphans).toEqual([
      expect.objectContaining({ serverId: 1, reason: "no_live_row", instanceId: null }),
    ]);
  });

  it("ignores a server that a live instance or host row references", () => {
    const summary = findHetznerDeployOrphans({
      servers: [server(1, OLD)],
      references: references({ liveServerIds: new Set([1]) }),
      nowMs: NOW,
    });

    expect(summary.orphans).toEqual([]);
    expect(summary.liveServers).toBe(1);
  });

  it("reports a server that only an unprovisioned row (creation receipt) still points at", () => {
    const summary = findHetznerDeployOrphans({
      servers: [server(7, OLD)],
      references: references({ unprovisionedServers: new Map([[7, "inst-7"]]) }),
      nowMs: NOW,
    });

    expect(summary.orphans).toEqual([
      expect.objectContaining({
        serverId: 7,
        reason: "row_not_provisioned",
        instanceId: "inst-7",
      }),
    ]);
  });

  it("skips young servers so an in-flight provision is never reported", () => {
    const summary = findHetznerDeployOrphans({
      servers: [server(3, YOUNG)],
      references: references(),
      nowMs: NOW,
    });

    expect(summary.orphans).toEqual([]);
    expect(summary.youngServers).toBe(1);
  });

  it("uses a minimum age well above the 300 s route budget", () => {
    expect(HETZNER_ORPHAN_MIN_AGE_MS).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
  });
});

describe("runHetznerOrphanSweep", () => {
  it("lists only servers labelled app=hermes-deploy and never mutates them", async () => {
    const listServers = jest.fn().mockResolvedValue([
      server(1, OLD),
      server(2, OLD, { app: "something-else" }),
    ]);
    const loadReferences = jest.fn().mockResolvedValue(references());

    const summary = await runHetznerOrphanSweep({
      listServers,
      loadReferences,
      nowMs: () => NOW,
    });

    expect(summary.serversScanned).toBe(1);
    expect(summary.orphans.map((o) => o.serverId)).toEqual([1]);
    expect(summary.skipped).toBeNull();
  });

  it("skips cleanly when the platform Hetzner token is not configured", async () => {
    const originalToken = process.env.HETZNER_API_TOKEN;
    delete process.env.HETZNER_API_TOKEN;
    try {
      const summary = await runHetznerOrphanSweep({ nowMs: () => NOW });
      expect(summary.skipped).toBe("hetzner_token_not_configured");
      expect(summary.orphans).toEqual([]);
    } finally {
      if (originalToken === undefined) delete process.env.HETZNER_API_TOKEN;
      else process.env.HETZNER_API_TOKEN = originalToken;
    }
  });
});
