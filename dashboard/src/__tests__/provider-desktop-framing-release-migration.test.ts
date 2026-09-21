import { readFileSync } from "node:fs";
import path from "node:path";

it("adds only exact .05.7 release identities and retains .05.6 recovery authority", () => {
  const read = (name: string) => readFileSync(path.join(process.cwd(), "supabase/migrations", name), "utf8");
  const old = read("20260905200000_provider_desktop_worker_release.sql");
  const next = read("20260905230000_provider_desktop_framing_release.sql");
  const [native, desktop] = next.split("-- Retain the exact .05.6 cleanup identity; only add the sealed .05.7 pair.\n");
  expect(native.trimEnd().replace("2026.09.05.7 bundle", "2026.09.05.6 bundle").replace(",'2026.09.05.7'", "")
    .replace("\n      or (p_identity->'bundle'->>'bundleSha256'='d3631ea66b7d74084e1f29e7795f2459e6e215c4f97a6e231ccf480f3cb9ba9b' and p_identity->'bundle'->>'provisionerVersion'='2026.09.05.7')", ""))
    .toBe(old.trimEnd());
  const originalDesktop = read("20260905210000_provider_desktop_cleanup_contract.sql");
  const originalFunction = originalDesktop.slice(originalDesktop.indexOf("create function public.hivra_provider_desktop_identity_valid"), originalDesktop.indexOf("$$;") + 3);
  expect(desktop.trimEnd().replace("create or replace function", "create function")
    .replace("    and ((p_identity->'bundle'->>'bundleSha256'='1226dfc97e54f745b84b934e89246adc4453f85b3bdad1e14fc892d9ff5d1da4'\n      and p_identity->'bundle'->>'provisionerVersion'='2026.09.05.6')\n      or (p_identity->'bundle'->>'bundleSha256'='d3631ea66b7d74084e1f29e7795f2459e6e215c4f97a6e231ccf480f3cb9ba9b'\n      and p_identity->'bundle'->>'provisionerVersion'='2026.09.05.7'))",
      "    and p_identity->'bundle'->>'bundleSha256'='1226dfc97e54f745b84b934e89246adc4453f85b3bdad1e14fc892d9ff5d1da4'\n    and p_identity->'bundle'->>'provisionerVersion'='2026.09.05.6'"))
    .toBe(originalFunction);
});
