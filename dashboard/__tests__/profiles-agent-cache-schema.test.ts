import fs from "node:fs";
import path from "node:path";

const MIGRATION = path.resolve(
  __dirname,
  "../supabase/migrations/20260520143000_profiles_agent_cache_schema.sql"
);

function readMigration() {
  return fs.readFileSync(MIGRATION, "utf8").toLowerCase();
}

describe("profiles agent cache schema", () => {
  it("adds the columns live profile restore paths read and write", () => {
    const sql = readMigration();

    for (const column of [
      "instance_id uuid",
      "name text",
      "display_name text",
      "model text",
      "provider text",
      "system_prompt text",
      "gateway_port integer",
      "status text not null default 'running'",
      "created_at timestamptz not null default now()",
      "updated_at timestamptz not null default now()",
    ]) {
      expect(sql).toContain(`add column if not exists ${column}`);
    }
  });

  it("keeps profile upserts and live gateway route lookups indexed", () => {
    const sql = readMigration();

    expect(sql).toContain("profiles_instance_name_idx");
    expect(sql).toContain("on public.profiles (instance_id, name)");
    expect(sql).toContain("profiles_gateway_routes_idx");
    expect(sql).toContain("where gateway_port is not null");
  });

  it("keeps browser access user-scoped while allowing service-role operations", () => {
    const sql = readMigration();

    expect(sql).toContain("alter table public.profiles enable row level security");
    expect(sql).toContain("users manage own profiles");
    expect(sql).toContain("public.requesting_user_id() = user_id");
    expect(sql).toContain("service role full access profiles");
    expect(sql).toContain("revoke all on public.profiles from anon");
  });
});
