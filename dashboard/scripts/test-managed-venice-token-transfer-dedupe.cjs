// Apply the real managed Venice migrations in PostgreSQL/WASM and exercise the
// transfer-dedupe migration plus the SQL semantics settlement relies on
// (claim compare-and-set, unique tx claim, one item per transfer).
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
];
const MIGRATION = "20260922120000_managed_venice_token_transfer_dedupe.sql";

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
    const item = (dedupeKey) =>
      db.query(
        `insert into public.managed_venice_reconciliation_items (user_id, account_id, reason, metadata${dedupeKey === undefined ? "" : ", dedupe_key"})
         values ('user_1', $1, 'managed_venice_token_deposit_underpaid', '{}'::jsonb${dedupeKey === undefined ? "" : ", $2"})`,
        dedupeKey === undefined ? [account] : [account, dedupeKey]
      );

    // A pre-existing (legacy) item survives the migration with a null key.
    await item(undefined);

    const migration = read(MIGRATION);
    await db.exec(migration);
    await db.exec(migration); // Rerun-safe.

    const column = (await db.query(
      `select data_type from information_schema.columns
       where table_schema = 'public' and table_name = 'managed_venice_reconciliation_items' and column_name = 'dedupe_key'`
    )).rows;
    assert.deepEqual(column, [{ data_type: "text" }]);
    assert.equal((await db.query(
      "select count(*)::int as n from public.managed_venice_reconciliation_items where dedupe_key is null"
    )).rows[0].n, 1);

    const indexes = Object.fromEntries((await db.query(
      `select indexname, indexdef from pg_indexes where schemaname = 'public' and indexname in
        ('uq_managed_venice_reconciliation_items_dedupe_key', 'ix_managed_venice_token_quotes_deposit_address_quoted_at')`
    )).rows.map((row) => [row.indexname, row.indexdef]));
    assert.match(indexes.uq_managed_venice_reconciliation_items_dedupe_key, /CREATE UNIQUE INDEX .*\(dedupe_key\) WHERE \(dedupe_key IS NOT NULL\)/);
    assert.match(indexes.ix_managed_venice_token_quotes_deposit_address_quoted_at, /\(deposit_address, quoted_at\)/);

    // One item per transfer (tx-hash key): a repeat key is 23505 whichever
    // path writes it; null keys never collide.
    const key = "managed_venice_token_transfer:0xabc";
    await item(key);
    await rejectsWith("23505", () => item(key));
    await item("managed_venice_token_transfer:0xdef");
    await item(null);
    await item(null);
    assert.equal((await db.query(
      "select count(*)::int as n from public.managed_venice_reconciliation_items where dedupe_key = $1", [key]
    )).rows[0].n, 1);

    // Claim compare-and-set semantics settlement relies on.
    const quote = async (id) => db.query(
      `insert into public.managed_venice_token_quotes
        (id, account_id, user_id, token_amount_raw, snapshot_price_usd, locked_value_micro_usd,
         deposit_address, quoted_at, expires_at, status, source)
       values ($1, $2, 'user_1', 1000, '0.05', 50000000, '0xba5e',
         '2026-05-16T10:20:00Z', '2026-05-16T10:40:00Z', 'expired', 'dexscreener')`,
      [id, account]
    );
    const claim = (id, tx) => db.query(
      `update public.managed_venice_token_quotes set transaction_hash = $2
       where id = $1 and status in ('active', 'expired') and transaction_hash is null returning id`,
      [id, tx]
    );
    const qa = "11111111-1111-4111-8111-111111111111";
    const qb = "22222222-2222-4222-8222-222222222222";
    await quote(qa);
    await quote(qb);
    assert.equal((await claim(qa, "0xpaid")).rows.length, 1);
    assert.equal((await claim(qa, "0xother")).rows.length, 0); // Already claimed: CAS loses.
    await rejectsWith("23505", () => claim(qb, "0xpaid")); // One transfer, one quote.
    await db.query("update public.managed_venice_token_quotes set status = 'manual_review_required' where id = $1", [qb]);
    assert.equal((await claim(qb, "0xlate")).rows.length, 0); // Review is terminal for a claim.

    console.log("PASS managed Venice token transfer dedupe: rerun-safe migration, per-transfer unique item key, legacy rows kept, attribution index, claim CAS + unique tx");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
