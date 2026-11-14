// Applies the real managed-Venice wallet migrations and the Venice promo
// migration (twice, proving it re-runs) in PostgreSQL/WASM, then exercises
// grant_venice_promo and expire_venice_promo_grant: budget and max_grants caps,
// idempotent replays, disabled / undated campaigns, and the expiry math.
// Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const FILES = [
  "20260512180000_managed_venice_wallets.sql",
  "20260606140100_managed_venice_reservation_balance_guard.sql",
  "20260925201500_managed_venice_atomic_wallet_debits.sql",
  "20260605120000_hivra_agents.sql",
  "20260613170000_commit_hivra_llm_config_drift.sql",
  "20261111143017_venice_promo_campaigns.sql",
];
const MIGRATION = "20261111143017_venice_promo_campaigns.sql";
const read = (name) => fs.readFileSync(path.join(MIGRATIONS, name), "utf8");
const M = 1_000_000;
const T0 = "2026-11-20T00:00:00Z";

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
      create schema auth;
      create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
      create function public.update_updated_at() returns trigger language plpgsql as $$
        begin new.updated_at = now(); return new; end $$;
    `);
    for (const f of FILES) await db.exec(read(f));
    await db.exec(read(MIGRATION)); // rerun-safe

    const seeded = (await db.query("select slug, kind, code, enabled, budget_micro_usd::bigint b, max_grants, bonus_bps, grant_expiry_days from public.venice_promo_campaigns order by slug")).rows;
    assert.equal(seeded.length, 2);
    assert.deepEqual(seeded.map((r) => [r.slug, r.kind, r.code, r.enabled, Number(r.b), r.max_grants, r.bonus_bps, r.grant_expiry_days]), [
      ["venice-launch-2026", "launch_credit", "VENICE", false, 700 * M, 70, null, 30],
      ["venice-topup-2026", "topup_bonus", null, false, 200 * M, 20, 5000, 30],
    ]);

    const launch = (await db.query("select id from public.venice_promo_campaigns where slug='venice-launch-2026'")).rows[0].id;
    const grant = async (campaign, user, amount, ref, now = T0) =>
      (await db.query("select public.grant_venice_promo($1,$2,$3,$4,'new_subscriber',$5) r", [campaign, user, amount, ref, now])).rows[0].r;
    const balance = async (user) => Number((await db.query("select coalesce(sum(amount_micro_usd),0)::bigint s from public.managed_venice_card_ledger_entries where user_id=$1", [user])).rows[0].s);

    // Disabled / undated: nothing granted.
    assert.equal((await grant(launch, "u1", 10 * M, "g:u1")).status, "disabled");
    await db.query("update public.venice_promo_campaigns set enabled=true where id=$1", [launch]);
    assert.equal((await grant(launch, "u1", 10 * M, "g:u1")).status, "not_started");
    await db.query("update public.venice_promo_campaigns set starts_at='2026-11-01Z' where id=$1", [launch]);
    assert.equal((await grant(launch, "u1", 10 * M, "g:u1")).status, "ended", "no cutoff and no end date fails closed");
    await db.query("update public.venice_promo_campaigns set grant_cutoff_at='2026-12-31Z', ends_at='2027-01-31Z' where id=$1", [launch]);
    assert.equal(await balance("u1"), 0);

    // Grant, credited to the card ledger, capped at per-user cap, idempotent.
    const g1 = await grant(launch, "u1", 99 * M, "g:u1");
    assert.equal(g1.granted, true);
    assert.equal(g1.amountMicroUsd, 10 * M);
    assert.equal(await balance("u1"), 10 * M);
    const replay = await grant(launch, "u1", 10 * M, "g:u1");
    assert.equal(replay.status, "already_granted");
    assert.equal((await grant(launch, "u1", 10 * M, "g:other")).status, "already_granted");
    assert.equal(await balance("u1"), 10 * M);
    await assert.rejects(grant(launch, "u2", 10 * M, "g:u1"), /another grant/);
    assert.equal((await grant(launch, "u2", 10 * M, "g:u2", "2027-02-01T00:00:00Z")).status, "ended");

    // max_grants and budget under concurrent calls.
    await db.query("update public.venice_promo_campaigns set max_grants=3, budget_micro_usd=$2 where id=$1", [launch, 25 * M]);
    const results = await Promise.all(
      ["a", "b", "c", "d", "e"].map((u) => grant(launch, `race_${u}`, 10 * M, `g:race_${u}`))
    );
    const granted = results.filter((r) => r.granted).length;
    assert.equal(granted, 1, "u1 holds 10M, so only one more 10M fits in a 25M budget");
    assert.ok(results.filter((r) => !r.granted).every((r) => r.status === "budget_exhausted"));
    const total = Number((await db.query("select sum(amount_micro_usd)::bigint s from public.venice_promo_grants where campaign_id=$1", [launch])).rows[0].s);
    assert.ok(total <= 25 * M);
    await db.query("update public.venice_promo_campaigns set budget_micro_usd=$2, max_grants=2 where id=$1", [launch, 700 * M]);
    assert.equal((await grant(launch, "race_z", 10 * M, "g:race_z")).status, "max_grants_reached");

    // Expiry math.
    await db.query("update public.venice_promo_campaigns set max_grants=70 where id=$1", [launch]);
    const expire = async (id, now) => (await db.query("select public.expire_venice_promo_grant($1,$2) r", [id, now])).rows[0].r;
    const accountOf = async (user) => (await db.query("select id from public.managed_venice_wallet_accounts where user_id=$1", [user])).rows[0].id;
    const topUp = async (user, amount, ref, at) => db.query(
      `insert into public.managed_venice_card_ledger_entries (account_id,user_id,amount_micro_usd,source,actor,reason,reference_id,created_at)
       values ($1,$2,$3,'stripe','t','stripe_topup',$4,$5)`, [await accountOf(user), user, amount, ref, at]);
    const debit = async (user, amount, ref, at) => db.query(
      `insert into public.managed_venice_card_ledger_entries (account_id,user_id,amount_micro_usd,source,actor,reason,reference_id,created_at)
       values ($1,$2,$3,'system','t','managed_venice_debit',$4,$5)`, [await accountOf(user), user, -amount, ref, at]);
    const grantRow = async (user) => (await db.query("select id, status, spent_micro_usd::bigint s, expired_micro_usd::bigint e from public.venice_promo_grants where user_id=$1", [user])).rows[0];

    // Not due yet.
    assert.equal((await expire(g1.grantId, "2026-12-01T00:00:00Z")).status, "not_due");

    // u1: paid $5 on top, spent $4 after the grant: 6 of 10 promo unspent, removed.
    await topUp("u1", 5 * M, "s1", "2026-11-21Z");
    await debit("u1", 4 * M, "d1", "2026-11-22Z");
    await debit("u1", 3 * M, "before", "2026-11-19Z"); // before the grant: ignored
    // (the debit before the grant needs balance; skipped insert guard is by trigger so it may reject)
    const due = "2026-12-21T00:00:00Z";
    const r1 = await expire(g1.grantId, due);
    assert.equal(r1.removedMicroUsd, 6 * M);
    assert.equal(await balance("u1"), 15 * M - 4 * M - 3 * M - 6 * M);
    assert.equal((await grantRow("u1")).status, "expired");
    // Idempotent.
    assert.equal((await expire(g1.grantId, due)).status, "already_closed");
    assert.equal(await balance("u1"), 15 * M - 4 * M - 3 * M - 6 * M);

    // Fully spent grant: nothing removed, status spent.
    const g3 = await grant(launch, "u3", 10 * M, "g:u3");
    await debit("u3", 10 * M, "d3", "2026-11-25Z");
    await topUp("u3", 7 * M, "s3", "2026-11-26Z");
    const r3 = await expire(g3.grantId, "2026-12-21T00:00:00Z");
    assert.equal(r3.removedMicroUsd, 0);
    assert.equal(r3.status, "spent");
    assert.equal(await balance("u3"), 7 * M, "paid money untouched");

    // Capped at the available balance: an active hold takes part of it.
    const g4 = await grant(launch, "u4", 10 * M, "g:u4");
    await db.query(
      `insert into public.managed_venice_reservations (account_id,user_id,wallet_type,reference_id,estimated_cost_micro_usd,reserved_micro_usd)
       values ($1,'u4','card','hold4',$2,$2)`, [await accountOf("u4"), 8 * M]);
    const r4 = await expire(g4.grantId, "2026-12-21T00:00:00Z");
    assert.equal(r4.removedMicroUsd, 2 * M, "never more than available (10M - 8M held)");
    assert.equal((await grantRow("u4")).e > 0, true);

    // Report helpers.
    const stats = (await db.query("select public.venice_promo_grant_stats($1) r", ["2027-01-05T00:00:00Z"])).rows[0].r;
    const u1 = stats.find((g) => g.userId === "u1");
    assert.equal(u1.status, "expired");
    assert.equal(u1.spentMicroUsd, 4 * M);
    assert.equal(u1.active7, false);
    assert.equal(u1.toppedUpAfter, true);
    assert.equal(stats.find((g) => g.userId === "u3").toppedUpAfter, true);
    await db.query(
      `insert into public.managed_venice_usage_events (account_id,user_id,wallet_type,endpoint,model,charged_micro_usd,actual_cost_micro_usd,reference_id,created_at)
       values ($1,'u1','card','/chat','m-a',2000000,1500000,'ue1','2026-12-05T00:00:00Z'),
              ($1,'u1','card','/chat','m-b',1000000,900000,'ue2','2026-11-21T00:00:00Z'),
              ($2,'other','card','/chat','m-a',5000000,4000000,'ue3','2026-12-05T00:00:00Z')`,
      [await accountOf("u1"), (await db.query("insert into public.managed_venice_wallet_accounts (user_id) values ('other') returning id")).rows[0].id]);
    const stats2 = (await db.query("select public.venice_promo_grant_stats($1) r", ["2027-01-05T00:00:00Z"])).rows[0].r;
    assert.equal(stats2.find((g) => g.userId === "u1").active7, true);
    assert.equal(stats2.find((g) => g.userId === "u1").active30, false);
    await db.query("insert into public.hivra_agents (user_id,type,name,llm_config) values ('u1','hermes','a','{\"mode\":\"managed\"}'),('u1','hermes','b','{\"mode\":\"byok\"}')");
    const win = (await db.query("select public.venice_promo_window_stats($1,$2) r", ["2026-11-01T00:00:00Z", "2027-01-01T00:00:00Z"])).rows[0].r;
    assert.equal(win.creditsModeLaunchUsers, 1);
    assert.deepEqual(win.modelSpend.map((m) => [m.model, m.requests, m.chargedMicroUsd, m.promoUserChargedMicroUsd]), [
      ["m-a", 2, 7 * M, 2 * M],
      ["m-b", 1, 1 * M, 1 * M],
    ]);

    // Service role only.
    const acl = (await db.query("select has_function_privilege('anon','public.grant_venice_promo(uuid,text,bigint,text,text,timestamptz)','execute') a, has_function_privilege('service_role','public.grant_venice_promo(uuid,text,bigint,text,text,timestamptz)','execute') s")).rows[0];
    assert.deepEqual(acl, { a: false, s: true });
    console.log("venice promo SQL checks passed");
  } finally {
    await db.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
