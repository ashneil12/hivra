import { readFileSync } from "node:fs";
import path from "node:path";

const migration = readFileSync(
  path.resolve(
    __dirname,
    "../../supabase/migrations/20260826170000_hetzner_cloud_capacity_orders.sql",
  ),
  "utf8",
);
const normalized = migration.replace(/\s+/g, " ").toLowerCase();

function functionBody(name: string, nextName: string): string {
  const start = normalized.indexOf(`create or replace function public.${name}(`);
  const foundEnd = normalized.indexOf(`create or replace function public.${nextName}(`, start + 1);
  const end = foundEnd === -1 ? normalized.length : foundEnd;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return normalized.slice(start, end);
}

describe("Hetzner Cloud capacity purchase ledger migration", () => {
  it("keeps billable orders service-role-only and owner/provider bound", () => {
    expect(normalized).toContain(
      "foreign key (active_connection_id, user_id, provider) references public.infrastructure_connections (id, user_id, provider) on delete set null (active_connection_id)",
    );
    expect(normalized).toContain(
      "revoke all on public.infrastructure_capacity_orders from public, anon, authenticated",
    );
    expect(normalized).toContain(
      "grant all on public.infrastructure_capacity_orders to service_role",
    );
    expect(normalized).not.toContain(
      "grant select on public.infrastructure_capacity_orders to authenticated",
    );
  });

  it("creates new Hetzner connections with an app-generated ID and bound v2 secret", () => {
    const createV2 = functionBody(
      "create_hetzner_cloud_infrastructure_connection_v2",
      "create_hetzner_cloud_capacity_quote",
    );
    expect(createV2).toContain("p_connection_id uuid");
    expect(createV2).toContain("p_key_version <> 2");
    expect(createV2).toContain(
      "p_connection_id, p_user_id, p_encrypted_bundle, p_key_version",
    );
    expect(normalized).toContain(
      "revoke all on function public.create_hetzner_cloud_infrastructure_connection( text, text, text, smallint, timestamptz, jsonb ) from service_role",
    );
    expect(normalized).toContain(
      "create_hetzner_cloud_infrastructure_connection_v2( uuid, text, text, text, smallint, timestamptz, jsonb ) to service_role",
    );
  });

  it("serializes, purges, and durably caps unclaimed owner quotes", () => {
    const quote = functionBody(
      "create_hetzner_cloud_capacity_quote",
      "claim_hetzner_cloud_capacity_order",
    );
    expect(quote).toContain("pg_advisory_xact_lock");
    expect(quote).toContain("'hivra-hetzner-capacity-quote:' || p_user_id");
    expect(quote).toContain("status = 'quoted' and idempotency_key is null and quote_expires_at <= p_now");
    expect(quote).toContain("v_active_quote_count >= 5");
    expect(quote).toContain("return jsonb_build_object('outcome', 'quote_rate_limited')");
    expect(normalized).toContain(
      "create_hetzner_cloud_capacity_quote( text, uuid, bigint, uuid, text, jsonb, jsonb, text, timestamptz, timestamptz ) to service_role",
    );
  });

  it("enforces one retained Canary capacity slot per owner across connections", () => {
    expect(normalized).toContain(
      "create unique index if not exists infrastructure_capacity_orders_one_capacity_idx on public.infrastructure_capacity_orders (user_id)",
    );
    expect(normalized).toContain(
      "where status in ('creating', 'ambiguous', 'created_off') or provider_ssh_key_id is not null",
    );
    expect(normalized).toContain("return jsonb_build_object('outcome', 'canary_capacity_limit')");
  });

  it("records strict, monotonic action and powered-off observation evidence", () => {
    expect(normalized).toContain("not ( receipt.value ? 'id' and receipt.value ? 'command' and receipt.value ? 'status' )");
    expect(normalized).not.toContain("jsonb_object_length(");
    expect(normalized).toContain("from jsonb_object_keys(receipt.value)");
    expect(normalized).toContain("from jsonb_object_keys(p_provider_labels)");
    expect(normalized).toContain("receipt.value->>'command' in ('poweron', 'start_resource')");
    expect(normalized).toContain("provider_action_command = 'create_server'");
    expect(normalized).toContain("provider_observed_at is not null");
    expect(normalized).toContain("observed_server_status = 'off'");
    expect(normalized).toContain(
      "if (p_provider_observed_at is null) <> (p_observed_server_status is null) then",
    );
    expect(normalized).toContain("provider_action_status is distinct from 'error'");
    expect(normalized).toContain(
      "observed_server_status not in ('running', 'starting', 'unknown')",
    );
    expect(normalized).toContain(
      "p_observed_server_status is null or observed_server_status is null or observed_server_status not in ('running', 'starting', 'unknown') or p_observed_server_status = observed_server_status",
    );
    expect(normalized).toContain(
      "status = 'provider_rejected' and active_connection_id is not null and idempotency_key is not null and server_post_attempted_at is null",
    );
  });

  it("wipes encrypted bootstrap credentials on rejection and connection deletion", () => {
    const result = functionBody(
      "record_hetzner_cloud_capacity_order_result",
      "reconcile_hetzner_cloud_inventory",
    );
    expect(result).toContain("when p_status = 'provider_rejected' then null");
    const deletion = functionBody(
      "delete_infrastructure_connection",
      "force_forget_hetzner_cloud_connection",
    );
    expect(deletion).toContain("encrypted_bootstrap_bundle = null");
    expect(deletion).toContain("bootstrap_key_version = null");
    expect(deletion).toContain("active_connection_id = null");
    expect(deletion).toContain("and provider_ssh_key_id is null");
  });

  it("serializes generic deletion and distinguishes busy from force-forget-required", () => {
    const deletion = functionBody(
      "delete_infrastructure_connection",
      "force_forget_hetzner_cloud_connection",
    );
    const lockIndex = deletion.indexOf("order by capacity_order.id for update");
    const busyIndex = deletion.indexOf(
      "capacity_order.status = 'creating'",
    );
    const detachIndex = deletion.indexOf("active_connection_id = null");
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(busyIndex).toBeGreaterThan(lockIndex);
    expect(detachIndex).toBeGreaterThan(busyIndex);
    expect(deletion).toContain("return 'capacity_busy'");
    expect(deletion).toContain("status = 'creating'");
    expect(deletion).toContain("provider_ssh_key_status = 'pending'");
    expect(deletion).toContain("provider_server_status = 'pending'");
    expect(deletion).toContain("capacity_order.status = 'ambiguous'");
    expect(deletion).toContain("now() - interval '60 seconds'");
    expect(deletion).toContain("return 'capacity_force_forget_required'");
    expect(deletion).not.toContain("status in ('creating', 'ambiguous')");
  });

  it("force-forgets only idle ambiguity while preserving audit and the owner slot", () => {
    const forceForget = functionBody(
      "force_forget_hetzner_cloud_connection",
      "no_function_after_force_forget",
    );
    expect(forceForget).toContain("order by capacity_order.id for update");
    expect(forceForget).toContain("capacity_order.status = 'creating'");
    expect(forceForget).toContain("capacity_order.provider_ssh_key_status = 'pending'");
    expect(forceForget).toContain("capacity_order.provider_server_status = 'pending'");
    expect(forceForget).toContain("now() - interval '60 seconds'");
    expect(forceForget).toContain("return 'capacity_busy'");
    expect(forceForget).toContain("return 'not_ambiguous'");
    expect(forceForget).toContain(
      "set active_connection_id = null, detached_at = now(), encrypted_bootstrap_bundle = null, bootstrap_key_version = null",
    );
    expect(forceForget).toContain("and status = 'ambiguous'");
    expect(forceForget).toContain("return 'forgotten'");
    expect(forceForget).not.toContain("provider_resource_id = null");
    expect(forceForget).not.toContain("provider_ssh_key_id = null");
    expect(normalized).toContain(
      "force_forget_hetzner_cloud_connection(text, uuid) from public, anon, authenticated",
    );
    expect(normalized).toContain(
      "force_forget_hetzner_cloud_connection(text, uuid) to service_role",
    );
  });

  it("allows only monotonic ambiguous evidence enrichment", () => {
    const result = functionBody(
      "record_hetzner_cloud_capacity_order_result",
      "reconcile_hetzner_cloud_inventory",
    );
    expect(result).toContain("provider action evidence must be coherent");
    expect(result).toContain(
      "(p_provider_action_id is null) <> (p_provider_action_command is null)",
    );
    expect(result).toContain(
      "(p_provider_action_id is null) <> (p_provider_action_status is null)",
    );
    expect(result).toContain("status in ('creating', 'ambiguous')");
    expect(result).toContain(
      "p_provider_resource_id is null or provider_resource_id is null or provider_resource_id = p_provider_resource_id",
    );
    expect(result).not.toContain("provider_resource_id = p_provider_resource_id,");
    expect(result).toContain(
      "p_status = 'provider_rejected' and status = 'creating' and server_post_attempted_at is null",
    );
    expect(result).toContain(
      "p_provider_action_status is null or provider_action_status is null or provider_action_status = p_provider_action_status or ( provider_action_status = 'running' and p_provider_action_status in ('success', 'error') )",
    );
  });

  it("keeps an attempted but not-yet-visible SSH key recoverable", () => {
    const sshResult = functionBody(
      "record_hetzner_cloud_ssh_key_result",
      "mark_hetzner_cloud_server_post_attempted",
    );
    expect(sshResult).toContain(
      "p_status = 'accepted' and status = 'ambiguous' and provider_ssh_key_status = 'ambiguous' and server_post_attempted_at is null",
    );
    expect(sshResult).toContain(
      "p_status = 'ambiguous' and status = 'ambiguous' and provider_ssh_key_status = 'ambiguous' and server_post_attempted_at is null",
    );
  });

  it("persists an explicit monotonic provider-server mutation receipt", () => {
    expect(normalized).toContain(
      "provider_server_status text check ( provider_server_status is null or provider_server_status in ( 'pending', 'accepted', 'ambiguous' ) )",
    );
    const marker = functionBody(
      "mark_hetzner_cloud_server_post_attempted",
      "record_hetzner_cloud_capacity_order_progress",
    );
    expect(marker).toContain("provider_server_status = 'pending'");
    const progress = functionBody(
      "record_hetzner_cloud_capacity_order_progress",
      "record_hetzner_cloud_capacity_order_result",
    );
    expect(progress).toContain("provider_server_status = 'accepted'");
    const result = functionBody(
      "record_hetzner_cloud_capacity_order_result",
      "reconcile_hetzner_cloud_inventory",
    );
    expect(result).toContain(
      "when p_status = 'ambiguous' and server_post_attempted_at is not null then 'ambiguous'",
    );
    expect(normalized).toContain(
      "and provider_server_status = 'accepted' and last_error_code is null",
    );
  });

  it("requires an attached ambiguous SSH-key replay to recover to creating before server POST", () => {
    const sshResult = functionBody(
      "record_hetzner_cloud_ssh_key_result",
      "mark_hetzner_cloud_server_post_attempted",
    );
    expect(sshResult).toContain("active_connection_id = p_connection_id");
    expect(sshResult).toContain("when p_status = 'accepted' then 'creating'");
    expect(sshResult).toContain("status = 'ambiguous'");
    const serverMarker = functionBody(
      "mark_hetzner_cloud_server_post_attempted",
      "record_hetzner_cloud_capacity_order_progress",
    );
    expect(serverMarker).toContain("capacity_order.status = 'creating'");
    expect(serverMarker).toContain("active_connection_id = p_connection_id");
  });

  it("prevents stale full snapshots from overwriting or deleting a targeted create observation", () => {
    const reconcile = functionBody(
      "reconcile_hetzner_cloud_inventory",
      "upsert_hetzner_cloud_inventory_server",
    );
    expect(reconcile).toContain(
      "where public.infrastructure_capacity_inventory.discovered_at < excluded.discovered_at",
    );
    expect(reconcile).toContain("existing.discovered_at <= p_discovered_at");
    expect(reconcile).toContain(
      "p_discovered_at <= v_connection.last_checked_at then return null",
    );
  });

  it("revokes the exact RPC signatures and grants only service_role execution", () => {
    expect(normalized).toContain(
      "record_hetzner_cloud_capacity_order_progress( text, uuid, uuid, uuid, text, text, text, text, jsonb, timestamptz, text )",
    );
    expect(normalized).toContain(
      "record_hetzner_cloud_capacity_order_result( text, uuid, uuid, uuid, text, text, text, text, text, jsonb, timestamptz, text, text )",
    );
    expect(normalized).toContain("from public, anon, authenticated");
    expect(normalized).toContain("to service_role");
  });
});
