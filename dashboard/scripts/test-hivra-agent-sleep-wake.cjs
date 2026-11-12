// Apply every migration up to 20261113060000 in PostgreSQL/WASM (the new one
// twice, proving it re-runs), then check the sleep and wake leases: each claim's
// rules, the generation compare-and-swap, a pending delete, that status never
// changes, the event log, and that browsers can reach none of it.
// Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const TARGET = "20261113060000_hivra_agent_sleep_wake.sql";
const uuid = () => crypto.randomUUID();

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
    await apply(TARGET);
    await apply(TARGET);

    const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
    const make = async (set = {}) => {
      const id = (await one(
        "insert into public.hivra_agents (user_id, type, name, status) values ('user_a', 'claude-code', 'agent', 'running') returning id")).id;
      const keys = Object.keys(set);
      if (keys.length) {
        await db.query(`update public.hivra_agents set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1`,
          [id, ...keys.map((k) => set[k])]);
      }
      return id;
    };
    const row = async (id) => one(
      `select status, desired_state, sleep_state, sleep_generation::int as gen, operation_id, operation_kind,
              operation_started_at is not null as has_started, operation_payload, next_wake_at,
              sleep_tier_changed_at is not null as stamped
         from public.hivra_agents where id = $1`, [id]);
    const claimSleep = async (id, op, tier, gen) =>
      (await one("select public.claim_hivra_agent_sleep($1, $2, $3, $4) as r", [id, op, tier, gen])).r;
    const finishSleep = async (id, op, result) =>
      (await one("select public.finish_hivra_agent_sleep($1, $2, $3) as r", [id, op, result])).r;
    const claimWake = async (id, op) => (await one("select public.claim_hivra_agent_wake($1, $2) as r", [id, op])).r;
    const finishWake = async (id, op, result) =>
      (await one("select public.finish_hivra_agent_wake($1, $2, $3) as r", [id, op, result])).r;

    // A fresh running agent starts awake at generation 0 with no lease.
    const a = await make();
    assert.deepEqual(await row(a), {
      status: "running", desired_state: "running", sleep_state: "awake", gen: 0, operation_id: null,
      operation_kind: null, has_started: false, operation_payload: null, next_wake_at: null, stamped: false,
    });

    // Nap: refused on a stale generation, on bad arguments, and on a wrong tier input.
    const op1 = uuid();
    assert.equal(await claimSleep(a, op1, "nap", 5), null, "stale generation loses");
    assert.equal(await claimSleep(a, op1, "snooze", 0), null, "unknown tier");
    assert.equal(await claimSleep(a, null, "nap", 0), null, "no operation id");
    assert.equal(await claimSleep(a, op1, "nap", null), null, "no generation");
    assert.equal(await claimSleep(uuid(), op1, "nap", 0), null, "no such agent");
    assert.equal((await row(a)).gen, 0, "refusals change nothing");

    // Nap claim: lease, draining, generation bump, status untouched.
    assert.equal(Number(await claimSleep(a, op1, "nap", 0)), 1);
    let r = await row(a);
    assert.equal(r.status, "running");
    assert.equal(r.sleep_state, "draining");
    assert.equal(r.gen, 1);
    assert.equal(r.operation_id, op1);
    assert.equal(r.operation_kind, "sleep");
    assert.equal(r.has_started, true);
    assert.equal(r.stamped, true);
    assert.equal(await claimSleep(a, uuid(), "nap", 1), null, "a second claim finds the lease held");
    assert.equal(await claimSleep(a, op1, "hibernate", 1), null, "the lease blocks every tier");
    assert.equal(await claimWake(a, uuid()), "busy", "wake sees the lease");

    // Finishing: only the holder, only a known result.
    assert.equal(await finishSleep(a, uuid(), "napping"), false, "another operation cannot finish it");
    assert.equal(await finishSleep(a, op1, "sleeping"), false, "unknown result");
    assert.equal(await finishSleep(uuid(), op1, "napping"), false, "another agent");
    assert.equal(await finishSleep(a, op1, "napping"), true);
    r = await row(a);
    assert.deepEqual([r.status, r.sleep_state, r.gen, r.operation_id, r.operation_kind, r.has_started], ["running", "napping", 2, null, null, false]);
    assert.equal(await finishSleep(a, op1, "napping"), false, "a replayed finish changes nothing");
    assert.equal((await row(a)).gen, 2);

    // A nap cannot start from napping, but a hibernate can; it needs the right generation.
    assert.equal(await claimSleep(a, uuid(), "nap", 2), null, "nap needs awake");
    assert.equal(await claimSleep(a, uuid(), "hibernate", 1), null, "stale generation loses for hibernate too");
    const op2 = uuid();
    assert.equal(Number(await claimSleep(a, op2, "hibernate", 2)), 3);
    r = await row(a);
    assert.deepEqual([r.status, r.sleep_state, r.operation_kind], ["running", "hibernating", "sleep"]);
    assert.equal(await finishSleep(a, op2, "hibernated"), true);
    assert.equal((await row(a)).sleep_state, "hibernated");
    assert.equal((await row(a)).gen, 4);
    assert.equal(await claimSleep(a, uuid(), "hibernate", 4), null, "hibernate needs awake or napping");

    // Wake from hibernated: claim, finish awake. Also clears next_wake_at.
    await db.query("update public.hivra_agents set next_wake_at = now() + interval '1 hour' where id = $1", [a]);
    const w1 = uuid();
    assert.equal(await claimWake(a, w1), "claimed");
    r = await row(a);
    assert.deepEqual([r.status, r.sleep_state, r.gen, r.operation_id, r.operation_kind], ["running", "waking", 5, w1, "wake"]);
    assert.equal(await claimWake(a, uuid()), "busy");
    assert.equal(await claimWake(a, w1), "busy", "a replay does not claim twice");
    assert.equal(await finishWake(a, uuid(), "awake"), false);
    assert.equal(await finishWake(a, w1, "napping"), false, "unknown wake result");
    assert.equal(await finishWake(a, op2, "awake"), false, "a sleep operation id cannot finish a wake");
    assert.equal(await finishWake(a, w1, "awake"), true);
    r = await row(a);
    assert.deepEqual([r.status, r.sleep_state, r.gen, r.operation_id, r.next_wake_at], ["running", "awake", 6, null, null]);
    assert.equal(await claimWake(a, uuid()), "awake");
    assert.equal(await finishWake(a, w1, "awake"), false, "replayed finish");

    // A failed wake keeps next_wake_at, can be claimed again, and never sets status to error.
    const b = await make({ sleep_state: "napping", sleep_generation: 7, next_wake_at: "2030-01-01T00:00:00Z" });
    const w2 = uuid();
    assert.equal(await claimWake(b, w2), "claimed");
    assert.equal(await finishWake(b, w2, "wake_failed"), true);
    r = await row(b);
    assert.deepEqual([r.status, r.sleep_state, r.gen, r.operation_id], ["running", "wake_failed", 9, null]);
    assert.notEqual(r.next_wake_at, null, "a failed wake keeps the schedule");
    const w3 = uuid();
    assert.equal(await claimWake(b, w3), "claimed", "wake_failed can be retried");
    assert.equal(await finishWake(b, w3, "awake"), true);

    // A sleep that stands down finishes as awake.
    const c = await make();
    const op3 = uuid();
    await claimSleep(c, op3, "nap", 0);
    assert.equal(await finishSleep(c, op3, "awake"), true);
    r = await row(c);
    assert.deepEqual([r.status, r.sleep_state, r.gen, r.operation_id], ["running", "awake", 2, null]);

    // Refusals by status, desired state and an operation held by something else.
    for (const [label, set] of [
      ["stopped", { status: "stopped" }],
      ["provisioning", { status: "provisioning", operation_id: uuid(), operation_kind: "start", operation_started_at: "2026-11-01T00:00:00Z" }],
      ["error", { status: "error" }],
      ["stop requested", { desired_state: "stopped" }],
      ["delete requested", { desired_state: "deleted" }],
      ["keep awake switched on", { always_on: true }],
      ["another lease", { operation_id: uuid(), operation_kind: "restart", operation_started_at: "2026-11-01T00:00:00Z" }],
    ]) {
      const id = await make(set);
      const before = await row(id);
      assert.equal(await claimSleep(id, uuid(), "nap", 0), null, `no nap while ${label}`);
      assert.equal(await claimSleep(id, uuid(), "hibernate", 0), null, `no hibernate while ${label}`);
      assert.deepEqual(await row(id), before, `${label} is untouched`);
    }
    const stoppedNapper = await make({ status: "stopped", sleep_state: "napping" });
    assert.equal(await claimWake(stoppedNapper, uuid()), "refused", "wake needs a running agent");
    for (const state of ["draining", "hibernating", "waking"]) {
      const id = await make({ sleep_state: state });
      assert.equal(await claimWake(id, uuid()), "refused", `wake refuses ${state} without a lease`);
    }
    assert.equal(await claimWake(uuid(), uuid()), "refused", "no such agent");
    assert.equal(await claimWake(a, null), "refused", "no operation id");
    const busyWake = await make({ sleep_state: "napping", operation_id: uuid(), operation_kind: "restart", operation_started_at: "2026-11-01T00:00:00Z" });
    assert.equal(await claimWake(busyWake, uuid()), "busy");

    // Delete requested while a sleep or wake is in flight: only the lease is cleared.
    const d = await make();
    const op4 = uuid();
    await claimSleep(d, op4, "nap", 0);
    await db.query("update public.hivra_agents set desired_state = 'deleted' where id = $1", [d]);
    assert.equal(await finishSleep(d, op4, "napping"), true);
    r = await row(d);
    assert.deepEqual([r.status, r.desired_state, r.sleep_state, r.gen, r.operation_id, r.operation_kind], ["running", "deleted", "draining", 1, null, null]);
    const e = await make({ sleep_state: "hibernated", sleep_generation: 3 });
    const op5 = uuid();
    assert.equal(await claimWake(e, op5), "claimed");
    await db.query("update public.hivra_agents set desired_state = 'deleted' where id = $1", [e]);
    assert.equal(await finishWake(e, op5, "awake"), true);
    r = await row(e);
    assert.deepEqual([r.status, r.desired_state, r.sleep_state, r.gen, r.operation_id], ["running", "deleted", "waking", 4, null]);

    // The generation compare-and-swap: of two sweeps that read the same agent, one wins.
    const f = await make();
    const [x, y] = [uuid(), uuid()];
    const first = await claimSleep(f, x, "nap", 0);
    const second = await claimSleep(f, y, "nap", 0);
    assert.deepEqual([Number(first), second], [1, null]);
    assert.equal((await row(f)).operation_id, x);

    // The lease shape: only a sleep or wake kind with a start time, and nothing else changed.
    await assert.rejects(
      db.query("update public.hivra_agents set operation_id = $2, operation_kind = 'nap', operation_started_at = now() where id = $1", [await make(), uuid()]),
      (error) => error.code === "23514");
    await db.query("update public.hivra_agents set operation_id = $2, operation_kind = 'wake', operation_started_at = now() where id = $1", [await make(), uuid()]);
    const constraint = (await one("select pg_get_constraintdef(oid) as d, convalidated from pg_constraint where conname = 'hivra_agents_operation_shape_check'"));
    assert.equal(constraint.convalidated, true);
    for (const kind of ["provision", "start", "stop", "restart", "resize", "snapshot", "restore", "delete",
      "desktop_prepare", "agent_attach", "private_access", "agent_access_change", "agent_detach", "runtime_update", "sleep", "wake"]) {
      assert.ok(constraint.d.includes(`'${kind}'`), `operation shape admits ${kind}`);
    }

    // Events: kinds and triggers are checked, rows follow the agent, one index per agent and time.
    const insertEvent = (agentId, kind, trigger) => db.query(
      "insert into public.hivra_agent_sleep_events (agent_id, kind, trigger, from_state, to_state, generation, duration_ms, reason, detail) values ($1, $2, $3, 'awake', 'napping', 1, 1500, 'idle', '{\"suspendMs\": 800}')",
      [agentId, kind, trigger]);
    for (const kind of ["nap", "hibernate", "wake", "abort", "fail", "reconcile"]) await insertEvent(f, kind, "sweep");
    for (const trigger of ["sweep", "manual", "open", "action", "schedule", "reconcile"]) await insertEvent(f, "wake", trigger);
    await assert.rejects(insertEvent(f, "sleep", "sweep"), (error) => error.code === "23514");
    await assert.rejects(insertEvent(f, "nap", "cron"), (error) => error.code === "23514");
    await assert.rejects(insertEvent(uuid(), "nap", "sweep"), (error) => error.code === "23503");
    const defaults = await one("select at is not null as has_at, id > 0 as has_id from public.hivra_agent_sleep_events limit 1");
    assert.deepEqual(defaults, { has_at: true, has_id: true });
    assert.equal(Number((await one("select count(*)::int as n from public.hivra_agent_sleep_events where agent_id = $1", [f])).n), 12);
    const indexDef = (await one("select indexdef from pg_indexes where indexname = 'hivra_agent_sleep_events_agent_at_idx'")).indexdef;
    assert.match(indexDef, /\(agent_id, at DESC\)/);
    await db.query("delete from public.hivra_agents where id = $1", [f]);
    assert.equal(Number((await one("select count(*)::int as n from public.hivra_agent_sleep_events where agent_id = $1", [f])).n), 0, "events cascade");

    // No sleep or wake call ever changed status away from running.
    const statuses = (await db.query("select distinct status from public.hivra_agents where id = any($1)", [[a, b, c, d, e]])).rows;
    assert.deepEqual(statuses, [{ status: "running" }]);

    // Browsers can read or call none of it; only the service role can call the functions.
    const signatures = [
      "public.claim_hivra_agent_sleep(uuid, uuid, text, bigint)",
      "public.finish_hivra_agent_sleep(uuid, uuid, text)",
      "public.claim_hivra_agent_wake(uuid, uuid)",
      "public.finish_hivra_agent_wake(uuid, uuid, text)",
    ];
    for (const role of ["anon", "authenticated"]) {
      for (const signature of signatures) {
        assert.equal((await one("select has_function_privilege($1, $2, 'execute') as ok", [role, signature])).ok,
          false, `${role} cannot execute ${signature}`);
      }
    }
    for (const signature of signatures) {
      assert.equal((await one("select count(*)::int as n from pg_proc p, aclexplode(p.proacl) g where p.oid = $1::regprocedure and g.grantee = 0", [signature])).n,
        0, `${signature} is not granted to PUBLIC`);
    }
    for (const signature of signatures) {
      assert.equal((await one("select has_function_privilege('service_role', $1, 'execute') as ok", [signature])).ok, true);
      const def = await one("select prosecdef, proconfig from pg_proc where oid = $1::regprocedure", [signature]);
      assert.equal(def.prosecdef, true, `${signature} is security definer`);
      assert.deepEqual(def.proconfig, ["search_path=public"], `${signature} pins its search path`);
    }
    for (const role of ["anon", "authenticated"]) {
      for (const privilege of ["select", "insert", "update", "delete"]) {
        assert.equal((await one("select has_table_privilege($1, 'public.hivra_agent_sleep_events', $2) as ok", [role, privilege])).ok,
          false, `${role} cannot ${privilege} the sleep events`);
      }
      assert.equal((await one("select has_sequence_privilege($1, 'public.hivra_agent_sleep_events_id_seq', 'usage') as ok", [role])).ok,
        false, `${role} cannot use the events sequence`);
    }
    assert.equal((await one("select relrowsecurity as on from pg_class where oid = 'public.hivra_agent_sleep_events'::regclass")).on, true);
    assert.equal((await one("select count(*)::int as n from pg_policies where tablename = 'hivra_agent_sleep_events'")).n, 0);

    console.log("PASS agent sleep and wake leases");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
