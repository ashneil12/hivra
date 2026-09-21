import { readFileSync } from "node:fs";
import path from "node:path";

const migrationPath = path.resolve(
  __dirname,
  "../../supabase/migrations/20260904100000_hivra_canonical_resource_shadow.sql",
);
const sql = readFileSync(migrationPath, "utf8");
const normalized = sql.replace(/\s+/g, " ").toLowerCase();

function functionDefinition(name: string): string {
  const start = normalized.indexOf(`create function public.${name}(`);
  const bodyStart = normalized.indexOf("as $$", start);
  const end = normalized.indexOf("$$;", bodyStart);
  if (start < 0 || bodyStart < 0 || end < 0) return "";
  return normalized.slice(start, end + 3);
}

describe("canonical resource shadow migration", () => {
  it("creates separate canonical resources and one durable source mapping", () => {
    for (const table of [
      "hivra_canonical_computers",
      "hivra_canonical_agent_identities",
      "hivra_canonical_runtime_installations",
      "hivra_canonical_primary_bindings",
      "hivra_canonical_source_mappings",
      "hivra_canonical_source_events",
      "hivra_canonical_reconciliation_errors",
      "hivra_canonical_shadow_control",
    ]) {
      expect(normalized).toContain(`create table public.${table}`);
    }
    expect(normalized).toContain("primary key (source_kind, source_id)");
    expect(normalized).toContain("unique (compatibility_alias)");
    expect(normalized).toContain("unique (computer_id)");
    expect(normalized).toContain("write_authority text not null default 'legacy'");
    expect(normalized).toContain("check (write_authority = 'legacy')");
  });

  it("rejects competing primary bindings and cross-owner relationships", () => {
    expect(normalized).toContain(
      "create unique index hivra_canonical_one_active_primary_per_computer",
    );
    expect(normalized).toContain(
      "on public.hivra_canonical_primary_bindings(computer_id) where status = 'active'",
    );
    expect(normalized).toContain(
      "foreign key (computer_id, user_id) references public.hivra_canonical_computers(id, user_id)",
    );
    expect(normalized).toContain(
      "foreign key (agent_identity_id, user_id) references public.hivra_canonical_agent_identities(id, user_id)",
    );
  });

  it("keeps Ubuntu as a computer-only mapping", () => {
    expect(normalized).toContain("v_is_computer := v_event.source_kind = 'hivra'");
    expect(normalized).toContain(
      "nullif(v_event.payload ->> 'computerprofile', '') is not null",
    );
    expect(normalized).toContain("v_event.payload ->> 'type' = 'linux-desktop'");
    expect(normalized).toContain(
      "case when v_is_computer then null else gen_random_uuid() end",
    );
    expect(normalized).toContain(
      "resource_kind = 'computer' and agent_identity_id is null and runtime_installation_id is null and primary_binding_id is null",
    );
  });

  it("captures only an explicit secret-safe source projection", () => {
    expect(normalized).toContain(
      "create function public.capture_hivra_canonical_hermes_source_event()",
    );
    expect(normalized).toContain(
      "create function public.capture_hivra_canonical_hivra_source_event()",
    );
    expect(normalized).not.toContain("to_jsonb(new)");
    expect(normalized).not.toContain("to_jsonb(old)");
    expect(normalized).not.toContain("api_token");
    expect(normalized).not.toContain("api_key_encrypted");
    expect(normalized).not.toContain("llm_api_key_encrypted");
    expect(normalized).not.toContain("'config'");
    expect(normalized).toContain("'computerprofile', v_row.computer_profile");
    expect(normalized).toContain("'lifecyclestate', v_row.lifecycle_state");
  });

  it("uses an online row-locked seed instead of a migration-long table lock", () => {
    expect(normalized).not.toContain(
      "lock table public.hermes_instances, public.hivra_agents in share row exclusive mode",
    );
    expect(normalized).toContain(
      "create function public.seed_hivra_canonical_source_events(",
    );
    expect(normalized).toContain("for key share skip locked");
    expect(normalized).toContain(
      "create trigger hivra_canonical_hermes_source_event after insert or update or delete on public.hermes_instances",
    );
    expect(normalized).toContain(
      "create trigger hivra_canonical_hivra_source_event after insert or update or delete on public.hivra_agents",
    );
    expect(normalized).toContain("'backfill'");
    expect(normalized).toContain(
      "create function public.apply_hivra_canonical_source_event(p_event_id bigint)",
    );
    expect(normalized).toContain(
      "excluded.source_event_id > public.hivra_canonical_computers.source_event_id",
    );
    expect(normalized).toContain(
      "v_event.processed_at is not null then return 'already_processed'",
    );
  });

  it("synchronously projects post-migration writes and fails closed after cutover", () => {
    expect(functionDefinition("capture_hivra_canonical_hermes_source_event")).toContain(
      "v_result := public.apply_hivra_canonical_source_event(v_event_id)",
    );
    expect(functionDefinition("capture_hivra_canonical_hivra_source_event")).toContain(
      "v_result := public.apply_hivra_canonical_source_event(v_event_id)",
    );
    expect(normalized).toContain("v_mode = 'shadow'");
    expect(normalized).toContain("canonical shadow projection rejected the legacy write");
  });

  it("skips superseded events before payload validation and backs poison events off", () => {
    expect(normalized.indexOf("v_mapping.last_source_event_id > v_event.event_id")).toBeLessThan(
      normalized.indexOf("invalid owner or name in canonical source event"),
    );
    expect(normalized).toContain("next_attempt_at timestamptz");
    expect(normalized).toContain("next_attempt_at <= clock_timestamp()");
    expect(normalized).toMatch(/make_interval\(\s*secs =>/);
  });

  it("gates advanced actions on explicit Proxmox substrate evidence", () => {
    expect(normalized).toMatch(
      /coalesce\(p_payload ->> 'computersubstrate', ''\)\)\) = 'proxmox-kvm'/,
    );
    expect(normalized).not.toContain(
      "then array['stop','reboot','delete','resize']::text[]",
    );
  });

  it("provides observable reconciliation, parity-gated read cutover, and immediate read rollback", () => {
    expect(normalized).toContain(
      "create function public.reconcile_hivra_canonical_source_events(",
    );
    expect(normalized).toContain("p_limit integer default 100");
    expect(normalized).toContain(
      "create function public.hivra_canonical_shadow_parity()",
    );
    expect(normalized).toContain(
      "create function public.set_hivra_canonical_inventory_read_mode(p_mode text)",
    );
    expect(normalized).toContain("if p_mode = 'shadow' and not v_ready then");
    expect(normalized).toContain(
      "lock table public.hermes_instances, public.hivra_agents in share mode",
    );
    expect(normalized).toContain("projectionmismatchcount");
    expect(normalized).toContain("historicalmismatchcount");
    expect(normalized).toContain("computer.actions is distinct from");
    expect(normalized).toContain("computer.surfaces is distinct from");
    expect(normalized).toContain("computer.user_id is distinct from");
    expect(normalized).toContain("inventory_read_mode = 'legacy'");
    expect(normalized).toContain("pendingeventcount");
    expect(normalized).toContain("erroreventcount");
  });

  it("does not change legacy write authority or legacy row relationships", () => {
    expect(normalized).not.toContain("alter table public.hermes_instances add column");
    expect(normalized).not.toContain("alter table public.hivra_agents add column");
    expect(normalized).not.toContain("delete from public.hermes_instances");
    expect(normalized).not.toContain("delete from public.hivra_agents");
    expect(normalized).not.toContain("update public.hermes_instances");
    expect(normalized).not.toContain("update public.hivra_agents");
  });

  it("allows service-role reconciliation but rejects direct shadow writes", () => {
    expect(normalized).toContain(
      "revoke all on table public.hivra_canonical_computers",
    );
    expect(normalized).toContain(
      "grant select on table public.hivra_canonical_computers",
    );
    expect(normalized).toContain(
      "grant execute on function public.reconcile_hivra_canonical_source_events(integer) to service_role",
    );
    expect(normalized).toContain(
      "grant execute on function public.seed_hivra_canonical_source_events(integer) to service_role",
    );
    expect(normalized).toContain(
      "grant execute on function public.set_hivra_canonical_inventory_read_mode(text) to service_role",
    );
  });
});
