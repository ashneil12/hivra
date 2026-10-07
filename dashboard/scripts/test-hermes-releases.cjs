// Apply the Hermes release registry migration in PostgreSQL/WASM: rerun-safe,
// constraints reject bad digests / channels / percentages / inconsistent halts,
// new instance columns default correctly on existing rows, RLS is on with no
// API-role access, and an event row survives its release's deletion.
// Entirely in memory: no application credentials or live database are used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATION = path.resolve(__dirname, "../supabase/migrations/20261007120000_hermes_releases.sql");
const DIGEST = `sha256:${"a".repeat(64)}`;

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create table public.hermes_instances (id uuid primary key default gen_random_uuid(), name text);
      insert into public.hermes_instances (name) values ('existing box');
    `);
    const migration = fs.readFileSync(MIGRATION, "utf8");
    await db.exec(migration);
    await db.exec(migration); // Rerun-safe.

    // Existing rows take the defaults without a rewrite.
    const existing = (await db.query("select * from public.hermes_instances")).rows[0];
    assert.equal(existing.release_channel, "stable");
    assert.equal(existing.agent_image_digest, null);
    assert.equal(existing.update_health, null);

    const insertRelease = (overrides = {}) => {
      const row = { image_repo: "ghcr.io/example/agent", version: "1.0.0", digest: DIGEST, channel: "canary", rollout_percent: 0, ...overrides };
      return db.query(
        `insert into public.hermes_releases (image_repo, version, digest, channel, rollout_percent)
         values ($1, $2, $3, $4, $5) returning id, halted, pilot_instance_ids`,
        [row.image_repo, row.version, row.digest, row.channel, row.rollout_percent]
      );
    };
    const release = (await insertRelease()).rows[0];
    assert.equal(release.halted, false);
    assert.deepEqual(release.pilot_instance_ids, []);

    await assert.rejects(() => insertRelease({ digest: "latest" }), /check constraint/);
    await assert.rejects(() => insertRelease({ image_repo: "GHCR.io/X", digest: `sha256:${"b".repeat(64)}` }), /check constraint/);
    await assert.rejects(() => insertRelease({ channel: "beta", digest: `sha256:${"c".repeat(64)}` }), /check constraint/);
    await assert.rejects(() => insertRelease({ rollout_percent: 101, digest: `sha256:${"d".repeat(64)}` }), /check constraint/);
    await assert.rejects(() => insertRelease(), /unique|duplicate/); // same repo + digest
    await assert.rejects(
      () => db.query("update public.hermes_releases set halted_reason = 'orphan reason' where id = $1", [release.id]),
      /hermes_releases_halted_consistent/
    );
    await db.query("update public.hermes_releases set halted = true, halted_reason = 'bad', halted_at = now() where id = $1", [release.id]);

    // Instance columns: constraints and the release reference.
    await assert.rejects(() => db.query("update public.hermes_instances set release_channel = 'beta'"), /hermes_instances_release_channel_check/);
    await assert.rejects(() => db.query("update public.hermes_instances set update_health = 'weird'"), /hermes_instances_update_health_check/);
    await db.query("update public.hermes_instances set update_health = 'paused', agent_image_digest = $1, agent_release_id = $2, release_channel = 'canary'", [DIGEST, release.id]);

    // An event outlives its release; deleting a release clears the box's reference.
    await db.query("insert into public.hermes_release_events (release_id, kind, digest) values ($1, 'halted', $2)", [release.id, DIGEST]);
    await assert.rejects(() => db.query("insert into public.hermes_release_events (kind) values ('exploded')"), /check constraint/);
    await db.query("delete from public.hermes_releases where id = $1", [release.id]);
    assert.equal((await db.query("select count(*)::int n from public.hermes_release_events where release_id is null")).rows[0].n, 1);
    assert.equal((await db.query("select agent_release_id from public.hermes_instances")).rows[0].agent_release_id, null);

    // Locked down: RLS on, no API-role privileges, service role keeps access.
    const rls = (await db.query(
      "select relname, relrowsecurity from pg_class where relname in ('hermes_releases','hermes_release_events') order by relname"
    )).rows;
    assert.deepEqual(rls.map((row) => row.relrowsecurity), [true, true]);
    for (const table of ["hermes_releases", "hermes_release_events"]) {
      for (const role of ["anon", "authenticated"]) {
        const privileges = (await db.query(
          "select privilege_type from information_schema.role_table_grants where table_schema='public' and table_name=$1 and grantee=$2",
          [table, role]
        )).rows;
        assert.deepEqual(privileges, [], `${role} has privileges on ${table}`);
      }
      assert.ok(
        (await db.query("select has_table_privilege('service_role', $1, 'insert') ok", [`public.${table}`])).rows[0].ok,
        `service_role can write ${table}`
      );
    }

    const index = (await db.query("select indexdef from pg_indexes where indexname = 'hermes_instances_update_health_idx'")).rows;
    assert.equal(index.length, 1);
    assert.match(index[0].indexdef, /WHERE.*update_health IS NOT NULL.*update_health <> 'ok'/);

    console.log("PASS hermes releases: rerun-safe migration, constraints, default columns on existing rows, event survives release delete, RLS with no API-role access");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
