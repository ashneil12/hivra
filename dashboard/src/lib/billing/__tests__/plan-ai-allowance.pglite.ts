/**
 * @jest-environment node
 */
// Runs grant_plan_ai_allowance against the real migrations in PGlite:
// `npm run test:plan-allowance`.
import fs from "node:fs";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";

const MIGRATIONS = path.resolve(__dirname, "../../../../supabase/migrations");
const FILES = [
  "20260512180000_managed_venice_wallets.sql",
  "20260606140100_managed_venice_reservation_balance_guard.sql",
  "20260925201500_managed_venice_atomic_wallet_debits.sql",
  "20261117210000_plan_ladder.sql",
];

const M = 1_000_000;
let pg: PGlite;
jest.setTimeout(60_000);

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    create function public.update_updated_at() returns trigger language plpgsql as $$
      begin new.updated_at = now(); return new; end $$;
    create table public.hermes_subscriptions (user_id text primary key, plan text, status text);
  `);
  for (const f of FILES) await pg.exec(fs.readFileSync(path.join(MIGRATIONS, f), "utf8"));
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`
    delete from public.managed_venice_card_ledger_entries;
    delete from public.plan_ai_allowance_state;
  `);
});

async function grant(period: string, amount: number, at: string) {
  const res = await pg.query<{ r: Record<string, unknown> }>(
    "select public.grant_plan_ai_allowance('u1', $1, $2, $3::timestamptz) as r",
    [period, amount, at],
  );
  return res.rows[0].r;
}

async function spend(amount: number, at: string, ref: string) {
  const { rows } = await pg.query<{ id: string }>("select id from public.managed_venice_wallet_accounts where user_id = 'u1'");
  await pg.query(
    `insert into public.managed_venice_card_ledger_entries
       (account_id, user_id, amount_micro_usd, source, actor, reason, reference_id, created_at)
     values ($1, 'u1', $2, 'system', 'test', 'managed_venice_debit', $3, $4::timestamptz)`,
    [rows[0].id, -amount, ref, at],
  );
}

async function topUp(amount: number, at: string, ref: string) {
  const { rows } = await pg.query<{ id: string }>("select id from public.managed_venice_wallet_accounts where user_id = 'u1'");
  await pg.query(
    `insert into public.managed_venice_card_ledger_entries
       (account_id, user_id, amount_micro_usd, source, actor, reason, reference_id, created_at)
     values ($1, 'u1', $2, 'stripe', 'test', 'stripe_topup', $3, $4::timestamptz)`,
    [rows[0].id, amount, ref, at],
  );
}

async function balance() {
  const { rows } = await pg.query<{ b: string }>(
    "select coalesce(sum(amount_micro_usd), 0)::text as b from public.managed_venice_card_ledger_entries where user_id = 'u1'",
  );
  return Number(rows[0].b);
}

describe("grant_plan_ai_allowance", () => {
  it("is idempotent per month", async () => {
    expect(await grant("sub:2026-11-01", 10 * M, "2026-11-01Z")).toMatchObject({ granted: true });
    expect(await grant("sub:2026-11-01", 10 * M, "2026-11-02Z")).toMatchObject({ granted: false, status: "already_granted" });
    expect(await balance()).toBe(10 * M);
  });

  it("rolls one month over and expires anything older", async () => {
    await grant("sub:2026-11-01", 10 * M, "2026-11-01Z");
    // Nothing spent: all 10 roll over, balance 20.
    expect(await grant("sub:2026-12-01", 10 * M, "2026-12-01Z")).toMatchObject({ rolloverMicroUsd: 10 * M, expiredMicroUsd: 0 });
    expect(await balance()).toBe(20 * M);
    // Spend 4 in December: 16 allowance left, only 10 may roll, 6 expire.
    await spend(4 * M, "2026-12-15Z", "d1");
    expect(await grant("sub:2027-01-01", 10 * M, "2027-01-01Z")).toMatchObject({
      rolloverMicroUsd: 10 * M,
      expiredMicroUsd: 6 * M,
      removedMicroUsd: 6 * M,
    });
    expect(await balance()).toBe(20 * M);
  });

  it("never takes away money the owner paid for", async () => {
    await grant("sub:2026-11-01", 10 * M, "2026-11-01Z");
    await topUp(50 * M, "2026-11-02Z", "t1");
    await grant("sub:2026-12-01", 10 * M, "2026-12-01Z");
    await grant("sub:2027-01-01", 10 * M, "2027-01-01Z");
    // Allowance alone: 10 expired at January. Paid 50 untouched.
    expect(await balance()).toBe(50 * M + 20 * M);
  });

  it("takes spending from the allowance first", async () => {
    await grant("sub:2026-11-01", 10 * M, "2026-11-01Z");
    await topUp(50 * M, "2026-11-02Z", "t1");
    await spend(30 * M, "2026-11-20Z", "d1");
    const dec = await grant("sub:2026-12-01", 10 * M, "2026-12-01Z");
    expect(dec).toMatchObject({ rolloverMicroUsd: 0, expiredMicroUsd: 0 });
    expect(await balance()).toBe(10 * M + 50 * M - 30 * M + 10 * M);
  });
});
