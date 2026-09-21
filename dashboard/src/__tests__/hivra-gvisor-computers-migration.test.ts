import { readFileSync } from "node:fs";
import { join } from "node:path";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/20260915170000_hivra_gvisor_computers.sql"),
  "utf8",
);

describe("gVisor computer authority migration", () => {
  it("commits readiness and a pending policy rebind in one fenced transaction", () => {
    expect(migration).toContain("commit_hivra_gvisor_target_preflight");
    expect(migration).toContain("for update;");
    expect(migration).toContain("v_connection.preflight_run_id is distinct from p_run_id");
    expect(migration).toContain("preflight_run_id=null,preflight_started_at=null,preflight_lease_expires_at=null");
    expect(migration).toContain("v_rebind_from<>p_expected_revision-1");
    expect(migration).toContain("operation_id is not null");
    expect(migration).toContain("infrastructure_connection_revision=p_expected_revision");
    expect(migration).toContain("pending_binding_rebind_from_revision=null");
    expect(migration).toContain("grant execute on function public.commit_hivra_gvisor_target_preflight");
  });

  it("requires the exact terminal-only application-kernel capability receipt", () => {
    for (const claim of [
      '"isolationClass":"application-kernel"',
      '"supportedIsolationDrivers":["gvisor-runsc"]',
      '"supportedWorkloadKinds":["linux-terminal"]',
      '"terminal":"owner-gated-command-v1"',
      '"publicPorts":false',
      '"desktop":false',
      '"windows":false',
    ]) {
      expect(migration).toContain(claim);
    }
    expect(migration).toContain("hostIdentityDigest");
    expect(migration).toContain("gVisor target identity changed");
  });

  it("retains deleted sandbox evidence and accepts rebinds only through the pending revision", () => {
    expect(migration).toContain("Retain gVisor computer lifecycle evidence");
    expect(migration).toContain("gVisor cleanup is not verified");
    expect(migration).toContain("c.pending_binding_rebind_from_revision=old.infrastructure_connection_revision");
    expect(migration).toContain("t.capabilities->'runtime'->>'sha256'=new.gvisor_runtime_sha256");
    expect(migration).toContain("new.infrastructure_connection_id is null and new.deployment_target_id is null");
    expect(migration).toContain("gvisor_cleanup_receipt->'binding'->>'connectionId'=old.infrastructure_connection_id::text");
    expect(migration).toContain("deleted gVisor computer lacks detached verified absence evidence");
  });
});
