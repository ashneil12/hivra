/**
 * @jest-environment node
 */
// Runs the real migration chain in PGlite. No live database and no host actions.
import { PGlite } from "@electric-sql/pglite";

// eslint-disable-next-line @typescript-eslint/no-require-imports -- the migration-chain helper is CommonJS.
const { openMigratedDatabase, readMigration } = require("../../scripts/lib/pglite-all-migrations.cjs");

let pg: PGlite;
jest.setTimeout(120_000);

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const OP = "99999999-9999-4999-8999-999999999999";

beforeAll(async () => {
  pg = await openMigratedDatabase({ through: "20261124010000_hivra_agent_seat_funding.sql" });
  await pg.exec(readMigration("20261127172200_hivra_idle_sleep_owner_policy.sql"));
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec("delete from public.hivra_agents");
});

async function insertAgent(id: string, seatFunding: "paid" | "holder" | null, alwaysOn: boolean) {
  await pg.query(
    `insert into public.hivra_agents
       (id, user_id, type, name, status, desired_state, sleep_state, sleep_generation, sleep_policy, always_on, seat_funding)
     values ($1, 'u1', 'claude-code', 'Agent', 'running', 'running', 'awake', 0, 'off', $2, $3)`,
    [id, alwaysOn, seatFunding],
  );
}

async function claim(id: string, generation = 0, operation = OP) {
  const { rows } = await pg.query<{ claim: number | null }>(
    "select public.claim_hivra_agent_sleep($1, $2, 'nap', $3) as claim",
    [id, operation, generation],
  );
  return rows[0].claim;
}

describe("claim_hivra_agent_sleep seat funding", () => {
  it("lets a holder-funded seat sleep despite a stale always-on value, and keeps compare-and-set race protection", async () => {
    await insertAgent(A, "holder", true);
    expect(await claim(A)).toBe(1);
    const { rows } = await pg.query<Record<string, unknown>>(
      "select sleep_state, sleep_generation, operation_id, operation_kind from public.hivra_agents where id = $1",
      [A],
    );
    expect(rows[0]).toMatchObject({ sleep_state: "draining", sleep_generation: 1, operation_id: OP, operation_kind: "sleep" });
    // A retry or concurrent caller at the stale generation cannot take the row.
    expect(await claim(A)).toBeNull();
  });

  it.each(["paid", null] as const)("preserves the existing always-on refusal for a %s seat", async (seatFunding) => {
    await insertAgent(A, seatFunding, true);
    expect(await claim(A)).toBeNull();
    const { rows } = await pg.query<Record<string, unknown>>(
      "select sleep_state, sleep_generation, operation_id from public.hivra_agents where id = $1",
      [A],
    );
    expect(rows[0]).toMatchObject({ sleep_state: "awake", sleep_generation: 0, operation_id: null });
  });

  it("still lets an ordinary seat sleep only when always-on is false", async () => {
    await insertAgent(A, "paid", false);
    expect(await claim(A)).toBe(1);
    await insertAgent(B, null, false);
    expect(await claim(B)).toBe(1);
  });

  it("refuses the wrong generation and an invalid funding cohort", async () => {
    await insertAgent(A, "holder", false);
    expect(await claim(A, 7)).toBeNull();
    await expect(
      pg.query(
        `insert into public.hivra_agents (id, user_id, type, name, seat_funding) values ($1, 'u1', 'claude-code', 'Bad', 'user')`,
        [C],
      ),
    ).rejects.toThrow(/hivra_agents_seat_funding_check/);
  });
});


async function claimIdle(id: string, tier: "nap" | "hibernate" = "nap") {
  const { rows } = await pg.query<{ claim: number | null }>(
    "select public.claim_hivra_agent_idle_sleep($1, $2, $3, 0) as claim",
    [id, OP, tier],
  );
  return rows[0].claim;
}

describe("claim_hivra_agent_idle_sleep consent", () => {
  it.each(["paid", null, "holder"] as const)("refuses a %s seat with policy off without taking a lease", async (funding) => {
    await insertAgent(A, funding, false);
    expect(await claimIdle(A)).toBeNull();
    const { rows } = await pg.query("select sleep_state, sleep_generation, operation_id from public.hivra_agents where id = $1", [A]);
    expect(rows[0]).toMatchObject({ sleep_state: "awake", sleep_generation: 0, operation_id: null });
  });

  it("rechecks the persisted policy and tier before the lease, keeping the manual path separate", async () => {
    await insertAgent(A, "paid", false);
    await pg.query("update public.hivra_agents set sleep_policy = 't1' where id = $1", [A]);
    expect(await claimIdle(A, "hibernate")).toBeNull();
    await pg.query("update public.hivra_agents set sleep_policy = 'off' where id = $1", [A]);
    expect(await claimIdle(A)).toBeNull();
    expect(await claim(A)).toBe(1);
    await insertAgent(B, "holder", true);
    await pg.query("update public.hivra_agents set sleep_policy = 'full' where id = $1", [B]);
    expect(await claimIdle(B)).toBeNull();
    await pg.query("update public.hivra_agents set always_on = false where id = $1", [B]);
    expect(await claimIdle(B)).toBe(1);
  });

  it("exposes the new claim only to the service role", async () => {
    const { rows } = await pg.query(`select role, has_function_privilege(role, 'public.claim_hivra_agent_idle_sleep(uuid,uuid,text,bigint)', 'execute') as allowed
      from (values ('anon'), ('authenticated'), ('service_role')) as roles(role)`);
    expect(rows).toEqual([{ role: "anon", allowed: false }, { role: "authenticated", allowed: false }, { role: "service_role", allowed: true }]);
  });
});
