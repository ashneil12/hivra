import { readFileSync } from "node:fs";
import path from "node:path";

const migration = readFileSync(path.resolve(
  __dirname,
  "../../supabase/migrations/20260908074000_omarchy_native_activation_grant_reader.sql",
), "utf8").replace(/\s+/g, " ").toLowerCase();

describe("Hivra Omarchy native activation grant reader migration", () => {
  it("binds the stored grant to the exact owner, session and activation", () => {
    expect(migration).toContain("g.session_id=p_session_id and g.activation_id=p_activation_id");
    expect(migration).toContain("g.user_id=p_user_id and s.user_id=p_user_id");
    expect(migration).toContain("s.native_activation_id=p_activation_id");
  });

  it("remains service-role-only", () => {
    expect(migration).toContain("revoke all on function public.load_hivra_omarchy_native_activation_grant");
    expect(migration).toContain("from public,anon,authenticated");
    expect(migration).toContain("to service_role");
  });
});
