import {
  captureFleetUpdateFailure,
  classifyFleetUpdateReport,
  FLEET_LIVE_UPDATE_BACKENDS,
  filterStaleInstances,
  parseFleetLiveUpdateArgs,
} from "../fleet-live-update-helpers";

describe("fleet live-update helpers", () => {
  it("includes WebUI-free gateway rows in the live-update lane", () => {
    expect(FLEET_LIVE_UPDATE_BACKENDS).toEqual(["webui", "gateway"]);
  });

  it("filters rows that were not synced after the requested cutoff", () => {
    const rows = [
      { id: "never", last_synced_at: null },
      { id: "old", last_synced_at: "2026-06-08T05:55:38Z" },
      { id: "fresh", last_synced_at: "2026-06-08T05:55:39Z" },
    ];

    expect(filterStaleInstances(rows, "2026-06-08T05:55:39Z").map((row) => row.id))
      .toEqual(["never", "old"]);
  });

  it("parses stale-since and clamps concurrency for manual sweeps", () => {
    expect(parseFleetLiveUpdateArgs([
      "--apply",
      "--concurrency",
      "99",
      "--stale-since",
      "2026-06-08T05:55:39Z",
    ])).toMatchObject({
      apply: true,
      dryRun: false,
      concurrency: 10,
      staleSince: "2026-06-08T05:55:39Z",
    });
  });

  it("turns a thrown live-update error into one failed result without aborting the batch", async () => {
    const errors: string[] = [];
    const result = await captureFleetUpdateFailure(
      { id: "inst-1", name: "Agent One" },
      async () => {
        throw new Error("Failed to load profile deployment state: TypeError: fetch failed");
      },
      (message) => errors.push(message),
    );

    expect(result).toMatchObject({
      instanceId: "inst-1",
      name: "Agent One",
      status: "failed",
    });
    expect(result.detail).toContain("fetch failed");
    expect(errors).toHaveLength(1);
  });

  it("does not let a stale collapsed callback complete a new fleet launch", () => {
    expect(classifyFleetUpdateReport([
      {
        title: "Manual update succeeded",
        last_seen_at: "2026-09-04T15:00:00Z",
      },
    ], "2026-09-04T16:00:00Z")).toBeNull();
  });

  it("classifies fresh success and failure callbacks", () => {
    expect(classifyFleetUpdateReport([
      {
        title: "Manual update succeeded",
        last_seen_at: "2026-09-04T16:00:05Z",
      },
    ], "2026-09-04T16:00:00Z")).toEqual({ status: "succeeded" });

    expect(classifyFleetUpdateReport([
      {
        title: "Manual update failed",
        last_seen_at: "2026-09-04T16:00:05Z",
        metadata: { reason: "exit_status_1" },
      },
    ], "2026-09-04T16:00:00Z")).toEqual({
      status: "failed",
      detail: "exit_status_1",
    });
  });
});
