// Apply every migration up to 20261020120000 in PostgreSQL/WASM (the new one
// twice, proving it re-runs), then check what it adds:
// - hivra_agent_cli_updates: one row per agent, versions only in x.y.z form,
//   closed enums for observations, update states, request results and pauses,
//   request, pause and update fields present together or not at all, removed
//   with its agent, and closed to anon and authenticated with RLS on;
// - claim_hivra_agent_cli_update_request: one claim per (agent, target) every
//   20 hours, a new target claimable at once, a request the host wasn't ready
//   for or another operation blocked not holding the cooldown (any other
//   refusal does), only for the agent's owner, and executable by the service
//   role only. An automatic claim is refused when the owner turned automatic
//   updates off, on the owner's own server unless they turned them on, and for
//   a target paused after a failed automatic update, whatever the sweep read.
// Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const TARGET = "20261020120000_hivra_agent_cli_updates.sql";
const CLAIM = "public.claim_hivra_agent_cli_update_request(uuid, text, text, text, text, interval)";

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
    for (const name of [...files, TARGET]) {
      // PGlite ships without extensions; the functions they provide are stubbed above.
      await db.exec(fs.readFileSync(path.join(MIGRATIONS, name), "utf8").replace(/create extension[^;]*;/gi, ""));
    }

    const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
    const agent = async (userId) => (await one(
      "insert into public.hivra_agents (user_id, type, name, status) values ($1, 'codex', 'Codex agent', 'running') returning id",
      [userId],
    )).id;
    const owned = await agent("owner");
    const other = await agent("someone-else");

    // Closed to the API roles, RLS on, no policies.
    for (const role of ["anon", "authenticated"]) {
      for (const privilege of ["select", "insert", "update", "delete"]) {
        const { allowed } = await one("select has_table_privilege($1, 'public.hivra_agent_cli_updates', $2) as allowed", [role, privilege]);
        assert.equal(allowed, false, `${role} must not ${privilege}`);
      }
      assert.equal((await one("select has_function_privilege($1, $2, 'execute') ok", [role, CLAIM])).ok, false, `${role} must not claim`);
    }
    assert.equal((await one("select has_table_privilege('service_role', 'public.hivra_agent_cli_updates', 'insert') as allowed")).allowed, true);
    assert.equal((await one("select has_function_privilege('service_role', $1, 'execute') ok", [CLAIM])).ok, true);
    assert.equal((await one("select relrowsecurity from pg_class where oid = 'public.hivra_agent_cli_updates'::regclass")).relrowsecurity, true);
    assert.equal(Number((await one("select count(*) n from pg_policies where tablename = 'hivra_agent_cli_updates'")).n), 0);

    // A full observation row saves.
    await db.query(`insert into public.hivra_agent_cli_updates (agent_id, user_id, cli_name, observation, installed_version, tested_version,
      hivra_installed_version, update_state, update_target, update_reason, update_updated_at, observed_at, auto_update)
      values ($1, 'owner', 'codex', 'reported', '0.149.0', '0.149.1', '0.149.0', 'rolled_back', '0.149.1', 'install_failed', now(), now(), null)`, [owned]);

    // Closed values and shapes.
    await rejects(db, `update public.hivra_agent_cli_updates set installed_version = 'latest' where agent_id = '${owned}'`, /installed_version_check/, "non-semver installed version");
    await rejects(db, `update public.hivra_agent_cli_updates set tested_version = '1.2' where agent_id = '${owned}'`, /tested_version_check/, "short tested version");
    await rejects(db, `update public.hivra_agent_cli_updates set cli_name = 'gemini' where agent_id = '${owned}'`, /cli_name_check/, "unknown CLI");
    await rejects(db, `update public.hivra_agent_cli_updates set observation = 'guessed' where agent_id = '${owned}'`, /observation_check/, "unknown observation");
    await rejects(db, `update public.hivra_agent_cli_updates set update_state = 'exploded' where agent_id = '${owned}'`, /update_state_check/, "unknown update state");
    await rejects(db, `update public.hivra_agent_cli_updates set update_reason = 'Rm -rf' where agent_id = '${owned}'`, /update_reason_check/, "malformed reason");
    await rejects(db, `update public.hivra_agent_cli_updates set update_target = null where agent_id = '${owned}'`, /update_shape/, "update state without a target");
    await rejects(db, `update public.hivra_agent_cli_updates set auto_paused_target = '0.149.1' where agent_id = '${owned}'`, /pause_shape/, "pause without a reason");
    await rejects(db, `update public.hivra_agent_cli_updates set auto_paused_target = '0.149.1', auto_paused_reason = 'bored' where agent_id = '${owned}'`, /auto_paused_reason_check/, "unknown pause reason");
    await rejects(db, `update public.hivra_agent_cli_updates set requested_at = now(), requested_target = '0.149.1' where agent_id = '${owned}'`, /request_shape/, "request without who asked");
    await rejects(db, `update public.hivra_agent_cli_updates set requested_at = now(), requested_target = '0.149.1', requested_by = 'owner', request_result = 'maybe' where agent_id = '${owned}'`, /request_result_check/, "unknown request result");
    await rejects(db, `insert into public.hivra_agent_cli_updates (agent_id, user_id) values ('${owned}', 'owner')`, /duplicate key/, "a second row for the agent");

    // One claim per target every 20 hours.
    const claim = async (agentId, userId, target, by = "auto") =>
      (await one(`select public.claim_hivra_agent_cli_update_request($1, $2, 'codex', $3, $4) ok`, [agentId, userId, target, by])).ok;
    assert.equal(await claim(owned, "owner", "0.149.1"), true, "first claim");
    const claimed = await one("select requested_by, requested_target, request_result, installed_version from public.hivra_agent_cli_updates where agent_id = $1", [owned]);
    assert.deepEqual(claimed, { requested_by: "auto", requested_target: "0.149.1", request_result: null, installed_version: "0.149.0" }, "the claim keeps the observation");
    assert.equal(await claim(owned, "owner", "0.149.1"), false, "same target inside the cooldown");
    await db.query("update public.hivra_agent_cli_updates set request_result = 'scheduled' where agent_id = $1", [owned]);
    assert.equal(await claim(owned, "owner", "0.149.1"), false, "a request that reached the computer holds the cooldown");
    await db.query("update public.hivra_agent_cli_updates set request_result = 'busy' where agent_id = $1", [owned]);
    assert.equal(await claim(owned, "owner", "0.149.1"), true, "a request another operation blocked does not");
    await db.query("update public.hivra_agent_cli_updates set request_result = 'host_not_ready' where agent_id = $1", [owned]);
    assert.equal(await claim(owned, "owner", "0.149.1"), true, "nor one the host wasn't ready for");
    await db.query("update public.hivra_agent_cli_updates set request_result = 'refused' where agent_id = $1", [owned]);
    assert.equal(await claim(owned, "owner", "0.149.1"), false, "a refusal that won't clear by itself holds the cooldown");
    await db.query("update public.hivra_agent_cli_updates set request_result = 'unverified', requested_at = now() - interval '21 hours' where agent_id = $1", [owned]);
    assert.equal(await claim(owned, "owner", "0.149.1"), true, "after 20 hours");
    assert.equal(await claim(owned, "owner", "0.150.0"), true, "a new target at once");
    assert.equal(await claim(other, "owner", "0.149.1"), false, "not the owner's agent");
    assert.equal(Number((await one("select count(*) n from public.hivra_agent_cli_updates where agent_id = $1", [other])).n), 0, "no row for someone else's agent");
    assert.equal(await claim(other, "someone-else", "0.149.1"), true, "a first claim creates the row");

    // The owner's automatic-update choice, whatever the sweep read.
    const fresh = async (userId) => {
      const id = await agent(userId);
      await db.query("insert into public.hivra_agent_cli_updates (agent_id, user_id, cli_name) values ($1, $2, 'codex')", [id, userId]);
      return id;
    };
    const optedOut = await fresh("owner");
    await db.query("update public.hivra_agent_cli_updates set auto_update = false where agent_id = $1", [optedOut]);
    assert.equal(await claim(optedOut, "owner", "0.149.1"), false, "automatic updates turned off");
    const optedOutClaim = await one("select requested_at from public.hivra_agent_cli_updates where agent_id = $1", [optedOut]);
    assert.equal(optedOutClaim.requested_at, null, "a refused automatic claim writes nothing");
    assert.equal(await claim(optedOut, "owner", "0.149.1", "owner"), true, "the owner's own request still goes through");
    const defaultOn = await fresh("owner");
    assert.equal(await claim(defaultOn, "owner", "0.149.1"), true, "Hivra Cloud with no choice: on by default");
    const paused = await fresh("owner");
    await db.query("update public.hivra_agent_cli_updates set auto_paused_target = '0.149.1', auto_paused_reason = 'rolled_back' where agent_id = $1", [paused]);
    assert.equal(await claim(paused, "owner", "0.149.1"), false, "paused for this target");
    assert.equal(await claim(paused, "owner", "0.150.0"), true, "a newer target isn't paused");

    // My server: off until the owner turns it on, with or without a stored row.
    // Only deployment_mode matters here, so the fixture skips the connection
    // binding a real self-managed agent carries (its check and trigger).
    await db.exec("alter table public.hivra_agents drop constraint hivra_agents_deployment_authority_matrix_check");
    const ownServer = async () => {
      await db.exec("set session_replication_role = replica");
      try {
        return (await one(
          `insert into public.hivra_agents (user_id, type, name, status, deployment_mode, proxmox_host)
           values ('owner', 'codex', 'Codex agent', 'running', 'self-managed', '__hivra_self_managed_no_ambient_authority__') returning id`,
        )).id;
      } finally {
        await db.exec("set session_replication_role = origin");
      }
    };
    const noRow = await ownServer();
    assert.equal(await claim(noRow, "owner", "0.149.1"), false, "My server with no row: off by default");
    assert.equal(Number((await one("select count(*) n from public.hivra_agent_cli_updates where agent_id = $1", [noRow])).n), 0, "and no row is created");
    const noChoice = await ownServer();
    await db.query("insert into public.hivra_agent_cli_updates (agent_id, user_id, cli_name) values ($1, 'owner', 'codex')", [noChoice]);
    assert.equal(await claim(noChoice, "owner", "0.149.1"), false, "My server with no choice: off by default");
    await db.query("update public.hivra_agent_cli_updates set auto_update = true where agent_id = $1", [noChoice]);
    assert.equal(await claim(noChoice, "owner", "0.149.1"), true, "My server once its owner turned it on");

    // Removed with its agent.
    await db.query("delete from public.hivra_agents where id = $1", [owned]);
    assert.equal(Number((await one("select count(*) n from public.hivra_agent_cli_updates where agent_id = $1", [owned])).n), 0, "cascade");

    console.log("PASS hivra agent cli updates");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
