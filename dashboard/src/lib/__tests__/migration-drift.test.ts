import { diffMigrations } from "@/lib/migration-drift";

describe("diffMigrations", () => {
  it("returns zero drift when local and applied match by name", () => {
    const local = [
      { version: "20260101000000", name: "alpha" },
      { version: "20260102000000", name: "beta" },
    ];
    const applied = [
      { version: "20260101000000", name: "alpha" },
      { version: "20260102000000", name: "beta" },
    ];

    const result = diffMigrations(local, applied);

    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual([]);
    expect(result.versionMismatched).toEqual([]);
    expect(result.totalLocal).toBe(2);
    expect(result.totalApplied).toBe(2);
  });

  it("flags local migrations that have no matching name in prod", () => {
    // The 2026-05-12 scenario: 4 files in the repo, prod table missing
    // all 4. The drift check must emit one entry per missing migration
    // so the ops feed lists every name (not a single aggregate row).
    const local = [
      { version: "20260511000000", name: "rename_scheduled_tasks_to_deprecated" },
      { version: "20260512120000", name: "proxmox_hosts_disk_capacity" },
      { version: "20260512180000", name: "managed_venice_wallets" },
      { version: "20260512181000", name: "managed_venice_token_quotes" },
    ];
    const applied = [
      { version: "20260511000000", name: "rename_scheduled_tasks_to_deprecated" },
    ];

    const result = diffMigrations(local, applied);

    expect(result.missing.map((m) => m.name)).toEqual([
      "proxmox_hosts_disk_capacity",
      "managed_venice_wallets",
      "managed_venice_token_quotes",
    ]);
    expect(result.unexpected).toEqual([]);
  });

  it("flags applied migrations that don't exist in the local repo", () => {
    // Out-of-band DDL (emergency hotfix via supabase studio or manual
    // SQL) that nobody back-ported. Warn, don't fail.
    const local = [{ version: "20260101000000", name: "alpha" }];
    const applied = [
      { version: "20260101000000", name: "alpha" },
      { version: "20260601000000", name: "emergency_index_for_incident_42" },
    ];

    const result = diffMigrations(local, applied);

    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual([
      {
        version: "20260601000000",
        name: "emergency_index_for_incident_42",
      },
    ]);
  });

  it("flags version mismatch when the same migration name was applied with a different timestamp", () => {
    // Common when migrations are applied via supabase MCP — the apply
    // path stamps version with the apply timestamp, not the filename's.
    const local = [
      { version: "20260512120000", name: "proxmox_hosts_disk_capacity" },
    ];
    const applied = [
      { version: "20260514223616", name: "proxmox_hosts_disk_capacity" },
    ];

    const result = diffMigrations(local, applied);

    expect(result.missing).toEqual([]);
    expect(result.versionMismatched).toEqual([
      {
        name: "proxmox_hosts_disk_capacity",
        localVersion: "20260512120000",
        appliedVersion: "20260514223616",
      },
    ]);
  });

  it("matches on name, not version, so reorderings and MCP-applied rows are correctly resolved", () => {
    // Two ways the same migration can appear in prod with a different
    // version: MCP-apply (today's timestamp) or a manual `supabase
    // migration repair`. Either way it's the SAME migration, not a
    // missing one.
    const local = [
      { version: "20260512180000", name: "managed_venice_wallets" },
    ];
    const applied = [
      { version: "99999999999999", name: "managed_venice_wallets" },
    ];

    const result = diffMigrations(local, applied);

    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual([]);
    expect(result.versionMismatched).toHaveLength(1);
  });
});
