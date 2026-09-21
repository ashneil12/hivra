import { readFileSync } from "node:fs";
import path from "node:path";

const readMigration = (name: string) => readFileSync(path.resolve(
  __dirname,
  `../../supabase/migrations/${name}`,
), "utf8");
const previous = readMigration("20260905130000_provider_desktop_special_modes_release.sql");
const current = readMigration("20260905160000_provider_desktop_symlink_identity_release.sql");
const normalized = current
  .replace("2026.09.05.3 bundle", "2026.09.05.2 bundle")
  .replace(",'2026.09.05.3'", "")
  .replace("\n      or (p_identity->'bundle'->>'bundleSha256'='523d59b6e8f89a490558bedd229125e949119b4969b5233e0e12408156fdd269' and p_identity->'bundle'->>'provisionerVersion'='2026.09.05.3')", "");

describe("provider desktop symlink-identity release migration", () => {
  it("changes only the exact new immutable release identity", () => {
    expect(normalized).toBe(previous);
    expect(current).toContain("'2026.09.05.1','2026.09.05.2','2026.09.05.3'");
    expect(current).toContain("bundleSha256'='391a7ea9b299c01b65b2765824760af3d6a813aa2ae44f129dd9ffb660041b41'");
    expect(current).toContain("bundleSha256'='523d59b6e8f89a490558bedd229125e949119b4969b5233e0e12408156fdd269'");
    expect(current).toContain("provisionerVersion'='2026.09.05.3'");
  });

  it("retains owner, lease, receipt, native-cleanup, null, and service-role fences", () => {
    for (const boundary of [
      "user_id=p_user_id",
      "b.lease_id is distinct from p_lease_id",
      "p_receipt is distinct from jsonb_build_object",
      "provider_retired_at is not null",
      "nativeCleanup'->>'closureSha256'='ec0ab1faeadd46c4a21f03bde01b24e88f5d2a7e89f632b9c0e193cb51713b91'",
      ") is true",
      "from public,anon,authenticated",
      "to service_role",
    ]) expect(current).toContain(boundary);
  });
});
