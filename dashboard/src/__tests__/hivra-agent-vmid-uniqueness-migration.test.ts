import { readFileSync } from "fs";
import path from "path";

describe("hivra agent VMID uniqueness migration", () => {
  it("guards non-deleted Hivra rows from sharing a Proxmox host VMID", () => {
    const migration = readFileSync(
      path.join(
        process.cwd(),
        "supabase/migrations/20260608124500_hivra_agents_host_vmid_unique.sql"
      ),
      "utf8"
    );

    expect(migration).toContain("hivra_agents_active_proxmox_host_vmid_idx");
    expect(migration).toContain("coalesce(nullif(proxmox_host, ''), '__legacy__')");
    expect(migration).toContain("vmid");
    expect(migration).toContain("status <> 'deleted'");
  });
});
