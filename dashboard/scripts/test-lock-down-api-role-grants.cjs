// Check 20260930140000_lock_down_api_role_grants in PostgreSQL/WASM with
// hosted Supabase's default privileges emulated. Entirely in memory: no
// credentials or live database.
//
// The shared harness applies every committed migration except this one, then
// this file reproduces what the audit found on Canary and checks the fix:
// - anon can read public tables, and anon and authenticated can run public
//   functions (including a SECURITY DEFINER one) that nothing ever revoked;
//   a table or function created later inherits the same access; any JWT with a
//   sub claim can store and read files in hermes-attachments;
// - after the migration (applied twice) anon and PUBLIC hold nothing on any
//   public table, view or sequence, anon, authenticated and PUBLIC cannot run
//   any public function except the ones a policy or a view calls, the service
//   role keeps everything it could use (including EXECUTE it held only through
//   PUBLIC), authenticated keeps its table reads, and a new table, sequence or
//   function starts closed to the API roles;
// - the eight trigger functions stay closed to the API roles and still fire;
//   the four mutable-search_path functions are pinned and behave exactly as
//   before, including a database whose body differs from the repository's;
// - the hermes-attachments policies are gone, unrelated storage policies stay,
//   and the bucket carries the limits its one upload path enforces;
// - a privilege the migration cannot remove makes it fail and roll back.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { citext } = require("@electric-sql/pglite/contrib/citext");
const { openMigratedDatabase, readMigration, SUPABASE_STUBS } = require("./lib/pglite-all-migrations.cjs");

const MIGRATION = "20260930140000_lock_down_api_role_grants.sql";
const DASHBOARD = path.resolve(__dirname, "..");
const ATTACKER = "attacker-sub";

// Hosted Supabase grants EXECUTE on new public functions and ALL on new public
// sequences to the API roles through default privileges. The shared harness
// emulates only the table default, so add the other two or the grant
// assertions below would pass for the wrong reason.
const HOSTED_DEFAULTS = `
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;
// Hosted Supabase also grants the API roles the storage tables and schema
// usage, and keeps row level security on storage.objects.
const HOSTED_STORAGE = `
  grant usage on schema storage, auth to anon, authenticated, service_role;
  grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
  alter table storage.objects enable row level security;
  insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true) on conflict (id) do nothing;
  create policy "avatars are public" on storage.objects for select to public using (bucket_id = 'avatars');
