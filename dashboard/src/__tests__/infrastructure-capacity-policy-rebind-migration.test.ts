import { readFileSync } from "node:fs";
import { join } from "node:path";

const migration = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/20260915184000_infrastructure_capacity_policy_rebind.sql",
  ),
  "utf8",
);

describe("capacity-policy revision and rebind migration", () => {
  it("changes only capacityPolicy and creates one pending revision", () => {
    expect(migration).toContain("create or replace function public.update_infrastructure_capacity_policy");
    expect(migration).toContain("jsonb_set(");
    expect(migration).toContain("'{capacityPolicy}'");
    expect(migration).toContain("revision = revision + 1");
    expect(migration).toContain("status = 'pending'");
    expect(migration).toContain("then coalesce(pending_binding_rebind_from_revision, p_expected_revision)");
    expect(migration).toContain("last_error_code = 'PREFLIGHT_SUPERSEDED'");
  });

  it("serializes against inspection, provider operations, and uncompleted rebinds", () => {
    expect(migration).toContain("v_connection.preflight_run_id is not null");
    expect(migration).toContain("v_connection.pending_binding_rebind_from_revision is not null");
    expect(migration).toContain("from public.infrastructure_host_discovery_runs discovery_run");
    expect(migration).toContain("discovery_run.lease_expires_at > now()");
    expect(migration).toContain("agent.operation_id is not null");
  });

  it("keeps endpoint and credential identity outside the policy mutation", () => {
    const updateBody = migration.slice(
      migration.indexOf("update public.infrastructure_connections"),
      migration.indexOf("return next v_connection"),
    );
    expect(updateBody).not.toContain("ssh_host =");
    expect(updateBody).not.toContain("ssh_port =");
    expect(updateBody).not.toContain("ssh_user =");
    expect(updateBody).not.toContain("encrypted_bundle");
  });
});
