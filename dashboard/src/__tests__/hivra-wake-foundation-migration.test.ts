import fs from "node:fs";
import path from "node:path";

const dir = path.join(process.cwd(), "supabase/migrations");
const name = "20261113102000_hivra_wake_foundation.sql";
const sql = fs.readFileSync(path.join(dir, name), "utf8");
const code = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

it("comes after the Telegram wake migrations", () => {
  const earlier = fs.readdirSync(dir).filter((f) => f.endsWith(".sql") && f < name);
  expect(earlier).toContain("20261113100000_hivra_agent_telegram_wake.sql");
  expect(earlier).toContain("20261113101000_hivra_agent_telegram_wake_after_failed_wake.sql");
});

it("is idempotent and keeps both tables service-role only", () => {
  for (const table of ["hivra_agent_ingress", "hivra_agent_channel_wake"]) {
    expect(code).toContain(`create table if not exists public.${table}`);
    expect(code).toContain(`alter table public.${table} enable row level security`);
    expect(code).toContain(`revoke all on public.${table} from public, anon, authenticated`);
    expect(code).toContain(`grant select, insert, update, delete on public.${table} to service_role`);
  }
  expect(code).not.toMatch(/create policy/i);
  expect(code).not.toMatch(/create index (?!if not exists)/i);
  expect(code).not.toMatch(/add column (?!if not exists)/i);
  expect(code).not.toMatch(/drop table/i);
});

it("keeps one ingress row per agent and a unique metrics port per host", () => {
  expect(code).toMatch(/agent_id\s+uuid primary key references public\.hivra_agents\(id\) on delete cascade/);
  expect(code).toContain("check (mode in ('guest', 'host'))");
  expect(code).toContain("check (phase in ('none', 'forwarder', 'host_connector', 'cutover', 'rolled_back', 'failed'))");
  expect(code).toMatch(/create unique index if not exists \w+\s+on public\.hivra_agent_ingress using btree \(host_id, metrics_port\)/);
});

it("keys channel wake by agent and channel and stores no credential", () => {
  expect(code).toContain("primary key (agent_id, channel)");
  for (const column of ["enabled", "cred_fp", "state", "arm_id", "arm_data", "pending_since", "next_attempt_at",
    "arm_failures", "blocked_until", "deferred_wake_at", "wake_count_window", "last_error"]) {
    expect(code).toMatch(new RegExp(`\\n\\s+${column}\\s+\\w`));
  }
  expect(code).toContain("cred_fp ~ '^[0-9a-f]{16}$'");
  expect(code).not.toMatch(/\b(cred_enc|token_enc|password|token)\s+(text|bytea|jsonb)/);
});

it("adds the per-host ingress switch, default off, with a check", () => {
  expect(code).toContain("add column if not exists ingress_mode text not null default 'off'");
  expect(code).toContain("check (ingress_mode in ('off', 'canary', 'on')) not valid");
  expect(code).toContain("validate constraint proxmox_hosts_ingress_mode_check");
});

it("admits both new triggers next to every earlier one, in one check", () => {
  expect(code.match(/add constraint hivra_agent_sleep_events_trigger_check/g)).toHaveLength(1);
  expect(code).toContain("check (trigger in ('sweep', 'manual', 'open', 'action', 'schedule', 'reconcile', 'telegram', 'ingress', 'channel')) not valid");
  expect(code).toContain("validate constraint hivra_agent_sleep_events_trigger_check");
});
