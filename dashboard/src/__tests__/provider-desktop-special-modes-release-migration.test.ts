import { readFileSync } from "node:fs";
import path from "node:path";

const migration = readFileSync(path.resolve(
  __dirname,
  "../../supabase/migrations/20260905130000_provider_desktop_special_modes_release.sql",
), "utf8").replace(/\s+/g, " ").toLowerCase();

describe("provider desktop special-mode release migration", () => {
  it("admits only the exact new immutable bundle while retaining its predecessor", () => {
    expect(migration).toContain("'2026.09.04.4','2026.09.05.1','2026.09.05.2'");
    expect(migration).toContain("bundlesha256'='38d91e8f2077f0044beaec57d1846943379a1291225cc2992e71064f63364c93'");
    expect(migration).toContain("provisionerversion'='2026.09.05.1'");
    expect(migration).toContain("bundlesha256'='391a7ea9b299c01b65b2765824760af3d6a813aa2ae44f129dd9ffb660041b41'");
    expect(migration).toContain("provisionerversion'='2026.09.05.2'");
  });

  it("preserves owner, lease, receipt, native-cleanup, null, and service-role fences", () => {
    for (const boundary of [
      "user_id=p_user_id",
      "b.lease_id is distinct from p_lease_id",
      "p_receipt is distinct from jsonb_build_object",
      "provider_retired_at is not null",
      "nativecleanup'->>'closuresha256'='ec0ab1faeadd46c4a21f03bde01b24e88f5d2a7e89f632b9c0e193cb51713b91'",
      ") is true",
      "grant execute on function public.admit_prepared_provider_computer",
      "grant execute on function public.hivra_provider_native_identity_valid",
      "to service_role",
    ]) expect(migration).toContain(boundary);
    expect(migration).toContain("from public,anon,authenticated");
  });
});
