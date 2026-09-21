import fs from "node:fs";
import path from "node:path";

const migration = fs.readFileSync(path.resolve(
  process.cwd(), "supabase/migrations/20260908075000_omarchy_native_rolling_renewal.sql",
), "utf8").toLowerCase();

it("keeps native renewals service-only and idempotent", () => {
  expect(migration).toContain("create table if not exists public.hivra_omarchy_native_renewals");
  expect(migration).toContain("renewal_id uuid primary key");
  expect(migration).toContain("unique(session_id,renewal_count)");
  expect(migration).toContain("alter table public.hivra_omarchy_native_renewals enable row level security");
  expect(migration).toContain("revoke all on table public.hivra_omarchy_native_renewals from public,anon,authenticated");
  expect(migration).toContain("claim_hivra_omarchy_native_renewal");
  expect(migration).toContain("record_hivra_omarchy_native_renewal");
  expect(migration).toContain("refresh_hivra_omarchy_native_capability");
  expect(migration).toContain("revoke all on function public.refresh_hivra_omarchy_native_capability");
  expect(migration).toContain("to service_role");
});

it("rechecks the exact active Omarchy capability and twelve-hour ceiling", () => {
  expect(migration).toContain("s.transport<>'sunshine-moonlight'");
  expect(migration).toContain("s.input_state<>'takeover-pending'");
  expect(migration).toContain("generation=s.capability_generation");
  expect(migration).toContain("private_network_reachable=true");
  expect(migration).toContain("supports_input_takeover=true");
  expect(migration).toContain("s.created_at+interval '12 hours'");
  expect(migration).toContain("renewal_count=renewal_count+1");
});

it("upgrades activation grants to the monotonic v2 deadline shape", () => {
  expect(migration).toContain("hivra-omarchy-guardian-grant-v2");
  expect(migration).toContain("'expiresatunixms'");
  expect(migration).toContain("'continuousdeadlineboottimens'");
  expect(migration).toContain("(select count(*) from jsonb_object_keys(p_guardian_grant))<>20");
});
