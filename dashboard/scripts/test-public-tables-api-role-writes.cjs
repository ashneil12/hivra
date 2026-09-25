// Check 20260926090000_public_tables_api_role_writes in PostgreSQL/WASM with
// Supabase's default table grants emulated. Entirely in memory: no credentials
// or live database.
//
// Applies every committed migration except this one, reproduces the pre-launch
// finding on the full schema (a JWT with role=authenticated inserts a
// hermes_hosts row naming another tenant's Hetzner server, which
// DELETE /api/hosts/[id] would then delete), applies the fix twice, and checks:
// - no public table keeps a write-capable policy for PUBLIC, anon or
//   authenticated, while read-only and deny-only policies are unchanged;
// - anon and authenticated hold no write privilege on any public table, and a
//   table created afterwards does not inherit one;
// - the same forged writes are refused, and the service role keeps every write.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { openMigratedDatabase } = require("./lib/pglite-all-migrations.cjs");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const MIGRATION = "20260926090000_public_tables_api_role_writes.sql";
const VICTIM_SERVER = 4242;
const ATTACKER = "attacker-sub";

const read = (name) => fs.readFileSync(path.join(MIGRATIONS, name), "utf8");

const WRITE_POLICY_FILTER = `
  schemaname = 'public'
  and cmd in ('ALL', 'INSERT', 'UPDATE', 'DELETE')
  and roles && array['public', 'anon', 'authenticated']::name[]
  and not (coalesce(qual, 'false') = 'false' and coalesce(with_check, 'false') = 'false')`;

async function main() {
  const db = await openMigratedDatabase({ skip: [MIGRATION] });
  try {
    // Hosted Supabase grants EXECUTE on new public functions to authenticated
    // by name (see test-hermes-instances-api-role-writes.cjs); the harness does
    // not emulate function default privileges, so restore that one grant.
    await db.exec("grant execute on function public.requesting_user_id() to authenticated");

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
      assert.rejects(asRole(role, sub, sql, params), /permission denied for table/, `${role} must be refused: ${sql}`);
    const readOnlyPolicies = async () =>
      (
        await db.query(
          `select tablename, policyname from pg_policies
            where schemaname = 'public' and (cmd = 'SELECT'
              or (coalesce(qual, 'false') = 'false' and coalesce(with_check, 'false') = 'false'))
            order by tablename, policyname`
        )
      ).rows;

    // The finding reproduces on every committed migration.
    const forgeHost = `insert into public.hermes_hosts (user_id, name, hetzner_server_id) values ($1, 'x', $2) returning id`;
    const forged = await asRole("authenticated", ATTACKER, forgeHost, [ATTACKER, VICTIM_SERVER]);
    assert.equal(
      (await one("select count(*)::int as n from public.hermes_hosts where user_id = $1 and hetzner_server_id = $2", [ATTACKER, VICTIM_SERVER])).n,
      1,
      "pre-fix: an authenticated JWT can create a host row naming another tenant's server"
    );
    await db.query("delete from public.hermes_hosts where id = $1", [forged.rows[0].id]);
    const writePoliciesBefore = (await one(`select count(*)::int as n from pg_policies where ${WRITE_POLICY_FILTER}`)).n;
    assert.ok(writePoliciesBefore > 0, "pre-fix: API-role write policies exist on public tables");
    const readOnlyBefore = await readOnlyPolicies();

    await db.exec(read(MIGRATION));
    await db.exec(read(MIGRATION)); // Re-run safe.

    assert.equal(
      (await one(`select count(*)::int as n from pg_policies where ${WRITE_POLICY_FILTER}`)).n,
      0,
      "no public table keeps a write-capable policy for the API roles"
    );
    assert.deepEqual(await readOnlyPolicies(), readOnlyBefore, "read-only and deny-only policies are unchanged");

    const writable = await db.query(
      `select c.relname, r.role_name
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join (values ('anon'), ('authenticated')) as r(role_name)
        where n.nspname = 'public' and c.relkind in ('r', 'p')
          and has_table_privilege(r.role_name, c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')`
    );
    assert.deepEqual(writable.rows, [], "anon and authenticated hold no write privilege on any public table");
    const publicWrites = await one(
      `select count(*)::int as n
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace,
              aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
        where n.nspname = 'public' and c.relkind in ('r', 'p') and a.grantee = 0
          and a.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')`
    );
    assert.equal(publicWrites.n, 0, "PUBLIC holds no write privilege on any public table");

    // The forged writes are refused on the tables the finding names.
    await denied("authenticated", ATTACKER, forgeHost, [ATTACKER, VICTIM_SERVER]);
    await denied("authenticated", ATTACKER, "update public.hermes_hosts set hetzner_server_id = $1 where user_id = $2", [VICTIM_SERVER, ATTACKER]);
    await denied("authenticated", ATTACKER, "delete from public.hermes_hosts where user_id = $1", [ATTACKER]);
    await denied("authenticated", ATTACKER, "insert into public.user_api_keys (user_id) values ($1)", [ATTACKER]);
    await denied("authenticated", ATTACKER, "delete from public.hermes_conversations where user_id = $1", [ATTACKER]);
    await denied("anon", null, "insert into public.hermes_hosts (user_id, name) values ('x', 'x')");

    // A table created after the fix does not inherit write grants.
    await db.exec("create table public.api_role_default_probe (id int primary key)");
    for (const role of ["anon", "authenticated"]) {
      assert.equal(
        (await one("select has_table_privilege($1, 'public.api_role_default_probe', 'INSERT, UPDATE, DELETE, TRUNCATE') as can", [role])).can,
        false,
        `${role} gets no write privilege on a new public table`
      );
    }
    assert.equal(
      (await one("select has_table_privilege('service_role', 'public.api_role_default_probe', 'INSERT') as can")).can,
      true,
      "service_role still gets write privileges on a new public table"
    );

    // The service role keeps every write.
    const created = await asRole("service_role", null, forgeHost, ["user_owner", 1001]);
    const hostId = created.rows[0].id;
    await asRole("service_role", null, "update public.hermes_hosts set status = 'running' where id = $1", [hostId]);
    await asRole("service_role", null, "delete from public.hermes_hosts where id = $1", [hostId]);
    assert.equal(
      (await one("select count(*)::int as n from public.hermes_hosts where id = $1", [hostId])).n,
      0,
      "service_role insert, update and delete all work"
    );

    console.log(`PASS public tables API role writes (every migration -> ${MIGRATION} x2; ${writePoliciesBefore} write policies dropped)`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
