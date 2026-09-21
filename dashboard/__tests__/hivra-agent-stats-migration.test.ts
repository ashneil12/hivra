import fs from "node:fs";
import path from "node:path";

const migrationsDir = path.resolve(__dirname, "../supabase/migrations");

function readMigration(version: string): string {
  return fs.readFileSync(
    path.join(
      migrationsDir,
      version === "20260607100000"
        ? `${version}_include_hivra_agents_in_stats.sql`
        : `${version}_public_stats_optional_operator_usage.sql`,
    ),
    "utf8",
  );
}

describe("Hivra agent stats migration", () => {
  const migration = () => readMigration("20260607100000");

  it("counts provisioned Hivra agents in the public deployed-agent RPC", () => {
    const sql = migration();

    expect(sql).toContain("create or replace function public.get_agents_deployed_stats");
    expect(sql).toContain("create or replace function public.hivra_agents_deployed_between");
    expect(sql).toContain("provisioned_at is not null");
    expect(sql).toContain("'hivraAgents', v_hivra_total");
    expect(sql).toContain("public.hivra_agents_deployed_between(v_now - interval '24 hours', v_now)");
    expect(sql).toContain("public.hivra_agents_deployed_between(v_now - interval '7 days', v_now)");
    expect(sql).toContain("public.hivra_agents_deployed_between(d, d + interval '1 day')");
  });

  it("keeps public and platform stat counters aligned with Hivra agents", () => {
    const sql = migration();

    expect(sql).toContain("create or replace function public.get_public_stats");
    expect(sql).toContain("create or replace function public.get_platform_stats");
    expect(sql).toContain("create or replace function public.compute_platform_stats_snapshot");
    expect(sql).toContain("public.hivra_agents_deployed_before(null)");
    expect(sql).toContain("public.hivra_agents_deployed_before(d_end)");
    expect(sql).toContain("public.hivra_agents_running_now()");
  });

  it("backfills already-running Hivra agents that predate the stats fix", () => {
    const sql = migration();

    expect(sql).toContain("update public.hivra_agents");
    expect(sql).toContain("set provisioned_at = coalesce(provisioned_at, created_at)");
    expect(sql).toContain("status in ('running', 'stopped', 'deleted')");
  });

  it("keeps public stats working when operator usage telemetry is not installed", () => {
    const sql = readMigration("20260607103000");

    expect(sql).toContain("create or replace function public.get_public_stats");
    expect(sql).toContain("to_regprocedure('public.operator_usage_tokens_total()')");
    expect(sql).toContain("to_regclass('public.operator_usage_snapshots')");
    expect(sql).toContain("public.hivra_agents_deployed_before(null)");
    expect(sql).toContain("public.hivra_agents_running_now()");
  });
});
