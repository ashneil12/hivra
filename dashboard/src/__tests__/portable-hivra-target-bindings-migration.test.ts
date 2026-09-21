import { readFileSync } from "node:fs";
import path from "node:path";

const migrationPath = path.resolve(
  __dirname,
  "../../supabase/migrations/20260826120000_portable_hivra_target_bindings.sql",
);

const migration = readFileSync(migrationPath, "utf8");
const normalizedMigration = migration.replace(/\s+/g, " ").toLowerCase();

describe("portable Hivra deployment-target binding migration", () => {
  it("preserves target identity and binds evidence to the checked connection revision", () => {
    expect(normalizedMigration).toContain(
      "add column if not exists evidence_connection_revision bigint",
    );
    expect(normalizedMigration).toContain(
      "constraint deployment_targets_id_connection_user_key unique (id, connection_id, user_id)",
    );
    expect(normalizedMigration).toContain(
      "on conflict (connection_id, external_id) do update",
    );
    expect(normalizedMigration).toContain(
      "evidence_connection_revision = excluded.evidence_connection_revision",
    );
    expect(normalizedMigration).not.toContain("delete from public.deployment_targets");
  });

  it("fails closed old target evidence until runtime compatibility is preflighted", () => {
    expect(normalizedMigration).toContain(
      "where not (coalesce(capabilities, '{}'::jsonb) ? 'runtimecompatibility')",
    );
    expect(normalizedMigration).toContain(
      "coalesce(capabilities #>> '{runtimecompatibility,provisionerversion}', '') <> '2026.08.26.5'",
    );
    expect(normalizedMigration).toContain(
      "coalesce(capabilities #>> '{provisioner,version}', '') <> '2026.08.26.5'",
    );
    expect(normalizedMigration).toContain(
      "'{runtimecompatibility}', 'null'::jsonb",
    );
    expect(normalizedMigration).toContain(
      "last_error_code = 'preflight_superseded'",
    );
  });

  it("makes a self-managed Hivra binding nullable for legacy rows but complete when present", () => {
    expect(normalizedMigration).toContain(
      "alter table public.hivra_agents add column if not exists infrastructure_connection_id uuid, add column if not exists deployment_target_id uuid, add column if not exists infrastructure_connection_revision bigint",
    );
    expect(normalizedMigration).toContain(
      "constraint hivra_agents_self_managed_binding_complete_check",
    );
    expect(normalizedMigration).toContain(
      "infrastructure_connection_id is null and deployment_target_id is null and infrastructure_connection_revision is null",
    );
    expect(normalizedMigration).toContain(
      "infrastructure_connection_id is not null and deployment_target_id is not null and infrastructure_connection_revision is not null and infrastructure_connection_revision > 0",
    );
  });

  it("enforces target, connection, and owner as one fail-closed foreign key", () => {
    expect(normalizedMigration).toContain(
      "constraint hivra_agents_self_managed_target_fk foreign key ( deployment_target_id, infrastructure_connection_id, user_id ) references public.deployment_targets (id, connection_id, user_id) on update restrict on delete restrict",
    );
  });

  it("scopes active VMID uniqueness independently for managed and self-managed targets", () => {
    expect(normalizedMigration).toContain(
      "drop index if exists public.hivra_agents_active_proxmox_host_vmid_idx",
    );
    expect(normalizedMigration).toContain(
      "create unique index hivra_agents_active_proxmox_host_vmid_idx",
    );
    expect(normalizedMigration).toContain(
      "deployment_target_id is null and status <> 'deleted'",
    );
    expect(normalizedMigration).toContain(
      "create unique index if not exists hivra_agents_active_self_managed_target_vmid_idx on public.hivra_agents (deployment_target_id, vmid)",
    );
    expect(normalizedMigration).toContain(
      "deployment_target_id is not null and vmid is not null and status <> 'deleted'",
    );
  });

  it("invalidates readiness in place for edit, begin, completion, and failure flows", () => {
    expect(normalizedMigration).toContain(
      "create or replace function public.update_infrastructure_connection(",
    );
    expect(normalizedMigration).toContain(
      "create or replace function public.begin_infrastructure_connection_preflight(",
    );
    expect(normalizedMigration).toContain(
      "create or replace function public.complete_infrastructure_connection_preflight(",
    );
    expect(normalizedMigration).toContain(
      "create or replace function public.invalidate_infrastructure_connection_preflight(",
    );
    expect(normalizedMigration).toContain("set status = 'unavailable'");
    expect(normalizedMigration).toContain(
      "supported_isolation_drivers = '{}'::text[], isolation_class = null",
    );
    expect(normalizedMigration).toContain(
      "'{launchready}', 'false'::jsonb",
    );
  });

  it("keeps every replaced RPC service-role only", () => {
    for (const functionName of [
      "update_infrastructure_connection",
      "begin_infrastructure_connection_preflight",
      "complete_infrastructure_connection_preflight",
      "invalidate_infrastructure_connection_preflight",
    ]) {
      expect(normalizedMigration).toContain(
        `revoke all on function public.${functionName}(`,
      );
      expect(normalizedMigration).toContain(
        `grant execute on function public.${functionName}(`,
      );
    }
  });
});
