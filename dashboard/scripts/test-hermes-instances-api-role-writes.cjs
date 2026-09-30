// Check 20260925174500_hermes_instances_api_role_writes in PostgreSQL/WASM with
// Supabase's default table grants emulated. Entirely in memory: no credentials
// or live database.
//
// Phase 1 applies only the hermes_instances migrations plus the kinds of
// policies a database can carry out of band, then the fix twice, and checks
// that every write-capable policy for PUBLIC, anon and authenticated is gone,
// read-only and service_role policies stay, and the table privileges match.
//
// Phase 2 applies every committed migration, reproduces the pre-launch finding
// on the full schema (a JWT with role=authenticated inserts a row naming another
// tenant's server as scheduled_for_deletion and backdates it into the purge
// window), then applies the fix twice and checks the same calls are refused
// while the service role keeps every write.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { openMigratedDatabase } = require("./lib/pglite-all-migrations.cjs");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const PREREQUISITES = [
  "20260325000003_hermes_instances.sql",
  // Canary and prod both carry this file's "users manage own instances"
  // policy (FOR ALL TO authenticated) and Supabase's default grants.
  "20260420162000_harden_public_table_policies.sql",
];
const MIGRATION = "20260925174500_hermes_instances_api_role_writes.sql";
const API_ROLES = ["public", "anon", "authenticated"];
const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];
const VICTIM_SERVER = 4242;
const ATTACKER = "attacker-sub";

const read = (name) =>
  // gen_random_uuid() is built in; PGlite ships without pgcrypto.
  fs.readFileSync(path.join(MIGRATIONS, name), "utf8").replace(/create extension[^;]*pgcrypto[^;]*;/i, "");

function helpers(db) {
  const one = async (sql, params) => (await db.query(sql, params)).rows[0];
  const asRole = async (role, sub, sql, params) => {
    await db.exec(`set role ${role}`);
    await db.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(sub ? { sub, role } : { role })]);
    try {
      return await db.query(sql, params);
    } finally {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claims', '', false)");
    }
  };
  const denied = (role, sub, sql, params) =>
    assert.rejects(asRole(role, sub, sql, params), /permission denied for table hermes_instances/, `${role} must be refused: ${sql}`);
  const privilege = async (role, priv) =>
    role === "public"
      ? (
          await one(
            `select coalesce(bool_or(a.grantee = 0 and a.privilege_type = $1), false) as can
               from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
              where c.oid = 'public.hermes_instances'::regclass`,
            [priv]
          )
        ).can
      : (await one("select has_table_privilege($1, 'public.hermes_instances', $2) as can", [role, priv])).can;
  const policies = async () =>
    (
      await db.query(
        "select policyname, cmd, roles::text[] as roles from pg_policies where schemaname = 'public' and tablename = 'hermes_instances' order by policyname"
      )
    ).rows;
  return { one, asRole, denied, privilege, policies };
}

async function assertClosed(db, label) {
  const { one, privilege, policies } = helpers(db);
  const left = (await policies()).filter((p) => p.cmd !== "SELECT" && p.roles.some((r) => API_ROLES.includes(r)));
  assert.deepEqual(left, [], `${label}: no write-capable policy is left for anon, authenticated or PUBLIC`);
  assert.equal(
    (await one("select relrowsecurity from pg_class where oid = 'public.hermes_instances'::regclass")).relrowsecurity,
    true,
    `${label}: RLS stays on`
  );
  for (const role of API_ROLES) {
    for (const priv of WRITE_PRIVILEGES) {
      assert.equal(await privilege(role, priv), false, `${label}: ${role} ${priv} on hermes_instances`);
    }
  }
  assert.equal(await privilege("anon", "SELECT"), false, `${label}: anon cannot read hermes_instances`);
  assert.equal(await privilege("public", "SELECT"), false, `${label}: PUBLIC cannot read hermes_instances`);
  for (const priv of ["SELECT", ...WRITE_PRIVILEGES]) {
    assert.equal(await privilege("service_role", priv), true, `${label}: service_role keeps ${priv}`);
  }
}