`;

const FOUR_LINT_FUNCTIONS = [
  "hermes_instances_canonicalize_hetzner_gateway_url",
  "hermes_instances_track_first_active",
  "set_current_timestamp_updated_at",
  "touch_vm_response_seconds_daily_updated_at",
];
// The trigger functions the audit found executable by PUBLIC, anon and
// authenticated, plus two that authenticated could run.
const TRIGGER_FUNCTIONS = [
  ...FOUR_LINT_FUNCTIONS,
  "guard_hivra_gvisor_computer",
  "prevent_credit_ledger_mutation",
  "prevent_deprecated_chat_content_mirror_write",
  "prevent_managed_venice_financial_event_mutation",
  "update_updated_at",
  "update_updated_at_column",
];

const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const all = async (db, sql, params) => (await db.query(sql, params)).rows;

const asRole = async (db, role, sub, sql, params) => {
  await db.exec(`set role ${role}`);
  await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(sub ? { sub, role } : { role })]);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claims', '', false)");
  }
};
const denied = (db, role, sub, sql, params, pattern = /permission denied/) =>
  assert.rejects(asRole(db, role, sub, sql, params), pattern, `${role} must be refused: ${sql}`);

const canExecute = async (db, role, signature) =>
  (await one(db, "select has_function_privilege($1, $2::regprocedure, 'execute') as can", [role, signature])).can;
const publicExecutes = async (db, signature) =>
  (
    await one(
      db,
      `select coalesce(bool_or(a.grantee = 0 and a.privilege_type = 'EXECUTE'), false) as can
         from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where p.oid = $1::regprocedure`,
      [signature]
    )
  ).can;
const functionSignatures = async (db, name) =>
  (
    await all(db, "select p.oid::regprocedure::text as sig from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1", [name])
  ).map((r) => r.sig);

/** Everything the migration must not take from authenticated or the service role. */
async function snapshot(db) {
  const tables = await all(
    db,
    `select c.relname || ':' || r.role_name || ':' || p.priv as k
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join (values ('authenticated'), ('service_role')) as r(role_name)
       cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(priv)
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and has_table_privilege(r.role_name, c.oid, p.priv)
      order by 1`
  );
  const sequences = await all(
    db,
    `select c.relname || ':' || p.priv as k
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) as p(priv)
      where n.nspname = 'public' and c.relkind = 'S' and has_sequence_privilege('service_role', c.oid, p.priv)
      order by 1`
  );
  const serviceFunctions = await all(
    db,
    `select p.oid::regprocedure::text as k from pg_proc p
      where p.pronamespace = 'public'::regnamespace and has_function_privilege('service_role', p.oid, 'execute') order by 1`
  );
  return {
    tables: tables.map((r) => r.k),
    sequences: sequences.map((r) => r.k),
    serviceFunctions: serviceFunctions.map((r) => r.k),
  };
}

/** Fire the four mutable-search_path triggers through real tables. */
async function exerciseTriggers(db, tag) {
  const instance = (
    await db.query(
      `insert into public.hermes_instances (user_id, name, status, hetzner_server_id, ipv4_address, gateway_url)
       values ($1, 'probe', 'running', 77, ' 10.20.30.40 ', 'https://custom.example')
       returning id, gateway_url`,
      [`user_${tag}`]
    )
  ).rows[0];
  await db.query("update public.hermes_instances set lifecycle_state = 'active' where id = $1", [instance.id]);
  const firstActive = await one(db, "select first_active_at is not null as set from public.hermes_instances where id = $1", [instance.id]);
  await db.query(
    `insert into public.instance_bankr_wallets (instance_id, user_id, bankr_wallet_id, evm_address, updated_at)
     values ($1, $2, 'wallet', '0xAbC', now() - interval '1 day')`,
    [instance.id, `user_${tag}`]
  );
  await db.query("update public.instance_bankr_wallets set status = 'pending' where instance_id = $1", [instance.id]);
  const wallet = await one(
    db,
    "select updated_at > now() - interval '1 hour' as touched from public.instance_bankr_wallets where instance_id = $1",
    [instance.id]
  );
  await db.query(
    "insert into public.vm_response_seconds_daily (instance_id, billing_day, updated_at) values ($1, current_date, now() - interval '1 day')",
    [instance.id]
  );
  await db.query("update public.vm_response_seconds_daily set seconds_used = 5 where instance_id = $1", [instance.id]);
  const daily = await one(
    db,
    "select updated_at > now() - interval '1 hour' as touched from public.vm_response_seconds_daily where instance_id = $1",
    [instance.id]
  );
  await db.query("delete from public.hermes_instances where id = $1", [instance.id]);
  return { gateway: instance.gateway_url, firstActive: firstActive.set, walletTouched: wallet.touched, dailyTouched: daily.touched };
}

async function mainDatabase() {
  const db = await openMigratedDatabase({ skip: [MIGRATION], setup: HOSTED_DEFAULTS });
  try {
    await db.exec(HOSTED_STORAGE);

    // ── Probes that stand in for what Canary and Production hold ────────────
    await db.exec(`
      -- A SECURITY DEFINER function nobody revoked: executable by PUBLIC and, by
      -- default privilege, by anon and authenticated.
      create function public.exposed_definer_probe() returns text language sql security definer as $f$ select 'secret' $f$;
      -- A function the service role can run only through PUBLIC.
      create function public.service_via_public_probe() returns int language sql as $f$ select 1 $f$;
      revoke execute on function public.service_via_public_probe() from service_role, anon, authenticated;
      -- Functions a policy and a view call, which the API roles must keep.
      create function public.policy_helper_probe(text) returns boolean language sql stable as $f$ select true $f$;
      create function public.view_helper_probe() returns int language sql stable as $f$ select 1 $f$;
      create table public.helper_probe (id serial primary key, user_id text);
      alter table public.helper_probe enable row level security;
      create policy "helper probe read" on public.helper_probe for select to authenticated
        using (public.policy_helper_probe(user_id));
      create view public.helper_view_probe as select public.view_helper_probe() as v;
      grant select on public.helper_probe, public.helper_view_probe to authenticated;
      insert into public.helper_probe (user_id) values ('someone');
      -- Tables authenticated holds SELECT on through the default privilege. The
      -- migration keeps the ones a policy reads or depends on, and closes the rest.
      create table public.zero_policy_probe (id int);
      create table public.read_policy_probe (id int, user_id text);
      create table public.parent_probe (id int primary key);
      create table public.child_probe (id int, parent_id int, user_id text);
      create table public.write_policy_probe (id int);
      create table public.service_policy_probe (id int);
      create table public.view_source_probe (id int);
      create view public.view_probe as select id from public.view_source_probe;
      alter table public.zero_policy_probe enable row level security;
      alter table public.read_policy_probe enable row level security;
      -- parent_probe has no RLS and no policy: only the child's policy subquery reads it.
      alter table public.child_probe enable row level security;
      alter table public.write_policy_probe enable row level security;
      alter table public.service_policy_probe enable row level security;
      create policy "own rows" on public.read_policy_probe for select to authenticated
        using (public.requesting_user_id() = user_id);
      create policy "own children" on public.child_probe for select to authenticated
        using (exists (select 1 from public.parent_probe p where p.id = child_probe.parent_id) and public.requesting_user_id() = user_id);
      create policy "insert only" on public.write_policy_probe for insert to authenticated with check (true);
      create policy "service only" on public.service_policy_probe for select to service_role using (true);
      insert into public.read_policy_probe values (1, '${ATTACKER}');
      insert into public.parent_probe values (1);
      insert into public.child_probe values (1, 1, '${ATTACKER}');
      -- A legacy chat row the hermes_messages policy lets authenticated read.
      alter table public.hermes_messages disable trigger user;
      insert into public.hermes_instances (id, user_id, name, status) values ('00000000-0000-0000-0000-00000000a11c', '${ATTACKER}', 'chat', 'running');
      insert into public.hermes_conversations (id, instance_id, user_id)
        values ('00000000-0000-0000-0000-00000000c0de', '00000000-0000-0000-0000-00000000a11c', '${ATTACKER}');
      insert into public.hermes_messages (conversation_id, role, content) values ('00000000-0000-0000-0000-00000000c0de', 'user', 'hello');
      alter table public.hermes_messages enable trigger user;
      -- A trigger function attached to a table that a role with no EXECUTE writes.
      create table public.trigger_probe (id int primary key, updated_at timestamptz);
      create trigger trigger_probe_touch before insert or update on public.trigger_probe
        for each row execute function public.set_current_timestamp_updated_at();
      create role trigger_writer;
      grant all on public.trigger_probe to trigger_writer;
      -- The same trigger function on a table with a function that always raises.
      create table public.append_only_probe (id int primary key);
      create trigger append_only_probe_block before update on public.append_only_probe
        for each row execute function public.prevent_credit_ledger_mutation();
      insert into public.append_only_probe values (1);
      grant all on public.append_only_probe to trigger_writer;
      -- A row that anon could read if the table were open to it.
      insert into public.credit_accounts (user_id) values ('user_a');
      -- An out-of-band policy: any authenticated caller, any file in the bucket.
      create policy "attachments any authenticated" on storage.objects for all to authenticated
        using (bucket_id = 'hermes-attachments') with check (bucket_id = 'hermes-attachments');
    `);

    const before = await snapshot(db);
    const behaviourBefore = await exerciseTriggers(db, "before");
    assert.deepEqual(
      behaviourBefore,
      { gateway: "https://10-20-30-40.sslip.io", firstActive: true, walletTouched: true, dailyTouched: true },
      "the four triggers do their work before the migration"
    );

    // ── The findings reproduce on every committed migration ─────────────────
    assert.ok(before.tables.some((k) => k.endsWith(":authenticated:SELECT")), "authenticated reads some public table");
    for (const table of ["zero_policy_probe", "write_policy_probe", "service_policy_probe", "view_probe", "helper_view_probe"]) {
      assert.equal(
        (await one(db, "select has_table_privilege('authenticated', $1, 'SELECT') as can", [`public.${table}`])).can,
        true,
        `pre: authenticated holds SELECT on ${table}, which no policy lets it read`
      );
    }
    const chatRead = "select content from public.hermes_messages";
    assert.deepEqual(
      (await asRole(db, "authenticated", ATTACKER, chatRead)).rows,
      [{ content: "hello" }],
      "pre: authenticated reads its own legacy chat row through the hermes_messages policy"
    );
    assert.equal(
      (await one(db, "select count(*)::int as n from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and has_table_privilege('anon', c.oid, 'SELECT')")).n > 0,
      true,
      "pre: anon holds SELECT on public tables"
    );
    for (const name of ["exposed_definer_probe", ...TRIGGER_FUNCTIONS.filter((n) => n.startsWith("prevent_") || FOUR_LINT_FUNCTIONS.includes(n) || n === "guard_hivra_gvisor_computer")]) {
      for (const signature of await functionSignatures(db, name)) {
        assert.equal(await canExecute(db, "anon", signature), true, `pre: anon can execute ${signature}`);
        assert.equal(await canExecute(db, "authenticated", signature), true, `pre: authenticated can execute ${signature}`);
        assert.equal(await publicExecutes(db, signature), true, `pre: PUBLIC can execute ${signature}`);
      }
    }
    assert.equal(
      (await asRole(db, "anon", null, "select public.exposed_definer_probe() as v")).rows[0].v,
      "secret",
      "pre: anon can call a SECURITY DEFINER function nobody revoked"
    );
    // A policy with `using (true)` is enough to read a table, because the
    // default grant gives anon SELECT on it.
    await db.exec(`create policy "probe open read" on public.credit_accounts for select to public using (true)`);
    assert.equal(
      (await asRole(db, "anon", null, "select count(*)::int as n from public.credit_accounts")).rows[0].n,
      1,
      "pre: one permissive policy exposes a table to anon"
    );
    await db.exec(`drop policy "probe open read" on public.credit_accounts`);
    // Objects created later inherit the same access.
    await db.exec(`
      create table public.before_new_table (id int);
      create sequence public.before_new_sequence;
      create function public.before_new_function() returns int language sql as $f$ select 1 $f$;
    `);
    assert.equal(await one(db, "select has_table_privilege('anon', 'public.before_new_table', 'SELECT') as can").then((r) => r.can), true);
    assert.equal(await one(db, "select has_sequence_privilege('anon', 'public.before_new_sequence', 'USAGE') as can").then((r) => r.can), true);
    assert.equal(await canExecute(db, "anon", "public.before_new_function()"), true);
    await db.exec("drop table public.before_new_table; drop sequence public.before_new_sequence; drop function public.before_new_function()");
    // hermes-attachments: a user JWT with any sub can store and read its own files.
    const upload = `insert into storage.objects (bucket_id, name) values ('hermes-attachments', $1)`;
    await asRole(db, "authenticated", ATTACKER, upload, [`${ATTACKER}/file.bin`]);
    assert.equal(
      (await asRole(db, "authenticated", ATTACKER, "select count(*)::int as n from storage.objects where bucket_id = 'hermes-attachments'")).rows[0].n,
      1,
      "pre: an authenticated JWT stores and reads a file in hermes-attachments"
    );
    await db.query("delete from storage.objects where bucket_id = 'hermes-attachments'");
    assert.deepEqual(
      await one(db, "select file_size_limit, allowed_mime_types from storage.buckets where id = 'hermes-attachments'"),
      { file_size_limit: null, allowed_mime_types: null },
      "pre: the bucket has no limits of its own"
    );
    assert.equal(
      (
        await all(db, "select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and roles && array['public','anon','authenticated']::name[] and (qual like '%hermes-attachments%' or with_check like '%hermes-attachments%')")
      ).length,
      3,
      "pre: two committed policies plus the out-of-band one name the bucket"
    );
    for (const name of FOUR_LINT_FUNCTIONS) {
      assert.equal(
        (await one(db, "select proconfig is null as mutable from pg_proc where pronamespace = 'public'::regnamespace and proname = $1", [name])).mutable,
        true,
        `pre: ${name} has a mutable search_path`
      );
    }

    // ── Apply the migration twice ───────────────────────────────────────────
    await db.exec(readMigration(MIGRATION));
    await db.exec(readMigration(MIGRATION)); // Re-run safe.

    // Tables and views: nothing for anon or PUBLIC, at table or column level.
    assert.deepEqual(
      await all(
        db,
        `select c.relname from pg_class c
          where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
            and (exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a where a.grantee in (0, 'anon'::regrole))
              or has_any_column_privilege('anon', c.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))`
      ),
      [],
      "anon and PUBLIC hold nothing on any public table or view"
    );
    await denied(db, "anon", null, "select count(*) from public.credit_accounts");
    await db.exec(`create policy "probe open read" on public.credit_accounts for select to public using (true)`);
    await denied(db, "anon", null, "select count(*) from public.credit_accounts");
    await db.exec(`drop policy "probe open read" on public.credit_accounts`);
    // The service role keeps every table privilege. authenticated only loses
    // privileges, and keeps exactly the tables a policy lets it read or that a
    // policy or a view depends on.
    const after = await snapshot(db);
    const keysFor = (snap, role) => snap.tables.filter((k) => k.includes(`:${role}:`));
    assert.deepEqual(keysFor(after, "service_role"), keysFor(before, "service_role"), "service_role holds the same table privileges as before");
    for (const key of keysFor(after, "authenticated")) {
      assert.ok(keysFor(before, "authenticated").includes(key), `authenticated gains nothing: ${key}`);
    }
    const tablesOf = (keys) => [...new Set(keys.map((k) => k.split(":")[0]))].sort();
    const policyReads = (
      await all(
        db,
        `select distinct tablename from pg_policies
          where schemaname = 'public' and permissive = 'PERMISSIVE' and cmd in ('SELECT', 'ALL')
            and roles && array['public', 'authenticated']::name[]`
      )
    ).map((r) => r.tablename);
    const dependencyTables = ["hermes_instances", "parent_probe", "view_source_probe"];
    const heldBefore = tablesOf(keysFor(before, "authenticated"));
    const heldAfter = tablesOf(keysFor(after, "authenticated"));
    assert.ok(heldBefore.length > heldAfter.length, "authenticated lost the tables it had no use for");
    assert.deepEqual(
      heldAfter,
      heldBefore.filter((table) => policyReads.includes(table) || dependencyTables.includes(table)).sort(),
      "authenticated keeps exactly the tables a policy lets it read or that a policy or a view depends on"
    );
    for (const table of ["zero_policy_probe", "write_policy_probe", "service_policy_probe", "view_probe", "helper_view_probe"]) {
      assert.equal(heldAfter.includes(table), false, `authenticated lost ${table}`);
      await denied(db, "authenticated", ATTACKER, `select * from public.${table}`);
    }
    for (const table of ["read_policy_probe", "parent_probe", "child_probe", "view_source_probe", "hermes_conversations", "hermes_messages", "hermes_instances"]) {
      assert.equal(heldAfter.includes(table), true, `authenticated keeps ${table}`);
    }
    assert.deepEqual(
      (await asRole(db, "authenticated", ATTACKER, "select id from public.read_policy_probe")).rows,
      [{ id: 1 }],
      "authenticated reads its own rows through a read policy"
    );
    assert.deepEqual(
      (await asRole(db, "authenticated", ATTACKER, "select id from public.child_probe")).rows,
      [{ id: 1 }],
      "a policy subquery on a table with no policy of its own keeps working"
    );
    assert.deepEqual(
      (await asRole(db, "authenticated", ATTACKER, chatRead)).rows,
      [{ content: "hello" }],
      "authenticated still reads its own legacy chat row through the hermes_messages policy"
    );
    assert.deepEqual(after.sequences, before.sequences, "service_role holds the same sequence privileges as before");
    for (const signature of before.serviceFunctions) {
      assert.ok(after.serviceFunctions.includes(signature), `service_role can still execute ${signature}`);
    }
    // authenticated still reads its own rows through a policy that calls requesting_user_id().
    await db.query("insert into public.hermes_hosts (user_id, name, hetzner_server_id) values ($1, 'mine', 1001), ('user_victim', 'theirs', 4242)", [ATTACKER]);
    assert.deepEqual(
      (await asRole(db, "authenticated", ATTACKER, "select name from public.hermes_hosts order by name")).rows.map((r) => r.name),
      ["mine"],
      "authenticated still reads its own hosts, and only those"
    );
    await db.query("delete from public.hermes_hosts");

    // Sequences: nothing for the API roles.
    assert.deepEqual(
      await all(
        db,
        `select c.relname from pg_class c
          where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
            and exists (select 1 from aclexplode(coalesce(c.relacl, acldefault('s', c.relowner))) a where a.grantee in (0, 'anon'::regrole, 'authenticated'::regrole))`
      ),
      [],
      "the API roles hold nothing on any public sequence"
    );

    // Functions: closed to the API roles, except what a policy or a view calls.
    const kept = (
      await all(
        db,
        `select distinct p.proname from pg_depend d
           join pg_proc p on d.refclassid = 'pg_proc'::regclass and d.refobjid = p.oid
          where d.classid in ('pg_policy'::regclass, 'pg_rewrite'::regclass) and p.pronamespace = 'public'::regnamespace
          order by 1`
      )
    ).map((r) => r.proname);
    assert.deepEqual(
      kept,
      ["policy_helper_probe", "requesting_user_id", "view_helper_probe"],
      "the functions a policy or a view calls are exactly the expected three"
    );
    const exposed = await all(
      db,
      `select p.oid::regprocedure::text as sig
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.proname <> all ($1::text[])
          and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
            or exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0))`,
      [kept]
    );
    assert.deepEqual(exposed, [], "no other public function is executable by anon, authenticated or PUBLIC");
    for (const name of kept) {
      for (const signature of await functionSignatures(db, name)) {
        assert.equal(await canExecute(db, "authenticated", signature), true, `authenticated keeps EXECUTE on ${signature}`);
      }
    }
    await denied(db, "anon", null, "select public.exposed_definer_probe()");
    await denied(db, "authenticated", ATTACKER, "select public.exposed_definer_probe()");
    assert.equal((await asRole(db, "service_role", null, "select public.exposed_definer_probe() as v")).rows[0].v, "secret", "service_role still calls it");
    // EXECUTE the service role held only through PUBLIC becomes its own grant.
    assert.equal(
      (await asRole(db, "service_role", null, "select public.service_via_public_probe() as v")).rows[0].v,
      1,
      "service_role keeps a function it could run only through PUBLIC"
    );
    await denied(db, "anon", null, "select public.service_via_public_probe()");
    await denied(db, "authenticated", ATTACKER, "select public.service_via_public_probe()");
    // The function a policy calls keeps working for authenticated.
    assert.deepEqual(
      (await asRole(db, "authenticated", ATTACKER, "select user_id from public.helper_probe")).rows,
      [{ user_id: "someone" }],
      "a policy that calls a function keeps working for authenticated"
    );
    // A view nothing reads through a policy loses its authenticated grant, but
    // the function it calls stays executable for the views and policies that may use it.
    await denied(db, "authenticated", ATTACKER, "select v from public.helper_view_probe");

    // The trigger functions are closed to the API roles and still fire.
    for (const name of TRIGGER_FUNCTIONS) {
      const signatures = await functionSignatures(db, name);
      assert.ok(signatures.length > 0, `${name} exists`);
      for (const signature of signatures) {
        assert.equal(await canExecute(db, "anon", signature), false, `anon cannot execute ${signature}`);
        assert.equal(await canExecute(db, "authenticated", signature), false, `authenticated cannot execute ${signature}`);
        assert.equal(await publicExecutes(db, signature), false, `PUBLIC cannot execute ${signature}`);
      }
    }
    assert.equal(await canExecute(db, "trigger_writer", "public.set_current_timestamp_updated_at()"), false, "the writer role has no EXECUTE");
    await asRole(db, "trigger_writer", null, "insert into public.trigger_probe values (1, now() - interval '1 day')");
    assert.equal(
      (await one(db, "select updated_at > now() - interval '1 hour' as touched from public.trigger_probe where id = 1")).touched,
      true,
      "a trigger fires for a writer that holds no EXECUTE on its function"
    );
    await assert.rejects(
      asRole(db, "trigger_writer", null, "update public.append_only_probe set id = 2"),
      /credit_ledger_entries is append-only/,
      "a guard trigger still blocks a writer that holds no EXECUTE on its function"
    );

    // search_path: pinned, and the four triggers behave exactly as before.
    for (const name of FOUR_LINT_FUNCTIONS) {
      assert.equal(
        (await one(db, "select proconfig::text as config from pg_proc where pronamespace = 'public'::regnamespace and proname = $1", [name])).config,
        '{"search_path=\\"\\""}',
        `${name} has an empty search_path`
      );
    }
    assert.deepEqual(await exerciseTriggers(db, "after"), behaviourBefore, "the four triggers behave exactly as before");

    // hermes-attachments: no API-role policy, limits set, unrelated policies kept.
    assert.deepEqual(
      await all(db, "select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' and roles && array['public','anon','authenticated']::name[] and (qual like '%hermes-attachments%' or with_check like '%hermes-attachments%')"),
      [],
      "no API-role policy names hermes-attachments"
    );
    assert.deepEqual(
      (await all(db, "select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects' order by 1")).map((r) => r.policyname),
      ["Service role delete", "Service role upload", "avatars are public"],
      "policies for other buckets and for the service role stay"
    );
    assert.deepEqual(
      await one(db, "select file_size_limit::text as size, allowed_mime_types from storage.buckets where id = 'hermes-attachments'"),
      { size: "52428800", allowed_mime_types: ["application/zip"] },
      "the bucket carries the limits its upload route enforces"
    );
    await denied(db, "authenticated", ATTACKER, upload, [`${ATTACKER}/file.bin`], /row-level security/);
    await denied(db, "anon", null, upload, ["anyone/file.bin"], /row-level security/);
    await asRole(db, "service_role", null, upload, ["migrations/user_a/archive.zip"]);
    assert.equal(
      (await asRole(db, "anon", null, "select count(*)::int as n from storage.objects where bucket_id = 'avatars'")).rows[0].n,
      0,
      "the avatars policy still evaluates for anon"
    );
    await db.query("delete from storage.objects");

    // New objects start closed to the API roles and open to the service role.
    await db.exec(`
      create table public.after_new_table (id int);
      create sequence public.after_new_sequence;
      create function public.after_new_definer() returns text language sql security definer as $f$ select 'secret' $f$;
      create schema probe_schema;
      create function probe_schema.other_schema_function() returns int language sql as $f$ select 1 $f$;
    `);
    assert.equal(
      (
        await one(
          db,
          `select count(*)::int as n from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
            where c.oid = 'public.after_new_table'::regclass and a.grantee in (0, 'anon'::regrole, 'authenticated'::regrole)`
        )
      ).n,
      0,
      "a new table carries no entry for anon, authenticated or PUBLIC"
    );
    assert.equal(
      (await one(db, "select has_table_privilege('service_role', 'public.after_new_table', 'SELECT, INSERT, UPDATE, DELETE') as can")).can,
      true,
      "a new table is usable by the service role"
    );
    for (const role of ["anon", "authenticated"]) {
      assert.equal((await one(db, "select has_sequence_privilege($1, 'public.after_new_sequence', 'USAGE, SELECT, UPDATE') as can", [role])).can, false, `${role}: new sequence`);
      assert.equal(await canExecute(db, role, "public.after_new_definer()"), false, `${role}: new SECURITY DEFINER function`);
      assert.equal(await canExecute(db, role, "probe_schema.other_schema_function()"), false, `${role}: new function in another schema`);
    }
    assert.equal(await publicExecutes(db, "public.after_new_definer()"), false, "PUBLIC: new function");
    assert.equal(await publicExecutes(db, "probe_schema.other_schema_function()"), false, "PUBLIC: new function in another schema");
    assert.equal((await one(db, "select has_sequence_privilege('service_role', 'public.after_new_sequence', 'USAGE, SELECT, UPDATE') as can")).can, true);
    assert.equal(await canExecute(db, "service_role", "public.after_new_definer()"), true, "service_role: new function");
    await denied(db, "anon", null, "select public.after_new_definer()");
    await denied(db, "authenticated", ATTACKER, "select public.after_new_definer()");
    assert.equal((await asRole(db, "service_role", null, "select public.after_new_definer() as v")).rows[0].v, "secret");
    await denied(db, "anon", null, "select count(*) from public.after_new_table");
    // The same permissive-policy mistake no longer exposes a new table.
    await db.exec(`alter table public.after_new_table enable row level security;
      create policy "probe open read" on public.after_new_table for select to public using (true);
      insert into public.after_new_table values (1)`);
    await denied(db, "anon", null, "select count(*) from public.after_new_table");
    await denied(db, "authenticated", ATTACKER, "select count(*) from public.after_new_table");
    assert.equal((await asRole(db, "service_role", null, "select count(*)::int as n from public.after_new_table")).rows[0].n, 1);

    console.log("PASS main database");
  } finally {
    await db.close();
  }
}

async function driftedBodyDatabase() {
  // A database whose trigger body was edited outside the repository to call a
  // table without a schema. An empty search_path would break it; the migration
  // must pin it to the path callers normally have instead.
  const db = await openMigratedDatabase({ skip: [MIGRATION], setup: HOSTED_DEFAULTS });
  try {
    await db.exec(HOSTED_STORAGE);
    await db.exec(`
      create table public.drift_probe_log (note text);
      create or replace function public.touch_vm_response_seconds_daily_updated_at() returns trigger language plpgsql as $f$
      begin
        insert into drift_probe_log (note) values ('touched');
        NEW.updated_at := now();
        return NEW;
      end
      $f$;
    `);
    // The premise: an empty search_path breaks that body.
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.exec("alter function public.touch_vm_response_seconds_daily_updated_at() set search_path = ''");
        await exerciseTriggers(tx, "premise");
      }),
      /drift_probe_log/,
      "an empty search_path breaks a body that uses an unqualified table"
    );
    await db.exec(readMigration(MIGRATION));
    await db.exec(readMigration(MIGRATION));
    const configs = Object.fromEntries(
      (
        await all(db, "select proname, proconfig::text as config from pg_proc where pronamespace = 'public'::regnamespace and proname = any ($1::text[])", [FOUR_LINT_FUNCTIONS])
      ).map((r) => [r.proname, r.config])
    );
    assert.equal(configs.touch_vm_response_seconds_daily_updated_at, '{"search_path=public, pg_temp"}', "the drifted body keeps the path callers normally have");
    for (const name of FOUR_LINT_FUNCTIONS.filter((n) => n !== "touch_vm_response_seconds_daily_updated_at")) {
      assert.equal(configs[name], '{"search_path=\\"\\""}', `${name} still gets an empty search_path`);
    }
    assert.deepEqual(
      await exerciseTriggers(db, "drift"),
      { gateway: "https://10-20-30-40.sslip.io", firstActive: true, walletTouched: true, dailyTouched: true },
      "the drifted trigger still works after the migration"
    );
    assert.equal((await one(db, "select count(*)::int as n from public.drift_probe_log")).n, 1, "and still reaches its table");
    console.log("PASS drifted body database");
  } finally {
    await db.close();
  }
}

async function extensionDatabase() {
  // An extension's functions in public are not the application's to close: the
  // migration must leave their privileges alone, and still pass its own checks.
  const db = new PGlite({ extensions: { citext } });
  try {
    await db.exec(SUPABASE_STUBS);
    await db.exec(HOSTED_DEFAULTS);
    await db.exec("create extension citext schema public");
    await db.exec("create function public.application_probe() returns int language sql as $f$ select 1 $f$");
    const extensionFunctions = await all(
      db,
      `select p.oid::regprocedure::text as sig, p.proacl::text as acl from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and exists (select 1 from pg_depend e where e.classid = 'pg_proc'::regclass and e.objid = p.oid and e.deptype = 'e')
        order by 1`
    );
    assert.ok(extensionFunctions.length > 10, "the extension installs functions in public");
    assert.equal(await canExecute(db, "anon", "public.application_probe()"), true, "pre: anon runs the application function");
    await db.exec(readMigration(MIGRATION));
    await db.exec(readMigration(MIGRATION));
    assert.deepEqual(
      await all(
        db,
        `select p.oid::regprocedure::text as sig, p.proacl::text as acl from pg_proc p
          where p.pronamespace = 'public'::regnamespace
            and exists (select 1 from pg_depend e where e.classid = 'pg_proc'::regclass and e.objid = p.oid and e.deptype = 'e')
          order by 1`
      ),
      extensionFunctions,
      "the extension's function privileges are untouched"
    );
    assert.equal(await canExecute(db, "anon", "public.application_probe()"), false, "the application function is closed");
    assert.equal(await canExecute(db, "service_role", "public.application_probe()"), true, "and stays open to the service role");
    console.log("PASS extension database");
  } finally {
    await db.close();
  }
}

async function failureDatabase() {
  // A privilege the migration cannot remove (here granted by a role other than
  // the owner, which a REVOKE by the owner leaves in place) must make the whole
  // migration fail and roll back, not leave a gap and be recorded as applied.
  const db = new PGlite();
  try {
    await db.exec(SUPABASE_STUBS);
    await db.exec(HOSTED_DEFAULTS);
    await db.exec(`
      create table public.stubborn (id int);
      create role other_grantor;
      grant select on public.stubborn to other_grantor with grant option;
      set role other_grantor;
      grant select on public.stubborn to anon;
      reset role;
      insert into storage.buckets (id, name, public) values ('hermes-attachments', 'hermes-attachments', false);
      create function public.requesting_user_id() returns text language sql stable as $f$ select null::text $f$;
      create policy "users upload own attachments" on storage.objects for insert
        with check (bucket_id = 'hermes-attachments' and public.requesting_user_id() is not null);
    `);
    await assert.rejects(
      db.exec(readMigration(MIGRATION)),
      /anon or PUBLIC still holds table privileges on: stubborn/,
      "the migration fails when anon keeps a table privilege"
    );
    assert.equal(
      (await one(db, "select count(*)::int as n from pg_policies where schemaname = 'storage' and policyname = 'users upload own attachments'")).n,
      1,
      "a failed migration leaves the storage policy in place (everything rolled back)"
    );
    assert.deepEqual(
      await one(db, "select file_size_limit, allowed_mime_types from storage.buckets where id = 'hermes-attachments'"),
      { file_size_limit: null, allowed_mime_types: null },
      "and leaves the bucket limits unset"
    );
    assert.equal((await one(db, "select has_table_privilege('anon', 'public.stubborn', 'SELECT') as can")).can, true, "and no grant was removed");
    assert.equal(
      (await all(db, "select 1 from pg_default_acl where defaclnamespace = 0")).length,
      0,
      "and the default privileges are unchanged"
    );
    console.log("PASS failure database");
  } finally {
    await db.close();
  }
}

async function emptyDatabase() {
  // A database that lacks the objects the migration names (Production lacks many
  // of Canary's) must still apply it, twice, without error.
  const db = new PGlite();
  try {
    await db.exec(SUPABASE_STUBS);
    await db.exec(HOSTED_DEFAULTS);
    await db.exec(readMigration(MIGRATION));
    await db.exec(readMigration(MIGRATION));
    console.log("PASS empty database");
  } finally {
    await db.close();
  }
}

async function scopePremise() {
  // Why the migration changes the default that is not limited to one schema: a
  // default that names a schema cannot take away the grant PostgreSQL makes to
  // PUBLIC on every new function.
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      alter default privileges for role postgres in schema public grant execute on functions to anon;
      alter default privileges for role postgres in schema public revoke execute on functions from anon;
      create function public.first_probe() returns int language sql as $f$ select 1 $f$;
    `);
    assert.equal(await canExecute(db, "anon", "public.first_probe()"), true, "a schema-only revoke leaves anon executing through PUBLIC");
    await db.exec(`
      alter default privileges for role postgres revoke execute on functions from public;
      create function public.second_probe() returns int language sql as $f$ select 1 $f$;
    `);
    assert.equal(await canExecute(db, "anon", "public.second_probe()"), false, "the unscoped revoke closes new functions");
    console.log("PASS default privilege scope premise");
  } finally {
    await db.close();
  }
}

