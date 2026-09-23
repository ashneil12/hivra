// Apply every migration that defines, or changes the grants of, the SECURITY
// DEFINER functions canary exposed to the API roles on 2026-09-23, in version
// order, in PostgreSQL/WASM with Supabase's default privileges emulated. Then
// check who can execute each function and that the balance-guard triggers
// still fire for a role without EXECUTE on them.
// Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const PREREQUISITES = [
  "20260425120000_credit_billing_foundation.sql",
  "20260512180000_managed_venice_wallets.sql",
];
// Trigger functions: nothing calls them directly, so no role needs EXECUTE.
const TRIGGER_FUNCTIONS = [
  "public.enforce_credit_reservation_balance()",
  "public.enforce_managed_venice_card_balance()",
  "public.enforce_managed_venice_reservation_balance()",
];
// RPCs whose only callers use the service-role admin client.
const SERVICE_ROLE_RPCS = [
  "public.record_cron_heartbeat(text)",
  "public.refresh_credit_account_cached_balance(uuid)",
];
const FUNCTION_NAMES = [...TRIGGER_FUNCTIONS, ...SERVICE_ROLE_RPCS].map((signature) =>
  signature.slice("public.".length, signature.indexOf("("))
);

const read = (name) => fs.readFileSync(path.join(MIGRATIONS, name), "utf8");
// Every migration that creates, grants or revokes one of the functions, so a
// later migration that recreates or re-grants one is covered too.
const FUNCTION_MIGRATIONS = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith(".sql"))
  // From the dual platform token foundation on, these definitions depend on
  // the token tables this script stubs out; that migration's own test
  // (test-dual-platform-token-foundation.cjs) covers them and their grants.
  .filter((name) => name < "20260923150000")
  .sort()
  .filter((name) => FUNCTION_NAMES.some((fn) => new RegExp(`public\\.${fn}\\s*\\(`, "i").test(read(name))));

