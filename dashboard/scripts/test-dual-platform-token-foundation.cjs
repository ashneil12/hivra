// Apply the real token, yearly and managed-Venice migrations in
// PostgreSQL/WASM, then the dual platform token foundation (twice), and
// exercise it: $HermesOS backfills, the dormant and activated access rule, the
// grandfather cohort and conversion grace, token-scoped yearly settlement, the
// shared token-wallet balance guard, the token-aware stale-state reset and the
// function grants. Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const PREREQUISITES = [
  "20260425130000_token_verification_foundation.sql",
  "20260429150000_token_tier_qualifications.sql",
  "20260430090000_deposit_quotes.sql",
  "20260501090000_yearly_token_subscriptions.sql",
  "20260501100000_bankr_deposit_credentials_yearly_subscription_purpose.sql",
  "20260512180000_managed_venice_wallets.sql",
  "20260512181000_managed_venice_token_quotes.sql",
  "20260606130100_managed_venice_token_lots_unique_quote.sql",
  "20260606140100_managed_venice_reservation_balance_guard.sql",
  "20260922222737_yearly_token_payment_attribution.sql",
  "20260922224500_managed_venice_token_transfer_dedupe.sql",
];
const MIGRATION = "20260923150000_dual_platform_token_foundation.sql";
// Follow-up: the stale-state reset's base tier counts every allowed token.
const FOLLOW_UP = "20260923203000_reconcile_token_base_any_allowed_token.sql";
const HERMESOS = "0x95ccfd2b81a9667b0cc979992632f98fc853eba3";
const HIVRA = "0x1111111111111111111111111111111111111111";
const ACTIVATED_AT = "2026-10-01T00:00:00.000Z";
const BEFORE = "2026-09-20T00:00:00.000Z";
const AFTER = "2026-10-02T00:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const read = (name) => fs.readFileSync(path.join(MIGRATIONS, name), "utf8");
const tx = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const at = (base, ms) => new Date(Date.parse(base) + ms).toISOString();

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
      create schema auth;
      create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
      create function public.update_updated_at() returns trigger language plpgsql as $$
        begin new.updated_at = now(); return new; end $$;
      create table public.bankr_deposit_wallet_credentials (
        id uuid primary key default gen_random_uuid(), purpose text);
      create table public.hermes_subscriptions (
        user_id text primary key, plan text not null, status text not null,
        stripe_subscription_id text, instance_limit integer not null,
        total_cpu_budget numeric not null, total_ram_budget integer not null,
        current_period_start timestamptz, current_period_end timestamptz,
        grace_period_ends_at timestamptz, updated_at timestamptz not null);
      create table public.hermes_instances (
        id uuid primary key default gen_random_uuid(), user_id text not null,
        status text not null, resource_tier text, cpu_limit numeric, ram_limit integer,
        tier_change_pending boolean not null default false,
        updated_at timestamptz not null default now());
    `);
    for (const name of PREREQUISITES) await db.exec(read(name));
    // What 20260923001301 does to the reservation guard (the rest of that file
    // needs unrelated credit tables): this migration replaces the function
    // and must keep it closed to the API roles.
    await db.exec(`revoke all on function public.enforce_managed_venice_reservation_balance()
      from public, anon, authenticated;`);

    const one = async (sql, params) => (await db.query(sql, params)).rows[0];
    const all = async (sql, params) => (await db.query(sql, params)).rows;

    // Pre-existing rows, written before the migration.
    const qualify = (user, qualifiedAt, eligible = true) =>
      db.query(
        `insert into token_tier_qualifications (user_id, tier, qualifying_quantity, threshold_at_qualification,
           qualifying_threshold_tier, qualified_at, currently_eligible, created_at)
         values ($1, 'pro', 1000, 1000, 'PRO_STANDARD', $2, $3, $2)`,
        [user, qualifiedAt, eligible]
      );
    await qualify("user_qual", BEFORE);
    await db.query(
      `insert into yearly_token_quotes (user_id, tier, usd_target_cents, price_usd_at_quote,
         tokens_required_raw, tokens_required_display, deposit_address, quoted_at, expires_at, status)
       values ('user_legacy_quote', 'pro', 4900, '0.00001', 1000, '1000', '0xabc', $1, $2, 'expired')`,
      [BEFORE, at(BEFORE, 20 * 60_000)]
    );

    await db.exec(read(MIGRATION));
    await db.exec(read(MIGRATION)); // rerun-safe
    await db.exec(read(FOLLOW_UP));
    await db.exec(read(FOLLOW_UP)); // rerun-safe

    // ── backfills and shapes ───────────────────────────────────────────
    assert.equal((await one(`select token_key from token_tier_qualifications where user_id = 'user_qual'`)).token_key, "hermesos");
    const legacyQuote = await one(`select token_key, token_address from yearly_token_quotes where user_id = 'user_legacy_quote'`);
    assert.deepEqual(legacyQuote, { token_key: "hermesos", token_address: HERMESOS });
    assert.equal(
      (await one(`select pg_get_constraintdef(oid) def from pg_constraint where conname = 'token_entitlement_configs_pkey'`)).def,
      "PRIMARY KEY (tier_key, token_key)"
    );
    assert.equal((await one(`select token_key from token_entitlement_configs where tier_key = 'token_base'`)).token_key, "hermesos");
    for (const table of ["deposit_quotes", "yearly_token_subscriptions", "managed_venice_token_quotes", "managed_venice_token_lots"]) {
      const cols = await all(
        `select column_name, column_default from information_schema.columns
          where table_schema = 'public' and table_name = $1 and column_name in ('token_key', 'token_address') order by 1`,
        [table]
      );
      assert.equal(cols.length, 2, `${table} token columns`);
    }
    // Still one qualification row per (user, tier): a second token row is refused.
    await assert.rejects(
      db.query(
        `insert into token_tier_qualifications (user_id, tier, qualifying_quantity, threshold_at_qualification,
           qualifying_threshold_tier, token_key) values ('user_qual', 'pro', 1, 1, 'PRO_STANDARD', 'hivra')`
      ),
      (error) => error.code === "23505"
    );

    // ── dormant: only $HermesOS ────────────────────────────────────────
    const allowed = async (user, key, now) =>
      (await one(`select public.token_key_allowed_for_user($1, $2, $3) ok`, [user, key, now])).ok;
    assert.equal(await allowed("anyone", "hermesos", AFTER), true);
    assert.equal(await allowed("anyone", "hivra", AFTER), false);
    assert.equal(await allowed("anyone", "vvv", AFTER), false);
    assert.equal(
      (await one(`select public.ensure_token_grandfather_membership('user_qual', $1) ok`, [AFTER])).ok,
      false,
      "no cohort before activation"
    );

    // ── cohort evidence ────────────────────────────────────────────────
    const account = async (user) =>
      (await one(`insert into managed_venice_wallet_accounts (user_id) values ($1) returning id`, [user])).id;
    await db.query(
      `insert into yearly_token_subscriptions (user_id, tier, paid_at, expires_at, amount_received_raw, status)
       values ('user_yearly', 'power', $1, $2, 1000, 'active')`,
      [BEFORE, at(BEFORE, 365 * DAY_MS)]
    );
    const lotAccount = await account("user_lot");
    await db.query(
      `insert into managed_venice_token_lots (account_id, user_id, token_amount_raw, remaining_token_amount_raw,
         snapshot_price_usd, original_value_micro_usd, remaining_value_micro_usd, quote_source, quoted_at, created_at)
       values ($1, 'user_lot', 10, 10, '1', 1000, 1000, 'dexscreener', $2, $2)`,
      [lotAccount, BEFORE]
    );
    const snapshot = (user, token, qualifies, checkedAt) =>
      db.query(
        `insert into token_holding_snapshots (user_id, wallet_address, normalized_wallet_address, chain_id,
           token_address, token_symbol, token_decimals, balance_raw, balance_display, qualifies_base_tier, source, checked_at)
         values ($1, '0xw', '0xw', 8453, $2, 'X', 18, 5, '5', $3, 'base_rpc', $4)`,
        [user, token, qualifies, checkedAt]
      );
    await snapshot("user_base", HERMESOS, true, BEFORE);
    await snapshot("user_dust", HERMESOS, false, BEFORE); // below 1 token: not evidence
    await qualify("user_new", AFTER); // after activation: not evidence

    const record = (address = HIVRA, activatedAt = ACTIVATED_AT, now = AFTER) =>
      one(`select public.record_platform_token_activation('hivra', 8453, $1, 'HIVRA', 18, $2, $3) r`, [
        address,
        activatedAt,
        now,
      ]).then((row) => row.r);

    assert.equal((await record(HIVRA, ACTIVATED_AT, BEFORE)).status, "not_yet_active");
    assert.equal((await record(HERMESOS)).status, "invalid_address");
    assert.equal(
      (await one(`select public.record_platform_token_activation('hivra', 1, $1, 'HIVRA', 18, $2, $3) r`, [HIVRA, ACTIVATED_AT, AFTER])).r.status,
      "unsupported_chain"
    );
    // Superset CHECK constraints are added NOT VALID: no scan under lock.
    assert.equal(
      (await one(`select convalidated from pg_constraint where conname = 'managed_venice_usage_events_wallet_type_check'`)).convalidated,
      false
    );
    const first = await record();
    assert.equal(first.status, "activated");
    assert.equal(first.cohort_size, 4);
    const cohort = await all(`select user_id, evidence from token_grandfather_cohort order by user_id`);
    assert.deepEqual(
      cohort.map((row) => [row.user_id, row.evidence]),
      [
        ["user_base", ["hermesos_base_tier_balance"]],
        ["user_lot", ["managed_venice_token_deposit"]],
        ["user_qual", ["token_tier_qualification"]],
        ["user_yearly", ["yearly_token_subscription"]],
      ]
    );
    const hivraConfig = await one(
      `select token_address, token_symbol, min_balance_raw::text, active from token_entitlement_configs
        where tier_key = 'token_base' and token_key = 'hivra'`
    );
    assert.deepEqual(hivraConfig, { token_address: HIVRA, token_symbol: "HIVRA", min_balance_raw: "1000000000000000000", active: true });

    const again = await record();
    assert.equal(again.status, "already_active");
    assert.equal(again.cohort_inserted, 0);
    assert.equal((await record("0x2222222222222222222222222222222222222222")).status, "address_conflict");
    assert.equal((await record(HIVRA, "2026-10-01T01:00:00.000Z")).status, "activation_instant_conflict");

    // A member the bulk pass missed is recorded on first check; a
    // post-activation user never is.
    await qualify("user_late_seen", BEFORE);
    assert.equal((await one(`select public.ensure_token_grandfather_membership('user_late_seen', $1) ok`, [AFTER])).ok, true);
    assert.equal((await one(`select public.ensure_token_grandfather_membership('user_new', $1) ok`, [AFTER])).ok, false);

    // ── activated access rule and conversion grace ─────────────────────
    assert.equal(await allowed("user_qual", "hermesos", AFTER), true, "cohort keeps $HermesOS");
    assert.equal(await allowed("user_qual", "hivra", AFTER), true);
    assert.equal(await allowed("user_new", "hermesos", AFTER), false, "new users are $HIVRA only");
    assert.equal(await allowed("user_new", "hivra", AFTER), true);
    assert.equal(await allowed("user_new", "hermesos", at(ACTIVATED_AT, -HOUR_MS)), true, "before the instant");

    await db.query(
      `update token_grandfather_cohort set converted_at = $1, conversion_grace_ends_at = $2 where user_id = 'user_qual'`,
      [AFTER, at(AFTER, 72 * HOUR_MS)]
    );
    assert.equal(await allowed("user_qual", "hermesos", at(AFTER, 71 * HOUR_MS)), true, "either token during grace");
    assert.equal(await allowed("user_qual", "hermesos", at(AFTER, 72 * HOUR_MS)), false, "$HIVRA only after grace");
    await assert.rejects(
      db.query(`update token_grandfather_cohort set converted_at = $1 where user_id = 'user_yearly'`, [AFTER]),
      (error) => error.code === "23514"
    );

    // ── yearly settlement credits only the quote's token ───────────────
    const yearlyQuote = async (user, tokenKey, tokenAddress) =>
      (
        await one(
          `insert into yearly_token_quotes (user_id, tier, usd_target_cents, price_usd_at_quote, tokens_required_raw,
             tokens_required_display, deposit_address, quoted_at, expires_at, token_key, token_address)
           values ($1, 'pro', 4900, '0.001', 1000, '1000', '0xdeposit', $2, $3, $4, $5) returning id`,
          [user, AFTER, at(AFTER, 20 * 60_000), tokenKey, tokenAddress]
        )
      ).id;
    const settle = (quoteId, n, token) =>
      one(`select public.settle_yearly_platform_token_payment($1, $2, 0, 1000, $3, $4, $3) r`, [quoteId, tx(n), AFTER, token]).then(
        (row) => row.r
      );
    const legacySettle = (quoteId, n) =>
      one(`select public.settle_yearly_token_payment($1, $2, 0, 1000, $3, $3) r`, [quoteId, tx(n), AFTER]).then((row) => row.r);

    const hivraQuote = await yearlyQuote("user_new", "hivra", HIVRA);
    const wrong = await settle(hivraQuote, 1, HERMESOS);
    assert.equal(wrong.status, "wrong_token");
    assert.equal((await legacySettle(hivraQuote, 2)).status, "wrong_token", "old signature never settles $HIVRA");
    assert.equal((await one(`select status from yearly_token_quotes where id = $1`, [hivraQuote])).status, "active");
    assert.equal((await one(`select count(*)::int n from yearly_token_subscriptions where user_id = 'user_new'`)).n, 0);
    const paid = await settle(hivraQuote, 3, HIVRA.toUpperCase().replace("0X", "0x"));
    assert.equal(paid.status, "activated");
    const sub = await one(`select token_key, token_address from yearly_token_subscriptions where id = $1`, [paid.subscription_id]);
    assert.deepEqual(sub, { token_key: "hivra", token_address: HIVRA });

    const hermesosQuote = await yearlyQuote("user_qual", "hermesos", HERMESOS);
    const legacyPaid = await legacySettle(hermesosQuote, 4);
    assert.equal(legacyPaid.status, "activated", "old signature still settles $HermesOS");
    assert.equal(
      (await one(`select token_key from yearly_token_subscriptions where id = $1`, [legacyPaid.subscription_id])).token_key,
      "hermesos"
    );

    // ── both token wallet types draw on one pool of token lots ─────────
    const guardAccount = await account("user_wallet");
    await db.query(
      `insert into managed_venice_token_lots (account_id, user_id, token_amount_raw, remaining_token_amount_raw,
         snapshot_price_usd, original_value_micro_usd, remaining_value_micro_usd, quote_source, quoted_at, source, token_key, token_address)
       values ($1, 'user_wallet', 10, 10, '1', 1000, 1000, 'dexscreener', $2, 'hivra_deposit', 'hivra', $3)`,
      [guardAccount, AFTER, HIVRA]
    );
    const reserve = (walletType, amount, ref) =>
      db.query(
        `insert into managed_venice_reservations (account_id, user_id, wallet_type, reference_id,
           estimated_cost_micro_usd, reserved_micro_usd) values ($1, 'user_wallet', $2, $3, $4, $4)`,
        [guardAccount, walletType, ref, amount]
      );
    await reserve("hivra", 600, "r1");
    await assert.rejects(reserve("hermesos", 500, "r2"), (error) => error.code === "P0001");
    await reserve("hermesos", 400, "r3");
    await assert.rejects(
      db.query(
        `insert into managed_venice_financial_events (user_id, wallet_type, event_type, reference_id, idempotency_key)
         values ('user_wallet', 'dogecoin', 'token_deposit', 'x', 'x')`
      ),
      (error) => error.code === "23514"
    );
    await db.query(
      `insert into managed_venice_financial_events (user_id, wallet_type, event_type, reference_id, idempotency_key)
       values ('user_wallet', 'hivra', 'token_deposit', 'y', 'y')`
    );

    // ── stale-state reset counts only allowed tokens ───────────────────
    const reset = async (user, now) => {
      await db.query(
        `insert into hermes_subscriptions (user_id, plan, status, instance_limit, total_cpu_budget, total_ram_budget, updated_at)
         values ($1, 'operator', 'canceled', 3, 2, 4096, $2)
         on conflict (user_id) do update set plan = 'operator', status = 'canceled', updated_at = $2`,
        [user, "2026-09-01T00:00:00.000Z"]
      );
      const result = await one(
        `select public.reconcile_stale_subscription_state_to_free($1, 'operator', 'canceled', null, $2, $3) r`,
        [user, "2026-09-01T00:00:00.000Z", now]
      );
      return result.r.target_tier;
    };
    // user_new paid a $HIVRA year: that entitles it whatever else it holds.
    assert.equal(await reset("user_new", AFTER), "operator");
    // user_post holds an eligible $HermesOS Pro row written after activation
    // (not a cohort member): it no longer grants Pro.
    await qualify("user_post", AFTER);
    assert.equal(await reset("user_post", AFTER), "credit_base");
    // user_late_seen is a cohort member with an eligible $HermesOS Pro row.
    assert.equal(await reset("user_late_seen", AFTER), "operator");
    // user_qual converted and its grace is over, but its $HermesOS row has not
    // been moved to $HIVRA yet: the row still counts (no access gap).
    assert.equal(await reset("user_qual", at(AFTER, 100 * HOUR_MS)), "operator");
    // Base tier: a cohort member's $HermesOS snapshot counts, a non-member's
    // does not, and a $HIVRA snapshot counts for anyone.
    assert.equal(await reset("user_base", AFTER), "token_base");
    await snapshot("user_hivra_only", HERMESOS, true, AFTER);
    assert.equal(await reset("user_hivra_only", AFTER), "credit_base");
    await snapshot("user_hivra_only", HIVRA, true, at(AFTER, 60_000));
    assert.equal(await reset("user_hivra_only", at(AFTER, 120_000)), "token_base");

    // A grandfathered member holding only $HermesOS keeps the base tier even
    // though the refresh wrote a newer (empty) $HIVRA snapshot after it.
    await snapshot("user_base", HIVRA, false, at(AFTER, 180_000));
    assert.equal(await reset("user_base", at(AFTER, 240_000)), "token_base");

    // ── grants ─────────────────────────────────────────────────────────
    for (const signature of [
      "public.token_key_allowed_for_user(text, text, timestamptz)",
      "public.token_tier_row_counts_for_user(text, text, timestamptz)",
      "public.enforce_managed_venice_reservation_balance()",
      "public.hermesos_grandfather_evidence(text, timestamptz)",
      "public.ensure_token_grandfather_membership(text, timestamptz)",
      "public.record_platform_token_activation(text, integer, text, text, integer, timestamptz, timestamptz)",
      "public.settle_yearly_platform_token_payment(uuid, text, integer, numeric, timestamptz, text, timestamptz)",
      "public.settle_yearly_token_payment(uuid, text, integer, numeric, timestamptz, timestamptz)",
      "public.reconcile_stale_subscription_state_to_free(text, text, text, text, timestamptz, timestamptz)",
    ]) {
      const grants = await one(
        `select has_function_privilege('anon', $1, 'execute') anon,
                has_function_privilege('authenticated', $1, 'execute') authenticated,
                has_function_privilege('service_role', $1, 'execute') service_role`,
        [signature]
      );
      assert.deepEqual(grants, { anon: false, authenticated: false, service_role: true }, signature);
    }
    for (const table of ["platform_token_activations", "token_grandfather_cohort"]) {
      assert.equal((await one(`select relrowsecurity from pg_class where oid = $1::regclass`, [`public.${table}`])).relrowsecurity, true);
    }

    console.log("PASS dual platform token foundation");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
