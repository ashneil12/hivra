// Apply the real wallet, snapshot and qualification migrations in
// PostgreSQL/WASM, then the refresh cursor (20260925181500) and the
// standing-first refresh (20260925194500, twice, proving it re-runs), and
// check:
//   - an account with Pro/Power standing is re-read on EVERY run, however many
//     accounts without standing exist (4,000 here; the cursor needed 41 runs,
//     about 10 days, to reach it);
//   - accounts without standing get the leftover capacity, least recently
//     judged first, and all of them are reached over time;
//   - an account is only moved back once it has been judged: a failed read or
//     an unevaluated page is claimed first on the next run;
//   - a claim is a lease: the same run and an overlapping run never claim an
//     account twice;
//   - the lane's cycle over accounts with standing completes only when every
//     one has been judged since it began, and reports how long it has run;
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
  "20260925181500_token_holding_refresh_cursor.sql",
];
const STANDING_FIRST = "20260925194500_token_holding_refresh_standing_first.sql";
const HERMESOS = "0x95ccfd2b81a9667b0cc979992632f98fc853eba3";
const JUNK_ACCOUNTS = 4000;

const read = (name) => fs.readFileSync(path.join(MIGRATIONS, name), "utf8");

// Supabase roles, default privileges (so a missing revoke shows up) and the
// auth helpers the prerequisite policies reference. `serviceRoleDefaults:
// false` leaves service_role out of the default privileges, so a grant the
// migration relies on but never makes shows up too.
async function supabaseLike({ serviceRoleDefaults = true } = {}) {
  const db = new PGlite();
  const grantees = serviceRoleDefaults ? "anon, authenticated, service_role" : "anon, authenticated";
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    alter default privileges in schema public grant execute on functions to ${grantees};
    alter default privileges in schema public grant all on tables to ${grantees};
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
    for (let run = 0; run < 2; run++) await db.exec(read(STANDING_FIRST));

    const one = async (sql, params) => (await db.query(sql, params)).rows[0];
    const all = async (sql, params) => (await db.query(sql, params)).rows;

    let seq = 0x100000;
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
           values ($1, 'evm', 8453, $2, $2, $3, $4, $5, $6) returning id, normalized_address`,
          [userId, row.address, row.is_primary, row.verified_at, row.verification_method, JSON.stringify(row.metadata)]
        )
      );
    };
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
    const snapshot = (userId, walletAddress, balanceRaw, checkedAt, tokenAddress = HERMESOS) =>
      db.query(
        `insert into public.token_holding_snapshots(user_id, wallet_address, normalized_wallet_address, chain_id,
           token_address, token_symbol, token_decimals, balance_raw, balance_display, source, checked_at)
         values ($1, $2, $2, 8453, $3, 'HermesOS', 18, $4::numeric, $4::text, 'base_rpc', $5)`,
        [userId, walletAddress, tokenAddress, balanceRaw, checkedAt]
      );
    const lockMetadata = { bankr: { walletId: "wlt_lock", purpose: "hermesos_lock" } };

    // ── Accounts ───────────────────────────────────────────────────────────
    // Junk: fresh verified primaries with no standing, sorting BEFORE and
    // after the standing accounts, as sign-ups each verifying one wallet.
    await db.exec(`
      insert into public.user_wallets(user_id, chain_type, chain_id, address, normalized_address,
        is_primary, verified_at, verification_method)
      select 'acct_junk_' || lpad(g::text, 5, '0'), 'evm', 8453,
             '0x' || lpad(to_hex(g), 40, '0'), '0x' || lpad(to_hex(g), 40, '0'),
             true, '2026-09-01T00:00:00Z', 'signature'
      from generate_series(1, ${JUNK_ACCOUNTS}) as g`);
    // Standing. The Power holder verified a wallet, then moved the tokens on:
    // it sorts after every junk account, where the cursor reached it last.
    await wallet("zz_power", { is_primary: true });
    await qualification("zz_power");
    // In breach grace, no primary wallet at all.
    await qualification("acct_grace", { currently_eligible: false, last_breach_at: "2026-09-24T00:00:00Z" });
    await boost("acct_boost", true);
    // Grandfathered lock wallet (not primary) whose latest read is positive.
    const lockHeld = await wallet("acct_lock_held", { verification_method: "bankr", metadata: lockMetadata });
    await snapshot("acct_lock_held", lockHeld.normalized_address, "0", "2026-09-20T00:00:00Z");
    await snapshot("acct_lock_held", lockHeld.normalized_address, "5000000000000000000", "2026-09-21T00:00:00Z");
    // Lock wallet whose LATEST read is zero (an older one was positive), and
    // one never read: no standing, but still read for new holdings.
    const lockEmptied = await wallet("acct_lock_emptied", { verification_method: "bankr", metadata: lockMetadata });
    await snapshot("acct_lock_emptied", lockEmptied.normalized_address, "5000000000000000000", "2026-09-20T00:00:00Z");
    await snapshot("acct_lock_emptied", lockEmptied.normalized_address, "0", "2026-09-21T00:00:00Z");
    await wallet("acct_lock_unread", { verification_method: "bankr", metadata: lockMetadata });
    // A positive read of another token, or of another wallet, is not the lock wallet's.
    await snapshot("acct_lock_unread", "0x00000000000000000000000000000000000000aa", "7", "2026-09-21T00:00:00Z");
    // No standing: suspended qualification and ineligible boost, each with a primary.
    await wallet("acct_suspended", { is_primary: true });
    await qualification("acct_suspended", {
      currently_eligible: false,
      last_breach_at: "2026-09-01T00:00:00Z",
      last_suspend_at: "2026-09-03T00:00:00Z",
    });
    await wallet("acct_boost_off", { is_primary: true });
    await boost("acct_boost_off", false);
    // Not a candidate at all: unverified primary, deposit wallet that is not primary.
    await wallet("acct_unverified", { is_primary: true, verified_at: null });
    await wallet("acct_deposit_only", {
      verification_method: "bankr",
      metadata: { bankr: { walletId: "wlt_dep", purpose: "credit_deposit" } },
    });

    const STANDING = ["acct_boost", "acct_grace", "acct_lock_held", "zz_power"];

    const candidates = await all("select user_id, has_standing from public.token_holding_refresh_candidates() order by user_id");
    assert.deepEqual(
      candidates.filter((row) => row.has_standing).map((row) => row.user_id),
      STANDING,
      "standing: eligible or in-grace Pro/Power, eligible boost, lock wallet with a positive latest read"
    );
    const withoutStanding = candidates.filter((row) => !row.has_standing).map((row) => row.user_id);
    assert.equal(withoutStanding.length, JUNK_ACCOUNTS + 4);
    for (const id of ["acct_lock_emptied", "acct_lock_unread", "acct_suspended", "acct_boost_off"]) {
      assert.ok(withoutStanding.includes(id), `${id} is read for new holdings, without standing`);
    }
    for (const id of ["acct_unverified", "acct_deposit_only"]) {
      assert.ok(!candidates.some((row) => row.user_id === id), `${id} is not read at all`);
    }

    // ── One run, as refreshVerifiedHermesTokenHoldings drives it ───────────
    const claim = async (lane, standing, limit) =>
      (await all("select user_id from public.claim_token_holding_refresh_page($1, $2, $3)", [lane, standing, limit])).map(
        (row) => row.user_id
      );
    const judge = async (lane, ids) =>
      (await one("select public.record_token_holding_refresh_judgments($1, $2) as n", [lane, ids])).n;
    const close = (lane) => one("select * from public.close_token_holding_refresh_run($1)", [lane]);
    // The next run starts after the ten-minute lease has lapsed.
    const nextRun = () =>
      db.exec("update public.token_holding_refresh_accounts set claimed_at = claimed_at - interval '6 hours'");
    const runOnce = async (lane, { limit = 100, failing = [] } = {}) => {
      const standing = [];
      for (;;) {
        const page = await claim(lane, true, limit);
        standing.push(...page);
        await judge(lane, page.filter((id) => !failing.includes(id)));
        if (page.length < limit) break;
      }
      const plain = await claim(lane, false, limit);
      await judge(lane, plain.filter((id) => !failing.includes(id)));
      return { standing, plain, cycle: await close(lane) };
    };

    const first = await runOnce("token_holdings");
    assert.deepEqual(first.standing, STANDING, "run 1 reads every account with standing, never-judged first");
    assert.equal(first.plain.length, 100, "accounts without standing get the leftover capacity");
    assert.ok(first.plain.every((id) => !STANDING.includes(id)));
    assert.equal(first.cycle.standing, 4);
    assert.equal(first.cycle.unjudged, 0);
    assert.equal(first.cycle.cycle_completed, true, "every account with standing judged: the cycle completes");

    // Within the lease, neither this run nor an overlapping one claims again.
    assert.deepEqual(await claim("token_holdings", true, 100), [], "leased standing accounts are not re-claimed");
    assert.ok(
      (await claim("token_holdings", false, 100)).every((id) => !first.plain.includes(id)),
      "leased plain accounts are not re-claimed"
    );

    // Every later run re-reads every account with standing, whatever the junk.
    const runs = Math.ceil((JUNK_ACCOUNTS + 4) / 100) + 2;
    const plainSeen = new Set(first.plain);
    const plainOrder = [first.plain];
    for (let run = 2; run <= runs; run++) {
      await nextRun();
      const result = await runOnce("token_holdings");
      assert.deepEqual([...result.standing].sort(), STANDING, `run ${run} reads every account with standing`);
      for (const id of result.plain) plainSeen.add(id);
      plainOrder.push(result.plain);
    }
    assert.equal(plainSeen.size, JUNK_ACCOUNTS + 4, "every account without standing is reached over time");
    // Once all have been judged, the least recently judged come round first:
    // the run that reads the last never-judged accounts fills up with the
    // first run's page, in order.
    const wrap = Math.floor((JUNK_ACCOUNTS + 4) / 100);
    const remaining = (JUNK_ACCOUNTS + 4) % 100;
    assert.deepEqual(
      plainOrder[wrap].slice(remaining),
      plainOrder[0].slice(0, 100 - remaining),
      "rotation restarts with the least recently judged"
    );
    assert.ok(
      plainOrder[wrap].slice(0, remaining).every((id) => !plainOrder.slice(0, wrap).flat().includes(id)),
      "never-judged accounts come before any re-read"
    );

    // ── Failures are retried first, not after a cycle ──────────────────────
    await nextRun();
    await db.exec(
      "update public.token_holding_refresh_accounts set judged_at = judged_at - interval '1 minute' where user_id = 'acct_boost'"
    );
    const failedRun = await runOnce("token_holdings", { failing: ["zz_power"] });
    assert.ok(failedRun.standing.includes("zz_power"));
    assert.equal(failedRun.cycle.cycle_completed, false, "a failed read leaves the cycle open");
    assert.equal(failedRun.cycle.unjudged, 1);
    await nextRun();
    const retry = await claim("token_holdings", true, 1);
    assert.deepEqual(retry, ["zz_power"], "the failed account is claimed first on the next run");
    await judge("token_holdings", retry);
    for (;;) {
      const page = await claim("token_holdings", true, 100);
      await judge("token_holdings", page);
      if (page.length < 100) break;
    }
    const retried = await close("token_holdings");
    assert.equal(retried.cycle_completed, true, "the cycle completes once the failed account is judged");

    // A page that was claimed but never judged (evaluation threw, run died)
    // is also first next run: claiming no longer moves an account back.
    await nextRun();
    const unjudgedPage = await claim("token_holdings", false, 3);
    await nextRun();
    assert.deepEqual(await claim("token_holdings", false, 3), unjudgedPage, "an unjudged page is claimed first next run");

    // ── Overdue cycles ──────────────────────────────────────────────────────
    // Thirty hours pass with no run judging anything (cron down, or every read
    // failing): the open cycle is as old as the last judgments.
    await nextRun();
    await db.exec(
      "update public.token_holding_refresh_accounts set judged_at = judged_at - interval '31 hours' where lane = 'token_holdings'"
    );
    await db.exec(
      "update public.token_holding_refresh_cursors set standing_cycle_started_at = now() - interval '30 hours' where lane = 'token_holdings'"
    );
    const stale = await close("token_holdings");
    assert.equal(stale.cycle_completed, false);
    assert.equal(stale.unjudged, 4, "nothing judged since the cycle began");
    assert.ok(Number(stale.cycle_seconds) >= 30 * 3600, "reports how long the open cycle has run");
    const stillStale = await close("token_holdings");
    assert.ok(Number(stillStale.cycle_seconds) >= 30 * 3600, "an open cycle keeps its start");
    const catchUp = await runOnce("token_holdings");
    assert.equal(catchUp.cycle.cycle_completed, true);
    assert.ok(Number(catchUp.cycle.cycle_seconds) >= 30 * 3600, "the closing run still reports the long cycle");
    const fresh = await close("token_holdings");
    assert.ok(Number(fresh.cycle_seconds) < 60, "the next cycle starts when one completes");

    // A newly qualified account joins the open cycle and is read first.
    await nextRun();
    await wallet("aa_new_power", { is_primary: true });
    await qualification("aa_new_power");
    const joined = await claim("token_holdings", true, 1);
    assert.deepEqual(joined, ["aa_new_power"], "a never-judged account with standing comes first");

    // ── Lanes are independent ──────────────────────────────────────────────
    const tiers = await runOnce("token_tiers", { limit: 2 });
    assert.deepEqual(tiers.standing.sort(), [...STANDING, "aa_new_power"].sort(), "a fresh lane reads all standing");
    assert.equal(tiers.plain.length, 2, "limit caps accounts without standing per run");
    const holdingsJudged = await one(
      "select judged_at from public.token_holding_refresh_accounts where lane = 'token_holdings' and user_id = $1",
      [tiers.plain[0]]
    );
    const tiersJudged = await one(
      "select judged_at from public.token_holding_refresh_accounts where lane = 'token_tiers' and user_id = $1",
      [tiers.plain[0]]
    );
    assert.ok(tiersJudged.judged_at, "judged on the tiers lane");
    assert.notDeepEqual(holdingsJudged?.judged_at ?? null, tiersJudged.judged_at, "the holdings lane keeps its own time");

    // Only claimed accounts can be recorded as judged.
    assert.equal(await judge("token_tiers", ["acct_never_claimed", tiers.plain[0]]), 1);
    assert.equal(
      (await one("select count(*)::int as n from public.token_holding_refresh_accounts where user_id = 'acct_never_claimed'")).n,
      0
    );

    // ── Argument checks ────────────────────────────────────────────────────
    await nextRun();
    assert.equal((await claim("token_tiers", false, 1000)).length, 100, "limit clamps to 100");
    assert.equal((await claim("token_tiers", false, 0)).length, 1, "limit clamps to 1");
    await assert.rejects(() => claim("somewhere_else", true, 10), /unknown token holding refresh lane/);
    await assert.rejects(() => claim("token_holdings", null, 10), /must name the class/);
    await assert.rejects(() => judge("somewhere_else", ["x"]), /unknown token holding refresh lane/);
    await assert.rejects(() => close("somewhere_else"), /unknown token holding refresh lane/);

    // The superseded cursor function still answers for code deployed before this release.
    assert.ok((await all("select user_id from public.claim_token_holding_refresh_batch('token_holdings', 5)")).length > 0);

    // ── Empty database ─────────────────────────────────────────────────────
    const emptyDb = await supabaseLike();
    try {
      await emptyDb.exec(read(STANDING_FIRST));
      assert.equal((await emptyDb.query("select * from public.claim_token_holding_refresh_page('token_holdings', true, 100)")).rows.length, 0);
      const emptyClose = (await emptyDb.query("select * from public.close_token_holding_refresh_run('token_holdings')")).rows[0];
      assert.equal(emptyClose.standing, 0);
      assert.equal(emptyClose.cycle_completed, true, "nothing with standing: every cycle completes");
    } finally {
      await emptyDb.close();
    }

    // ── Grants ─────────────────────────────────────────────────────────────
    const functions = [
      "public.token_holding_refresh_candidates()",
      "public.claim_token_holding_refresh_page(text, boolean, integer)",
      "public.record_token_holding_refresh_judgments(text, text[])",
      "public.close_token_holding_refresh_run(text)",
    ];
    for (const role of ["anon", "authenticated"]) {
      for (const fn of functions) {
        const { allowed } = await one("select has_function_privilege($1, $2, 'EXECUTE') as allowed", [role, fn]);
        assert.equal(allowed, false, `${role} cannot execute ${fn}`);
      }
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const { granted } = await one(
          "select has_table_privilege($1, 'public.token_holding_refresh_accounts', $2) as granted",
          [role, privilege]
        );
        assert.equal(granted, false, `${role} has no ${privilege} on token_holding_refresh_accounts`);
      }
    }
    assert.equal(
      (await one("select relrowsecurity from pg_class where oid = 'public.token_holding_refresh_accounts'::regclass"))
        .relrowsecurity,
      true,
      "RLS enabled"
    );

    // The functions run as their caller: service_role needs its grants from
    // this migration, not only from a project's default privileges.
    const bareDb = await supabaseLike({ serviceRoleDefaults: false });
    try {
      await bareDb.exec(read(STANDING_FIRST));
      for (const privilege of ["SELECT", "INSERT", "UPDATE"]) {
        const { granted } = (
          await bareDb.query(
            "select has_table_privilege('service_role', 'public.token_holding_refresh_accounts', $1) as granted",
            [privilege]
          )
        ).rows[0];
        assert.equal(granted, true, `service_role has ${privilege} on token_holding_refresh_accounts`);
      }
      for (const fn of functions) {
        const { allowed } = (
          await bareDb.query("select has_function_privilege('service_role', $1, 'EXECUTE') as allowed", [fn])
        ).rows[0];
        assert.equal(allowed, true, `service_role can execute ${fn} without default privileges`);
      }
    } finally {
      await bareDb.close();
    }

    console.log("PASS token holding refresh standing first");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
