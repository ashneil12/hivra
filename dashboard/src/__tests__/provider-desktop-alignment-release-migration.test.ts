import { readFileSync } from "node:fs";
import path from "node:path";

it("adds only the sealed alignment release without changing admission or cleanup authority", () => {
  const read = (name: string) => readFileSync(path.resolve(__dirname, "../../supabase/migrations", name), "utf8");
  const previous = read("20260905170000_provider_desktop_session_binding_release.sql");
  const current = read("20260905180000_provider_desktop_alignment_release.sql");
  expect(current.replace("2026.09.05.5 bundle", "2026.09.05.4 bundle")
    .replace(",'2026.09.05.5'", "")
    .replace("\n      or (p_identity->'bundle'->>'bundleSha256'='64f86f200ee20aa06e4ff2a56369daddd7b85a723a1688a5e113b8f16f98e596' and p_identity->'bundle'->>'provisionerVersion'='2026.09.05.5')", ""))
    .toBe(previous);
  expect(current).toContain("provisionerVersion'='2026.09.05.5'");
});
