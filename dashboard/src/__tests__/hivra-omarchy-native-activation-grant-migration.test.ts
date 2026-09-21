import { readFileSync } from "node:fs";
import path from "node:path";

const migration = readFileSync(path.resolve(
  __dirname,
  "../../supabase/migrations/20260908073000_omarchy_native_activation_grant.sql",
), "utf8").replace(/\s+/g, " ").toLowerCase();

describe("Hivra Omarchy native activation grant migration", () => {
  it("persists one immutable grant behind service-role-only authority", () => {
    expect(migration).toContain("session_id uuid primary key");
    expect(migration).toContain("activation_id uuid not null unique");
    expect(migration).toContain("guardian_grant jsonb not null");
    expect(migration).toContain("enable row level security");
    expect(migration).toContain("revoke all on table public.hivra_omarchy_native_activation_grants from public,anon,authenticated");
  });

  it("binds the exact claimed session, client identity, capability and grant shape", () => {
    expect(migration).toContain("p_guardian_grant->>'leaseid' is distinct from p_activation_id::text");
    expect(migration).toContain("s.native_activation_id is distinct from p_activation_id");
    expect(migration).toContain("p_guardian_grant->>'clientcertificatepem' is distinct from s.native_client_certificate_pem");
    expect(migration).toContain("p_guardian_grant->>'observedrevision' is distinct from c.observed_revision");
    expect(migration).toContain("jsonb_object_keys(p_guardian_grant))<>18");
  });

  it("is idempotent only for byte-equivalent JSON authority and is not callable by browser roles", () => {
    expect(migration).toContain("prior.guardian_grant=p_guardian_grant");
    expect(migration).toContain("'status','operation_conflict'");
    expect(migration).toContain("revoke all on function public.record_hivra_omarchy_native_activation_grant");
    expect(migration).toContain("to service_role");
  });
});
