// Apply the real yearly-token migrations and every migration that (re)defines
// reconcile_stale_subscription_state_to_free, in version order, in
// PostgreSQL/WASM. Yearly rows are minted through the real
// settle_yearly_token_payment so a Pro renewal lands exactly as it does live.
// Entirely in memory: no credentials or live database.
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
  "20260922222737_yearly_token_payment_attribution.sql",
];
const RPC_MIGRATIONS = fs
  .readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith(".sql"))
  // The dual platform token migrations need the real token tables this
  // script stubs out; their own test (test-dual-platform-token-foundation.cjs)
  // applies them on top of them and checks these functions and their grants.
  // Later migrations stay covered here.
  .filter(
    (name) =>
      name !== "20260923150000_dual_platform_token_foundation.sql" &&
      name !== "20260923160000_reconcile_token_base_any_allowed_token.sql"
  )
  .sort()
  .filter((name) =>
    /create or replace function public\.reconcile_stale_subscription_state_to_free\s*\(/i.test(
      fs.readFileSync(path.join(MIGRATIONS, name), "utf8")
    )
  );
const NOW = "2026-09-23T12:00:00.000Z";
const OBSERVED_UPDATED_AT = "2026-09-01T00:00:00.000Z";

const read = (name) => fs.readFileSync(path.join(MIGRATIONS, name), "utf8");
const tx = (n) => `0x${n.toString(16).padStart(64, "0")}`;

async function main() {
  assert.ok(RPC_MIGRATIONS.length >= 2, `found RPC migrations: ${RPC_MIGRATIONS.join(", ")}`);

  const db = new PGlite();
  try {
    // Supabase-provided objects, plus minimal stand-ins for the non-yearly
    // tables the function reads and writes (only the columns it touches).
    // Supabase's default privileges grant EXECUTE on every new public function
    // to the API roles explicitly, so `revoke ... from public` alone leaves
    // anon/authenticated able to call it (as canary showed on 2026-09-23).
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
      create schema auth;
      create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
      create function public.update_updated_at() returns trigger language plpgsql as $$
        begin new.updated_at = now(); return new; end $$;
      create table public.bankr_deposit_wallet_credentials (
        id uuid primary key default gen_random_uuid(), purpose text);
      create table public.hermes_subscriptions (
        user_id text primary key,
        plan text not null,
        status text not null,
        stripe_subscription_id text,
        instance_limit integer not null,
        total_cpu_budget numeric not null,
        total_ram_budget integer not null,
        current_period_start timestamptz,
        current_period_end timestamptz,
        grace_period_ends_at timestamptz,
        updated_at timestamptz not null);
      create table public.hermes_instances (
        id uuid primary key default gen_random_uuid(),
        user_id text not null,
        status text not null,
        resource_tier text,
        cpu_limit numeric,
        ram_limit integer,
        tier_change_pending boolean not null default false,
        updated_at timestamptz not null default now());
      create table public.token_tier_qualifications (
        user_id text not null, tier text not null, currently_eligible boolean not null);
      create table public.token_entitlement_configs (
        tier_key text primary key, chain_id integer, token_address text, token_symbol text);
      create table public.token_holding_snapshots (
        user_id text not null, chain_id integer, token_address text, token_symbol text,
        qualifies_base_tier boolean, checked_at timestamptz);
    `);
    for (const name of PREREQUISITES) await db.exec(read(name));
    for (const name of RPC_MIGRATIONS) await db.exec(read(name));
    await db.exec(read(RPC_MIGRATIONS[RPC_MIGRATIONS.length - 1])); // Rerun-safe.

    const one = async (sql, params) => (await db.query(sql, params)).rows[0];
    const all = async (sql, params) => (await db.query(sql, params)).rows;
    let nextTx = 1;

    // Pay for a year of `tier` at `now` through the real settlement function.
    const pay = async (userId, tier, now) => {
      const quoteId = (
        await one(
          `insert into public.yearly_token_quotes
             (user_id, tier, usd_target_cents, price_usd_at_quote, tokens_required_raw,
              tokens_required_display, deposit_address, quoted_at, expires_at, status)
           values ($1, $2, 4900, '0.0000025', 1000, '1000',
                   '0x000000000000000000000000000000000000ba5e', $3::timestamptz - interval '20 minutes',
                   $3, 'active')
           returning id`,
          [userId, tier, now]
        )
      ).id;
      return (
        await one("select public.settle_yearly_token_payment($1, $2, 0, 1000, $3, $3) as result", [
          quoteId,
          tx(nextTx++),
          now,
        ])
      ).result;
    };

    // A paid-looking Stripe row the reconcile cron has proven stale, with one
    // running, one stopped and one deleted instance.
    const seedAccount = async (userId) => {
      await db.query(
        `insert into public.hermes_subscriptions
           (user_id, plan, status, stripe_subscription_id, instance_limit, total_cpu_budget,
            total_ram_budget, current_period_end, updated_at)
         values ($1, 'operator', 'past_due', 'sub_stale', 3, 2, 4096, $2, $2)`,
        [userId, OBSERVED_UPDATED_AT]
      );
      await db.query(
        `insert into public.hermes_instances (user_id, status, resource_tier, cpu_limit, ram_limit)
         values ($1, 'running', 'fleet', 4, 8192),
                ($1, 'stopped', 'credit_base', 0.5, 1024),
                ($1, 'deleted', 'credit_base', 0.5, 1024)`,
        [userId]
      );
    };

    const reconcile = async (userId) =>
      (
        await one(
          "select public.reconcile_stale_subscription_state_to_free($1, 'operator', 'past_due', 'sub_stale', $2, $3) as result",
          [userId, OBSERVED_UPDATED_AT, NOW]
        )
      ).result;

    const instances = (userId) =>
      all(
        `select status, resource_tier, cpu_limit::float8 as cpu, ram_limit as ram, tier_change_pending
           from public.hermes_instances where user_id = $1 order by status`,
        [userId]
      );

    const liveTiers = async (userId) =>
      (
        await all(
          `select tier from public.yearly_token_subscriptions
            where user_id = $1 and status in ('active', 'grace') order by tier`,
          [userId]
        )
      ).map((row) => row.tier);

    // ── Pro renewal while a paid Power year is still running ──────────
    // The reported path: the renewal inserts the newest live row (Pro).
    await seedAccount("user_renew");
    assert.equal((await pay("user_renew", "pro", "2025-10-10T00:00:00Z")).status, "activated");
    assert.equal((await pay("user_renew", "power", "2026-06-01T00:00:00Z")).status, "activated");
    assert.equal((await pay("user_renew", "pro", "2026-09-22T12:00:00Z")).status, "renewed");
    assert.deepEqual(await liveTiers("user_renew"), ["power", "pro"]);

    const renewed = await reconcile("user_renew");
    assert.equal(renewed.subscription_updated, true);
    assert.equal(renewed.target_tier, "fleet", "Power outranks the newer Pro renewal");
    assert.equal(renewed.instances_updated, 2);
    assert.equal(renewed.instances_changed, 1);
    assert.deepEqual(await instances("user_renew"), [
      { status: "deleted", resource_tier: "credit_base", cpu: 0.5, ram: 1024, tier_change_pending: false },
      { status: "running", resource_tier: "fleet", cpu: 4, ram: 8192, tier_change_pending: false },
      { status: "stopped", resource_tier: "fleet", cpu: 4, ram: 8192, tier_change_pending: true },
    ]);
    const resetSub = await one(
      "select plan, status, stripe_subscription_id, instance_limit from public.hermes_subscriptions where user_id = $1",
      ["user_renew"]
    );
    assert.deepEqual(resetSub, { plan: "free", status: "active", stripe_subscription_id: null, instance_limit: 1 });

    // ── First Pro purchase while Power is live ────────────────────────
    await seedAccount("user_buy_pro");
    assert.equal((await pay("user_buy_pro", "power", "2026-06-01T00:00:00Z")).status, "activated");
    assert.equal((await pay("user_buy_pro", "pro", "2026-09-22T12:00:00Z")).status, "activated");
    assert.equal((await reconcile("user_buy_pro")).target_tier, "fleet");

    // ── Power in grace still outranks a newer active Pro ──────────────
    await seedAccount("user_power_grace");
    assert.equal((await pay("user_power_grace", "power", "2025-09-20T00:00:00Z")).status, "activated");
    assert.equal((await pay("user_power_grace", "pro", "2026-09-22T12:00:00Z")).status, "activated");
    await db.query(
      "update public.yearly_token_subscriptions set status = 'grace' where user_id = $1 and tier = 'power'",
      ["user_power_grace"]
    );
    assert.equal((await reconcile("user_power_grace")).target_tier, "fleet");

    // ── Once Power is no longer live, the live Pro row decides ────────
    await seedAccount("user_power_expired");
    assert.equal((await pay("user_power_expired", "power", "2025-09-01T00:00:00Z")).status, "activated");
    assert.equal((await pay("user_power_expired", "pro", "2026-09-22T12:00:00Z")).status, "activated");
    await db.query(
      "update public.yearly_token_subscriptions set status = 'expired' where user_id = $1 and tier = 'power'",
      ["user_power_expired"]
    );
    const proOnly = await reconcile("user_power_expired");
    assert.equal(proOnly.target_tier, "operator");
    assert.equal(proOnly.instances_changed, 2);
    const proInstances = (await instances("user_power_expired")).filter((row) => row.status !== "deleted");
    for (const row of proInstances) assert.deepEqual([row.resource_tier, row.cpu, row.ram], ["operator", 2, 4096]);

    // ── The non-yearly fallbacks are unchanged ────────────────────────
    await seedAccount("user_token_power");
    await db.query("insert into public.token_tier_qualifications values ('user_token_power', 'power', true)");
    assert.equal((await reconcile("user_token_power")).target_tier, "fleet");
    await seedAccount("user_nothing");
    assert.equal((await reconcile("user_nothing")).target_tier, "credit_base");

    // ── Grants: service role only ─────────────────────────────────────
    const signature =
      "public.reconcile_stale_subscription_state_to_free(text, text, text, text, timestamptz, timestamptz)";
    for (const [role, allowed] of [["service_role", true], ["anon", false], ["authenticated", false]]) {
      const { can } = await one("select has_function_privilege($1, $2, 'execute') as can", [role, signature]);
      assert.equal(can, allowed, `${role} execute`);
    }

    console.log(`PASS reconcile stale subscription yearly tier (${RPC_MIGRATIONS.join(" -> ")})`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
