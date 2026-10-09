import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// The SEO engine (Search Console pull, index coverage, page inventory) is live on
// production today. A release that drops these crons silently stops SEO data.
const root = path.resolve(__dirname, "../../..");
const crons: { path: string; schedule: string }[] = JSON.parse(
  readFileSync(path.join(root, "vercel.json"), "utf8"),
).crons;

describe("SEO engine crons", () => {
  const required = ["gsc-pull", "inventory-check", "index-coverage"];
  it.each(required)("registers /api/cron/seo/%s and ships its route", (name) => {
    expect(crons.some((c) => c.path === `/api/cron/seo/${name}`)).toBe(true);
    expect(existsSync(path.join(root, `src/app/api/cron/seo/${name}/route.ts`))).toBe(true);
  });

  it("ships the migrations that create the seo_* tables", () => {
    for (const f of ["20260715120000_seo_engine.sql", "20260724120000_seo_index_coverage.sql"]) {
      expect(existsSync(path.join(root, "supabase/migrations", f))).toBe(true);
    }
  });
});
