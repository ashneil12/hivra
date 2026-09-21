import fs from "node:fs";
import path from "node:path";

const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/20260915153000_hivra_private_access.sql"), "utf8");

it("stores only service-role private access observations and fences lifecycle mutations", () => {
  expect(sql).toContain("hivra_private_access_connections");
  expect(sql).toContain("enable row level security");
  expect(sql).toContain("revoke all on public.hivra_private_access_connections from public,anon,authenticated,service_role");
  expect(sql).toContain("operation_kind='private_access'");
  expect(sql).toContain("guard_hivra_private_access_lease");
  expect(sql).toContain("p_receipt ? 'authKey'");
  expect(sql).toContain("ssh_enabled=false");
});

it("binds observations to exact agent authority and supports only Tailscale", () => {
  for (const field of ["infrastructure_binding_token_hash", "infrastructure_connection_revision", "vmid", "ip"]) {
    expect(sql).toContain(field);
  }
  expect(sql).toContain("kind='tailscale'");
  expect(sql).toContain("computer_substrate is distinct from 'proxmox-kvm'");
  expect(sql).toContain("computer_profile,'ubuntu-desktop'");
});
