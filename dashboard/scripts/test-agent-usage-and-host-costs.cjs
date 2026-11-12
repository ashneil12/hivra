// Apply every migration up to 20261112210000 in PostgreSQL/WASM (the new one
// twice, proving it re-runs), with a managed inference key already linked to an
// agent before it runs, then check: the existing link is backfilled into the
// key's metadata; new agents stamp their key; a bad or foreign key never blocks
// an agent write; server costs refuse negatives and duplicate dates; and
// hivra_agent_active_hours gives one row per agent per hour from inference and
// run events. Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const TARGET = "20261112210000_agent_usage_and_host_costs.sql";

async function rejects(db, sql, pattern, label) {
  let error = null;
  try {
    await db.exec(sql);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `${label}: expected a failure`);
  assert.match(String(error.message), pattern, `${label}: ${error.message}`);
}

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
    const agentIdOf = async (id) => (await one("select metadata->>'agentId' as a from public.managed_venice_proxy_keys where id = $1", [id])).a;

    // Before: an agent already names its key.
    const ownerAcct = await account("owner");
    const oldKey = await key("owner", ownerAcct, "old");
    const oldAgent = await agent("owner", "hermes", { proxyKeyId: oldKey });

    await apply(TARGET);
    await apply(TARGET);

    assert.equal(await agentIdOf(oldKey), oldAgent, "existing link backfilled");

    // A new agent stamps its key on insert, and again when it moves to another key.
    const k1 = await key("owner", ownerAcct, "k1");
    const k2 = await key("owner", ownerAcct, "k2");
    const a1 = await agent("owner", "codex", { proxyKeyId: k1, model: "m" });
    assert.equal(await agentIdOf(k1), a1, "stamped on insert");
    await db.query("update public.hivra_agents set llm_config = $2 where id = $1", [a1, { proxyKeyId: k2 }]);
    assert.equal(await agentIdOf(k2), a1, "stamped on update");
    // Deleting the agent leaves the key's memory of it.
    await db.query("delete from public.hivra_agents where id = $1", [a1]);
    assert.equal(await agentIdOf(k1), a1, "kept after delete");

    // Never blocks: junk ids, missing keys, someone else's key, no llm_config.
    const strangerAcct = await account("stranger");
    const strangerKey = await key("stranger", strangerAcct, "theirs");
    await agent("owner", "codex", { proxyKeyId: "not-a-uuid" });
    await agent("owner", "codex", { proxyKeyId: "00000000-0000-0000-0000-000000000000" });
    await agent("owner", "codex", { proxyKeyId: strangerKey });
    await agent("owner", "codex", null);
    await agent("owner", "codex", ["array"]);
    assert.equal(await agentIdOf(strangerKey), null, "another owner's key is not stamped");

    // Server costs.
    await db.exec("insert into public.hivra_host_costs (host_id, monthly_cost_minor, effective_from) values ('host-a', 3990, '2026-11-01')");
    await rejects(db, "insert into public.hivra_host_costs (host_id, monthly_cost_minor) values ('host-a', -1)", /check/i, "negative cost");
    await rejects(db, "insert into public.hivra_host_costs (host_id, monthly_cost_minor, effective_from) values ('host-a', 1, '2026-11-01')", /unique|duplicate/i, "same date twice");
    await rejects(db, "insert into public.hivra_host_costs (host_id, monthly_cost_minor, currency) values ('host-b', 1, 'JPY')", /check/i, "unknown currency");

    // Active hours: inference on the old agent's key in two hours, run events for it in one of
    // them and for a run-only agent, a voided event that does not count, and a key with no agent.
    const runOnly = await agent("owner", "claude-code", null);
    const looseKey = await key("owner", ownerAcct, "loose");
    let n = 0;
    const usage = async (k, at, charged, status = "recorded") => db.query(
      `insert into public.managed_venice_usage_events (account_id, user_id, proxy_key_id, wallet_type, endpoint, model,
         actual_cost_micro_usd, charged_micro_usd, status, reference_id, created_at)
       values ($1, 'owner', $2, 'hermesos', '/chat/completions', 'm', $3, $3, $4, $5, $6)`,
      [ownerAcct, k, charged, status, `ref-${n++}`, at]);
    await usage(oldKey, "2026-11-12T10:05:00Z", 100);
    await usage(oldKey, "2026-11-12T10:55:00Z", 50);
    await usage(oldKey, "2026-11-12T10:56:00Z", 999, "voided");
    await usage(oldKey, "2026-11-12T12:01:00Z", 7);
    await usage(looseKey, "2026-11-12T10:10:00Z", 5);
    const run = async (id, at, event = "otel_log") => db.query(
      "insert into public.hivra_agent_events (agent_id, user_id, event, created_at) values ($1, 'owner', $2, $3)", [id, event, at]);
    await run(oldAgent, "2026-11-12T10:20:00Z");
    await run(runOnly, "2026-11-12T11:00:00Z");
    await run(runOnly, "2026-11-12T11:59:00Z");
    await run(runOnly, "2026-11-12T11:30:00Z", "restarted");

    const rows = (await db.query(`select agent_id, agent_type, to_char(hour at time zone 'UTC', 'HH24') as h,
        inference_requests, inference_charged_micro_usd::int as charged, run_events
      from public.hivra_agent_active_hours order by h, agent_type`)).rows;
    assert.deepEqual(rows, [
      { agent_id: oldAgent, agent_type: "hermes", h: "10", inference_requests: 2, charged: 150, run_events: 1 },
      { agent_id: runOnly, agent_type: "claude-code", h: "11", inference_requests: 0, charged: 0, run_events: 2 },
      { agent_id: oldAgent, agent_type: "hermes", h: "12", inference_requests: 1, charged: 7, run_events: 0 },
    ]);

    // Browsers never read either.
    for (const rel of ["hivra_host_costs", "hivra_agent_active_hours"]) {
      const grants = (await db.query(
        "select grantee from information_schema.role_table_grants where table_schema = 'public' and table_name = $1 and grantee in ('anon', 'authenticated')",
        [rel])).rows;
      assert.deepEqual(grants, [], `${rel} is closed to browsers`);
    }
    console.log("PASS agent usage and host costs");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
