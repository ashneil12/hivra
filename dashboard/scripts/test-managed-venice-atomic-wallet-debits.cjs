// Apply the real managed-Venice wallet migrations in PostgreSQL/WASM, then the
// atomic wallet debit functions (twice, proving the file re-runs), and exercise
// them: FIFO token-lot debits with proportional token amounts, card debits
// that keep other holds covered, an idempotent capture retry, all-or-nothing
// failure, and the service-role-only grants. Entirely in memory: no
// credentials or live database.
//
// PGlite runs one statement at a time, so the "concurrent" captures below are
// serialized by the engine; test-managed-venice-wallet-debit-concurrency.cjs
// runs the same functions from separate PostgreSQL sessions at once.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const PREREQUISITES = [
  "20260512180000_managed_venice_wallets.sql",
  "20260606140100_managed_venice_reservation_balance_guard.sql",
];
const MIGRATION = "20260925201500_managed_venice_atomic_wallet_debits.sql";
const USER = "user_wallet";

const read = (name) => fs.readFileSync(path.join(MIGRATIONS, name), "utf8");

async function rejectsWith(pattern, action) {
  await assert.rejects(action, (error) => pattern.test(String(error.message)));
}

async function main() {
  const db = new PGlite();
  try {
    // Supabase-provided objects the real migrations reference. Supabase grants
    // EXECUTE on new functions to the API roles by default; mirror that so the
    // grant assertions below can't pass spuriously.
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
      create schema auth;
      create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
      create function public.update_updated_at() returns trigger language plpgsql as $$
        begin new.updated_at = now(); return new; end $$;
    `);
    for (const name of PREREQUISITES) await db.exec(read(name));
    const migration = read(MIGRATION);
    await db.exec(migration);
    await db.exec(migration); // Rerun-safe.

    const account = (await db.query(
      "insert into public.managed_venice_wallet_accounts (user_id) values ($1) returning id",
      [USER]
    )).rows[0].id;

    let lotSequence = 0;
    const lot = async (value, { tokens = value, createdAt } = {}) => {
      lotSequence += 1;
      const stamp = createdAt ?? new Date(Date.UTC(2026, 0, 1, 0, lotSequence)).toISOString();
      return (await db.query(
        `insert into public.managed_venice_token_lots
           (account_id, user_id, token_amount_raw, remaining_token_amount_raw, snapshot_price_usd,
            original_value_micro_usd, remaining_value_micro_usd, quote_source, quoted_at, created_at)
         values ($1, $2, $3, $3, '0.001', $4, $4, 'test', $5, $5)
         returning id`,
        [account, USER, tokens, value, stamp]
      )).rows[0].id;
    };
    const topUp = (amount, reference) => db.query(
      `insert into public.managed_venice_card_ledger_entries
         (account_id, user_id, amount_micro_usd, source, actor, reason, reference_id)
       values ($1, $2, $3, 'stripe', 'test', 'stripe_topup', $4)`,
      [account, USER, amount, reference]
    );
    const hold = (reference, amount, walletType = "hermesos") => db.query(
      `insert into public.managed_venice_reservations
         (account_id, user_id, wallet_type, reference_id, estimated_cost_micro_usd, reserved_micro_usd)
       values ($1, $2, $3, $4, $5, $5)`,
      [account, USER, walletType, reference, amount]
    );
    const capture = async (reference, amount) => (await db.query(
      "select public.capture_managed_venice_reservation($1, $2, $3) as result",
      [USER, reference, amount]
    )).rows[0].result;
    const debit = async (walletType, amount, reference) => (await db.query(
      "select public.debit_managed_venice_wallet($1, $2, $3, $4) as result",
      [USER, walletType, amount, reference]
    )).rows[0].result;
    const lots = async () => (await db.query(
      `select id, remaining_value_micro_usd::bigint as value, remaining_token_amount_raw::text as tokens, status
         from public.managed_venice_token_lots where user_id = $1 order by created_at, id`,
      [USER]
    )).rows.map((row) => ({ ...row, value: Number(row.value) }));
    const holdRow = async (reference) => (await db.query(
      `select status, captured_micro_usd::bigint as captured, released_micro_usd::bigint as released,
              captured_at is not null as has_captured_at, released_at is not null as has_released_at
         from public.managed_venice_reservations where reference_id = $1`,
      [reference]
    )).rows.map((row) => ({ ...row, captured: Number(row.captured), released: Number(row.released) }))[0];
    const cardDebits = async () => (await db.query(
      `select reference_id, amount_micro_usd::bigint as amount, source, reason, actor
         from public.managed_venice_card_ledger_entries
        where user_id = $1 and amount_micro_usd < 0 order by reference_id`,
      [USER]
    )).rows.map((row) => ({ ...row, amount: Number(row.amount) }));
    const reset = () => db.exec(`
      delete from public.managed_venice_reservations;
      delete from public.managed_venice_card_ledger_entries;
      delete from public.managed_venice_token_lots;
    `);

    // 1. A capture debits token lots oldest first, scales each lot's token
    //    amount down with its value, and marks the hold captured.
    const oldLot = await lot(1_000_000, { tokens: 1000 });
    const newLot = await lot(2_000_000, { tokens: 2001 });
    await hold("fifo", 1_600_000);
    assert.deepEqual(await capture("fifo", 1_500_000), {
      captured: true,
      status: "captured",
      walletType: "hermesos",
      reservedMicroUsd: 1_600_000,
      capturedMicroUsd: 1_500_000,
      releasedMicroUsd: 100_000,
    });
    assert.deepEqual(await lots(), [
      { id: oldLot, value: 0, tokens: "0", status: "depleted" },
      // 2001 * 1_500_000 / 2_000_000 = 1500.75, rounded down.
      { id: newLot, value: 1_500_000, tokens: "1500", status: "active" },
    ]);
    assert.deepEqual(await holdRow("fifo"), {
      status: "captured", captured: 1_500_000, released: 100_000, has_captured_at: true, has_released_at: true,
    });

    // 2. Retrying the capture (a lost response, the stale-hold sweep, two
    //    sweeps at once) reports the hold as settled and moves no money.
    assert.deepEqual(await capture("fifo", 1_500_000), {
      captured: false,
      status: "captured",
      walletType: "hermesos",
      reservedMicroUsd: 1_600_000,
      capturedMicroUsd: 1_500_000,
      releasedMicroUsd: 100_000,
    });
    assert.equal((await lots())[1].value, 1_500_000);

    // 3. A released hold is never charged afterwards.
    await hold("released", 100_000);
    await db.query("update public.managed_venice_reservations set status = 'released' where reference_id = 'released'");
    assert.equal((await capture("released", 100_000)).captured, false);
    assert.equal((await lots())[1].value, 1_500_000);

    // 4. A capture larger than its hold, or of an unknown hold, is refused.
    await hold("small", 10_000);
    await rejectsWith(/managed_venice_capture_exceeds_reservation/, () => capture("small", 10_001));
    await rejectsWith(/managed_venice_reservation_not_found/, () => capture("missing", 1));
    await rejectsWith(/managed_venice_capture_invalid/, () => capture("small", -1));
    assert.equal((await holdRow("small")).status, "active");

    // 5. A zero capture closes the hold and debits nothing.
    assert.equal((await capture("small", 0)).releasedMicroUsd, 10_000);
    assert.equal((await lots())[1].value, 1_500_000);

    // 6. All or nothing: a debit the lots can't cover changes no lot, even
    //    one it could have drained first, and leaves the hold active.
    await reset();
    const first = await lot(300_000);
    const second = await lot(300_000);
    await hold("short", 600_000);
    await db.query("update public.managed_venice_token_lots set status = 'voided' where id = $1", [second]);
    await rejectsWith(/managed_venice_insufficient_balance: token lots short by 300000 of 600000/, () =>
      capture("short", 600_000)
    );
    assert.deepEqual((await lots()).map((row) => [row.id, row.value, row.status]), [
      [first, 300_000, "active"],
      [second, 300_000, "voided"],
    ]);
    assert.equal((await holdRow("short")).status, "active");

    // 7. Ten captures of one lot each land (the review's lost-debit case:
    //    ten $0.05 images on a $1.00 lot used to leave $0.95).
    await reset();
    await lot(1_000_000);
    for (let index = 0; index < 10; index += 1) await hold(`image_${index}`, 50_000);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => capture(`image_${index}`, 50_000))
    );
    assert.ok(results.every((result) => result.captured));
    assert.equal((await lots())[0].value, 500_000);

    // 8. A hold-less debit (chat overage) spans lots too, and all of it lands.
    await lot(100_000);
    assert.deepEqual(await debit("hermesos", 550_000, "overage_1:overage"), {
      debited: true, walletType: "hermesos", amountMicroUsd: 550_000,
    });
    assert.deepEqual((await lots()).map((row) => row.value), [0, 50_000]);
    await rejectsWith(/managed_venice_insufficient_balance/, () => debit("hermesos", 50_001, "overage_2:overage"));
    assert.deepEqual((await lots()).map((row) => row.value), [0, 50_000]);

    // 9. Card: a capture spends its own hold; a debit with no hold can't eat
    //    into other holds; both write one system ledger debit per reference.
    await reset();
    await topUp(500_000, "cs_1");
    await hold("card_a", 200_000, "card");
    await hold("card_b", 300_000, "card");
    await rejectsWith(/managed_venice_insufficient_balance: card available=0 debit=100000/, () =>
      debit("card", 100_000, "card_a:overage")
    );
    assert.equal((await capture("card_a", 150_000)).capturedMicroUsd, 150_000);
    assert.equal((await capture("card_b", 300_000)).capturedMicroUsd, 300_000);
    assert.deepEqual(await debit("card", 50_000, "card_a:overage"), {
      debited: true, walletType: "card", amountMicroUsd: 50_000,
    });
    assert.deepEqual(await cardDebits(), [
      { reference_id: "card_a", amount: -150_000, source: "system", reason: "managed_venice_debit", actor: "managed_venice_proxy" },
      { reference_id: "card_a:overage", amount: -50_000, source: "system", reason: "managed_venice_debit", actor: "managed_venice_proxy" },
      { reference_id: "card_b", amount: -300_000, source: "system", reason: "managed_venice_debit", actor: "managed_venice_proxy" },
    ]);
    await rejectsWith(/managed_venice_insufficient_balance/, () => debit("card", 1, "card_b:overage"));
    await rejectsWith(/managed_venice_debit_invalid: unknown wallet type/, () => debit("stripe", 1, "bogus"));
    await rejectsWith(/managed_venice_debit_invalid: amount/, () => debit("card", 0, "zero"));

    // 10. Service role only, and the sweep's indexes exist.
    for (const signature of [
      "public.capture_managed_venice_reservation(text, text, bigint)",
      "public.debit_managed_venice_wallet(text, text, bigint, text)",
      "public.managed_venice_debit_wallet_locked(text, text, bigint, text, uuid, uuid)",
    ]) {
      const grants = (await db.query(
        `select has_function_privilege('anon', $1, 'execute') as anon,
                has_function_privilege('authenticated', $1, 'execute') as authenticated,
                has_function_privilege('service_role', $1, 'execute') as service_role,
                (select prosecdef from pg_proc where oid = $1::regprocedure) as definer,
                (select proconfig from pg_proc where oid = $1::regprocedure) as config`,
        [signature]
      )).rows[0];
      assert.deepEqual(
        { ...grants, config: grants.config },
        { anon: false, authenticated: false, service_role: true, definer: true, config: ["search_path=public"] },
        signature
      );
    }
    const indexes = (await db.query(
      `select indexname from pg_indexes where schemaname = 'public'
         and indexname in ('managed_venice_reservations_active_expiry_idx',
                           'managed_venice_reconciliation_items_open_reference_idx')
       order by indexname`
    )).rows.map((row) => row.indexname);
    assert.deepEqual(indexes, [
      "managed_venice_reconciliation_items_open_reference_idx",
      "managed_venice_reservations_active_expiry_idx",
    ]);

    console.log("PASS managed venice atomic wallet debits");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
