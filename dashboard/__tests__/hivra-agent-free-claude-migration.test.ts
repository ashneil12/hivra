import { readFileSync, readdirSync } from "fs";
import { join } from "path";

describe("hivra free Claude resource schema", () => {
  it("allows hivra_agents.cpu to store half-core values", () => {
    const migrationsDir = join(__dirname, "..", "supabase", "migrations");
    const sql = readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => readFileSync(join(migrationsDir, file), "utf8"))
      .join("\n");

    expect(sql).toMatch(/alter table public\.hivra_agents\s+alter column cpu type numeric/i);
  });
});
