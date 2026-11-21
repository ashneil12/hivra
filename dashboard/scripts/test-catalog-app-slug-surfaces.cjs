// Apply every migration up to 20261121090000 in PostgreSQL/WASM, then check
// what it changes on hivra_canonical_surfaces and hivra_canonical_actions:
// any catalog-shaped slug gets the catalog surfaces and the delete action,
// while 'aeon', the computer/OS profile types, bogus types, non-running
// statuses and hermes-source rows are unchanged. The patch re-runs without
// changing the functions (idempotent) and fails if an anchor is missing or
// duplicated. Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const TARGET = "20261121090000_catalog_app_slug_surfaces.sql";

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
    const surfaces = (source, payload, isComputer = false, deleted = false) => one(
      "select public.hivra_canonical_surfaces($1,$2::jsonb,$3,$4) as s",
      [source, JSON.stringify(payload), isComputer, deleted],
    ).then((row) => row.s);
    const actions = (source, payload, isComputer = false, deleted = false) => one(
      "select public.hivra_canonical_actions($1,$2::jsonb,$3,$4) as s",
      [source, JSON.stringify(payload), isComputer, deleted],
    ).then((row) => row.s);

    // A catalog slug that no Wave 1 list names still gets the catalog surfaces
    // while running, and the delete action in every agent status the actions
    // branch allows.
    assert.deepEqual(await surfaces("hivra", { status: "running", type: "memos" }), ["workspace", "files", "git", "terminal"], "memos running surfaces");
    assert.deepEqual(await surfaces("hivra", { status: "stopped", type: "memos" }), [], "surfaces still need running");
    assert.deepEqual(await actions("hivra", { status: "running", type: "memos" }), ["delete"], "memos running actions");
    assert.deepEqual(await actions("hivra", { status: "stopped", type: "memos" }), ["delete"], "memos stopped actions");
    assert.deepEqual(await actions("hivra", { status: "provisioning", type: "memos" }), ["delete"], "memos provisioning actions");
    assert.deepEqual(await actions("hivra", { status: "paused", type: "memos" }), [], "the status check still bounds the slug branch");
    assert.deepEqual(await actions("hivra", { status: "running", type: "memos" }, false, true), [], "deleted stays empty");

    // 'aeon' keeps its own narrower surfaces branch, and the computer/OS
    // profile types stay excluded from the catalog-slug branch.
    assert.deepEqual(await surfaces("hivra", { status: "running", type: "aeon" }), ["workspace"], "aeon surfaces");
    assert.deepEqual(await actions("hivra", { status: "running", type: "aeon" }), ["delete"], "aeon actions");
    for (const type of ["linux-desktop", "linux-server", "linux-terminal", "omarchy", "windows", "ubuntu-desktop", "ubuntu-server"]) {
      assert.deepEqual(await surfaces("hivra", { status: "running", type }), [], `${type} surfaces`);
      assert.deepEqual(await actions("hivra", { status: "running", type }), [], `${type} actions`);
    }

    // A type that is not slug-shaped still fails closed.
    assert.deepEqual(await surfaces("hivra", { status: "running", type: "Bad_Type" }), [], "bogus surfaces");
    assert.deepEqual(await actions("hivra", { status: "running", type: "Bad_Type" }), [], "bogus actions");
    assert.deepEqual(await surfaces("hivra", { status: "running", type: "a" }), [], "one-letter surfaces");

    // Hermes-source rows are untouched: the hermes branches still win first.
    assert.deepEqual(
      await surfaces("hermes", { status: "running", backend: "gateway", type: "memos" }),
      ["workspace", "terminal", "browser", "native"],
      "hermes gateway surfaces",
    );
    assert.deepEqual(
      await actions("hermes", { status: "running", backend: "gateway", type: "memos" }),
      ["stop", "reboot", "delete"],
      "hermes gateway actions",
    );
    assert.deepEqual(
      await actions("hermes", { status: "running", backend: "other", type: "memos" }),
      [],
      "hermes non-webui backend actions",
    );

    // Wave 1 slugs keep working through the explicit list.
    assert.deepEqual(await surfaces("hivra", { status: "running", type: "gitea" }), ["workspace", "files", "git", "terminal"]);
    assert.deepEqual(await actions("hivra", { status: "running", type: "gitea" }), ["delete"]);

    const surfacesBefore = (await one("select pg_get_functiondef('public.hivra_canonical_surfaces(text,jsonb,boolean,boolean)'::regprocedure) as d")).d;
    const actionsBefore = (await one("select pg_get_functiondef('public.hivra_canonical_actions(text,jsonb,boolean,boolean)'::regprocedure) as d")).d;
    assert.ok(surfacesBefore.includes(" or (lower(btrim(coalesce(p_payload->>'type',''))) ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$'"), "the slug branch is in the surfaces function");
    assert.ok(actionsBefore.includes("p_source_kind='hivra' and (lower(btrim(coalesce(p_payload->>'type',''))) in ('hermes'"), "the actions branch is wrapped");
    assert.ok(actionsBefore.includes("'uptime-kuma','gitea') or (lower(btrim"), "the actions slug branch is in place");

    // The patch is idempotent, and it refuses a missing or duplicated anchor.
    await db.exec(migration(TARGET));
    assert.equal((await one("select pg_get_functiondef('public.hivra_canonical_surfaces(text,jsonb,boolean,boolean)'::regprocedure) as d")).d, surfacesBefore, "a re-run leaves the surfaces function as it is");
    assert.equal((await one("select pg_get_functiondef('public.hivra_canonical_actions(text,jsonb,boolean,boolean)'::regprocedure) as d")).d, actionsBefore, "a re-run leaves the actions function as it is");

    const surfaceFn = "public.hivra_canonical_surfaces(text,jsonb,boolean,boolean)";
    const actionsFn = "public.hivra_canonical_actions(text,jsonb,boolean,boolean)";
    // The same anchor/addition pairs the migration patches with, so reversing
    // them here reproduces exactly the pre-migration function text.
    const TYPE_LIST = "'hermes','claude-code','codex','openclaw','agent-zero','deepseek-harness'";
    const SURFACE_ANCHOR = "'deepseek-harness','openbot','nuphos','nanobot','zeroclaw','picoclaw','opencode','goose','openhands','anythingllm','activepieces','uptime-kuma','gitea')";
    const SLUG_BRANCH = " or (lower(btrim(coalesce(p_payload->>'type',''))) ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$' and lower(btrim(coalesce(p_payload->>'type',''))) not in ('aeon','linux-desktop','linux-server','linux-terminal','omarchy','windows','ubuntu-desktop','ubuntu-server'))";
    const ACTIONS_ANCHOR = `p_source_kind='hivra' and lower(btrim(coalesce(p_payload->>'type',''))) in (${TYPE_LIST},'aeon','openbot','nuphos','nanobot','zeroclaw','picoclaw','opencode','goose','openhands','anythingllm','activepieces','uptime-kuma','gitea')`;
    const ACTIONS_ADDITION = `p_source_kind='hivra' and (lower(btrim(coalesce(p_payload->>'type',''))) in (${TYPE_LIST},'aeon','openbot','nuphos','nanobot','zeroclaw','picoclaw','opencode','goose','openhands','anythingllm','activepieces','uptime-kuma','gitea')${SLUG_BRANCH})`;
    const unpatchedSurfaces = surfacesBefore.split(SURFACE_ANCHOR + SLUG_BRANCH).join(SURFACE_ANCHOR);
    const unpatchedActions = actionsBefore.split(ACTIONS_ADDITION).join(ACTIONS_ANCHOR);
    assert.notEqual(unpatchedSurfaces, surfacesBefore, "the surfaces unpatched variant must differ");
    assert.notEqual(unpatchedActions, actionsBefore, "the actions unpatched variant must differ");
    await db.exec(unpatchedSurfaces);
    await db.exec(unpatchedActions);
    await db.exec(migration(TARGET));
    assert.equal((await one(`select pg_get_functiondef('${surfaceFn}'::regprocedure) as d`)).d, surfacesBefore, "re-applying restores the surfaces patch");
    assert.equal((await one(`select pg_get_functiondef('${actionsFn}'::regprocedure) as d`)).d, actionsBefore, "re-applying restores the actions patch");

    await db.exec(surfacesBefore.split(SURFACE_ANCHOR).join("'deepseek-harness','openbot','nuphos','nanobot','zeroclaw','picoclaw','opencode','goose','openhands','anythingllm','activepieces','uptime-kuma','gitea','memos')"));
    await rejects(db, migration(TARGET), /anchor mismatch/, "a duplicated surfaces anchor");
    await db.exec(surfacesBefore);
    await db.exec(actionsBefore.split("not in ('aeon','linux-desktop'").join("not in ('aeon','aeon','linux-desktop'"));
    await rejects(db, migration(TARGET), /anchor mismatch/, "a duplicated actions anchor");
    await db.exec(actionsBefore);

    console.log("PASS catalog app slug surfaces");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
