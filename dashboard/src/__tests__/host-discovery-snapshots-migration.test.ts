import { readFileSync } from "node:fs";
import path from "node:path";

const migration = readFileSync(
  path.resolve(
    __dirname,
    "../../supabase/migrations/20260826150000_host_discovery_snapshots.sql",
  ),
  "utf8",
);
const normalizedMigration = migration.replace(/\s+/g, " ").toLowerCase();

describe("host discovery snapshot migration", () => {
  it("stores immutable, bounded, revision-bound snapshots separately from authority", () => {
    expect(normalizedMigration).toContain(
      "create table if not exists public.infrastructure_host_discovery_snapshots",
    );
    expect(normalizedMigration).toContain("connection_revision bigint not null check (connection_revision > 0)");
    expect(normalizedMigration).toContain("check (octet_length(snapshot::text) <= 65536)");
    expect(normalizedMigration).toContain("check (expires_at = observed_at + interval '15 minutes')");
    expect(normalizedMigration).toContain(
      "before update on public.infrastructure_host_discovery_snapshots",
    );
    expect(normalizedMigration).toContain("raise exception 'host discovery snapshots are immutable'");
  });

  it("keeps runs and snapshots service-role only with no browser policy", () => {
    for (const table of [
      "infrastructure_host_discovery_runs",
      "infrastructure_host_discovery_snapshots",
    ]) {
      expect(normalizedMigration).toContain(
        `alter table public.${table} enable row level security`,
      );
      expect(normalizedMigration).toContain(
        `revoke all on public.${table} from public, anon, authenticated`,
      );
      expect(normalizedMigration).toContain(
        `grant all on public.${table} to service_role`,
      );
      expect(normalizedMigration).not.toMatch(
        new RegExp(`create policy [^;]+ on public\\.${table}`),
      );
    }
  });

  it("claims and completes through exact owner, revision, run, and expiry CAS", () => {
    expect(normalizedMigration).toContain(
      "create or replace function public.begin_infrastructure_host_discovery(",
    );
    expect(normalizedMigration).toContain(
      "create or replace function public.complete_infrastructure_host_discovery(",
    );
    expect(normalizedMigration).toContain(
      "create or replace function public.release_infrastructure_host_discovery(",
    );
    expect(normalizedMigration).toContain("and revision = p_expected_revision for update");
    expect(normalizedMigration).toContain("and run_id = p_run_id for update");
    expect(normalizedMigration).toContain("v_run.lease_expires_at <= v_now");
    expect(normalizedMigration).toContain("v_now + interval '2 minutes'");
  });

  it("serializes discovery against preparation without touching target or launch authority", () => {
    expect(normalizedMigration).toContain(
      "create or replace function public.prevent_preflight_during_host_discovery()",
    );
    expect(normalizedMigration).toContain(
      "before update of preflight_run_id on public.infrastructure_connections",
    );
    expect(normalizedMigration).toContain("if v_connection.preflight_run_id is not null then return false");
    expect(normalizedMigration).not.toContain("deployment_targets");
    expect(normalizedMigration).not.toContain("supported_isolation_drivers");
    expect(normalizedMigration).not.toContain("launchready");
  });

  it("revokes discovery RPCs from browser roles and grants only service_role", () => {
    expect(normalizedMigration).toContain(
      "revoke all on function public.begin_infrastructure_host_discovery(text, uuid, bigint, uuid) from public, anon, authenticated",
    );
    expect(normalizedMigration).toContain(
      "grant execute on function public.begin_infrastructure_host_discovery(text, uuid, bigint, uuid) to service_role",
    );
    expect(normalizedMigration).toContain(
      "grant execute on function public.complete_infrastructure_host_discovery( text, uuid, bigint, uuid, timestamptz, timestamptz, text, jsonb ) to service_role",
    );
  });
});
