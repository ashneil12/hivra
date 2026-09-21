import { readFileSync } from "node:fs";
import path from "node:path";

it("adds the sealed worker release without enabling desktop dispatch or changing cleanup authority", () => {
  const read = (name: string) => readFileSync(path.resolve(__dirname, "../../supabase/migrations", name), "utf8");
  const previous = read("20260905180000_provider_desktop_alignment_release.sql");
  const current = read("20260905200000_provider_desktop_worker_release.sql");
  expect(current.replace("2026.09.05.6 bundle", "2026.09.05.5 bundle")
    .replace(",'2026.09.05.6'", "")
    .replace("\n      or (p_identity->'bundle'->>'bundleSha256'='1226dfc97e54f745b84b934e89246adc4453f85b3bdad1e14fc892d9ff5d1da4' and p_identity->'bundle'->>'provisionerVersion'='2026.09.05.6')", ""))
    .toBe(previous);
});
