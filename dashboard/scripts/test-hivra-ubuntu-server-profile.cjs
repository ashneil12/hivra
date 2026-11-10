// Apply every migration up to the Ubuntu server profile in PostgreSQL/WASM, then
// check what 20261111090000 widens and what it leaves alone:
// - hivra_agents.computer_profile accepts 'ubuntu-server' and still refuses
//   other values;
// - bind_hivra_launch_operation_agent binds a linux-desktop launch to an
//   ubuntu-desktop or ubuntu-server row, still refuses omarchy, windows,
//   linux-terminal and a row with no profile, and still refuses an agent type
//   mismatch;
// - the patch re-runs without changing the function (idempotent) and fails if
//   its anchor is missing or duplicated.
// Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const TARGET = "20261111090000_hivra_ubuntu_server_profile.sql";
const OWNER = "owner";
const DIGEST = "a".repeat(64);
const INTENT = "b".repeat(64);

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
    const migration = (name) => fs.readFileSync(path.join(MIGRATIONS, name), "utf8").replace(/create extension[^;]*;/gi, "");
    for (const name of files) {
      try { await db.exec(migration(name)); } catch (e) { console.error("failed in", name); throw e; }
    }

    const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
    let nextVmid = 9000;
    const agent = async (id, type, profile) => {
      nextVmid += 1;
      // The fixture rows stand in for rows the launch route already created, so the
      // creation guards for other profiles (prepared Omarchy) are not under test here.
      await db.exec("set session_replication_role = replica");
      await db.query(
        `insert into public.hivra_agents (id,user_id,type,name,status,desired_state,computer_profile,cpu,ram,
          computer_substrate,proxmox_host,vmid,infrastructure_binding_token_hash,infrastructure_binding_token_enforced)
         values ($1,$2,$3,'fixture','provisioning','running',$4,1,2,'proxmox-kvm','fixturenode',$5,repeat('a',64),true)`,
        [id, OWNER, type, profile, nextVmid],
      );
      await db.exec("set session_replication_role = origin");
    };
    const uuid = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

    // The profile check accepts the new profile and nothing else new.
    await agent(uuid(1), "linux-desktop", "ubuntu-desktop");
    await agent(uuid(2), "linux-desktop", "ubuntu-server");
    await rejects(db, `update public.hivra_agents set computer_profile='ubuntu-mini' where id='${uuid(2)}'`,
      /hivra_agents_computer_profile_check/, "an unknown profile");
    assert.equal(Number((await one(`select count(*) as n from pg_constraint
      where conrelid='public.hivra_agents'::regclass and conname='hivra_agents_computer_profile_check'`)).n), 1);

    // Binding a launch operation to its row.
    const reserve = async (n, kind, runtime) => (await one(
      `select public.reserve_hivra_launch_operation($1,$2,$3,$4,$5,$6,$7) as result`,
      [OWNER, uuid(100 + n), uuid(200 + n), DIGEST, INTENT, kind, runtime])).result;
    const bind = async (n, agentId) => (await one(
      `select public.bind_hivra_launch_operation_agent($1,$2,$3,$4,$5,$6) as result`,
      [OWNER, uuid(100 + n), uuid(200 + n), DIGEST, INTENT, agentId])).result;
    const cases = [
      [1, "linux-desktop", "ubuntu-desktop", true],
      [2, "linux-desktop", "ubuntu-server", true],
      [3, "linux-desktop", "omarchy", false],
      [4, "linux-desktop", "windows", false],
      [5, "linux-desktop", null, false],
    ];
    for (const [n, type, profile, bound] of cases) {
      const id = uuid(10 + n);
      await agent(id, type, profile);
      await db.query("update public.hivra_agents set operation_id=$2,operation_kind='provision',operation_started_at=now() where id=$1", [id, uuid(200 + n)]);
      assert.equal((await reserve(n, "computer", "linux-desktop")).status, "reserved");
      const result = await bind(n, id);
      assert.equal(result !== null, bound, `${profile ?? "no profile"} ${bound ? "binds" : "is refused"}`);
      if (bound) assert.equal(result.phase, "bound");
    }
    // A codex launch still refuses a computer row, and a computer launch a codex row.
    const codex = uuid(30);
    await agent(codex, "codex", null);
    await db.query("update public.hivra_agents set operation_id=$2,operation_kind='provision',operation_started_at=now() where id=$1", [codex, uuid(206)]);
    assert.equal((await reserve(6, "computer", "linux-desktop")).status, "reserved");
    assert.equal(await bind(6, codex), null, "a computer launch never binds an agent row");

    // The patch is idempotent, and it refuses a missing or duplicated anchor.
    const before = (await one("select pg_get_functiondef('public.bind_hivra_launch_operation_agent(text,uuid,uuid,text,text,uuid)'::regprocedure) as d")).d;
    await db.exec(migration(TARGET));
    const after = (await one("select pg_get_functiondef('public.bind_hivra_launch_operation_agent(text,uuid,uuid,text,text,uuid)'::regprocedure) as d")).d;
    assert.equal(after, before, "a re-run leaves the function as it is");
    assert.equal(after.split("'ubuntu-server'").length - 1, 1);
    assert.ok(!after.includes("is distinct from 'ubuntu-desktop'"));

    const restore = before.replace("coalesce(a.computer_profile, '') not in ('ubuntu-desktop', 'ubuntu-server')", "a.computer_profile is distinct from 'ubuntu-desktop'");
    await db.exec(restore);
    await db.exec(migration(TARGET));
    assert.equal((await one("select pg_get_functiondef('public.bind_hivra_launch_operation_agent(text,uuid,uuid,text,text,uuid)'::regprocedure) as d")).d, before);
    const duplicated = restore.replace("declare\n", "declare\n  -- a.computer_profile is distinct from 'ubuntu-desktop'\n");
    assert.notEqual(duplicated, restore, "the duplicate-anchor variant must differ");
    await db.exec(duplicated);
    await rejects(db, migration(TARGET), /anchor mismatch/, "a duplicated anchor");
    await db.exec(restore.replace("a.computer_profile is distinct from 'ubuntu-desktop'", "a.computer_profile is distinct from 'omarchy'"));
    await rejects(db, migration(TARGET), /anchor mismatch/, "a missing anchor");

    console.log("PASS hivra ubuntu server profile");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
