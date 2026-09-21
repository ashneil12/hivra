import fs from "node:fs";
import path from "node:path";

const migration = fs.readFileSync(path.join(process.cwd(),
  "supabase/migrations/20260908110000_desktop_prepare_profiles.sql"), "utf8");

describe("desktop preparation profile admission migration", () => {
  it("admits only the three implemented computer profiles into the durable preparation lease", () => {
    expect(migration).toContain("create or replace function public.begin_hivra_desktop_prepare");
    expect(migration).toContain("not in ('ubuntu-desktop','omarchy','windows')");
    expect(migration).toContain("a.infrastructure_binding_token_enforced is distinct from true");
    expect(migration).toContain("grant execute on function public.begin_hivra_desktop_prepare(text,uuid,uuid,jsonb) to service_role");
  });
});
