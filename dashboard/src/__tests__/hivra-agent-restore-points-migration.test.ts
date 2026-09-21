import fs from "node:fs";
import path from "node:path";

const sql = fs.readFileSync(
  path.join(process.cwd(), "supabase/migrations/20260830180000_hivra_agent_restore_points.sql"),
  "utf8",
);

describe("Hivra agent restore-point authority migration", () => {
  it("binds each restore point to exact provider and infrastructure identity", () => {
    expect(sql).toContain("source_binding_token_hash text not null");
    expect(sql).toContain("source_connection_revision bigint null");
    expect(sql).toContain("source_vmid integer not null");
    expect(sql).toContain("source_cpu numeric not null");
    expect(sql).toContain("source_ram integer not null");
    expect(sql).toContain("unique (agent_id, provider_snapshot_id)");
    expect(sql).toContain("where id = p_snapshot_id and user_id = p_user_id and agent_id = p_agent_id");
    expect(sql).toContain("v_snapshot.source_deployment_mode <> v_agent.deployment_mode");
    expect(sql).toContain("v_snapshot.source_proxmox_host <> v_agent.proxmox_host");
    expect(sql).toContain("v_snapshot.source_connection_id is distinct from v_agent.infrastructure_connection_id");
    expect(sql).toContain("v_snapshot.source_target_id is distinct from v_agent.deployment_target_id");
    expect(sql).toContain("v_snapshot.source_connection_revision is distinct from v_agent.infrastructure_connection_revision");
    expect(sql).toContain("v_snapshot.source_binding_token_hash <> v_agent.infrastructure_binding_token_hash");
    expect(sql).toContain("v_snapshot.source_vmid <> v_agent.vmid");
  });

  it("serializes snapshot and restore through the existing lifecycle operation lease", () => {
    expect(sql).toMatch(/'snapshot',\s*\n\s*'restore', 'delete'/);
    expect(sql).toContain("public.claim_hivra_agent_operation(");
    expect(sql).toContain("'snapshot',");
    expect(sql).toContain("'restore',");
    expect(sql).toContain("or v_agent.operation_id is not null");
  });

  it("makes restore completion atomic with the selected durable snapshot", () => {
    expect(sql).toContain("complete_hivra_agent_snapshot_restore");
    expect(sql).toContain("snapshot_config_sha256 = p_snapshot_config_sha256");
    expect(sql).toContain("restore_count = restore_count + 1");
    expect(sql).toContain("v_snapshot.source_cpu, v_snapshot.source_ram");
  });

  it("marks restore points deleted only after exact VM cleanup completes", () => {
    const deleteFunction = sql.slice(sql.indexOf("create or replace function public.complete_hivra_agent_delete"));
    expect(deleteFunction).toContain("if v_updated then");
    expect(deleteFunction).toContain("update public.hivra_agent_snapshots");
    expect(deleteFunction).toContain("set status = 'deleted', deleted_at = now()");
  });

  it("exposes owner read-only metadata and keeps mutation RPCs service-role-only", () => {
    expect(sql).toContain("for select\n  to authenticated");
    expect(sql).toContain("current_setting('request.jwt.claims', true)::json ->> 'sub'");
    expect(sql).toContain("revoke all on table public.hivra_agent_snapshots from anon, authenticated");
    expect(sql).toContain("grant execute on function public.begin_hivra_agent_snapshot");
    expect(sql).toContain("to service_role");
  });
});
