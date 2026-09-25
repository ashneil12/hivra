// Apply the real wallet, snapshot and qualification migrations in
// PostgreSQL/WASM, then the token-holding refresh cursor and the Bankr deposit
// wallet primary repair (each twice, proving they re-run), and check:
//   - the holdings crons page through EVERY account with token standing,
//     a bounded page per run, per lane, wrapping around;
//   - accounts whose standing has no primary wallet are still candidates;
//   - deposit-wallet primaries are demoted and the displaced signed wallet is
//     restored, never stealing another account's primary;
//   - nothing is callable or readable by the API roles.
// Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const PREREQUISITES = [
  "20260425130000_token_verification_foundation.sql",
  "20260429150000_token_tier_qualifications.sql",
  "20260522120000_venice_compute_boost_qualifications.sql",
  "20260704120000_wallet_primary_global_uniqueness.sql",
];
const CURSOR = "20260925181500_token_holding_refresh_cursor.sql";
const REPAIR = "20260925181600_bankr_deposit_wallet_primary_repair.sql";

const read = (name) => fs.readFileSync(path.join(MIGRATIONS, name), "utf8");

// Supabase roles, default privileges (so a missing revoke shows up) and the
// auth helpers the prerequisite policies reference.
async function supabaseLike() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    create schema auth;
    create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
    create function public.update_updated_at() returns trigger language plpgsql as $$
      begin new.updated_at = now(); return new; end $$;
  `);
  for (const name of PREREQUISITES) await db.exec(read(name));
  return db;
}

async function main() {
  const db = await supabaseLike();
  try {

    const one = async (sql, params) => (await db.query(sql, params)).rows[0];
    const all = async (sql, params) => (await db.query(sql, params)).rows;

    let seq = 0;
    const address = () => `0x${(++seq).toString(16).padStart(40, "0")}`;
    const wallet = async (userId, fields = {}) => {
      const row = {
        address: address(),
        is_primary: false,
        verified_at: "2026-04-01T00:00:00Z",
        verification_method: "signature",
        metadata: {},
        ...fields,
      };
      return (
        await one(
          `insert into public.user_wallets(user_id, chain_type, chain_id, address, normalized_address,
             is_primary, verified_at, verification_method, metadata)
           values ($1, 'evm', 8453, $2, $2, $3, $4, $5, $6) returning id`,
          [userId, row.address, row.is_primary, row.verified_at, row.verification_method, JSON.stringify(row.metadata)]
        )
      ).id;
    };
    const bankr = (purpose) => ({
      verification_method: "bankr",
      metadata: purpose ? { bankr: { walletId: `wlt_${seq}`, purpose } } : { bankr: { walletId: `wlt_${seq}` } },
    });
    const qualification = (userId, fields = {}) =>
      db.query(
        `insert into public.token_tier_qualifications(user_id, tier, qualifying_quantity,
           threshold_at_qualification, qualifying_threshold_tier, currently_eligible, last_breach_at, last_suspend_at)
         values ($1, 'power', 1000, 1000, 'POWER_LAUNCH', $2, $3, $4)`,
        [userId, fields.currently_eligible ?? true, fields.last_breach_at ?? null, fields.last_suspend_at ?? null]
      );
    const boost = (userId, eligible) =>
      db.query(
        `insert into public.venice_compute_boost_qualifications(user_id, currently_eligible, threshold_usd)
         values ($1, $2, 199)`,
        [userId, eligible]
      );

    // ── Repair fixtures, written before the migrations run ──────────────────
    // A: verified a signed wallet, then paid crypto: deposit wallet displaced it.
    const aSigned = await wallet("acct_a", { verified_at: "2026-04-02T00:00:00Z" });
    const aOlder = await wallet("acct_a", { verified_at: "2026-04-01T00:00:00Z" });
    const aDeposit = await wallet("acct_a", { is_primary: true, ...bankr("credit_deposit") });
    // B: only a yearly deposit wallet, no self-custody wallet ever.
    const bDeposit = await wallet("acct_b", { is_primary: true, ...bankr("yearly_subscription") });
    // C: grandfathered lock wallet primary: it can back standing, untouched.
    const cLock = await wallet("acct_c", { is_primary: true, ...bankr("hermesos_lock") });
    // D: legacy Bankr wallet without a purpose: eligible, untouched.
    const dLegacy = await wallet("acct_d", { is_primary: true, ...bankr(null) });
    // E: its signed wallet's address is now another account's primary: no restore.
    const taken = address();
    const eSigned = await wallet("acct_e", { address: taken });
    await wallet("acct_f", { address: taken, is_primary: true });
    const eDeposit = await wallet("acct_e", { is_primary: true, ...bankr("managed_venice_inference") });
    // G: signature wallet primary, deposit wallet not primary: untouched.
    const gSigned = await wallet("acct_g", { is_primary: true });
    const gDeposit = await wallet("acct_g", bankr("credit_deposit"));
    // H: an unverified (taken-over) signed wallet is never restored.
    const hUnverified = await wallet("acct_h", { verified_at: null });
    const hDeposit = await wallet("acct_h", { is_primary: true, ...bankr("credit_deposit") });

    for (let run = 0; run < 2; run++) {
      await db.exec(read(CURSOR));
      await db.exec(read(REPAIR));
    }

    const state = async (id) =>
      one("select is_primary, verified_at, metadata from public.user_wallets where id = $1", [id]);
    const primary = async (id) => (await state(id)).is_primary;

    assert.equal(await primary(aDeposit), false, "A: deposit wallet demoted");
    assert.equal((await state(aDeposit)).metadata.primary_repair.reason, "bankr_deposit_wallet_not_verification_wallet");
    assert.equal(await primary(aSigned), true, "A: most recently verified signed wallet restored");
    assert.equal((await state(aSigned)).metadata.primary_repair.displaced_by, aDeposit);
    assert.equal(await primary(aOlder), false, "A: older signed wallet stays secondary");
    assert.equal(await primary(bDeposit), false, "B: yearly deposit wallet demoted");
    assert.equal(
      (await one("select count(*)::int as n from public.user_wallets where user_id = 'acct_b' and is_primary")).n,
      0,
      "B: nothing to restore"
    );
    assert.equal(await primary(cLock), true, "C: lock wallet untouched");
    assert.equal((await state(cLock)).metadata.primary_repair, undefined);
    assert.equal(await primary(dLegacy), true, "D: legacy Bankr wallet untouched");
    assert.equal(await primary(eDeposit), false, "E: managed Venice deposit wallet demoted");
    assert.equal(await primary(eSigned), false, "E: never steals another account's primary");
    assert.equal(await primary(gSigned), true, "G: untouched");
    assert.equal(await primary(gDeposit), false, "G: untouched");
    assert.equal((await state(gSigned)).metadata.primary_repair, undefined, "G: no repair marker");
    assert.equal(await primary(hDeposit), false, "H: deposit wallet demoted");
    assert.equal(await primary(hUnverified), false, "H: unverified wallet not restored");

    // ── Refresh cursor ─────────────────────────────────────────────────────
    const claim = async (lane, limit) =>
      (await all("select user_id from public.claim_token_holding_refresh_batch($1, $2)", [lane, limit])).map(
        (row) => row.user_id
      );

    // Accounts with standing and no primary wallet at all.
    await qualification("acct_q_eligible");
    await qualification("acct_q_grace", { currently_eligible: false, last_breach_at: "2026-04-10T00:00:00Z" });
    await qualification("acct_q_suspended", {
      currently_eligible: false,
      last_breach_at: "2026-04-01T00:00:00Z",
      last_suspend_at: "2026-04-03T00:00:00Z",
    });
    await boost("acct_boost", true);
    await boost("acct_boost_off", false);
    // Grandfathered lock wallet that is not the primary.
    await wallet("acct_lock_secondary", bankr("hermesos_lock"));
    // Deposit wallet only (not primary after the repair): no standing to judge.
    await wallet("acct_deposit_only", bankr("credit_deposit"));
    // Enough verified primary wallets for several pages.
    for (let i = 0; i < 230; i++) await wallet(`acct_w${String(i).padStart(3, "0")}`, { is_primary: true });

    const expected = (
      await all(`
        select distinct user_id from public.user_wallets where is_primary and verified_at is not null
        union select 'acct_q_eligible' union select 'acct_q_grace' union select 'acct_boost'
        union select 'acct_lock_secondary' union select 'acct_c'
        order by 1`)
    ).map((row) => row.user_id);
    // Primaries a (restored), c (lock), d (legacy), f, g + 230; plus the
    // no-primary standing accounts q_eligible, q_grace, boost, lock_secondary.
    assert.equal(expected.length, 239);

    const pages = [await claim("token_holdings", 100), await claim("token_holdings", 100), await claim("token_holdings", 100)];
    for (const page of pages) assert.ok(page.length <= 100, "bounded page");
    assert.equal(pages[0].length, 100);
    assert.equal(pages[1].length, 100);
    const seen = new Set(pages.flat());
    assert.deepEqual([...seen].sort(), [...expected].sort(), "three runs visit every candidate");
    for (const excluded of ["acct_q_suspended", "acct_boost_off", "acct_deposit_only", "acct_b", "acct_e", "acct_h"]) {
      assert.ok(!seen.has(excluded), `${excluded} has no standing to judge`);
    }
    // The first two pages never overlap; the third wraps to the start.
    assert.equal(new Set([...pages[0], ...pages[1]]).size, 200);
    const wrapped = pages[2].slice(expected.length - 200);
    assert.deepEqual(wrapped, expected.slice(0, 100 - (expected.length - 200)), "wraps to the start in order");

    // Lanes keep their own position.
    const tiersFirst = await claim("token_tiers", 5);
    assert.deepEqual(tiersFirst, expected.slice(0, 5), "a fresh lane starts at the beginning");
    const positions = await all("select lane, after_user_id from public.token_holding_refresh_cursors order by lane");
    assert.deepEqual(
      positions.map((row) => [row.lane, row.after_user_id]),
      [
        ["token_holdings", pages[2][pages[2].length - 1]],
        ["token_tiers", expected[4]],
      ]
    );

    // Limits are clamped to 1..100.
    assert.equal((await claim("token_tiers", 1000)).length, 100);
    assert.equal((await claim("token_tiers", 0)).length, 1);
    assert.equal((await claim("token_tiers", null)).length, 100);

    // An unknown lane is refused (and records nothing).
    await assert.rejects(() => claim("somewhere_else", 10), /check constraint/);

    // Nothing to judge: an empty page leaves the position alone.
    const emptyDb = await supabaseLike();
    try {
      await emptyDb.exec(read(CURSOR));
      const rows = (await emptyDb.query("select * from public.claim_token_holding_refresh_batch('token_holdings', 100)")).rows;
      assert.equal(rows.length, 0);
      const cursor = (await emptyDb.query("select after_user_id from public.token_holding_refresh_cursors")).rows[0];
      assert.equal(cursor.after_user_id, null);
    } finally {
      await emptyDb.close();
    }

    // ── Grants ─────────────────────────────────────────────────────────────
    const fn = "public.claim_token_holding_refresh_batch(text, integer)";
    for (const role of ["anon", "authenticated"]) {
      const { allowed } = await one("select has_function_privilege($1, $2, 'EXECUTE') as allowed", [role, fn]);
      assert.equal(allowed, false, `${role} cannot claim a refresh batch`);
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const { granted } = await one(
          "select has_table_privilege($1, 'public.token_holding_refresh_cursors', $2) as granted",
          [role, privilege]
        );
        assert.equal(granted, false, `${role} has no ${privilege} on the cursor table`);
      }
    }
    assert.equal(
      (await one("select has_function_privilege('service_role', $1, 'EXECUTE') as allowed", [fn])).allowed,
      true
    );
    assert.equal(
      (await one("select relrowsecurity from pg_class where oid = 'public.token_holding_refresh_cursors'::regclass"))
        .relrowsecurity,
      true,
      "RLS enabled"
    );

    console.log("PASS token holding refresh cursor");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
