import { readFileSync } from "node:fs";
import path from "node:path";

const migration = readFileSync(path.resolve(
  __dirname,
  "../../supabase/migrations/20260901235500_provider_desktop_timing_release.sql",
), "utf8").replace(/\s+/g, " ").toLowerCase();

describe("provider desktop timing release migration", () => {
  it("admits the exact new provider bundle without weakening prior identities", () => {
    expect(migration).toContain("'2026.09.01.8','2026.09.01.9'");
    expect(migration).toContain("bundlesha256'='d2666888d06a02ec75a8edb771e32487e57f54588d527e004bfe134dedb5d246'");
    expect(migration).toContain("provisionerversion'='2026.09.01.9'");
    expect(migration).toContain("bundlesha256'='d641a55cb724a59abf5f5453b44bd00a4078be923956b5b82f11a0fd2fbcb4e0'");
  });

  it("preserves exact owner, lease, receipt, and service-role fences", () => {
    for (const boundary of [
      "user_id=p_user_id",
      "b.lease_id is distinct from p_lease_id",
      "p_receipt is distinct from jsonb_build_object",
      "provider_retired_at is not null",
      "grant execute on function public.admit_prepared_provider_computer",
      "to service_role",
    ]) expect(migration).toContain(boundary);
    expect(migration).toContain("from public,anon,authenticated");
  });
});