async function main() {
  assert.ok(FUNCTION_MIGRATIONS.length >= 4, `found function migrations: ${FUNCTION_MIGRATIONS.join(", ")}`);

  const db = new PGlite();
  try {
    // Supabase grants ALL on new public tables and EXECUTE on new public
    // functions to the API roles through default privileges, and PostgreSQL
    // grants EXECUTE to PUBLIC. A function is closed to anon/authenticated
    // only once all three grants are gone.
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
      create schema auth;
      create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
      create function public.update_updated_at() returns trigger language plpgsql as $$
        begin new.updated_at = now(); return new; end $$;
      create table public.hermes_instances (id uuid primary key default gen_random_uuid());
    `);
    for (const name of PREREQUISITES) await db.exec(read(name));
    for (const name of FUNCTION_MIGRATIONS) await db.exec(read(name));
    await db.exec(read(FUNCTION_MIGRATIONS[FUNCTION_MIGRATIONS.length - 1])); // Rerun-safe.

    const one = async (sql, params) => (await db.query(sql, params)).rows[0];
    const asRole = async (role, sql, params) => {
      await db.exec(`set role ${role}`);
      try {
        return (await db.query(sql, params)).rows;
      } finally {
        await db.exec("reset role");
      }
    };
    const rejects = async (role, sql, params, pattern) =>
      assert.rejects(asRole(role, sql, params), pattern, `${role}: ${sql}`);

    // ── Grants ────────────────────────────────────────────────────────
    const canExecute = async (role, signature) =>
      role === "public"
        ? (
            await one(
              `select coalesce(bool_or(a.grantee = 0 and a.privilege_type = 'EXECUTE'), false) as can
                 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where p.oid = $1::regprocedure`,
              [signature]
            )
          ).can
        : (await one("select has_function_privilege($1, $2, 'execute') as can", [role, signature])).can;

    const expected = [
      ...TRIGGER_FUNCTIONS.map((signature) => [signature, { service_role: false }]),
      ...SERVICE_ROLE_RPCS.map((signature) => [signature, { service_role: true }]),
    ];
    for (const [signature, { service_role }] of expected) {
      for (const [role, allowed] of [
        ["public", false],
        ["anon", false],
        ["authenticated", false],
        ["service_role", service_role],
      ]) {
        assert.equal(await canExecute(role, signature), allowed, `${role} execute ${signature}`);
      }
    }

    // ── The API roles are refused at call time ────────────────────────
    const accountId = (
      await one("insert into public.credit_accounts (user_id) values ('user_a') returning id")
    ).id;
    await db.query(
      `insert into public.credit_ledger_entries
         (account_id, user_id, amount_credits, source, actor, reason, reference_id)
       values ($1, 'user_a', 100, 'admin', 'test', 'admin_adjustment', 'grant-1')`,
      [accountId]
    );
    for (const role of ["anon", "authenticated"]) {
      await rejects(role, "select public.record_cron_heartbeat('daily-vm-backups')", [], /permission denied/);
      await rejects(role, "select public.refresh_credit_account_cached_balance($1)", [accountId], /permission denied/);
    }
    assert.equal(
      (await one("select count(*)::int as n from public.ops_cron_heartbeats")).n,
      0,
      "a refused call must not stamp a heartbeat"
    );

    // ── The service role keeps its RPCs ───────────────────────────────
    await asRole("service_role", "select public.record_cron_heartbeat('daily-vm-backups')");
    await asRole("service_role", "select public.record_cron_heartbeat('daily-vm-backups')");
    assert.deepEqual(
      await one("select cron_name, run_count::int, ok_count::int from public.ops_cron_heartbeats"),
      { cron_name: "daily-vm-backups", run_count: 2, ok_count: 2 }
    );
    const [refreshed] = await asRole(
      "service_role",
      "select public.refresh_credit_account_cached_balance($1) as balance",
      [accountId]
    );
    assert.equal(refreshed.balance, 100);

    // ── The balance guards still fire without EXECUTE on them ─────────
    // PostgreSQL checks EXECUTE on a trigger function when the trigger is
    // created, not when it fires, so revoking it from every API role must not
    // switch off the overdraft guards.
    const reserveCredits = (reference, amount) =>
      asRole(
        "service_role",
        `insert into public.credit_reservations (user_id, account_id, amount_credits, reason, reference_id)
         values ('user_a', $1, $2, 'compute', $3)`,
        [accountId, amount, reference]
      );
    await reserveCredits("reserve-1", 60);
    await assert.rejects(reserveCredits("reserve-2", 50), /credit_reservation_insufficient_balance/);

    const walletId = (
      await one("insert into public.managed_venice_wallet_accounts (user_id) values ('user_a') returning id")
    ).id;
    const cardEntry = (reference, amount, reason) =>
      asRole(
        "service_role",
        `insert into public.managed_venice_card_ledger_entries
           (account_id, user_id, amount_micro_usd, source, actor, reason, reference_id)
         values ($1, 'user_a', $2, 'system', 'test', $3, $4)`,
        [walletId, amount, reason, reference]
      );
    await cardEntry("topup-1", 1_000_000, "stripe_topup");
    await assert.rejects(cardEntry("debit-1", -1_500_000, "managed_venice_debit"), /managed_venice_insufficient_balance/);
    await cardEntry("debit-2", -400_000, "managed_venice_debit");

    const reserveVenice = (reference, amount) =>
      asRole(
        "service_role",
        `insert into public.managed_venice_reservations
           (account_id, user_id, wallet_type, reference_id, estimated_cost_micro_usd, reserved_micro_usd)
         values ($1, 'user_a', 'card', $2, $3, $3)`,
        [walletId, reference, amount]
      );
    await reserveVenice("venice-1", 500_000);
    await assert.rejects(reserveVenice("venice-2", 200_000), /managed_venice_insufficient_balance/);

    console.log(`PASS definer function API grants (${FUNCTION_MIGRATIONS.join(" -> ")})`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
