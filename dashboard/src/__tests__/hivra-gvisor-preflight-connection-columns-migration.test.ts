import { readFileSync } from "node:fs";
import { join } from "node:path";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260915190100_gvisor_preflight_connection_columns.sql"),
  "utf8",
);

describe("gVisor preflight connection columns correction migration", () => {
  it("replaces the applied RPC without writing a nonexistent lease column", () => {
    expect(migration).toContain("create or replace function public.commit_hivra_gvisor_target_preflight(");
    expect(migration).toContain("preflight_run_id=null,preflight_lease_expires_at=null");
    expect(migration).not.toMatch(/preflight_started_at\s*=/);
  });

  it("preserves owner, revision, runtime identity, rebind, and service-role fences", () => {
    expect(migration).toContain("id=p_connection_id and user_id=p_user_id and revision=p_expected_revision for update");
    expect(migration).toContain("v_connection.preflight_run_id is distinct from p_run_id");
    expect(migration).toContain("gvisor_adapter_sha256<>p_target->'capabilities'->'adapter'->>'sha256'");
    expect(migration).toContain("pending_binding_rebind_from_revision");
    expect(migration).toContain("revoke all on function public.commit_hivra_gvisor_target_preflight");
    expect(migration).toContain("grant execute on function public.commit_hivra_gvisor_target_preflight");
  });
});
