import { readFileSync } from "node:fs";
import path from "node:path";

const migration = readFileSync(path.resolve(
  __dirname,
  "../../supabase/migrations/20260905110000_provider_desktop_workspace_identity_release.sql",
), "utf8").replace(/\s+/g, " ").toLowerCase();

describe("provider desktop workspace identity release migration", () => {
  it("admits only the exact new immutable bundle while retaining its predecessor", () => {
    expect(migration).toContain("'2026.09.04.4','2026.09.05.1'");
    expect(migration).toContain("bundlesha256'='b9ae70bf6469b3c0c726616f7103d7ab809730ab84726a0b7a4a37b2680622a6'");
    expect(migration).toContain("provisionerversion'='2026.09.04.4'");
    expect(migration).toContain("bundlesha256'='38d91e8f2077f0044beaec57d1846943379a1291225cc2992e71064f63364c93'");
    expect(migration).toContain("provisionerversion'='2026.09.05.1'");
  });

  it("preserves owner, lease, receipt, native-cleanup, and service-role fences", () => {
    for (const boundary of [
      "user_id=p_user_id",
      "b.lease_id is distinct from p_lease_id",
      "p_receipt is distinct from jsonb_build_object",
      "provider_retired_at is not null",
      "nativecleanup'->>'closuresha256'='ec0ab1faeadd46c4a21f03bde01b24e88f5d2a7e89f632b9c0e193cb51713b91'",
      "grant execute on function public.admit_prepared_provider_computer",
      "grant execute on function public.hivra_provider_native_identity_valid",
      "to service_role",
    ]) expect(migration).toContain(boundary);
    expect(migration).toContain("from public,anon,authenticated");
  });
});
