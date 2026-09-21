import { readFileSync } from "node:fs";
import { join } from "node:path";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260915190000_gvisor_preflight_external_id_text.sql"),
  "utf8",
);

describe("gVisor preflight external ID correction migration", () => {
  it("replaces the applied RPC and matches the extracted text value", () => {
    expect(migration).toContain("create or replace function public.commit_hivra_gvisor_target_preflight(");
    expect(migration).toContain("p_target->>'externalId' !~ '^gvisor-[0-9a-f]{24}$'");
    expect(migration).not.toMatch(/p_target->'externalId'\s*!~/);
    expect(migration).toContain("p_target->>'externalId' <> ('gvisor-' || left(");
  });

  it("preserves the owner, run, revision, and service-role fences", () => {
    expect(migration).toContain("id=p_connection_id and user_id=p_user_id and revision=p_expected_revision for update");
    expect(migration).toContain("v_connection.preflight_run_id is distinct from p_run_id");
    expect(migration).toContain("preflight_run_id=null,preflight_started_at=null,preflight_lease_expires_at=null");
    expect(migration).toContain("revoke all on function public.commit_hivra_gvisor_target_preflight");
    expect(migration).toContain("grant execute on function public.commit_hivra_gvisor_target_preflight");
  });
});
