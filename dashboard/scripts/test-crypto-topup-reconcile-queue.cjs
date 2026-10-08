// Apply the real USDC top-up billing migrations in PostgreSQL/WASM and exercise
// the reconcile-queue migration plus the SQL the reconciler relies on: a new
// intent joins the back of the queue by the column default, rows that predate
// the column get a queue position without a rewrite, the queue read is oldest
// position first, and a pick moves an intent to the back.
// Entirely in memory: no application credentials or live database are used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const PREREQUISITES = [
  "20260425120000_credit_billing_foundation.sql",
  "20260425140000_crypto_deposit_receipts.sql",
  "20260426183000_bankr_deposit_wallets.sql",
  "20260922180543_crypto_topup_reconciliation_items.sql",
];
const MIGRATION = "20260925193000_crypto_topup_reconcile_queue.sql";

const read = (name) => fs.readFileSync(path.join(MIGRATIONS, name), "utf8");

async function main() {
  const db = new PGlite();
  try {
    // Supabase-provided objects the real migrations reference.
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth;
      create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create function public.update_updated_at() returns trigger language plpgsql as $$
        begin new.updated_at = now(); return new; end $$;
      create table public.hermes_instances (id uuid primary key default gen_random_uuid());
      create table public.user_wallets (id uuid primary key default gen_random_uuid());
    `);
    for (const name of PREREQUISITES) await db.exec(read(name));

    const intent = async (ref, { status = "pending", createdAt, userId = "user_1", provider = "bankr" } = {}) =>
      (await db.query(
        `insert into public.payment_transactions
          (user_id, provider, provider_reference_id, status, asset, amount_minor, package_credits, metadata, created_at)
         values ($1, $2, $3, $4, 'usdc_base', 10000000, 1000, '{}'::jsonb, $5) returning id`,
        [userId, provider, ref, status, createdAt]
      )).rows[0].id;

    // An intent that predates the column.
    const legacy = await intent("bankr_crypto_topup:legacy", { createdAt: "2026-09-25T09:00:00Z" });

    const migration = read(MIGRATION);
    await db.exec(migration);
    await db.exec(migration); // Rerun-safe.

    const column = (await db.query(
      `select data_type, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'payment_transactions' and column_name = 'reconcile_queued_at'`
    )).rows;
    assert.equal(column.length, 1);
    assert.equal(column[0].data_type, "timestamp with time zone");
    assert.match(column[0].column_default, /now\(\)/);

    // The existing row got a queue position from the non-volatile default.
    const legacyQueued = (await db.query(
      "select reconcile_queued_at from public.payment_transactions where id = $1",
      [legacy]
    )).rows[0].reconcile_queued_at;
    assert.ok(legacyQueued instanceof Date, "an existing intent has a queue position");

    const index = (await db.query(
      "select indexdef from pg_indexes where schemaname = 'public' and indexname = 'ix_payment_transactions_crypto_topup_reconcile_queue'"
    )).rows;
    assert.equal(index.length, 1);
    assert.match(index[0].indexdef, /reconcile_queued_at NULLS FIRST, created_at/);
    assert.match(index[0].indexdef, /WHERE .*provider = 'bankr'.*asset = 'usdc_base'.*status = 'pending'/);

    // New intents join the back of the queue at insert.
    const before = Date.now();
    const a = await intent("bankr_crypto_topup:a", { createdAt: "2026-09-25T10:00:00Z" });
    const b = await intent("bankr_crypto_topup:b", { createdAt: "2026-09-25T10:01:00Z", userId: "user_2" });
    const c = await intent("bankr_crypto_topup:c", { createdAt: "2026-09-25T10:02:00Z", userId: "user_3" });
    await intent("stripe:ignored", { createdAt: "2026-09-25T10:03:00Z", provider: "stripe" });
    const queuedAtInsert = (await db.query(
      "select reconcile_queued_at from public.payment_transactions where id = $1",
      [a]
    )).rows[0].reconcile_queued_at;
    assert.ok(queuedAtInsert.getTime() >= before - 1000, "a new intent is queued at its insert");

    // Give the queue distinct positions: the legacy intent has waited longest.
    await db.query(
      `update public.payment_transactions set reconcile_queued_at = v.at
         from (values ($1::uuid, '2026-09-25T09:00:00Z'::timestamptz), ($2::uuid, '2026-09-25T10:00:00Z'::timestamptz),
                      ($3::uuid, '2026-09-25T10:01:00Z'::timestamptz), ($4::uuid, '2026-09-25T10:01:00Z'::timestamptz)) as v(id, at)
        where payment_transactions.id = v.id`,
      [legacy, a, b, c]
    );
    const queueOrder = async () =>
      (await db.query(
        `select provider_reference_id from public.payment_transactions
          where provider = 'bankr' and asset = 'usdc_base' and status = 'pending'
          order by reconcile_queued_at asc nulls first, created_at asc
          limit 10`
      )).rows.map((row) => row.provider_reference_id);
    assert.deepEqual(await queueOrder(), [
      "bankr_crypto_topup:legacy",
      "bankr_crypto_topup:a",
      "bankr_crypto_topup:b",
      "bankr_crypto_topup:c",
    ]);

    // A run picks the two at the head and moves them to the back.
    const picked = await db.query(
      `update public.payment_transactions set reconcile_queued_at = '2026-09-25T10:10:00Z'
        where id = any($1::uuid[]) and provider = 'bankr' returning id`,
      [[legacy, a]]
    );
    assert.equal(picked.rows.length, 2);
    assert.deepEqual(await queueOrder(), [
      "bankr_crypto_topup:b",
      "bankr_crypto_topup:c",
      "bankr_crypto_topup:legacy",
      "bankr_crypto_topup:a",
    ]);

    // Settling takes an intent out of the queue.
    await db.query("update public.payment_transactions set status = 'succeeded' where id = $1", [b]);
    assert.deepEqual(await queueOrder(), [
      "bankr_crypto_topup:c",
      "bankr_crypto_topup:legacy",
      "bankr_crypto_topup:a",
    ]);

    console.log("PASS crypto top-up reconcile queue: rerun-safe migration, default queue position for new and existing rows, partial queue index, oldest-first read, pick moves to the back");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
