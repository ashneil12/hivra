import fs from "node:fs";
import path from "node:path";

const dir = path.join(process.cwd(), "supabase/migrations");
const name = "20261113100000_hivra_agent_telegram_wake.sql";
const sql = fs.readFileSync(path.join(dir, name), "utf8");

it("comes after every migration that was there before it", () => {
  const earlier = fs.readdirSync(dir).filter((f) => f.endsWith(".sql") && f < name);
  expect(earlier).toContain("20261113091000_provider_release_admission_2026_11_12_5.sql");
});

it("is idempotent and keeps the table service-role only", () => {
  expect(sql).toContain("create table if not exists public.hivra_agent_telegram_wake");
  expect(sql).toContain("create index if not exists");
  expect(sql).toContain("enable row level security");
  expect(sql).toContain("revoke all on public.hivra_agent_telegram_wake from public, anon, authenticated");
  expect(sql).not.toMatch(/create policy/i);
  expect(sql).toContain("drop constraint if exists hivra_agent_sleep_events_trigger_check");
  expect(sql).toMatch(/create or replace function public\.claim_hivra_agent_tg_arm/);
  expect(sql).toMatch(/create or replace function public\.finish_hivra_agent_tg_arm/);
});

it("admits the telegram trigger next to every earlier one", () => {
  expect(sql).toContain("check (trigger in ('sweep', 'manual', 'open', 'action', 'schedule', 'reconcile', 'telegram')) not valid");
  expect(sql).toContain("validate constraint hivra_agent_sleep_events_trigger_check");
});

it("stores the token only encrypted, with a short fingerprint", () => {
  expect(sql).toContain("token_enc        text");
  expect(sql).toContain("token_fp ~ '^[0-9a-f]{16}$'");
  expect(sql).not.toMatch(/\btoken\s+text/);
});

it("arms only an asleep agent with no operation, after the nap rule, under the agent row lock", () => {
  expect(sql).toContain("select * into a from public.hivra_agents where id = p_agent_id for update");
  expect(sql).toContain("a.operation_id is not null or a.sleep_state not in ('napping', 'hibernated')");
  expect(sql).toContain("make_interval(secs => p_min_pending_s)");
  expect(sql).toContain("where agent_id = p_agent_id and arm_id = p_arm_id and state = 'arming' for update");
  expect(sql).toContain("to service_role");
});

describe("arming again after a failed wake", () => {
  const laterName = "20261113101000_hivra_agent_telegram_wake_after_failed_wake.sql";
  const later = fs.readFileSync(path.join(dir, laterName), "utf8");

  it("comes after the table it changes", () => {
    expect(laterName > name).toBe(true);
  });

  it("only widens the claim's sleep states to wake_failed, and stays service-role only", () => {
    expect(later).toMatch(/create or replace function public\.claim_hivra_agent_tg_arm/);
    expect(later).toContain("a.operation_id is not null or a.sleep_state not in ('napping', 'hibernated', 'wake_failed')");
    const body = (text: string) => /create or replace function public\.claim_hivra_agent_tg_arm[\s\S]*?\n\$\$;/.exec(text)![0]
      .split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    expect(body(later).replace(", 'wake_failed'", "")).toBe(body(sql));
    expect(later).toContain("revoke all on function public.claim_hivra_agent_tg_arm(uuid, uuid, integer) from public, anon, authenticated");
    expect(later).toContain("grant execute on function public.claim_hivra_agent_tg_arm(uuid, uuid, integer) to service_role");
    expect(later).not.toMatch(/create table|drop table|create policy/i);
  });
});
