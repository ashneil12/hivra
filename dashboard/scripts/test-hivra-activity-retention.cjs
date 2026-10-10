// Apply the real Hivra activity migrations plus the retention migration (twice)
// in PostgreSQL/WASM, then prove: a computer's activity is deleted when it
// reaches status 'deleted'; prune_hivra_activity counts on a dry run, deletes
// in bounded batches, keeps recent rows and tombstones, and refuses unsafe
// input; and only service_role can execute it.
// Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const PREREQUISITES = [
  "20260605120000_hivra_agents.sql",
  "20260605120100_hivra_agent_events.sql",
  "20260922190915_hivra_activity_collectors.sql",
];
const MIGRATION = "20260923190000_hivra_activity_retention.sql";
const read = (name) => fs.readFileSync(path.join(MIGRATIONS, name), "utf8");

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    `);
    for (const name of PREREQUISITES) await db.exec(read(name));
    const migration = read(MIGRATION);
    await db.exec(migration);
    await db.exec(migration); // Rerun-safe.

    const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
    const count = async (sql, params = []) => Number((await one(sql, params)).n);
    const agent = async (userId, status = "running") =>
      (await one(
        "insert into public.hivra_agents (user_id, type, name, status) values ($1, 'claude-code', 'box', $2) returning id",
        [userId, status]
      )).id;
    const event = (agentId, userId, ageDays, name = "otel_log") =>
      db.query(
        `insert into public.hivra_agent_events (agent_id, user_id, event, created_at)
         values ($1, $2, $3, now() - make_interval(days => $4))`,
        [agentId, userId, name, ageDays]
      );
    const collector = (agentId, userId) =>
      db.query("insert into public.hivra_activity_collectors (agent_id, user_id) values ($1, $2)", [agentId, userId]);

    // --- Per-computer deletion trigger ---------------------------------------
    const kept = await agent("user_a");
    const doomed = await agent("user_a");
    for (const id of [kept, doomed]) {
      await event(id, "user_a", 1);
      await event(id, "user_a", 2, "started");
      await collector(id, "user_a");
    }
    await db.query("update public.hivra_agents set status = 'stopped' where id = $1", [doomed]);
    assert.equal(await count("select count(*) n from public.hivra_agent_events where agent_id = $1", [doomed]), 2);
    await db.query("update public.hivra_agents set status = 'deleted' where id = $1", [doomed]);
    assert.equal(await count("select count(*) n from public.hivra_agent_events where agent_id = $1", [doomed]), 0);
    assert.equal(await count("select count(*) n from public.hivra_activity_collectors where agent_id = $1", [doomed]), 0);
    assert.equal(await count("select count(*) n from public.hivra_agent_events where agent_id = $1", [kept]), 2);
    assert.equal(await count("select count(*) n from public.hivra_activity_collectors where agent_id = $1", [kept]), 1);
    // The tombstone logged after the flip survives a later no-op status write.
    await event(doomed, "user_a", 0, "deleted");
    await db.query("update public.hivra_agents set status = 'deleted' where id = $1", [doomed]);
    assert.equal(await count("select count(*) n from public.hivra_agent_events where agent_id = $1", [doomed]), 1);

    // The trigger's delete is bounded; the job's leftover class removes the rest.
    const big = await agent("user_big");
    await db.query(
      `insert into public.hivra_agent_events (agent_id, user_id, event, created_at)
       select $1, 'user_big', 'otel_log', now() - interval '1 day' from generate_series(1, 20005)`,
      [big]
    );
    await db.query("update public.hivra_agents set status = 'deleted' where id = $1", [big]);
    assert.equal(await count("select count(*) n from public.hivra_agent_events where agent_id = $1", [big]), 5);
    assert.equal(
      (await one("select public.prune_hivra_activity(now() - interval '90 days', 100, false) r")).r.deletedComputerEvents,
      5
    );
    assert.equal(await count("select count(*) n from public.hivra_agent_events where agent_id = $1", [big]), 0);

    // --- Retention function ---------------------------------------------------
    await db.exec("delete from public.hivra_agent_events; delete from public.hivra_activity_collectors;");
    const live = await agent("user_b");
    // Leftovers of a computer deleted before the trigger existed.
    await db.exec("alter table public.hivra_agents disable trigger delete_hivra_activity_after_agent_delete");
    const legacy = await agent("user_b");
    await event(legacy, "user_b", 5);
    await event(legacy, "user_b", 6);
    await event(legacy, "user_b", 1, "deleted"); // tombstone: ages out, not removed early
    await collector(legacy, "user_b");
    await db.query("update public.hivra_agents set status = 'deleted' where id = $1", [legacy]);
    await db.exec("alter table public.hivra_agents enable trigger delete_hivra_activity_after_agent_delete");
    for (let i = 0; i < 7; i += 1) await event(live, "user_b", 91 + i);
    await event(null, "user_b", 120, "launch_requested");
    for (let i = 0; i < 3; i += 1) await event(live, "user_b", 10 + i);
    await collector(live, "user_b");

    const cutoff = "now() - interval '90 days'";
    const prune = async (batch, dryRun) =>
      (await one(`select public.prune_hivra_activity(${cutoff}, $1, $2) r`, [batch, dryRun])).r;

    const before = await count("select count(*) n from public.hivra_agent_events");
    assert.deepEqual(await prune(3, true), { expiredEvents: 8, deletedComputerEvents: 2, deletedComputerCollectors: 1 });
    assert.equal(await count("select count(*) n from public.hivra_agent_events"), before, "dry run deletes nothing");

    assert.deepEqual(await prune(3, false), { expiredEvents: 3, deletedComputerEvents: 2, deletedComputerCollectors: 1 });
    assert.deepEqual(await prune(3, false), { expiredEvents: 3, deletedComputerEvents: 0, deletedComputerCollectors: 0 });
    assert.deepEqual(await prune(3, false), { expiredEvents: 2, deletedComputerEvents: 0, deletedComputerCollectors: 0 });
    assert.deepEqual(await prune(3, false), { expiredEvents: 0, deletedComputerEvents: 0, deletedComputerCollectors: 0 });
    assert.deepEqual(await prune(3, true), { expiredEvents: 0, deletedComputerEvents: 0, deletedComputerCollectors: 0 });
    // Recent live rows, the live collector and the tombstone remain.
    assert.equal(await count("select count(*) n from public.hivra_agent_events where agent_id = $1", [live]), 3);
    assert.equal(await count("select count(*) n from public.hivra_agent_events where agent_id = $1 and event = 'deleted'", [legacy]), 1);
    assert.equal(await count("select count(*) n from public.hivra_activity_collectors where agent_id = $1", [live]), 1);

    // Refuses a cutoff in the last day and out-of-range batches.
    await assert.rejects(db.query("select public.prune_hivra_activity(now(), 10, true)"), /at least one day/);
    await assert.rejects(db.query(`select public.prune_hivra_activity(${cutoff}, 0, true)`), /batch size/);
    await assert.rejects(db.query(`select public.prune_hivra_activity(${cutoff}, 10001, false)`), /batch size/);
    await assert.rejects(db.query("select public.prune_hivra_activity(null, 10, true)"), /at least one day/);

    // Only service_role can call the RPC; nobody needs EXECUTE on the trigger function.
    const canExecute = async (role, signature) =>
      (await one("select has_function_privilege($1, $2, 'execute') ok", [role, signature])).ok;
    const rpc = "public.prune_hivra_activity(timestamptz, integer, boolean)";
    const trig = "public.delete_hivra_activity_after_agent_delete()";
    assert.equal(await canExecute("service_role", rpc), true);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await canExecute(role, rpc), false, `${role} must not execute ${rpc}`);
      assert.equal(await canExecute(role, trig), false, `${role} must not execute ${trig}`);
    }

    // The age scan has its own index.
    assert.equal(
      await count("select count(*) n from pg_indexes where indexname = 'hivra_agent_events_created_at_idx'"),
      1
    );

    // A database without the collectors table (prod before its catch-up) must
    // still finalize computer deletes and run retention.
    await db.exec("drop table public.hivra_activity_collectors");
    const bare = await agent("user_c");
    await event(bare, "user_c", 1);
    await db.query("update public.hivra_agents set status = 'deleted' where id = $1", [bare]);
    assert.equal(await count("select count(*) n from public.hivra_agent_events where agent_id = $1", [bare]), 0);
    assert.equal((await prune(3, true)).deletedComputerCollectors, 0);
    assert.equal((await prune(3, false)).deletedComputerCollectors, 0);

    console.log("PASS hivra activity retention");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
