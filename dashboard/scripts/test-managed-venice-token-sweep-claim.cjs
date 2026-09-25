// Apply the real managed Venice migrations in PostgreSQL/WASM and exercise the
// sweep-claim migration plus the SQL the sweep relies on: one claimant per
// quote (compare-and-set from 'pending'/'failed'), a submit marker written only
// under the claim's own token, the terminal 'needs_operator' state, and rows
// that predate the migration left as they were.
// Entirely in memory: no application credentials or live database are used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const PREREQUISITES = [
  "20260512180000_managed_venice_wallets.sql",
  "20260512181000_managed_venice_token_quotes.sql",
  "20260516120000_managed_venice_token_treasury_sweeps.sql",
  "20260606130100_managed_venice_token_lots_unique_quote.sql",
  "20260922224500_managed_venice_token_transfer_dedupe.sql",
];
const MIGRATION = "20260925193100_managed_venice_token_sweep_claim.sql";

const read = (name) => fs.readFileSync(path.join(MIGRATIONS, name), "utf8");

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
      create table public.bankr_deposit_wallet_credentials (id uuid primary key default gen_random_uuid(), purpose text);
    `);
    for (const name of PREREQUISITES) await db.exec(read(name));

    const account = (await db.query(
      "insert into public.managed_venice_wallet_accounts (user_id) values ('user_1') returning id"
    )).rows[0].id;
    let txCounter = 0;
    const quote = async (id, sweepStatus) => {
      txCounter += 1;
      await db.query(
        `insert into public.managed_venice_token_quotes
          (id, account_id, user_id, token_amount_raw, snapshot_price_usd, locked_value_micro_usd,
           deposit_address, quoted_at, expires_at, status, source, transaction_hash, settled_at, sweep_status)
         values ($1, $2, 'user_1', 1000, '0.05', 50000000, '0xba5e',
           '2026-09-25T10:20:00Z', '2026-09-25T10:40:00Z', 'settled', 'dexscreener', $3, '2026-09-25T10:30:00Z', $4)`,
        [id, account, `0xdeposit${txCounter}`, sweepStatus]
      );
    };

    // Rows that predate the migration.
    const legacyFailed = "00000000-0000-4000-8000-000000000001";
    const legacySwept = "00000000-0000-4000-8000-000000000002";
    await quote(legacyFailed, "failed");
    await quote(legacySwept, "swept");
    await db.query(
      "update public.managed_venice_token_quotes set sweep_error = 'transfer failed: Bankr 400' where id = $1",
      [legacyFailed]
    );

    const migration = read(MIGRATION);
    await db.exec(migration);
    await db.exec(migration); // Rerun-safe.

    const column = (await db.query(
      `select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'managed_venice_token_quotes' and column_name = 'sweep_submitted_at'`
    )).rows;
    assert.deepEqual(column, [{ data_type: "timestamp with time zone" }]);
    const legacy = (await db.query(
      "select id, sweep_status, sweep_submitted_at, sweep_error from public.managed_venice_token_quotes order by id"
    )).rows;
    assert.deepEqual(legacy, [
      { id: legacyFailed, sweep_status: "failed", sweep_submitted_at: null, sweep_error: "transfer failed: Bankr 400" },
      { id: legacySwept, sweep_status: "swept", sweep_submitted_at: null, sweep_error: null },
    ]);
    const index = (await db.query(
      "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'ix_managed_venice_token_quotes_sweep_claims'"
    )).rows;
    assert.equal(index.length, 1);
    assert.match(index[0].indexdef, /WHERE \(sweep_status = 'sweeping'/);

    // The claim: one of two racing sweepers wins.
    const pendingQuote = "00000000-0000-4000-8000-000000000003";
    await quote(pendingQuote, "pending");
    const claim = (id, token) => db.query(
      `update public.managed_venice_token_quotes
          set sweep_status = 'sweeping', sweep_attempted_at = $2, sweep_error = null
        where id = $1 and status = 'settled' and sweep_status in ('pending', 'failed') and sweep_submitted_at is null
        returning id`,
      [id, token]
    );
    const token = "2026-09-25T11:00:00.000Z";
    assert.equal((await claim(pendingQuote, token)).rows.length, 1);
    assert.equal((await claim(pendingQuote, "2026-09-25T11:00:00.001Z")).rows.length, 0);

    // The submit marker is written only under the claim's own token.
    const markSubmitted = (id, claimToken) => db.query(
      `update public.managed_venice_token_quotes set sweep_submitted_at = now()
        where id = $1 and sweep_status = 'sweeping' and sweep_attempted_at = $2 and sweep_submitted_at is null
        returning id`,
      [id, claimToken]
    );
    assert.equal((await markSubmitted(pendingQuote, "2026-09-25T10:00:00.000Z")).rows.length, 0);
    assert.equal((await markSubmitted(pendingQuote, token)).rows.length, 1);

    // A quote with a submitted transfer cannot be claimed again, even as 'failed'.
    await db.query("update public.managed_venice_token_quotes set sweep_status = 'failed' where id = $1", [pendingQuote]);
    assert.equal((await claim(pendingQuote, "2026-09-25T11:30:00.000Z")).rows.length, 0);

    // needs_operator is a valid terminal state; anything else is refused.
    await db.query("update public.managed_venice_token_quotes set sweep_status = 'needs_operator' where id = $1", [pendingQuote]);
    assert.equal((await claim(pendingQuote, "2026-09-25T11:40:00.000Z")).rows.length, 0);
    await rejectsWith("23514", () =>
      db.query("update public.managed_venice_token_quotes set sweep_status = 'made_up' where id = $1", [pendingQuote])
    );

    // A legacy failed row (no submit marker) is still claimable, as before.
    assert.equal((await claim(legacyFailed, "2026-09-25T11:50:00.000Z")).rows.length, 1);

    console.log("PASS managed-venice token sweep claim: rerun-safe migration, legacy rows unchanged, one claimant, submit marker under the claim token, needs_operator terminal");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
