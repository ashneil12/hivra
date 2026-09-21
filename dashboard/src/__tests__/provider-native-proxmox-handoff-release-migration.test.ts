import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("provider native Proxmox handoff release migration", () => {
  const migration = readFileSync(join(process.cwd(), "supabase/migrations/20260902030000_provider_native_proxmox_handoff_release.sql"), "utf8");

  it("admits only the exact new immutable bundle while retaining prior releases", () => {
    expect(migration).toMatch(/'2026\.09\.01\.9',\s*'2026\.09\.02\.1'/);
    expect(migration).toContain("7122d4a6b6c0ce4e498841800ad0b372a76e57ca6d67f24245f070df7a61787c");
    expect(migration).toContain("ec0ab1faeadd46c4a21f03bde01b24e88f5d2a7e89f632b9c0e193cb51713b91");
    expect(migration).toContain("from public,anon,authenticated");
    expect(migration).toContain("to service_role");
  });
});
