// Apply every migration up to 20260924101500 in PostgreSQL/WASM (twice for the
// new file, proving it re-runs), then check the two things it adds:
// - a DigitalOcean agent can be released with a "forgotten" receipt only when
//   the receipt records the owner's acknowledgement and names the bound
//   session, and a forgotten agent can never come back;
// - owner-declared token expiry rows are shaped, owner-bound, cascade with
//   the connection, and closed to anon and authenticated.
// Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const TARGET = "20260924101500_digitalocean_token_expiry_and_forget.sql";
const CONNECTION = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const SESSION_NAME = "hivra-22222222222242228222222222222222";

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
    for (const name of [...files, TARGET]) {
      // PGlite ships without extensions; the functions they provide are stubbed above.
      await db.exec(fs.readFileSync(path.join(MIGRATIONS, name), "utf8").replace(/create extension[^;]*;/gi, ""));
    }

    const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
    await one(`select public.create_digitalocean_infrastructure_connection($1,'owner','Team','ciphertext',2::smallint,now(),$2::jsonb)`, [
      CONNECTION,
      JSON.stringify({ capacity: { model: "serverless-sessions", sizes: [] }, capabilities: { kind: "digitalocean-managed-agents", launchReady: true, adapter: { version: "2026.09.23.1" }, harnesses: ["claude-code", "codex", "hermes"], sizes: ["mars-2vcpu-4gb"] } }),
    ]);
    const { id: targetId } = await one("select id from public.deployment_targets where connection_id = $1", [CONNECTION]);
    await db.query(
      `insert into public.hivra_agents (id,user_id,type,name,status,desired_state,deployment_mode,computer_substrate,proxmox_host,cpu,ram,cpu_max,ram_max,
        infrastructure_connection_id,deployment_target_id,infrastructure_connection_revision,infrastructure_binding_token_hash,infrastructure_binding_token_enforced,
        do_session_name,do_session_harness,do_session_size,do_launch_request_id,chat_url)
       values ($1,'owner','codex','A','provisioning','running','self-managed','do-managed-session','__hivra_self_managed_no_ambient_authority__',2,4,2,4,
        $2,$3,1,repeat('a',64),true,$4,'codex','mars-2vcpu-4gb','33333333-3333-4333-8333-333333333333','/x')`,
      [AGENT, CONNECTION, targetId, SESSION_NAME],
    );
    await db.query("update public.hivra_agents set do_session_id = 'sess_abc', status = 'running' where id = $1", [AGENT]);

    const release = (receipt) => `
      update public.hivra_agents set status = 'deleted', desired_state = 'deleted', infrastructure_connection_id = null,
        deployment_target_id = null, infrastructure_connection_revision = null, do_cleanup_receipt = '${JSON.stringify(receipt)}'::jsonb
      where id = '${AGENT}'`;
    const binding = { connectionId: CONNECTION, targetId, connectionRevision: "1" };
    const base = { state: "forgotten", sessionName: SESSION_NAME, sessionId: "sess_abc", reason: "token_rejected", binding };

    await rejects(db, release(base), /hivra_agents_do_session_identity_check/, "forgotten without acknowledgement");
    await rejects(db, release({ ...base, state: "gone", acknowledgedAt: "2026-09-24T00:00:00Z" }), /hivra_agents_do_session_identity_check/, "unknown receipt state");
    await rejects(db, release({ ...base, sessionId: "sess_other", acknowledgedAt: "2026-09-24T00:00:00Z" }), /does not match the bound session/, "receipt for another session");
    await db.exec(release({ ...base, acknowledgedAt: "2026-09-24T00:00:00Z" }));
    const released = await one("select status, infrastructure_connection_id, do_cleanup_receipt->>'state' as state from public.hivra_agents where id = $1", [AGENT]);
    assert.deepEqual(released, { status: "deleted", infrastructure_connection_id: null, state: "forgotten" });
    await rejects(db, `update public.hivra_agents set status = 'running' where id = '${AGENT}'`, /cannot be reused/, "forgotten agent revived");

    // Token expiry: shape, owner binding, upsert, cascade, grants.
    await db.exec(`insert into public.infrastructure_credential_expiry (connection_id,user_id,no_expiry,expires_on) values ('${CONNECTION}','owner',false,'2026-10-01')`);
    await db.exec(`insert into public.infrastructure_credential_expiry (connection_id,user_id,no_expiry,expires_on) values ('${CONNECTION}','owner',true,null)
      on conflict (connection_id) do update set no_expiry = excluded.no_expiry, expires_on = excluded.expires_on`);
    assert.deepEqual(await one("select no_expiry, expires_on from public.infrastructure_credential_expiry"), { no_expiry: true, expires_on: null });
    await rejects(db, `update public.infrastructure_credential_expiry set expires_on = '2026-10-01'`, /infrastructure_credential_expiry_shape_check/, "no expiry with a date");
    await db.exec("delete from public.infrastructure_credential_expiry");
    await rejects(db, `insert into public.infrastructure_credential_expiry (connection_id,user_id,no_expiry) values ('${CONNECTION}','someone_else',true)`,
      /infrastructure_credential_expiry_connection_fk/, "another owner's connection");
    await db.exec(`insert into public.infrastructure_credential_expiry (connection_id,user_id,no_expiry) values ('${CONNECTION}','owner',true)`);
    for (const role of ["anon", "authenticated"]) {
      const { allowed } = await one("select has_table_privilege($1, 'public.infrastructure_credential_expiry', 'select') as allowed", [role]);
      assert.equal(allowed, false, `${role} cannot read declared expiry`);
    }
    assert.equal((await one("select relrowsecurity from pg_class where oid = 'public.infrastructure_credential_expiry'::regclass")).relrowsecurity, true);
    // With the agent released, the connection can go, and its reminder with it.
    await db.exec(`delete from public.infrastructure_connections where id = '${CONNECTION}'`);
    assert.equal(Number((await one("select count(*) as n from public.infrastructure_credential_expiry")).n), 0);

    console.log("PASS digitalocean token expiry and forget");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
