// Apply every migration up to 20261020121500 in PostgreSQL/WASM (the new one
// twice, proving it re-runs), then check what it changes on
// hivra_agent_cli_updates: rows for the Aeon dashboard, OpenClaw and Agent Zero
// save with each app's own version form (an upstream commit, an x.y.z release,
// an image digest) in every version column; anything else is still refused;
// rows saved under the old checks still pass; pauses stay x.y.z (automatic
// updates are CLI-only). Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const TARGET = "20261020121500_hivra_agent_app_updates.sql";
const COMMIT = "8b8d719715ec9bb68fb858a1e334d23209047d82";
const DIGEST = "sha256:" + "b".repeat(64);

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
    const agent = async (type) => (await one(
      "insert into public.hivra_agents (user_id, type, name, status) values ('owner', $1, 'agent', 'running') returning id",
      [type],
    )).id;

    // A CLI row saved before still passes.
    const codex = await agent("codex");
    await db.query(`insert into public.hivra_agent_cli_updates (agent_id, user_id, cli_name, observation, installed_version, tested_version)
      values ($1, 'owner', 'codex', 'reported', '0.149.0', '0.149.1')`, [codex]);

    // Each app saves a full observation and request in its own version form.
    for (const [type, older, tested] of [["aeon", "e".repeat(40), COMMIT], ["openclaw", "2026.6.10", "2026.9.33"], ["agent-zero", "sha256:" + "d".repeat(64), DIGEST]]) {
      const id = await agent(type);
      await db.query(`insert into public.hivra_agent_cli_updates (agent_id, user_id, cli_name, observation, installed_version, tested_version,
        hivra_installed_version, update_state, update_target, update_reason, update_updated_at, observed_at,
        requested_at, requested_target, requested_by, request_result)
        values ($1, 'owner', $2, 'reported', $3, $4, $3, 'waiting', $4, null, now(), now(), now(), $4, 'owner', 'scheduled')`, [id, type, older, tested]);
      const row = await one("select cli_name, installed_version, tested_version, update_target, requested_target from public.hivra_agent_cli_updates where agent_id = $1", [id]);
      assert.deepEqual(row, { cli_name: type, installed_version: older, tested_version: tested, update_target: tested, requested_target: tested }, type);
    }

    // Anything else is still refused.
    await rejects(db, `update public.hivra_agent_cli_updates set cli_name = 'hermes' where agent_id = '${codex}'`, /cli_name_check/, "unknown software");
    for (const column of ["installed_version", "tested_version", "hivra_installed_version", "update_target", "requested_target"]) {
      for (const value of ["latest", "v2.14", "8b8d719", "sha256:short", "1.2"]) {
        await rejects(db, `update public.hivra_agent_cli_updates set ${column} = '${value}' where agent_id = '${codex}'`, new RegExp(`${column}_check|update_shape|request_shape`), `${column} = ${value}`);
      }
    }
    // Pauses follow automatic updates, which only the CLIs get.
    await rejects(db, `update public.hivra_agent_cli_updates set auto_paused_target = '${DIGEST}', auto_paused_reason = 'failed' where agent_id = '${codex}'`, /auto_paused_target_check/, "a paused app target");
    await db.exec(`update public.hivra_agent_cli_updates set auto_paused_target = '0.149.1', auto_paused_reason = 'failed' where agent_id = '${codex}'`);

    process.stdout.write("PASS hivra agent app updates\n");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
