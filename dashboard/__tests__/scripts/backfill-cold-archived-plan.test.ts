import {
  buildColdArchivedBackfillPatch,
  parseColdStorageManifest,
  planColdArchivedBackfill,
} from "../../scripts/ops/backfill-cold-archived-plan";

const manifest = {
  schema_version: 1,
  archived_at: "2026-05-16T10:29:40Z",
  vmid: 216,
  pve_host: "fixturenode2",
  instance_id: "00000000-0000-4000-8000-000000000216",
  archive_path: "free/00000000-0000-4000-8000-000000000216/data-20260516T102940Z.tar.zst",
  archive_size_bytes: 917665644,
  archive_sha256: "10977054c9de258a9e9011d812c562bcaf6fc8fd02a60bdcba9747040e356e22",
  tier: "free",
  contents: [
    "/opt/hermes/instances/00000000-0000-4000-8000-000000000216",
  ],
};

describe("cold archived backfill planning", () => {
  it("parses a valid Storage Box manifest into canonical DB fields", () => {
    const parsed = parseColdStorageManifest(JSON.stringify(manifest), "meta/iid/ts.json");

    expect(parsed).toMatchObject({
      instanceId: "00000000-0000-4000-8000-000000000216",
      archivedAt: "2026-05-16T10:29:40.000Z",
      archiveUri: "free/00000000-0000-4000-8000-000000000216/data-20260516T102940Z.tar.zst",
      archiveSizeBytes: 917665644,
      archiveSha256: "10977054c9de258a9e9011d812c562bcaf6fc8fd02a60bdcba9747040e356e22",
      sourceProxmoxNode: "fixturenode2",
      sourceProxmoxVmid: 216,
      manifestPath: "meta/iid/ts.json",
    });
  });

  it("rejects manifests without a complete sha256 before any DB update is planned", () => {
    expect(() =>
      parseColdStorageManifest(
        JSON.stringify({ ...manifest, archive_sha256: "" }),
        "meta/iid/ts.json"
      )
    ).toThrow("archive_sha256");
  });

  it("builds an atomic cold_archived patch that clears hot Proxmox routing fields", () => {
    const parsed = parseColdStorageManifest(JSON.stringify(manifest), "meta/iid/ts.json");

    expect(buildColdArchivedBackfillPatch(parsed, { nowIso: "2026-05-16T12:00:00.000Z" })).toEqual({
      lifecycle_state: "cold_archived",
      status: "stopped",
      archive_uri: manifest.archive_path,
      archived_at: "2026-05-16T10:29:40.000Z",
      archive_size_bytes: 917665644,
      archive_sha256: manifest.archive_sha256,
      archive_count: 1,
      lifecycle_substate: null,
      paused_reason: "cold_archived",
      proxmox_node: null,
      proxmox_vmid: null,
      ipv4_address: null,
      last_lifecycle_transition_at: "2026-05-16T12:00:00.000Z",
    });
  });

  it("refuses apply mode unless the operator confirms the source VMs are already destroyed", () => {
    const parsed = parseColdStorageManifest(JSON.stringify(manifest), "meta/iid/ts.json");

    expect(() =>
      planColdArchivedBackfill({
        manifests: [parsed],
        apply: true,
        confirmSourceVmsDestroyed: false,
        nowIso: "2026-05-16T12:00:00.000Z",
      })
    ).toThrow("confirm-source-vms-destroyed");
  });
});
