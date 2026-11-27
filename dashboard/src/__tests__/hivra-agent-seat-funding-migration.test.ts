import fs from "node:fs";
import path from "node:path";

const sql = fs.readFileSync(
  path.resolve(process.cwd(), "supabase/migrations/20261124010000_hivra_agent_seat_funding.sql"),
  "utf8",
);
const code = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

describe("hivra agent seat funding migration", () => {
  it("adds the authoritative per-computer funding cohort without changing existing rows", () => {
    expect(code).toContain("add column if not exists seat_funding text");
    expect(code).toContain("check (seat_funding is null or seat_funding in ('paid', 'holder')) not valid");
    expect(code).toContain("alter table public.hivra_agents validate constraint hivra_agents_seat_funding_check");
    expect(code).toContain("set local lock_timeout = '2s'");
    expect(code).not.toMatch(/seat_funding\s+text\s+not\s+null/);
    expect(code).not.toMatch(/update\s+public\.hivra_agents\s+set\s+seat_funding/i);
  });

  it("adds the same immutable funding cohort column to Hermes seats without backfilling unknown rows", () => {
    expect(code).toContain("alter table public.hermes_instances");
    expect(code).toContain("hermes_instances_seat_funding_check");
    expect(code).toContain("alter table public.hermes_instances validate constraint hermes_instances_seat_funding_check");
    expect(code).not.toMatch(/update\s+public\.hermes_instances\s+set\s+seat_funding/i);
  });

  it("keeps the sleep lease compare-and-set race check while making stale holder always-on ineffective", () => {
    expect(code).toContain("create or replace function public.claim_hivra_agent_sleep");
    expect(code).toContain("a.operation_id is not null");
    expect(code).toContain("a.sleep_generation is distinct from p_expected_generation");
    expect(code).toContain("(a.always_on is distinct from false and a.seat_funding is distinct from 'holder')");
    expect(code).toContain("if p_tier = 'nap' and a.sleep_state is distinct from 'awake' then return null; end if;");
    expect(code).toContain("if p_tier = 'hibernate' and a.sleep_state not in ('awake', 'napping') then return null; end if;");
  });

  it("applies the same effective control inside long-term storage candidates", () => {
    expect(code).toContain("create or replace function public.hivra_sleep_store_candidates");
    expect(code).toContain("(a.always_on = false or a.seat_funding = 'holder')");
    expect(code).toContain("grant execute on function public.hivra_sleep_store_candidates(timestamptz, integer) to service_role");
  });

  it("keeps the claim function service-role only", () => {
    expect(code).toContain("revoke all on function public.claim_hivra_agent_sleep(uuid, uuid, text, bigint) from public, anon, authenticated");
    expect(code).toContain("grant execute on function public.claim_hivra_agent_sleep(uuid, uuid, text, bigint) to service_role");
    expect(code).not.toMatch(/grant execute on function public\.claim_hivra_agent_sleep[^;]+to authenticated/);
  });
});
