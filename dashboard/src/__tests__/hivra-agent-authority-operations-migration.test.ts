import { readFileSync } from "node:fs";
import path from "node:path";

const migrationPath = path.resolve(
  __dirname,
  "../../supabase/migrations/20260826130000_hivra_agent_authority_operations.sql",
);
const migration = readFileSync(migrationPath, "utf8");
const sql = migration.replace(/\s+/g, " ").toLowerCase();

describe("Hivra agent authority operation migration", () => {
  it("makes the agent table service-role-only in the exposed public schema", () => {
    expect(sql).toContain("alter table public.hivra_agents enable row level security");
    expect(sql).toContain(
      "revoke all on table public.hivra_agents from public, anon, authenticated",
    );
    expect(sql).toContain("grant all on table public.hivra_agents to service_role");
  });

  it("persists explicit mode, desired state, and an all-or-none operation lease", () => {
    expect(sql).toContain("add column if not exists deployment_mode text");
    expect(sql).toContain("alter column deployment_mode set not null");
    expect(sql).toContain("deployment_mode in ('hivra-managed', 'self-managed')");
    expect(sql).toContain("add column if not exists desired_state text");
    expect(sql).toContain("add column if not exists operation_id uuid");
    expect(sql).toContain("add column if not exists operation_payload jsonb");
    expect(sql).toContain("constraint hivra_agents_operation_shape_check");
    expect(sql).toContain("alter column deployment_mode set default 'hivra-managed'");
    expect(sql).toContain("a_hivra_agents_operation_compatibility");
    expect(sql).toContain("old.status in ('running', 'stopped', 'error')");
    expect(sql).toContain("new.status = 'provisioning'");
    expect(sql).toContain("old.operation_kind in ('provision', 'start', 'restart', 'resize')");
    expect(sql).toContain("old.desired_state = 'deleted' and new.status <> 'deleted'");
    expect(sql.match(/jsonb_build_object\('compatibility', 'n_minus_one'\)/g)).toHaveLength(3);
  });

  it("uses the N-1 rollback sentinel and enforces the mode-binding matrix", () => {
    expect(sql).toContain("__hivra_self_managed_no_ambient_authority__");
    expect(sql).toContain("constraint hivra_agents_deployment_authority_matrix_check");
    expect(sql).toContain("create trigger hivra_agents_deployment_authority_guard");
    expect(sql).toContain("for key share");
    expect(sql).toContain("v_connection_revision <> new.infrastructure_connection_revision");
    expect(sql).toContain("v_target_revision <> new.infrastructure_connection_revision");
    expect(sql).toContain("add column if not exists infrastructure_binding_token_hash text");
    expect(sql).toContain("infrastructure_binding_token_enforced");
  });

  it("provides service-only claim, checkpoint, completion, and delete CAS functions", () => {
    for (const name of [
      "claim_hivra_agent_operation",
      "request_hivra_agent_delete",
      "checkpoint_hivra_agent_operation",
      "claim_hivra_agent_operation_recovery",
      "persist_hivra_agent_provision_identity",
      "complete_hivra_agent_operation",
      "continue_hivra_agent_operation",
      "complete_hivra_agent_running",
      "release_hivra_agent_operation",
      "record_hivra_agent_operation_failure",
      "complete_hivra_agent_delete",
    ]) {
      expect(sql).toContain(`create or replace function public.${name}(`);
      expect(sql).toContain(`revoke all on function public.${name}(`);
      expect(sql).toContain(`grant execute on function public.${name}(`);
    }
    expect(sql).toContain("set desired_state = 'deleted'");
    expect(sql).toContain("and operation_id = p_operation_id");
    expect(sql).toContain("p_expected_operation_started_at + interval '10 minutes'");
    expect(sql).toContain("and operation_started_at = p_expected_operation_started_at");
  });

  it("retains an active provision lease when delete arrives before allocation receipt", () => {
    const requestDelete = sql.slice(
      sql.indexOf("create or replace function public.request_hivra_agent_delete("),
      sql.indexOf("create or replace function public.checkpoint_hivra_agent_operation("),
    );
    const activeLeaseBranch = requestDelete.slice(
      requestDelete.indexOf("if v_agent.operation_id is not null then"),
      requestDelete.indexOf("end if;", requestDelete.indexOf("if v_agent.operation_id is not null then")),
    );
    expect(activeLeaseBranch).toContain("set desired_state = 'deleted'");
    expect(activeLeaseBranch).toContain("return 'pending'");
    expect(activeLeaseBranch).not.toContain("operation_id = p_operation_id");
  });

  it("blocks authority rotation while a live portable binding exists", () => {
    expect(sql).toContain("if p_operational_change and exists (");
    expect(sql).toContain("infrastructure_connection_id = p_connection_id");
    expect(sql).toContain("deployment_mode = 'self-managed'");
    expect(sql).toContain("status <> 'deleted'");
    expect(sql).toContain("using errcode = '55006'");
  });

  it("releases provider bindings only through verified delete completion", () => {
    const completeDelete = sql.slice(
      sql.indexOf("create or replace function public.complete_hivra_agent_delete("),
      sql.indexOf("create or replace function public.update_infrastructure_connection("),
    );
    expect(completeDelete).toContain("and operation_id = p_operation_id");
    expect(completeDelete).toContain("and operation_kind in ('delete', 'provision')");
    expect(completeDelete).toContain("and desired_state = 'deleted'");
    expect(completeDelete).toContain("infrastructure_connection_id = null");
    expect(completeDelete).toContain("deployment_target_id = null");
    expect(completeDelete).toContain("infrastructure_connection_revision = null");
    expect(completeDelete).toContain("allocation_operation_id = null");
  });

  it("serializes preparation, preflight, update, and delete authority", () => {
    expect(sql).toContain("create or replace function public.begin_infrastructure_connection_preparation(");
    expect(sql).toContain("preflight_lease_expires_at = p_started_at + interval '10 minutes'");
    expect(sql).toContain("v_connection.preflight_run_id <> p_run_id");
    expect(sql).toContain("create or replace function public.recover_expired_infrastructure_connection_run(");
    expect(sql).toContain("and preflight_run_id = p_expected_run_id");
    expect(sql).toContain("and preflight_lease_expires_at < p_recovered_at");
    expect(sql).toContain("create or replace function public.delete_infrastructure_connection(");
    expect(sql).toContain("if v_connection.preflight_run_id is not null then return 'blocked'");
    expect(
      sql.match(/v_connection\.preflight_lease_expires_at >= p_started_at/g),
    ).toHaveLength(2);
    expect(
      sql.match(/preflight_lease_expires_at = p_started_at \+ interval '10 minutes'/g),
    ).toHaveLength(2);
  });

  it.each([
    ["preparation", "begin_infrastructure_connection_preparation", "begin_infrastructure_connection_preflight"],
    ["preflight", "begin_infrastructure_connection_preflight", "invalidate_infrastructure_connection_preflight"],
  ])("lets N-1 %s replace only a definitively expired foreign lease under the connection lock", (_label, name, nextName) => {
    const begin = sql.slice(
      sql.indexOf(`create or replace function public.${name}(`),
      sql.indexOf(`create or replace function public.${nextName}(`),
    );
    expect(begin).toContain("for update");
    expect(begin).toContain("v_connection.preflight_run_id <> p_run_id");
    expect(begin).toContain("v_connection.preflight_lease_expires_at is null");
    expect(begin).toContain("v_connection.preflight_lease_expires_at >= p_started_at");
    expect(begin).toContain("return false");
    expect(begin).toContain("preflight_run_id = p_run_id");
    expect(begin).toContain("preflight_lease_expires_at = p_started_at + interval '10 minutes'");
    expect(begin).toContain("set status = 'unavailable'");
    expect(begin).toContain("'{launchready}'");
  });

  it("atomically resets desired state when stale lifecycle evidence proves the old provider state", () => {
    const complete = sql.slice(
      sql.indexOf("create or replace function public.complete_hivra_agent_operation("),
      sql.indexOf("create or replace function public.continue_hivra_agent_operation("),
    );
    expect(complete).toContain("when p_status = 'running' then 'running'");
    expect(complete).toContain("when p_status = 'stopped' then 'stopped'");
    expect(complete).toContain("or (p_cpu is null and p_ram is null)");
    expect(complete).toContain("(operation_payload ->> 'cpu')::numeric = p_cpu");
  });

  it("supports credential-only bound recovery and atomic post-preflight rebind", () => {
    expect(sql).toContain("create or replace function public.recover_infrastructure_connection_credentials(");
    expect(sql).toContain("pending_binding_rebind_from_revision");
    expect(sql).toContain("and operation_id is not null");
    expect(sql).toContain("operation_started_at > now() - interval '10 minutes'");
    expect(sql).toContain("infrastructure connection has a fresh hivra operation");
    expect(sql).toContain("coalesce(pending_binding_rebind_from_revision, p_expected_revision)");
    expect(sql).toContain("set infrastructure_connection_revision = p_expected_revision");
    expect(sql).toContain("not all hivra bindings could be rebound safely");
    const authorityGuard = sql.slice(
      sql.indexOf("create or replace function public.enforce_hivra_agent_deployment_authority("),
      sql.indexOf("create or replace function public.claim_hivra_agent_operation("),
    );
    expect(authorityGuard).toContain("v_credential_recovery_completion");
    expect(authorityGuard).toContain("old.operation_id is not null");
    expect(authorityGuard).toContain("new.operation_id is null and new.operation_kind is null");
    expect(authorityGuard).toContain("v_connection_pending_rebind_from_revision = old.infrastructure_connection_revision");
    expect(authorityGuard).toContain("v_connection_revision > old.infrastructure_connection_revision");
    expect(authorityGuard).toContain("v_target_revision <> old.infrastructure_connection_revision");
  });

  it("refuses preflight invalidation underneath an active agent operation", () => {
    const invalidate = sql.slice(
      sql.indexOf("create or replace function public.invalidate_infrastructure_connection_preflight("),
      sql.indexOf("create or replace function public.recover_expired_infrastructure_connection_run("),
    );
    expect(invalidate).toContain("operation_id is not null");
    expect(invalidate).toContain("return false");
    expect(invalidate).toContain("and preflight_run_id is null");
    expect(invalidate).toContain("for update");
  });

  it("stores allocation ownership only for provider-tag-enforced rows", () => {
    const persistIdentity = sql.slice(
      sql.indexOf("create or replace function public.persist_hivra_agent_provision_identity("),
      sql.indexOf("create or replace function public.complete_hivra_agent_operation("),
    );
    expect(persistIdentity).toContain("when infrastructure_binding_token_enforced then p_operation_id");
    expect(persistIdentity).toContain("else null");
    expect(persistIdentity).toContain("desired_state in ('running', 'deleted')");
  });
});
