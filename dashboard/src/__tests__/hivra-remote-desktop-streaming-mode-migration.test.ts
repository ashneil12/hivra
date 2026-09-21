import { readFileSync } from "node:fs";
import path from "node:path";

const migration = readFileSync(path.resolve(
  __dirname,
  "../../supabase/migrations/20260908050000_remote_desktop_streaming_mode.sql",
), "utf8").replace(/\s+/g, " ").toLowerCase();

describe("Hivra remote desktop streaming mode migration", () => {
  it("keeps existing sessions HQ-first and accepts only the two product modes", () => {
    expect(migration).toContain("streaming_mode text not null default 'hq'");
    expect(migration).toContain("check (streaming_mode in ('hq','performance'))");
    expect(migration).toContain("p_streaming_mode not in ('hq','performance')");
  });

  it("serializes the mode with issue and returns the bound choice", () => {
    expect(migration).toContain("issue_hivra_remote_desktop_session_v2");
    expect(migration).toContain("relay_credential_expires_at,streaming_mode");
    expect(migration).toContain("'streamingmode',p_streaming_mode");
    expect(migration).toContain("pg_advisory_xact_lock");
  });

  it("keeps the new authority service-role-only", () => {
    expect(migration).toContain("revoke all on function public.issue_hivra_remote_desktop_session_v2(");
    expect(migration).toContain("from public,anon,authenticated");
    expect(migration).toContain("grant execute on function public.issue_hivra_remote_desktop_session_v2(");
    expect(migration).toContain("to service_role");
  });
});
