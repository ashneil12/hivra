import fs from "node:fs";
import path from "node:path";

const migrationsDir = path.resolve(__dirname, "../supabase/migrations");

function readColdStorageMigration(): string {
  const matches = fs
    .readdirSync(migrationsDir)
    .filter((name) => /^\d{14}_cold_storage_lifecycle\.sql$/.test(name));

  expect(matches).toHaveLength(1);
  return fs.readFileSync(path.join(migrationsDir, matches[0]), "utf8");
}

describe("cold storage lifecycle migration", () => {
  it("extends lifecycle_state without dropping existing production states", () => {
    const sql = readColdStorageMigration();

    for (const state of [
      "pending",
      "provisioning",
      "active",
      "paused",
      "suspended",
      "deleting",
      "deleted",
      "failed",
      "archiving",
      "cold_archived",
      "restoring",
      "pending_deletion",
    ]) {
      expect(sql).toContain(`'${state}'`);
    }
  });

  it("adds the cold archive bookkeeping columns and cron indexes idempotently", () => {
    const sql = readColdStorageMigration();

    for (const column of [
      "add column if not exists archive_uri",
      "add column if not exists archived_at",
      "add column if not exists archive_size_bytes",
      "add column if not exists archive_sha256",
      "add column if not exists archive_count",
      "add column if not exists lifecycle_substate",
      "add column if not exists notifications_sent",
    ]) {
      expect(sql.toLowerCase()).toContain(column);
    }

    expect(sql).toContain("hermes_instances_lifecycle_paused_archive_idx");
    expect(sql).toContain("hermes_instances_cold_archived_idx");
  });
});
