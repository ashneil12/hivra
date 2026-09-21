import { readFileSync } from "node:fs";
import path from "node:path";

const migration = readFileSync(
  path.resolve(
    __dirname,
    "../../supabase/migrations/20260826160000_hetzner_cloud_connections.sql",
  ),
  "utf8",
);
const normalized = migration.replace(/\s+/g, " ").toLowerCase();

describe("Hetzner Cloud infrastructure migration", () => {
  it("adds a provider-discriminated connection without fake SSH metadata", () => {
    expect(normalized).toContain("provider in ('proxmox', 'host', 'hetzner-cloud')");
    expect(normalized).toContain("provider = 'hetzner-cloud' and setup_mode = 'simple'");
    expect(normalized).toContain("and ssh_host is null");
    expect(normalized).toContain("and ssh_port is null");
    expect(normalized).toContain("and ssh_user is null");
    expect(normalized).toContain("and ssh_host_fingerprint_sha256 is null");
  });

  it("keeps sanitized capacity inventory owner-scoped and non-launch-authoritative", () => {
    expect(normalized).toContain(
      "create table if not exists public.infrastructure_capacity_inventory",
    );
    expect(normalized).toContain("provider_resource_id text not null");
    expect(normalized).toContain("public_network jsonb not null");
    expect(normalized).toContain(
      "foreign key (connection_id, user_id, provider) references public.infrastructure_connections (id, user_id, provider) on delete cascade",
    );
    expect(normalized).toContain(
      'create policy "users can view own infrastructure capacity inventory"',
    );
    expect(normalized).toContain("grant select on public.infrastructure_capacity_inventory to authenticated");
    expect(normalized).not.toContain("insert into public.deployment_targets");
    expect(normalized).not.toContain("insert into public.hivra_agents");
  });

  it("atomically persists encrypted credentials and inventory through service-role RPCs", () => {
    expect(normalized).toContain(
      "create or replace function public.create_hetzner_cloud_infrastructure_connection(",
    );
    expect(normalized).toContain("insert into public.infrastructure_connection_secrets");
    expect(normalized).toContain("insert into public.infrastructure_capacity_inventory");
    expect(normalized).toContain("p_expected_revision bigint");
    expect(normalized).toContain("for update");
    expect(normalized).toContain(
      "p_discovered_at <= v_connection.last_checked_at then return null",
    );
    expect(normalized).toContain(
      "revoke all on function public.create_hetzner_cloud_infrastructure_connection(",
    );
    expect(normalized).toContain("from public, anon, authenticated");
    expect(normalized).toContain(
      "grant execute on function public.reconcile_hetzner_cloud_inventory(",
    );
    expect(normalized).toContain("to service_role");
  });

  it("persists monotonic provider failures without deleting the last good inventory", () => {
    const start = normalized.indexOf(
      "create or replace function public.record_hetzner_cloud_inventory_failure(",
    );
    const end = normalized.indexOf(
      "revoke all on function public.create_hetzner_cloud_infrastructure_connection(",
      start,
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const failureFunction = normalized.slice(start, end);

    expect(failureFunction).toContain("set status = 'error'");
    expect(failureFunction).toContain("and user_id = p_user_id");
    expect(failureFunction).toContain("and provider = 'hetzner-cloud'");
    expect(failureFunction).toContain("and revision = p_expected_revision");
    expect(failureFunction).toContain(
      "last_checked_at is null or p_checked_at > last_checked_at",
    );
    expect(failureFunction).not.toContain("delete from public.infrastructure_capacity_inventory");
  });

  it("contains no provider mutation or ambient managed credential path", () => {
    expect(normalized).not.toContain("post /servers");
    expect(normalized).not.toContain("hetzner_api_token");
    expect(normalized).not.toContain("create server");
  });
});
