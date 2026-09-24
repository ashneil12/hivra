// Apply every migration up to 20260924190000 in PostgreSQL/WASM (twice for the
// new file, proving it re-runs), then check what it adds:
// - hivra_computer_contracts: one row per agent revision, a delivered or sent
//   revision always carries its receipt, content is capped, and the table is
//   closed to anon and authenticated with RLS on;
// - hivra_do_session_inputs.source: existing prompts read as the owner's, and
//   only Hivra's visible setup note may be marked otherwise.
// Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const TARGET = "20260924190000_hivra_computer_contracts.sql";
const CONNECTION = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const SESSION_NAME = "hivra-22222222222242228222222222222222";
const DIGEST = "a".repeat(64);

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

    const revision = (n, extra = "") => `insert into public.hivra_computer_contracts
        (agent_id,user_id,revision,template_version,channel,input,input_sha256,content,content_sha256${extra ? "," + extra.split("|")[0] : ""})
      values ('${AGENT}','owner',${n},1,'do-setup-message','{"templateVersion":1}'::jsonb,'${DIGEST}','note ${n}','${DIGEST}'${extra ? "," + extra.split("|")[1] : ""})`;

    await db.exec(revision(1));
    const stored = await one("select delivery_state, delivered_at, receipt, rendered_at is not null as rendered from public.hivra_computer_contracts where revision = 1");
    assert.deepEqual(stored, { delivery_state: "pending", delivered_at: null, receipt: null, rendered: true });
    await rejects(db, revision(1), /hivra_computer_contracts_revision_key/, "a second revision 1");
    await rejects(db, revision(0), /hivra_computer_contracts_revision_check/, "revision 0");
    await rejects(db, revision(2, "delivery_state|'delivered'"), /hivra_computer_contracts_delivery_receipt_check/, "delivered without a receipt");
    await rejects(db, revision(2, "delivery_state,delivered_at,receipt|'sent',now(),null"), /hivra_computer_contracts_delivery_receipt_check/, "sent without a receipt");
    await rejects(db, revision(2, "delivered_at|now()"), /hivra_computer_contracts_delivery_receipt_check/, "pending with a delivery time");
    await rejects(db, revision(2).replace("'do-setup-message'", "'email'"), /hivra_computer_contracts_channel_check/, "unknown channel");
    await rejects(db, revision(2, "last_error|'Free text; drop table'"), /hivra_computer_contracts_last_error_check/, "free-text error");
    await rejects(db, revision(2).replace("'note 2'", "repeat('x', 4097)"), /hivra_computer_contracts_content_check/, "content over 4 KB");
    await rejects(db, revision(2).replace(`'${DIGEST}','note 2'`, "'not-a-digest','note 2'"), /hivra_computer_contracts_input_sha256_check/, "bad input digest");
    await db.exec(revision(2, `delivery_state,delivered_at,receipt|'sent',now(),'{"runId":"run_1"}'::jsonb`));
    // A delivered revision later found edited keeps its delivery as history.
    await db.exec(`update public.hivra_computer_contracts set delivery_state = 'conflict', last_error = 'edited_on_computer' where revision = 2`);
    assert.equal((await one("select delivered_at is not null as kept from public.hivra_computer_contracts where revision = 2")).kept, true);

    for (const role of ["anon", "authenticated"]) {
      for (const privilege of ["select", "insert", "update", "delete"]) {
        const { allowed } = await one("select has_table_privilege($1, 'public.hivra_computer_contracts', $2) as allowed", [role, privilege]);
        assert.equal(allowed, false, `${role} cannot ${privilege} computer contracts`);
      }
    }
    assert.equal((await one("select has_table_privilege('service_role', 'public.hivra_computer_contracts', 'insert') as allowed")).allowed, true);
    assert.equal((await one("select relrowsecurity from pg_class where oid = 'public.hivra_computer_contracts'::regclass")).relrowsecurity, true);

    // Prompt source: old rows are the owner's; only Hivra's setup note differs.
    await db.exec(`insert into public.hivra_do_session_inputs (agent_id,user_id,run_id,text) values ('${AGENT}','owner','run_1','hello')`);
    assert.equal((await one("select source from public.hivra_do_session_inputs where run_id = 'run_1'")).source, "user");
    await db.exec(`insert into public.hivra_do_session_inputs (agent_id,user_id,run_id,text,source) values ('${AGENT}','owner','run_2','note','hivra-setup')`);
    await rejects(db, `insert into public.hivra_do_session_inputs (agent_id,user_id,run_id,text,source) values ('${AGENT}','owner','run_3','x','system')`,
      /hivra_do_session_inputs_source_check/, "an unknown prompt source");
    assert.equal(Number((await one("select count(*) as n from pg_constraint where conname = 'hivra_do_session_inputs_source_check'")).n), 1);

    console.log("PASS hivra computer contracts");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
