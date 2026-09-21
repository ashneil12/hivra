import { readFileSync } from "node:fs";
import path from "node:path";

const migration = readFileSync(path.resolve(
  __dirname,
  "../../supabase/migrations/20260901210000_hivra_remote_desktop_session_renewal.sql",
), "utf8").replace(/\s+/g, " ").toLowerCase();

describe("Hivra remote desktop rolling renewal migration", () => {
  it("keeps each lease short and caps the continuous session", () => {
    expect(migration).toContain("expires_at <= created_at + interval '12 hours'");
    expect(migration).toContain("p_ttl_seconds not between 30 and 300");
    expect(migration).toContain("v_now+make_interval(secs=>p_ttl_seconds)");
    expect(migration).toContain("s.created_at+interval '12 hours'");
  });

  it("rechecks exact active authority before renewing", () => {
    for (const boundary of [
      "s.revoked_at is not null",
      "s.input_state<>'active'",
      "s.transport<>'selkies-websocket'",
      "generation=s.capability_generation",
      "c.expires_at<=v_now+interval '30 seconds'",
      "c.supports_input_takeover",
      "hermes_instances",
      "hivra_agents",
      "controller_conflict",
    ]) expect(migration).toContain(boundary);
  });

  it("accepts only the service role and stores no browser credential", () => {
    expect(migration).toContain("renew_hivra_remote_desktop_session_by_token");
    expect(migration).toContain("revoke all on function public.renew_hivra_remote_desktop_session_by_token(text,integer) from public,anon,authenticated");
    expect(migration).toContain("grant execute on function public.renew_hivra_remote_desktop_session_by_token(text,integer) to service_role");
    expect(migration).not.toContain("p_cookie");
  });
});