function uploadRouteMatchesBucket() {
  // The bucket's limits must equal what its upload route sends, because bucket
  // limits apply to service-role uploads too. If the route changes, so must the
  // migration's values (in a new migration).
  const route = fs.readFileSync(path.join(DASHBOARD, "src/app/api/upload-migration/route.ts"), "utf8");
  const limit = /MAX_FILE_SIZE_BYTES\s*=\s*([0-9 *]+);/.exec(route);
  assert.ok(limit, "the upload route declares MAX_FILE_SIZE_BYTES");
  assert.equal(Function(`return ${limit[1]}`)(), 52428800, "the route's size cap equals the bucket's file_size_limit");
  assert.ok(/contentType:\s*"application\/zip"/.test(route), "the route uploads with content type application/zip");
  const migration = fs.readFileSync(path.join(DASHBOARD, "supabase/migrations", MIGRATION), "utf8");
  assert.ok(migration.includes("52428800") && migration.includes("array['application/zip']"));
  console.log("PASS upload route matches bucket limits");
}

async function main() {
  uploadRouteMatchesBucket();
  await scopePremise();
  await emptyDatabase();
  await extensionDatabase();
  await failureDatabase();
  await driftedBodyDatabase();
  await mainDatabase();
  console.log(`PASS lock down API role grants (every migration -> ${MIGRATION} x2)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
