import { readFileSync } from "node:fs";
import path from "node:path";

const migrationPath = path.resolve(
  __dirname,
  "../../supabase/migrations/20260825170000_infrastructure_connections.sql"
);

const migration = readFileSync(migrationPath, "utf8");
const normalizedMigration = migration.replace(/\s+/g, " ").toLowerCase();
const rotationScript = readFileSync(
  path.resolve(__dirname, "../../scripts/rotate-encryption-keys.ts"),
  "utf8",
);

describe("owner-scoped infrastructure connections migration", () => {
  it("creates a Proxmox-only, self-managed connection contract with pinned SSH identity", () => {
    expect(normalizedMigration).toContain(
      "create table if not exists public.infrastructure_connections"
    );
    expect(normalizedMigration).toContain("check (provider in ('proxmox'))");
    expect(normalizedMigration).toContain("check (operating_mode in ('self-managed'))");
    expect(normalizedMigration).toContain("check (setup_mode in ('simple', 'advanced'))");
    expect(normalizedMigration).toContain("ssh_host_fingerprint_sha256 text not null");
    expect(normalizedMigration).toContain(
      "constraint infrastructure_connections_id_user_key unique (id, user_id)"
    );
  });

  it("keeps the encrypted credential bundle in a one-to-one service-role-only table", () => {
    expect(normalizedMigration).toContain(
      "create table if not exists public.infrastructure_connection_secrets"
    );
    expect(normalizedMigration).toContain("connection_id uuid primary key");
    expect(normalizedMigration).toContain("encrypted_bundle text not null");
    expect(normalizedMigration).toContain("key_version smallint not null default 1");
    expect(normalizedMigration).toContain(
      "foreign key (connection_id, user_id) references public.infrastructure_connections (id, user_id) on delete cascade"
    );
    expect(normalizedMigration).toContain(
      "alter table public.infrastructure_connection_secrets enable row level security"
    );
    expect(normalizedMigration).toContain(
      "revoke all on public.infrastructure_connection_secrets from anon, authenticated"
    );
    expect(normalizedMigration).toContain(
      "grant all on public.infrastructure_connection_secrets to service_role"
    );
    expect(normalizedMigration).not.toMatch(
      /create policy [^;]+ on public\.infrastructure_connection_secrets/
    );
    expect(normalizedMigration).not.toMatch(
      /grant [^;]+ on public\.infrastructure_connection_secrets to (anon|authenticated)/
    );
  });

  it("binds discovered deployment targets to the same owner and advertises only supported isolation", () => {
    expect(normalizedMigration).toContain(
      "create table if not exists public.deployment_targets"
    );
    expect(normalizedMigration).toContain(
      "foreign key (connection_id, user_id) references public.infrastructure_connections (id, user_id) on delete cascade"
    );
    expect(normalizedMigration).toContain(
      "supported_isolation_drivers text[] not null default '{}'::text[]"
    );
    expect(normalizedMigration).toContain(
      "supported_isolation_drivers <@ array['proxmox-kvm']::text[]"
    );
    expect(normalizedMigration).toContain(
      "check (isolation_class is null or isolation_class in ('hardware-vm'))"
    );
    expect(normalizedMigration).toContain("capacity jsonb not null default '{}'::jsonb");
    expect(normalizedMigration).toContain("capabilities jsonb not null default '{}'::jsonb");
  });

  it("uses service-role-only atomic RPCs and preflight leases for cross-table lifecycle writes", () => {
    expect(normalizedMigration).toContain(
      "revision bigint not null default 1 check (revision > 0)"
    );
    expect(normalizedMigration).toContain("preflight_run_id uuid");
    expect(normalizedMigration).toContain(
      "create or replace function public.create_infrastructure_connection("
    );
    expect(normalizedMigration).toContain(
      "create or replace function public.update_infrastructure_connection("
    );
    expect(normalizedMigration).toContain(
      "create or replace function public.begin_infrastructure_connection_preflight("
    );
    expect(normalizedMigration).toContain(
      "create or replace function public.complete_infrastructure_connection_preflight("
    );
    expect(normalizedMigration).toContain(
      "and preflight_run_id = p_run_id for update"
    );
    expect(normalizedMigration).toContain(
      "revision = case when p_operational_change then revision + 1 else revision end"
    );
    expect(normalizedMigration).toContain(
      "set display_name = left(v_connection.name || ' / ' || external_id, 128)"
    );
    expect(normalizedMigration).toContain(
      "revoke all on function public.complete_infrastructure_connection_preflight("
    );
    expect(normalizedMigration).toContain("from public, anon, authenticated");
    expect(normalizedMigration).toContain(
      "grant execute on function public.complete_infrastructure_connection_preflight("
    );
    expect(normalizedMigration).toContain("to service_role");
  });

  it("rotates large encrypted SSH bundles with a body-based database CAS", () => {
    expect(normalizedMigration).toContain(
      "create or replace function public.rotate_infrastructure_connection_secret("
    );
    expect(normalizedMigration).toContain(
      "and encrypted_bundle = p_expected_encrypted_bundle"
    );
    expect(rotationScript).toContain(
      'this.supabase.rpc(\n      "rotate_infrastructure_connection_secret"',
    );
    expect(rotationScript).toContain(
      "p_expected_encrypted_bundle: expectedEncryptedBundle",
    );
    expect(rotationScript).not.toContain('.eq("encrypted_bundle", expectedEncryptedBundle)');
  });

  it("exposes only owner-scoped reads for non-secret metadata", () => {
    expect(normalizedMigration).toContain(
      'create policy "users can view own infrastructure connections"'
    );
    expect(normalizedMigration).toContain(
      'create policy "users can view own deployment targets"'
    );
    expect(normalizedMigration).toContain(
      "using ((select public.requesting_user_id()) = user_id)"
    );
    expect(normalizedMigration).toContain(
      "grant select on public.infrastructure_connections to authenticated"
    );
    expect(normalizedMigration).toContain(
      "grant select on public.deployment_targets to authenticated"
    );
  });

  it("does not alter either agent lifecycle table in this milestone", () => {
    expect(normalizedMigration).not.toContain("alter table public.hivra_agents");
    expect(normalizedMigration).not.toContain("alter table public.hermes_instances");
  });
});
