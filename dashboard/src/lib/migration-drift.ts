import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import {
  LOCAL_MIGRATIONS,
  type LocalMigrationEntry,
} from "@/lib/generated/migrations-manifest";

const LOG_SOURCE = "migration-drift-check";

export interface MigrationDriftResult {
  totalLocal: number;
  totalApplied: number;
  missing: LocalMigrationEntry[];
  // `unexpected` is a prod-side migration whose name does not appear in
  // the local manifest. We treat that as a warning, not a fatal — it
  // typically means an out-of-band one-off (e.g. supabase studio editor,
  // emergency DDL during an incident) that hasn't been captured in the
  // repo yet. Worth surfacing so it eventually gets backfilled, but not
  // worth failing the build over.
  unexpected: AppliedMigration[];
  // Local migrations whose VERSION timestamp in prod doesn't match the
  // filename version (typically because they were applied via the
  // supabase MCP `apply_migration` tool, which assigns a fresh timestamp
  // at apply time). This is non-fatal but worth tracking so we can
  // rewrite the filename if we want canonical history.
  versionMismatched: VersionMismatch[];
}

export interface AppliedMigration {
  version: string;
  name: string;
}

interface VersionMismatch {
  name: string;
  localVersion: string;
  appliedVersion: string;
}

type SupabaseLike = NonNullable<typeof supabaseAdmin>;

async function loadAppliedMigrations(
  client: SupabaseLike
): Promise<AppliedMigration[]> {
  // `supabase_migrations.schema_migrations` is the table the Supabase
  // platform uses to track applied migrations. PostgREST refuses
  // schema("supabase_migrations") with "Invalid schema" unless the
  // schema is in db.schemas — which we don't want to widen. Instead
  // call public.list_applied_supabase_migrations (SECURITY DEFINER,
  // service_role only — see migration 20260518021500_migration_drift_rpc).
  const { data, error } = await client.rpc(
    "list_applied_supabase_migrations" as never
  );

  if (error) {
    throw new Error(
      `Failed to read supabase_migrations.schema_migrations: ${error.message}`
    );
  }

  const rows = (data ?? []) as Array<{ version?: string; name?: string }>;
  return rows
    .filter(
      (row): row is { version: string; name: string } =>
        typeof row.version === "string" && typeof row.name === "string"
    )
    .map((row) => ({ version: row.version, name: row.name }));
}

export function diffMigrations(
  local: readonly LocalMigrationEntry[],
  applied: readonly AppliedMigration[]
): MigrationDriftResult {
  const appliedByName = new Map<string, AppliedMigration>();
  for (const row of applied) {
    appliedByName.set(row.name, row);
  }

  const localByName = new Map<string, LocalMigrationEntry>();
  for (const row of local) {
    localByName.set(row.name, row);
  }

  const missing: LocalMigrationEntry[] = [];
  const versionMismatched: VersionMismatch[] = [];
  for (const entry of local) {
    const found = appliedByName.get(entry.name);
    if (!found) {
      missing.push(entry);
      continue;
    }
    if (found.version !== entry.version) {
      versionMismatched.push({
        name: entry.name,
        localVersion: entry.version,
        appliedVersion: found.version,
      });
    }
  }

  const unexpected: AppliedMigration[] = [];
  for (const row of applied) {
    if (!localByName.has(row.name)) {
      unexpected.push(row);
    }
  }

  return {
    totalLocal: local.length,
    totalApplied: applied.length,
    missing,
    unexpected,
    versionMismatched,
  };
}

export async function runMigrationDriftCheck(): Promise<MigrationDriftResult> {
  const client = supabaseAdmin;
  if (!client) {
    throw new Error("Database not configured");
  }
  const applied = await loadAppliedMigrations(client);
  return diffMigrations(LOCAL_MIGRATIONS, applied);
}

export const MIGRATION_DRIFT_LOG_SOURCE = LOG_SOURCE;
