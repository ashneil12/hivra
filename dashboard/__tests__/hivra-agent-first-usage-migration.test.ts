import { readFileSync, readdirSync } from "fs";
import { join } from "path";

describe("hivra first usage schema", () => {
  it("adds a durable first_usage_at column to hivra_agents", () => {
    const migrationsDir = join(__dirname, "..", "supabase", "migrations");
    const sql = readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => readFileSync(join(migrationsDir, file), "utf8"))
      .join("\n");

    expect(sql).toMatch(/alter table public\.hivra_agents\s+add column if not exists first_usage_at timestamptz/i);
  });
});