async function assertServiceRoleWrites(db, label) {
  const { one, asRole } = helpers(db);
  const created = await asRole(
    "service_role",
    null,
    "insert into public.hermes_instances (user_id, name, status) values ('user_new', 'n', 'provisioning') returning id"
  );
  const id = created.rows[0].id;
  await asRole("service_role", null, "update public.hermes_instances set status = 'running' where id = $1", [id]);
  await asRole("service_role", null, "delete from public.hermes_instances where id = $1", [id]);
  assert.equal(
    (await one("select count(*)::int as n from public.hermes_instances where id = $1", [id])).n,
    0,
    `${label}: service_role insert, update and delete all work`
  );
}

async function phaseOne() {
  const db = new PGlite();
  try {
    // Supabase grants ALL on new public tables to the API roles through
    // default privileges. Without this the "denied" checks pass spuriously.
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
      -- Tables the hardening migration also touches; only their user_id and
      -- conversation_id columns are referenced.
      create table public.hermes_hosts (id uuid primary key default gen_random_uuid(), user_id text);
      create table public.hermes_conversations (id uuid primary key default gen_random_uuid(), user_id text);
      create table public.hermes_messages (id uuid primary key default gen_random_uuid(), conversation_id uuid);
      create table public.hermes_scheduled_tasks (id uuid primary key default gen_random_uuid(), user_id text);
      create table public.user_api_keys (id uuid primary key default gen_random_uuid(), user_id text);
      create table public.hermes_subscriptions (id uuid primary key default gen_random_uuid(), user_id text);
      create table public.ops_events (id uuid primary key default gen_random_uuid(), user_id text);
      create table public.hermes_trial_usage (id uuid primary key default gen_random_uuid());
      create table public.stripe_webhook_events (id uuid primary key default gen_random_uuid());
    `);
    for (const name of PREREQUISITES) await db.exec(read(name));

    // Policies a database may carry out of band. 20260330130000 created
    // "users manage own instances" with no TO clause (PUBLIC) on databases that
    // never received the hardening file, so PUBLIC write policies must go too.
    await db.exec(`
      create policy "legacy public insert" on public.hermes_instances
        for insert with check (true);
      create policy "legacy public all" on public.hermes_instances
        for all using (public.requesting_user_id() = user_id)
        with check (public.requesting_user_id() = user_id);
      create policy "legacy authenticated update" on public.hermes_instances
        for update to authenticated using (true) with check (true);
      create policy "users read own instances" on public.hermes_instances
        for select to authenticated using (public.requesting_user_id() = user_id);
      create policy "service role manages instances" on public.hermes_instances
        for all to service_role using (true) with check (true);
    `);

    const { one, asRole, denied, policies } = helpers(db);
    const seed = async (userId, server) =>
      (
        await one(
          "insert into public.hermes_instances (user_id, name, status, hetzner_server_id) values ($1, 'h', 'running', $2) returning id",
          [userId, server]
        )
      ).id;
    const victimId = await seed("user_victim", VICTIM_SERVER);
    const attackerId = await seed(ATTACKER, 1001);

    // The finding reproduces on the pre-fix state.
    await asRole("authenticated", ATTACKER, "update public.hermes_instances set hetzner_server_id = $1 where id = $2", [
      VICTIM_SERVER,
      attackerId,
    ]);
    assert.equal(
      (await one("select hetzner_server_id::int as server from public.hermes_instances where id = $1", [attackerId])).server,
      VICTIM_SERVER,
      "pre-fix: an authenticated JWT can repoint its own row at another tenant's server"
    );
    await db.query("update public.hermes_instances set hetzner_server_id = 1001 where id = $1", [attackerId]);

    await db.exec(read(MIGRATION));
    await db.exec(read(MIGRATION)); // Re-run safe.

    await assertClosed(db, "phase 1");
    assert.deepEqual(
      (await policies()).map((p) => p.policyname),
      ["service role manages instances", "users read own instances"],
      "phase 1: read-only and service-role policies are kept"
    );

    const insertForged = `insert into public.hermes_instances (user_id, name, status, hetzner_server_id) values ('${ATTACKER}', 'x', 'deleted', ${VICTIM_SERVER})`;
    await denied("authenticated", ATTACKER, insertForged);
    await denied("authenticated", ATTACKER, "update public.hermes_instances set hetzner_server_id = $1 where id = $2", [VICTIM_SERVER, attackerId]);
    await denied("authenticated", ATTACKER, "update public.hermes_instances set status = 'deleted' where id = $1", [victimId]);
    await denied("authenticated", ATTACKER, "delete from public.hermes_instances where id = $1", [attackerId]);
    await denied("authenticated", ATTACKER, "truncate public.hermes_instances");
    await denied("anon", null, insertForged);
    await denied("anon", null, "select id from public.hermes_instances");

    // The kept read policy still scopes reads to the caller's own rows.
    const visible = await asRole("authenticated", ATTACKER, "select id from public.hermes_instances order by id");
    assert.deepEqual(visible.rows.map((r) => r.id), [attackerId], "phase 1: authenticated reads only its own row");

    // Nothing the refused calls attempted landed.
    assert.deepEqual(
      (await db.query("select user_id, status, hetzner_server_id::int as server from public.hermes_instances order by user_id")).rows,
      [
        { user_id: ATTACKER, status: "running", server: 1001 },
        { user_id: "user_victim", status: "running", server: VICTIM_SERVER },
      ]
    );
    await assertServiceRoleWrites(db, "phase 1");
  } finally {
    await db.close();
  }
}

async function phaseTwo() {
  // 20260926090000 closes the same write path on every public table; skip it
  // too so the pre-fix state this phase reproduces is still reachable.
  const db = await openMigratedDatabase({ skip: [MIGRATION, "20260926090000_public_tables_api_role_writes.sql"] });
  try {
    // Hosted Supabase's default privileges grant EXECUTE on new public
    // functions to authenticated by name, so 20260402150000's revoke from
    // PUBLIC leaves requesting_user_id() callable by authenticated there
    // (Canary's ACL lists authenticated=X). The shared harness does not emulate
    // function default privileges, so restore that one grant.
    await db.exec("grant execute on function public.requesting_user_id() to authenticated");
    const { one, asRole, denied } = helpers(db);

    // The finding reproduces on every committed migration: the row the purge
    // cron would pick up (scheduled_for_deletion, deadline passed) naming
    // another tenant's server.
    const forged = await asRole(
      "authenticated",
      ATTACKER,
      "insert into public.hermes_instances (user_id, name, status, hetzner_server_id) values ($1, 'x', 'scheduled_for_deletion', $2) returning id",
      [ATTACKER, VICTIM_SERVER]
    );
    const forgedId = forged.rows[0].id;
    await asRole(
      "authenticated",
      ATTACKER,
      "update public.hermes_instances set scheduled_deletion_at = now() - interval '1 day' where id = $1",
      [forgedId]
    );
    assert.equal(
      (
        await one(
          "select count(*)::int as n from public.hermes_instances where status = 'scheduled_for_deletion' and scheduled_deletion_at <= now() and hetzner_server_id = $1",
          [VICTIM_SERVER]
        )
      ).n,
      1,
      "pre-fix: an authenticated JWT can queue another tenant's server for the purge cron"
    );
    await db.query("delete from public.hermes_instances where id = $1", [forgedId]);

    await db.exec(read(MIGRATION));
    await db.exec(read(MIGRATION)); // Re-run safe.

    await assertClosed(db, "phase 2");
    assert.deepEqual(
      (
        await db.query(
          "select policyname from pg_policies where schemaname = 'public' and tablename = 'hermes_instances' and roles && array['public', 'anon', 'authenticated']::name[]"
        )
      ).rows,
      [],
      "phase 2: the committed schema carries no API-role policy on hermes_instances"
    );
    await denied(
      "authenticated",
      ATTACKER,
      "insert into public.hermes_instances (user_id, name, status, hetzner_server_id) values ($1, 'x', 'scheduled_for_deletion', $2)",
      [ATTACKER, VICTIM_SERVER]
    );
    await denied("authenticated", ATTACKER, "update public.hermes_instances set scheduled_deletion_at = now() where user_id = $1", [ATTACKER]);
    await denied("authenticated", ATTACKER, "delete from public.hermes_instances where user_id = $1", [ATTACKER]);
    await assertServiceRoleWrites(db, "phase 2");
  } finally {
    await db.close();
  }
}

async function main() {
  await phaseOne();
  await phaseTwo();
  console.log(`PASS hermes_instances API role writes (${[...PREREQUISITES, MIGRATION].join(" -> ")}; every migration -> ${MIGRATION} x2)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
