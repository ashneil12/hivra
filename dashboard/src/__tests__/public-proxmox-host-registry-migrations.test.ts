import { readFileSync } from "node:fs";
import path from "node:path";

const migration = (name: string) => readFileSync(
  path.resolve(__dirname, "../../supabase/migrations", name),
  "utf8",
).replace(/\s+/g, " ");

describe("public Proxmox host-registry migrations", () => {
  it("create portable schema without seeding deployment-owned hosts or capacity", () => {
    const registry = migration("20260510120000_proxmox_hosts_registry.sql");
    const capacity = migration("20260512120000_proxmox_hosts_disk_capacity.sql");

    expect(registry).toContain("create table if not exists public.proxmox_hosts");
    expect(capacity).toContain("alter table public.proxmox_hosts");
    expect(registry).not.toMatch(/insert into public\.proxmox_hosts/i);
    expect(capacity).not.toMatch(/update public\.proxmox_hosts/i);
    expect(`${registry} ${capacity}`).not.toMatch(/\bpve\d+\b/i);
  });
});
