// Apply every migration up to 20261113033000 in PostgreSQL/WASM (the new one
// twice, proving it re-runs), then check the activity records: a reading stores
// the latest state, one sample in its hour and one in-use sample in each used
// hour; a late reading is dropped; an unreachable one keeps what was last read;
// hours stay after the agent is deleted; the active-hours view and the usage
// function count an in-use hour once, together with inference in the same
// hour; and browsers can read or call none of it.
// Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const TARGET = "20261113033000_agent_activity_samples.sql";

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
    const agent = async (user, type, llm = null) => (await one(
      "insert into public.hivra_agents (user_id, type, name, status, llm_config) values ($1, $2, 'agent', 'running', $3) returning id",
      [user, type, llm])).id;
    const record = (args) => db.query(
      `select public.hivra_record_agent_activity(
         p_agent_id => $1, p_user_id => $2, p_agent_type => $3, p_observed_at => $4, p_reachable => $5,
         p_boot_id => $6, p_app_last_used_at => $7, p_last_reply_at => $8, p_last_used_at => $9,
         p_open_connections => $10, p_active_runs => $11, p_terminal_attached => $12, p_used_hours => $13::timestamptz[])`,
      [args.agent, args.user, args.type, args.at, args.reachable ?? true, args.boot ?? null, args.appUsed ?? null, args.reply ?? null,
        args.lastUsed ?? null, args.open ?? null, args.runs ?? null, args.terminal ?? null, args.usedHours ?? []]);
    const latest = async (id) => one(
      `select reachable, boot_id, open_connections, active_runs, terminal_attached, desktop_attached, next_job_at,
              to_char(observed_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI') as observed,
              to_char(last_used_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI') as last_used
         from public.hivra_agent_activity where agent_id = $1`, [id]);
    const hours = async (id) => (await db.query(
      `select to_char(hour at time zone 'utc', 'YYYY-MM-DD"T"HH24') as hour, samples, active_samples, user_id, agent_type
         from public.hivra_agent_activity_hours where agent_id = $1 order by hour`, [id])).rows;

    await apply(TARGET);
    await apply(TARGET);

    const claw = await agent("ana", "openclaw");
    const coder = await agent("ben", "claude-code");

    // A quiet reading: one sample, nothing in use, unknowns stay null.
    await record({ agent: claw, user: "ana", type: "openclaw", at: "2026-11-05T10:05:00Z", boot: "b1", appUsed: "2026-11-05T09:00:00Z", open: 0, runs: 0, terminal: false });
    assert.deepEqual(await latest(claw), {
      reachable: true, boot_id: "b1", open_connections: 0, active_runs: 0, terminal_attached: false,
      desktop_attached: null, next_job_at: null, observed: "2026-11-05T10:05", last_used: null,
    });
    assert.deepEqual(await hours(claw), [{ hour: "2026-11-05T10", samples: 1, active_samples: 0, user_id: "ana", agent_type: "openclaw" }]);

    // In use now and also used in the hour before: both hours count, once each.
    await record({ agent: claw, user: "ana", type: "openclaw", at: "2026-11-05T10:15:00Z", boot: "b1", appUsed: "2026-11-05T10:14:00Z",
      lastUsed: "2026-11-05T10:15:00Z", open: 2, runs: 0, terminal: false,
      usedHours: ["2026-11-05T09:50:00Z", "2026-11-05T09:10:00Z", "2026-11-05T10:15:00Z"] });
    assert.deepEqual(await hours(claw), [
      { hour: "2026-11-05T09", samples: 0, active_samples: 1, user_id: "ana", agent_type: "openclaw" },
      { hour: "2026-11-05T10", samples: 2, active_samples: 1, user_id: "ana", agent_type: "openclaw" },
    ]);
    assert.equal((await latest(claw)).last_used, "2026-11-05T10:15");

    // A reading that arrives late is dropped whole.
    await record({ agent: claw, user: "ana", type: "openclaw", at: "2026-11-05T10:10:00Z", boot: "b1", open: 9, usedHours: ["2026-11-05T10:10:00Z"] });
    assert.equal((await latest(claw)).open_connections, 2, "late reading does not replace the newer one");
    assert.deepEqual((await hours(claw)).map((row) => [row.samples, row.active_samples]), [[0, 1], [2, 1]]);

    // The last known use never moves backwards, and unknown parts are stored as unknown.
    await record({ agent: claw, user: "ana", type: "openclaw", at: "2026-11-05T10:25:00Z", boot: "b2", lastUsed: "2026-11-05T08:00:00Z" });
    assert.deepEqual(await latest(claw), {
      reachable: true, boot_id: "b2", open_connections: null, active_runs: null, terminal_attached: null,
      desktop_attached: null, next_job_at: null, observed: "2026-11-05T10:25", last_used: "2026-11-05T10:15",
    });

    // Unreachable: what was last read is kept, and no sample is counted.
    await record({ agent: claw, user: "ana", type: "openclaw", at: "2026-11-05T10:35:00Z", reachable: false });
    const down = await latest(claw);
    assert.equal(down.reachable, false);
    assert.equal(down.observed, "2026-11-05T10:35");
    assert.equal(down.boot_id, "b2");
    assert.equal(down.last_used, "2026-11-05T10:15");
    assert.deepEqual((await hours(claw)).map((row) => [row.samples, row.active_samples]), [[0, 1], [3, 1]]);
    // An agent first seen unreachable gets a row saying only that.
    await record({ agent: coder, user: "ben", type: "claude-code", at: "2026-11-05T10:35:00Z", reachable: false });
    assert.deepEqual(await latest(coder), {
      reachable: false, boot_id: null, open_connections: null, active_runs: null, terminal_attached: null,
      desktop_attached: null, next_job_at: null, observed: "2026-11-05T10:35", last_used: null,
    });
    assert.deepEqual(await hours(coder), []);

    // Ben's Claude Code: a reply at 11:40 and managed inference in the same hour count as one hour.
    const benAcct = (await one("insert into public.managed_venice_wallet_accounts (user_id) values ('ben') returning id")).id;
    const benKey = (await one(
      `insert into public.managed_venice_proxy_keys (account_id, user_id, name, key_hash, key_prefix)
       values ($1, 'ben', 'k', 'k-hash', 'hv_') returning id`, [benAcct])).id;
    const hermes = await agent("ben", "hermes", { proxyKeyId: benKey });
    await db.query(
      `insert into public.managed_venice_usage_events (account_id, user_id, proxy_key_id, wallet_type, endpoint, model,
         actual_cost_micro_usd, charged_micro_usd, status, reference_id, created_at)
       values ($1, 'ben', $2, 'hermesos', '/chat/completions', 'm', 8, 10, 'recorded', 'ref-1', '2026-11-05T11:20:00Z')`, [benAcct, benKey]);
    await record({ agent: hermes, user: "ben", type: "hermes", at: "2026-11-05T11:45:00Z", boot: "h1", open: 1, usedHours: ["2026-11-05T11:45:00Z"] });
    await record({ agent: hermes, user: "ben", type: "hermes", at: "2026-11-05T12:05:00Z", boot: "h1", open: 1, usedHours: ["2026-11-05T12:05:00Z"] });
    await record({ agent: coder, user: "ben", type: "claude-code", at: "2026-11-05T11:45:00Z", reply: "2026-11-05T11:40:00Z", runs: 1, terminal: false,
      usedHours: ["2026-11-05T11:40:00Z", "2026-11-05T11:45:00Z"] });

    // Deleting an agent removes its latest reading and keeps its hours and type.
    await db.query("delete from public.hivra_agents where id = $1", [claw]);
    assert.equal(await latest(claw), undefined);
    assert.equal((await hours(claw)).length, 2);

    const usage = async (from, to) => (await db.query("select * from public.hivra_usage_by_user_and_type($1, $2)", [from, to])).rows
      .map((r) => ({ user: r.user_id, type: r.agent_type, agents: r.agents, hours: r.active_hours, requests: Number(r.inference_requests), charged: Number(r.inference_charged_micro_usd) }));
    assert.deepEqual(await usage("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"), [
      { user: "ana", type: "openclaw", agents: 1, hours: 2, requests: 0, charged: 0 },
      { user: "ben", type: "claude-code", agents: 1, hours: 1, requests: 0, charged: 0 },
      { user: "ben", type: "hermes", agents: 1, hours: 2, requests: 1, charged: 10 },
    ]);
    // Only hours that start inside the range.
    assert.deepEqual(await usage("2026-11-05T10:00:00Z", "2026-11-05T11:00:00Z"), [
      { user: "ana", type: "openclaw", agents: 1, hours: 1, requests: 0, charged: 0 },
    ]);

    const view = (await db.query(
      `select agent_type, count(*)::int as hours, sum(inference_requests)::int as requests
         from public.hivra_agent_active_hours where hour >= '2026-11-05' and hour < '2026-11-06' group by 1 order by 1`)).rows;
    assert.deepEqual(view, [
      { agent_type: "claude-code", hours: 1, requests: 0 }, { agent_type: "hermes", hours: 2, requests: 1 }, { agent_type: "openclaw", hours: 2, requests: 0 },
    ]);

    // Browsers can read or call none of it.
    const signature = "public.hivra_record_agent_activity(uuid, text, text, timestamptz, boolean, text, timestamptz, timestamptz, timestamptz, integer, integer, boolean, timestamptz[])";
    for (const role of ["anon", "authenticated"]) {
      for (const table of ["hivra_agent_activity", "hivra_agent_activity_hours"]) {
        for (const privilege of ["select", "insert", "update", "delete"]) {
          const allowed = (await one("select has_table_privilege($1, $2, $3) as ok", [role, `public.${table}`, privilege])).ok;
          assert.equal(allowed, false, `${role} cannot ${privilege} ${table}`);
        }
      }
      assert.equal((await one("select has_function_privilege($1, $2, 'execute') as ok", [role, signature])).ok, false, `${role} cannot record activity`);
    }
    assert.equal((await one("select has_function_privilege('service_role', $1, 'execute') as ok", [signature])).ok, true);
    for (const table of ["hivra_agent_activity", "hivra_agent_activity_hours"]) {
      assert.equal((await one("select relrowsecurity as on from pg_class where oid = $1::regclass", [`public.${table}`])).on, true, `${table} has row security on`);
    }
    console.log("PASS agent activity samples");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
