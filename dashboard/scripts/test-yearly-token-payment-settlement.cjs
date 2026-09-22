// Apply the real yearly-token and managed-Venice migrations in PostgreSQL/WASM,
// then the yearly payment-attribution migration (twice), and exercise
// settle_yearly_token_payment plus the constraints and indexes the reconciler
// and sweep rely on. Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const PREREQUISITES = [
  "20260501090000_yearly_token_subscriptions.sql",
  "20260501100000_bankr_deposit_credentials_yearly_subscription_purpose.sql",
  "20260512180000_managed_venice_wallets.sql",
  "20260512181000_managed_venice_token_quotes.sql",
  "20260606130100_managed_venice_token_lots_unique_quote.sql",
];
const MIGRATION = "20260922210000_yearly_token_payment_attribution.sql";
const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365 * DAY_MS;
const NOW = "2026-09-22T12:00:00.000Z";

const read = (name) => fs.readFileSync(path.join(MIGRATIONS, name), "utf8");
const tx = (n) => `0x${n.toString(16).padStart(64, "0")}`;

async function rejectsWith(code, action) {
  await assert.rejects(action, (error) => error.code === code);
}

async function main() {
  const db = new PGlite();
  try {
    // Supabase-provided objects the real migrations reference.
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
      create function public.update_updated_at() returns trigger language plpgsql as $$
        begin new.updated_at = now(); return new; end $$;
      create table public.bankr_deposit_wallet_credentials (
        id uuid primary key default gen_random_uuid(), purpose text);
    `);
    for (const name of PREREQUISITES) await db.exec(read(name));

    const one = async (sql, params) => (await db.query(sql, params)).rows[0];
    const all = async (sql, params) => (await db.query(sql, params)).rows;
    const quote = async (overrides = {}) => {
      const row = {
        user_id: "user_1",
        tier: "pro",
        deposit_address: "0x000000000000000000000000000000000000BA5E",
        quoted_at: "2026-09-22T11:40:00Z",
        expires_at: "2026-09-22T12:00:00Z",
        status: "active",
        ...overrides,
      };
      return (
        await one(
          `insert into public.yearly_token_quotes
             (user_id, tier, usd_target_cents, price_usd_at_quote, tokens_required_raw,
              tokens_required_display, deposit_address, quoted_at, expires_at, status)
           values ($1, $2, 4900, '0.0000025', 1000, '1000', $3, $4, $5, $6) returning id`,
          [row.user_id, row.tier, row.deposit_address, row.quoted_at, row.expires_at, row.status]
        )
      ).id;
    };
    const settle = async (quoteId, hash, amount = "1000", now = NOW, logIndex = 3) =>
      (
        await one(
          "select public.settle_yearly_token_payment($1, $2, $3, $4, $5, $6) as result",
          [quoteId, hash, logIndex, amount, "2026-09-22T11:50:00Z", now]
        )
      ).result;
    const subs = (userId = "user_1") =>
      all(
        `select id, status, tier, yearly_quote_id, deposit_tx_hash, deposit_log_index, deposit_address,
                amount_received_raw::text, sweep_status, paid_at, expires_at, metadata
           from public.yearly_token_subscriptions where user_id = $1 order by created_at, paid_at`,
        [userId]
      );

    // A legacy subscription (pre-attribution) survives and gets its
    // deposit_address backfilled from the metadata the old code recorded.
    const legacyQuote = await quote({ user_id: "user_legacy", status: "consumed" });
    const legacyExpired = await quote({ user_id: "user_legacy", tier: "power", status: "expired" });
    await db.query(
      `insert into public.yearly_token_subscriptions
         (user_id, tier, yearly_quote_id, expires_at, amount_received_raw, sweep_status, metadata)
       values ('user_legacy', 'pro', $1, now() + interval '200 days', 5, 'swept',
               '{"depositAddress": "0x78F4ff3c8d68afdb11d09c4201e800c55432bb05"}'::jsonb)`,
      [legacyQuote]
    );

    const migration = read(MIGRATION);
    await db.exec(migration);
    await db.exec(migration); // Rerun-safe.

    const [legacy] = await subs("user_legacy");
    assert.equal(legacy.deposit_address, "0x78f4ff3c8d68afdb11d09c4201e800c55432bb05");
    assert.equal(legacy.status, "active");
    // Final legacy quotes are closed for attribution; open ones stay watched.
    const closedAt = async (id) =>
      (await one("select attribution_closed_at from public.yearly_token_quotes where id = $1", [id])).attribution_closed_at;
    assert.ok(await closedAt(legacyQuote), "legacy consumed quote closed");
    assert.equal(await closedAt(legacyExpired), null);

    // New statuses are accepted; unknown ones still rejected.
    await rejectsWith("23514", () =>
      db.query("update public.yearly_token_quotes set status = 'bogus' where id = $1", [legacyQuote])
    );
    await rejectsWith("23514", () =>
      db.query("update public.yearly_token_subscriptions set sweep_status = 'bogus' where user_id = 'user_legacy'")
    );

    // ── Fresh activation ──────────────────────────────────────────────
    const q1 = await quote();
    const activated = await settle(q1, tx(1).toUpperCase().replace("0X", "0x"));
    assert.equal(activated.status, "activated");
    assert.equal(activated.transaction_hash, tx(1));
    const [s1] = await subs();
    assert.equal(s1.id, activated.subscription_id);
    assert.equal(s1.status, "active");
    assert.equal(s1.yearly_quote_id, q1);
    assert.equal(s1.deposit_tx_hash, tx(1));
    assert.equal(s1.deposit_log_index, 3);
    assert.equal(s1.deposit_address, "0x000000000000000000000000000000000000ba5e");
    assert.equal(s1.amount_received_raw, "1000");
    assert.equal(s1.sweep_status, "pending");
    assert.equal(new Date(s1.paid_at).toISOString(), NOW);
    assert.equal(new Date(s1.expires_at).getTime(), Date.parse(NOW) + YEAR_MS);
    assert.equal(s1.metadata.tokensRequiredRaw, "1000");
    assert.equal(s1.metadata.renewsSubscriptionId, undefined);
    const q1Row = await one(
      "select status, consumed_tx_hash, consumed_balance_raw::text, metadata from public.yearly_token_quotes where id = $1",
      [q1]
    );
    assert.deepEqual(
      { status: q1Row.status, tx: q1Row.consumed_tx_hash, amount: q1Row.consumed_balance_raw },
      { status: "consumed", tx: tx(1), amount: "1000" }
    );
    assert.equal(q1Row.metadata.consumedLogIndex, 3);
    // Settling does not close attribution: the range is still watched for
    // duplicate or late transfers until it has been fully scanned.
    assert.equal(await closedAt(q1), null);

    // Idempotent replay; a different tx on a settled quote is a conflict.
    // A multi-send's OTHER log in the same tx is a different transfer.
    assert.equal((await settle(q1, tx(1), "1000", NOW, 4)).status, "quote_settled_with_other_transaction");
    const replay = await settle(q1, tx(1));
    assert.equal(replay.status, "already_settled");
    assert.equal(replay.subscription_id, activated.subscription_id);
    assert.equal((await settle(q1, tx(2))).status, "quote_settled_with_other_transaction");
    assert.equal((await subs()).length, 1);

    // ── One transfer pays at most one thing ───────────────────────────
    const qPower = await quote({ tier: "power" });
    assert.equal((await settle(qPower, tx(1))).status, "transaction_already_claimed");
    const account = (
      await one("insert into public.managed_venice_wallet_accounts (user_id) values ('user_1') returning id")
    ).id;
    await db.query(
      `insert into public.managed_venice_token_quotes
         (account_id, user_id, token_amount_raw, snapshot_price_usd, locked_value_micro_usd,
          deposit_address, quoted_at, expires_at, status, source, transaction_hash)
       values ($1, 'user_1', 1000, '0.05', 50000000, '0x000000000000000000000000000000000000ba5e', now() - interval '1 hour',
               now() - interval '40 minutes', 'settled', 'dexscreener', $2)`,
      [account, tx(0x77)]
    );
    assert.equal((await settle(qPower, tx(0x77))).status, "transaction_already_claimed");
    await db.query(
      `insert into public.managed_venice_token_lots
         (account_id, user_id, token_amount_raw, remaining_token_amount_raw, snapshot_price_usd,
          original_value_micro_usd, remaining_value_micro_usd, quote_source, quoted_at, transaction_hash)
       values ($1, 'user_1', 1000, 1000, '0.05', 50000000, 50000000, 'dexscreener', now(), $2)`,
      [account, tx(0x78)]
    );
    assert.equal((await settle(qPower, tx(0x78))).status, "transaction_already_claimed");
    // A managed-Venice quote in review does not own the tx it recorded (the
    // pre-attribution Venice flow wrote REJECTED transfers there).
    await db.query(
      `insert into public.managed_venice_token_quotes
         (account_id, user_id, token_amount_raw, snapshot_price_usd, locked_value_micro_usd,
          deposit_address, quoted_at, expires_at, status, source, transaction_hash)
       values ($1, 'user_1', 1000, '0.05', 50000000, '0x000000000000000000000000000000000000ba5e', now() - interval '3 hours',
               now() - interval '160 minutes', 'manual_review_required', 'dexscreener', $2)`,
      [account, tx(0x79)]
    );
    const qContested = await quote({ user_id: "user_contested" });
    assert.equal((await settle(qContested, tx(0x79))).status, "activated");
    const qPowerRow = await one("select status, consumed_tx_hash from public.yearly_token_quotes where id = $1", [qPower]);
    assert.deepEqual(qPowerRow, { status: "active", consumed_tx_hash: null });

    // ── Renewal of an active subscription: +365 days from its end ─────
    await db.query("update public.yearly_token_quotes set status = 'expired' where id = $1", [qPower]);
    const q2 = await quote();
    const renewNow = "2026-10-01T00:00:00.000Z";
    const renewed = await settle(q2, tx(2), "1500", renewNow);
    assert.equal(renewed.status, "renewed");
    assert.equal(renewed.renewed_subscription_id, activated.subscription_id);
    const afterRenewal = await subs();
    const live = afterRenewal.filter((row) => row.status === "active" || row.status === "grace");
    assert.equal(live.length, 1);
    assert.equal(live[0].id, renewed.subscription_id);
    assert.equal(new Date(live[0].expires_at).getTime(), Date.parse(NOW) + 2 * YEAR_MS);
    assert.equal(live[0].amount_received_raw, "1500");
    assert.equal(live[0].metadata.renewsSubscriptionId, activated.subscription_id);
    const old = afterRenewal.find((row) => row.id === activated.subscription_id);
    assert.equal(old.status, "renewed");
    assert.equal(old.metadata.renewedBySubscriptionId, renewed.subscription_id);
    assert.equal(old.metadata.renewedByQuoteId, q2);

    // ── Renewal during grace: +365 days from the payment ──────────────
    await db.query("update public.yearly_token_subscriptions set status = 'grace', expires_at = $2 where id = $1", [
      renewed.subscription_id,
      "2026-09-01T00:00:00Z",
    ]);
    const q3 = await quote();
    const graceNow = "2026-09-05T00:00:00.000Z";
    const fromGrace = await settle(q3, tx(3), "1000", graceNow);
    assert.equal(fromGrace.status, "renewed");
    assert.equal(new Date(fromGrace.expires_at).getTime(), Date.parse(graceNow) + YEAR_MS);

    // ── An 'expired' quote (window passed, payment seen late) settles ──
    const q4 = await quote({ user_id: "user_2", status: "expired" });
    assert.equal((await settle(q4, tx(4))).status, "activated");

    // ── Closed quotes never settle ────────────────────────────────────
    for (const status of ["cancelled", "manual_review"]) {
      const closed = await quote({ user_id: `user_${status}`, status });
      assert.deepEqual(await settle(closed, tx(0x100 + status.length)), {
        status: "not_settleable",
        quote_status: status,
      });
    }
    assert.equal((await settle(legacyQuote, tx(0x200))).status, "not_settleable");

    // A quote the pre-attribution flow already activated (sub inserted, quote
    // left active) goes to an operator instead of granting a second year.
    const halfDone = await quote({ user_id: "user_half" });
    await db.query(
      `insert into public.yearly_token_subscriptions (user_id, tier, yearly_quote_id, expires_at, amount_received_raw)
       values ('user_half', 'pro', $1, now() + interval '365 days', 1000)`,
      [halfDone]
    );
    assert.equal((await settle(halfDone, tx(0x300))).status, "legacy_subscription_exists");

    // Input validation.
    assert.equal((await settle(q4, "not-a-hash")).status, "invalid_transaction");
    assert.equal((await settle(q4, tx(5), "1000", NOW, null)).status, "invalid_transaction");
    assert.equal((await settle(q4, tx(5), "0")).status, "invalid_amount");
    assert.equal(
      (await settle("00000000-0000-0000-0000-000000000000", tx(6))).status,
      "not_found"
    );

    // ── Unique indexes backing the claim ──────────────────────────────
    const q5 = await quote({ user_id: "user_3" });
    // One Transfer log (tx + log index) pays at most one quote / subscription.
    await rejectsWith("23505", () =>
      db.query(
        "update public.yearly_token_quotes set consumed_tx_hash = $2, consumed_log_index = 3 where id = $1",
        [q5, tx(1).toUpperCase()]
      )
    );
    await rejectsWith("23505", () =>
      db.query(
        `insert into public.yearly_token_subscriptions
           (user_id, tier, expires_at, amount_received_raw, deposit_tx_hash, deposit_log_index)
         values ('user_3', 'power', now(), 1, $1, 3)`,
        [tx(1)]
      )
    );
    // Another log of the same tx is a different transfer.
    await db.query("update public.yearly_token_quotes set consumed_tx_hash = $2, consumed_log_index = 9 where id = $1", [
      q5,
      tx(1),
    ]);
    await db.query("update public.yearly_token_quotes set consumed_tx_hash = null, consumed_log_index = null where id = $1", [q5]);
    await rejectsWith("23505", () =>
      db.query(
        `insert into public.yearly_token_subscriptions (user_id, tier, yearly_quote_id, expires_at, amount_received_raw)
         values ('user_3', 'power', $1, now(), 1)`,
        [q1]
      )
    );

    // ── Reconciliation items: one open row per transfer ───────────────
    const item = () =>
      db.query(
        `insert into public.yearly_token_reconciliation_items
           (user_id, quote_id, reason, transaction_hash, log_index, token_amount_raw, dedupe_key)
         values ('user_3', $1, 'underpaid', $2, 0, 500, $3)`,
        [q5, tx(9), `yearly_token_transfer:${tx(9)}:0`]
      );
    await item();
    await rejectsWith("23505", item);
    assert.equal(
      (await one("select status from public.yearly_token_reconciliation_items where quote_id = $1", [q5])).status,
      "open"
    );

    // ── Grants: service role only ─────────────────────────────────────
    const signature = "public.settle_yearly_token_payment(uuid, text, integer, numeric, timestamptz, timestamptz)";
    for (const [role, allowed] of [["service_role", true], ["anon", false], ["authenticated", false]]) {
      const { can } = await one(`select has_function_privilege($1, $2, 'execute') as can`, [role, signature]);
      assert.equal(can, allowed, `${role} execute`);
    }
    const itemsRls = await one(
      "select relrowsecurity from pg_class where oid = 'public.yearly_token_reconciliation_items'::regclass"
    );
    assert.equal(itemsRls.relrowsecurity, true);

    // ── One multi-send pays two users' wallets (one log each) ─────────
    const walletA = "0x00000000000000000000000000000000000000a1";
    const walletB = "0x00000000000000000000000000000000000000b2";
    const qA = await quote({ user_id: "user_bundle_a", deposit_address: walletA });
    const qB = await quote({ user_id: "user_bundle_b", deposit_address: walletB });
    assert.equal((await settle(qB, tx(0x500), "1000", NOW, 1)).status, "activated");
    assert.equal((await settle(qA, tx(0x500), "1000", NOW, 0)).status, "activated");
    // A managed-Venice quote on ANOTHER wallet binding a tx never blocks this
    // wallet's log of it; on THIS wallet it does.
    await db.query(
      `insert into public.managed_venice_token_quotes
         (account_id, user_id, token_amount_raw, snapshot_price_usd, locked_value_micro_usd,
          deposit_address, quoted_at, expires_at, status, source, transaction_hash)
       values ($1, 'user_1', 1000, '0.05', 50000000, $2, now() - interval '1 hour',
               now() - interval '40 minutes', 'settled', 'dexscreener', $3)`,
      [account, walletB, tx(0x501)]
    );
    const qOtherWallet = await quote({ user_id: "user_bundle_c", deposit_address: walletA });
    assert.equal((await settle(qOtherWallet, tx(0x501), "1000", NOW, 2)).status, "activated");

    // Re-applying the migration closes only quotes the OLD flow finished:
    // a quote this function consumed keeps its range watched.
    const oldFlowConsumed = await quote({ user_id: "user_old_flow", status: "consumed" });
    await db.exec(migration);
    assert.ok(await closedAt(oldFlowConsumed), "old-flow consumed quote closed on rerun");
    assert.equal(await closedAt(q1), null);
    assert.equal(await closedAt(qA), null);

    console.log("PASS yearly token payment settlement");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
