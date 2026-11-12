import fs from "node:fs";
import path from "node:path";

const sql = fs.readFileSync(
  path.resolve(__dirname, "../supabase/migrations/20261113020000_hivra_agent_sleep_state.sql"),
  "utf8",
);

describe("agent sleep state migration", () => {
  it("adds every column with the never-sleep default, guarded for reruns", () => {
    for (const column of [
      "sleep_state text not null default 'awake'",
      "sleep_tier_changed_at timestamptz",
      "sleep_generation bigint not null default 0",
      "sleep_policy text not null default 'off'",
      "always_on boolean not null default false",
      "next_wake_at timestamptz",
    ]) {
      expect(sql).toContain(`add column if not exists ${column}`);
    }
    expect(sql).toContain("add column if not exists sleep_mode text not null default 'off'");
    expect(sql).toMatch(/hivra_agents_sleep_state_check[\s\S]*awake[\s\S]*wake_failed/);
    expect(sql).toMatch(/hivra_agents_sleep_policy_check[\s\S]*'off', 't1', 't3', 'full'/);
    expect(sql).toMatch(/proxmox_hosts_sleep_mode_check[\s\S]*'off', 'observe', 'canary', 'on'/);
    expect(sql.match(/not exists \(\s*select 1 from pg_constraint/g)).toHaveLength(3);
  });

  it("adds constraints without a long table lock", () => {
    expect(sql).toContain("set local lock_timeout = '2s'");
    expect(sql.match(/\) not valid;/g)).toHaveLength(3);
    for (const name of [
      "hivra_agents_sleep_state_check",
      "hivra_agents_sleep_policy_check",
      "proxmox_hosts_sleep_mode_check",
    ]) {
      expect(sql).toMatch(new RegExp(`validate constraint ${name};`));
    }
  });

  it("keeps the observation table service-role only", () => {
    expect(sql).toContain("create table if not exists public.hivra_agent_sleep_observations");
    expect(sql).toContain("references public.hivra_agents(id) on delete cascade");
    expect(sql).toContain("alter table public.hivra_agent_sleep_observations enable row level security");
    expect(sql).toContain("revoke all on public.hivra_agent_sleep_observations from anon, authenticated");
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).toContain("(agent_id, observed_at desc)");
    expect(sql).toContain("(observed_at)");
  });

  it("does not widen operation kinds yet", () => {
    expect(sql).not.toMatch(/operation_kind/);
  });
});
