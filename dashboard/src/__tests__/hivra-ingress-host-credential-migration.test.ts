import fs from "node:fs";
import path from "node:path";

const dir = path.join(process.cwd(), "supabase/migrations");
const name = "20261113120000_hivra_ingress_host_credential.sql";
const sql = fs.readFileSync(path.join(dir, name), "utf8");
const code = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

it("comes after the host ingress migrations it builds on", () => {
  const earlier = fs.readdirSync(dir).filter((f) => f.endsWith(".sql") && f < name);
  expect(earlier).toContain("20261113102000_hivra_wake_foundation.sql");
  expect(earlier).toContain("20261113111000_provider_release_admission_2026_11_13_2.sql");
});

it("stores no credential, only the generation, and keeps the nonce table service-role only", () => {
  expect(code).toContain("add column if not exists ingress_credential_generation bigint not null default 0");
  expect(code).not.toMatch(/\b(credential|secret|token)\s+(text|bytea|jsonb)/);
  expect(code).toContain("create table if not exists public.hivra_ingress_host_nonces");
  expect(code).toContain("alter table public.hivra_ingress_host_nonces enable row level security");
  expect(code).toContain("revoke all on public.hivra_ingress_host_nonces from public, anon, authenticated");
  expect(code).not.toMatch(/create policy/i);
  expect(code).not.toMatch(/create index (?!if not exists)/i);
});

it("refuses a negative generation and a malformed nonce, and drops nonces with their host", () => {
  expect(code).toContain("check (ingress_credential_generation >= 0) not valid");
  expect(code).toContain("validate constraint proxmox_hosts_ingress_credential_generation_check");
  expect(code).toContain("nonce       text not null check (nonce ~ '^[A-Za-z0-9_-]{16,64}$')");
  expect(code).toContain("primary key (host_id, nonce)");
  expect(code).toMatch(/host_id\s+text not null references public\.proxmox_hosts\(id\) on update cascade on delete cascade/);
});
