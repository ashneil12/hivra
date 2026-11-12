// Apply every migration up to 20261113021500 in PostgreSQL/WASM (the new one
// twice, proving it re-runs), with a managed inference key already linked to an
// agent before it runs, then check: existing links gain the agent's type; new
// agents stamp id and type; usage keeps its type after the agent is deleted;
// hivra_usage_by_user_and_type sums a time range per person and agent type and
// leaves out voided and out-of-range events; and browsers cannot call it.
// Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const TARGET = "20261113021500_usage_by_user_and_type.sql";

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create role supabase_admin; create role authenticator;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
      create schema auth; create schema storage; create schema supabase_migrations; create schema extensions;
      create table supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
      create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      create function auth.role() returns text language sql stable as $$ select null::text $$;
      create table auth.users (id uuid primary key, email text);
      create table storage.buckets (id text primary key, name text not null, public boolean default false,
        file_size_limit bigint, allowed_mime_types text[], owner uuid, created_at timestamptz default now(), updated_at timestamptz default now());
      create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
        name text, owner uuid, metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
      create function storage.foldername(name text) returns text[] language sql as $$ select string_to_array(name, '/') $$;
      create publication supabase_realtime;
      create function public.digest(text, text) returns bytea language sql as $$ select sha256(convert_to($1, 'UTF8')) $$;
      create function public.digest(bytea, text) returns bytea language sql as $$ select sha256($1) $$;
    `);
    const files = fs.readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql") && name <= TARGET).sort();
    assert.equal(files.at(-1), TARGET, "the migration under test is applied last");
    const apply = async (name) =>
      // PGlite ships without extensions; the functions they provide are stubbed above.
      db.exec(fs.readFileSync(path.join(MIGRATIONS, name), "utf8").replace(/create extension[^;]*;/gi, ""));
    for (const name of files.slice(0, -1)) await apply(name);

    const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
    const account = async (user) => (await one(
      "insert into public.managed_venice_wallet_accounts (user_id) values ($1) returning id", [user])).id;
    const key = async (user, acct, name) => (await one(
      `insert into public.managed_venice_proxy_keys (account_id, user_id, name, key_hash, key_prefix)
       values ($1, $2, $3, $3 || '-hash', 'hv_') returning id`, [acct, user, name])).id;
    const agent = async (user, type, llm) => (await one(
      "insert into public.hivra_agents (user_id, type, name, status, llm_config) values ($1, $2, 'agent', 'running', $3) returning id",
      [user, type, llm])).id;
    const meta = async (id) => (await one("select metadata from public.managed_venice_proxy_keys where id = $1", [id])).metadata;

    // Before: the earlier migration already stamped the agent id, without a type.
    const anaAcct = await account("ana");
    const benAcct = await account("ben");
    const hermesKey = await key("ana", anaAcct, "hermes");
    const hermes = await agent("ana", "hermes", { proxyKeyId: hermesKey });
    assert.deepEqual(await meta(hermesKey), { agentId: hermes }, "before: id only");

    await apply(TARGET);
    await apply(TARGET);

    assert.deepEqual(await meta(hermesKey), { agentId: hermes, agentType: "hermes" }, "existing link gains the type");

    // New agents stamp both; a deleted agent's key keeps both.
    const clawKey = await key("ana", anaAcct, "claw");
    const claw = await agent("ana", "openclaw", { proxyKeyId: clawKey });
    assert.deepEqual(await meta(clawKey), { agentId: claw, agentType: "openclaw" }, "stamped on insert");
    const benKey = await key("ben", benAcct, "ben");
    const benHermes = await agent("ben", "hermes", { proxyKeyId: benKey });
    const coder = await agent("ben", "claude-code", null);

    let n = 0;
    const usage = async (acct, user, k, at, charged, cost, status = "recorded") => db.query(
      `insert into public.managed_venice_usage_events (account_id, user_id, proxy_key_id, wallet_type, endpoint, model,
         actual_cost_micro_usd, charged_micro_usd, status, reference_id, created_at)
       values ($1, $2, $3, 'hermesos', '/chat/completions', 'm', $4, $5, $6, $7, $8)`,
      [acct, user, k, cost, charged, status, `ref-${n++}`, at]);
    const run = async (id, user, type, at) => db.query(
      "insert into public.hivra_agent_events (agent_id, user_id, event, agent_type, created_at) values ($1, $2, 'otel_log', $3, $4)",
      [id, user, type, at]);

    // November: Ana's Hermes works in two hours, her OpenClaw in three; Ben's Hermes in one
    // hour and his Claude Code (runs only) in two. Plus events that must not count.
    await usage(anaAcct, "ana", hermesKey, "2026-11-03T10:05:00Z", 100, 80);
    await usage(anaAcct, "ana", hermesKey, "2026-11-03T10:45:00Z", 50, 40);
    await usage(anaAcct, "ana", hermesKey, "2026-11-04T09:00:00Z", 10, 8);
    await usage(anaAcct, "ana", hermesKey, "2026-11-04T09:01:00Z", 999, 999, "voided");
    await usage(anaAcct, "ana", hermesKey, "2026-10-31T23:59:59Z", 7, 7);
    await usage(anaAcct, "ana", hermesKey, "2026-12-01T00:00:00Z", 7, 7);
    await usage(anaAcct, "ana", clawKey, "2026-11-05T01:00:00Z", 1, 1);
    await usage(anaAcct, "ana", clawKey, "2026-11-05T02:00:00Z", 1, 1);
    await usage(anaAcct, "ana", clawKey, "2026-11-05T03:00:00Z", 1, 1);
    await usage(benAcct, "ben", benKey, "2026-11-10T12:00:00Z", 20, 15);
    await run(benHermes, "ben", "hermes", "2026-11-10T12:30:00Z");
    await run(coder, "ben", "claude-code", "2026-11-11T08:00:00Z");
    await run(coder, "ben", "claude-code", "2026-11-11T08:10:00Z");
    await run(coder, "ben", "claude-code", "2026-11-11T09:00:00Z");

    // Deleting agents must not lose their type.
    await db.query("delete from public.hivra_agents where id = any($1)", [[claw, coder]]);

    const rows = (await db.query(
      "select * from public.hivra_usage_by_user_and_type('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z')")).rows
      .map((r) => ({ ...r, inference_requests: Number(r.inference_requests), inference_charged_micro_usd: Number(r.inference_charged_micro_usd),
        inference_cost_micro_usd: Number(r.inference_cost_micro_usd), run_events: Number(r.run_events) }));
    assert.deepEqual(rows, [
      { user_id: "ana", agent_type: "hermes", agents: 1, active_hours: 2, inference_requests: 3, inference_charged_micro_usd: 160, inference_cost_micro_usd: 128, run_events: 0 },
      { user_id: "ana", agent_type: "openclaw", agents: 1, active_hours: 3, inference_requests: 3, inference_charged_micro_usd: 3, inference_cost_micro_usd: 3, run_events: 0 },
      { user_id: "ben", agent_type: "claude-code", agents: 1, active_hours: 2, inference_requests: 0, inference_charged_micro_usd: 0, inference_cost_micro_usd: 0, run_events: 3 },
      { user_id: "ben", agent_type: "hermes", agents: 1, active_hours: 1, inference_requests: 1, inference_charged_micro_usd: 20, inference_cost_micro_usd: 15, run_events: 1 },
    ]);

    // The view names the type of deleted agents too.
    const types = (await db.query(
      "select agent_type, count(*)::int as hours from public.hivra_agent_active_hours where hour >= '2026-11-01' and hour < '2026-12-01' group by 1 order by 1")).rows;
    assert.deepEqual(types, [
      { agent_type: "claude-code", hours: 2 }, { agent_type: "hermes", hours: 3 }, { agent_type: "openclaw", hours: 3 },
    ]);

    // Browsers cannot call it.
    for (const role of ["anon", "authenticated"]) {
      const allowed = (await one(
        "select has_function_privilege($1, 'public.hivra_usage_by_user_and_type(timestamptz, timestamptz)', 'execute') as ok", [role])).ok;
      assert.equal(allowed, false, `${role} cannot run the usage function`);
    }
    assert.equal((await one(
      "select has_function_privilege('service_role', 'public.hivra_usage_by_user_and_type(timestamptz, timestamptz)', 'execute') as ok")).ok, true);
    console.log("PASS usage by user and type");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
