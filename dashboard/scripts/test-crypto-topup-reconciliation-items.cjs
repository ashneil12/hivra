// Apply the real USDC top-up billing migrations in PostgreSQL/WASM and exercise
// the reconciliation-items migration plus the SQL semantics top-up settlement
// relies on (claim-first receipts, compare-and-set on the intent status, one
// review item per transfer). Entirely in memory: no application credentials or
// live database are used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const PREREQUISITES = [
  "20260425120000_credit_billing_foundation.sql",
  "20260425140000_crypto_deposit_receipts.sql",
  "20260426183000_bankr_deposit_wallets.sql",
];
const MIGRATION = "20260922130000_crypto_topup_reconciliation_items.sql";

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
      create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create function public.update_updated_at() returns trigger language plpgsql as $$
        begin new.updated_at = now(); return new; end $$;
      create table public.hermes_instances (id uuid primary key default gen_random_uuid());
      create table public.user_wallets (id uuid primary key default gen_random_uuid());
    `);
    for (const name of PREREQUISITES) await db.exec(read(name));

    const migration = read(MIGRATION);
    await db.exec(migration);
    await db.exec(migration); // Rerun-safe.

    const rls = (await db.query(
      "select relrowsecurity from pg_class where oid = 'public.crypto_topup_reconciliation_items'::regclass"
    )).rows[0].relrowsecurity;
    assert.equal(rls, true);

    const intent = async (ref, status = "pending", metadata = {}) =>
      (await db.query(
        `insert into public.payment_transactions
          (user_id, provider, provider_reference_id, status, asset, amount_minor, package_credits, metadata)
         values ('user_1', 'bankr', $1, $2, 'usdc_base', 10000000, 1000, $3::jsonb) returning id`,
        [ref, status, JSON.stringify(metadata)]
      )).rows[0].id;
    const a = await intent("bankr_crypto_topup:a");
    const b = await intent("bankr_crypto_topup:b");

    // Claim-first: one transfer funds one intent; one intent holds one transfer.
    const claim = (paymentId, ref, tx, logIndex) => db.query(
      `insert into public.crypto_deposit_receipts
        (user_id, payment_transaction_id, provider, reference_id, chain_id, token_address, token_symbol,
         token_decimals, deposit_address, normalized_deposit_address, amount_minor, tx_hash, log_index,
         block_number, status)
       values ('user_1', $1, 'bankr', $2, 8453, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC', 6,
         '0xdead', '0xdead', 10000000, $3, $4, 51183675, 'confirmed')`,
      [paymentId, ref, tx, logIndex]
    );
    await claim(a, "bankr_crypto_topup:a", "0xpaid", 417);
    await rejectsWith("23505", () => claim(b, "bankr_crypto_topup:b", "0xpaid", 417));
    await rejectsWith("23505", () => claim(a, "bankr_crypto_topup:a", "0xother", 1));

    // Compare-and-set on the status read: a refunded intent is not clobbered.
    const flip = (ref, from) => db.query(
      `update public.payment_transactions set status = 'succeeded'
       where provider = 'bankr' and provider_reference_id = $1 and status = $2 returning id`,
      [ref, from]
    );
    await db.query("update public.payment_transactions set status = 'refunded' where provider_reference_id = 'bankr_crypto_topup:b'");
    assert.equal((await flip("bankr_crypto_topup:b", "pending")).rows.length, 0);
    assert.equal((await flip("bankr_crypto_topup:a", "pending")).rows.length, 1);

    // The candidate query's JSON-path filter for intents the old session
    // helper failed without a chain check.
    await intent("bankr_crypto_topup:legacy", "failed", { failureType: "crypto_payment_session_expired" });
    await intent("bankr_crypto_topup:closed", "failed", {
      failureType: "crypto_payment_session_expired",
      reconciliationClosedAt: "2026-09-22T12:00:00.000Z",
    });
    const unchecked = (await db.query(
      `select provider_reference_id from public.payment_transactions
       where status = 'failed' and metadata->>'failureType' = 'crypto_payment_session_expired'
         and metadata->>'reconciliationClosedAt' is null`
    )).rows.map((row) => row.provider_reference_id);
    assert.deepEqual(unchecked, ["bankr_crypto_topup:legacy"]);

    // One review item per transfer: a repeat dedupe key is 23505.
    const item = (dedupeKey, reason = "underpaid", amount = "9990000") => db.query(
      `insert into public.crypto_topup_reconciliation_items
        (user_id, payment_transaction_id, reference_id, reason, chain_id, token_address, tx_hash,
         log_index, observed_amount_minor, expected_amount_minor, dedupe_key)
       values ('user_1', $1, 'bankr_crypto_topup:a', $2, 8453, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
         '0xunder', 3, $3, 10000000, $4)`,
      [a, reason, amount, dedupeKey]
    );
    const key = "crypto_topup_transfer:8453:0xunder:3";
    await item(key);
    await rejectsWith("23505", () => item(key));
    await rejectsWith("23514", () => item("crypto_topup_transfer:8453:0xbad:1", "made_up_reason"));
    await rejectsWith("23514", () => item("crypto_topup_transfer:8453:0xzero:1", "underpaid", "0"));
    // Amounts beyond int64 (a spam transfer) still fit.
    await item("crypto_topup_transfer:8453:0xhuge:1", "overpaid", "115792089237316195423570985008687907853269984665640564039457584007913129639935");
    const stored = (await db.query(
      "select status, observed_amount_minor::text as amount from public.crypto_topup_reconciliation_items where dedupe_key = $1",
      [key]
    )).rows[0];
    assert.deepEqual(stored, { status: "open", amount: "9990000" });

    console.log("PASS crypto top-up reconciliation items: rerun-safe migration, RLS, per-transfer unique item key, claim-first receipt uniqueness, status CAS, unchecked-expired filter");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
