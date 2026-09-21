import { readFileSync } from "node:fs";
import path from "node:path";

const migration = readFileSync(path.resolve(
  __dirname,
  "../../supabase/migrations/20260908063000_native_desktop_client_identity.sql",
), "utf8").replace(/\s+/g, " ").toLowerCase();

describe("Hivra native desktop client identity migration", () => {
  it("binds only a complete public Moonlight identity to Sunshine", () => {
    expect(migration).toContain("native_profile_bound boolean not null default false");
    expect(migration).toContain("transport='sunshine-moonlight'");
    expect(migration).toContain("native_client_certificate_sha256 ~ '^[a-f0-9]{64}$'");
    expect(migration).toContain("octet_length(native_client_certificate_pem) between 64 and 16384");
  });

  it("validates before atomically wrapping the existing issue authority", () => {
    const validation = migration.indexOf("return jsonb_build_object('status','invalid_request')");
    const issue = migration.indexOf("issue_hivra_remote_desktop_session_v2(");
    const bind = migration.indexOf("native_profile_bound=true", issue);
    expect(validation).toBeGreaterThan(0);
    expect(issue).toBeGreaterThan(validation);
    expect(bind).toBeGreaterThan(issue);
    expect(migration).toContain("nativeclientcertificatesha256',p_native_client_certificate_sha256");
  });

  it("keeps v3 service-role-only", () => {
    expect(migration).toContain("revoke all on function public.issue_hivra_remote_desktop_session_v3(");
    expect(migration).toContain("from public,anon,authenticated");
    expect(migration).toContain("grant execute on function public.issue_hivra_remote_desktop_session_v3(");
    expect(migration).toContain("to service_role");
  });
});
