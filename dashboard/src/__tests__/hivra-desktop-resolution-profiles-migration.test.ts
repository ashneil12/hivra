import { readFileSync } from "node:fs";
import path from "node:path";

const migration = readFileSync(path.resolve(
  __dirname,
  "../../supabase/migrations/20260909160000_desktop_resolution_profiles.sql",
), "utf8").replace(/\s+/g, " ").toLowerCase();

describe("Hivra desktop resolution profiles migration", () => {
  it("keeps HQ as the existing default while admitting QHD and explicit 4K", () => {
    expect(migration).toContain("check (streaming_mode in ('hq','qhd','uhd','performance'))");
    expect(migration).toContain("p_streaming_mode not in (''hq'',''qhd'',''uhd'',''performance'')");
    expect(migration).not.toContain("default 'uhd'");
  });

  it("fails rather than silently leaving the issue function stale", () => {
    expect(migration).toContain("desktop_streaming_mode_validator_not_found");
    expect(migration).toContain("pg_get_functiondef");
  });
});
