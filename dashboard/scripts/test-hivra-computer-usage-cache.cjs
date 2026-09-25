// Apply hivra_agents plus the computer usage cache migration (twice) in
// PostgreSQL/WASM, then prove:
// - the table is service-role only: RLS on, nothing granted to anon or
//   authenticated, and neither can execute the two functions;
// - the claim is single-flight on the database clock: one claimant at a time,
//   none while the stored observation is fresh, and force (0) skips only the
//   freshness check;
// - a row is created only for the computer's owner, never for a deleted one;
// - recording a sample stores it and releases the claim; recording an error
//   keeps the sample and the claim; clearing drops the sample;
// - the checks hold (source, error code, sample shape and size, sample and
//   time together), and the row goes with its computer.
// Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const PREREQUISITES = ["20260605120000_hivra_agents.sql"];
const MIGRATION = "20260925130000_hivra_computer_usage_cache.sql";
const read = (name) => fs.readFileSync(path.join(MIGRATIONS, name), "utf8");

async function rejects(db, sql, params, pattern, label) {
  let error = null;
  try {
    await db.query(sql, params);
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
      alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
    `);
    for (const name of PREREQUISITES) await db.exec(read(name));
    const migration = read(MIGRATION);
    await db.exec(migration);
    await db.exec(migration); // Rerun-safe.

    const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
    const agent = async (userId, status = "running") =>
      (await one("insert into public.hivra_agents (user_id, type, name, status) values ($1, 'linux-desktop', 'Desk', $2) returning id", [userId, status])).id;
    const claim = async (agentId, userId, fresh = 20, claimSeconds = 20) =>
      (await one("select public.claim_hivra_computer_usage_refresh($1, $2, 'proxmox', $3, $4) r", [agentId, userId, fresh, claimSeconds])).r;
    const record = async (agentId, userId, sample, errorCode = null, clear = false) =>
      (await one("select public.record_hivra_computer_usage($1, $2, $3::jsonb, $4, $5) r",
        [agentId, userId, sample === null ? null : JSON.stringify(sample), errorCode, clear])).r;
    const row = (agentId) => one("select * from public.hivra_computer_usage where agent_id = $1", [agentId]);
    const expireClaim = (agentId) => db.query("update public.hivra_computer_usage set refresh_claimed_until = now() - interval '1 second' where agent_id = $1", [agentId]);
    const age = (agentId, seconds) => db.query("update public.hivra_computer_usage set observed_at = now() - make_interval(secs => $2) where agent_id = $1", [agentId, seconds]);

    // --- Service role only ---------------------------------------------------
    assert.equal((await one("select relrowsecurity r from pg_class where oid = 'public.hivra_computer_usage'::regclass")).r, true);
    assert.equal(Number((await one("select count(*) n from pg_policies where tablename = 'hivra_computer_usage'")).n), 0);
    for (const role of ["anon", "authenticated"]) {
      for (const privilege of ["select", "insert", "update", "delete"]) {
        assert.equal((await one(`select has_table_privilege('${role}', 'public.hivra_computer_usage', '${privilege}') r`)).r, false, `${role} ${privilege}`);
      }
      assert.equal((await one(`select has_function_privilege('${role}', 'public.claim_hivra_computer_usage_refresh(uuid, text, text, integer, integer)', 'execute') r`)).r, false);
      assert.equal((await one(`select has_function_privilege('${role}', 'public.record_hivra_computer_usage(uuid, text, jsonb, text, boolean)', 'execute') r`)).r, false);
    }
    assert.equal((await one("select has_table_privilege('service_role', 'public.hivra_computer_usage', 'select') r")).r, true);
    assert.equal((await one("select has_function_privilege('service_role', 'public.claim_hivra_computer_usage_refresh(uuid, text, text, integer, integer)', 'execute') r")).r, true);
    assert.equal((await one("select has_function_privilege('service_role', 'public.record_hivra_computer_usage(uuid, text, jsonb, text, boolean)', 'execute') r")).r, true);

    // --- Single-flight claim -------------------------------------------------
    const desk = await agent("owner");
    const first = await claim(desk, "owner");
    assert.deepEqual(first, { claimed: true, sample: null, observedAt: null, lastErrorCode: null });
    assert.equal((await row(desk)).source, "proxmox");
    // A second reader while the claim is live gets the (empty) observation.
    assert.equal((await claim(desk, "owner")).claimed, false);
    assert.equal((await claim(desk, "owner", 0)).claimed, false, "force never overrides a live claim");

    const sample = { v: 1, result: "sample", recordedStatus: "running", sample: { v: 1 } };
    const stored = await record(desk, "owner", sample);
    assert.deepEqual(stored.sample, sample);
    assert.equal(stored.lastErrorCode, null);
    assert.ok(stored.observedAt);
    assert.equal((await row(desk)).refresh_claimed_until, null, "a stored sample releases the claim");
    // Fresh: nobody reads the host again, even with the claim released.
    const fresh = await claim(desk, "owner");
    assert.equal(fresh.claimed, false);
    assert.deepEqual(fresh.sample, sample);
    // Out of date after a state change: force claims despite freshness.
    assert.equal((await claim(desk, "owner", 0)).claimed, true);
    await expireClaim(desk);
    // Stale by age: the next reader claims.
    await age(desk, 30);
    assert.equal((await claim(desk, "owner")).claimed, true);

    // An error keeps the last sample and the claim.
    const failed = await record(desk, "owner", null, "host_unreachable");
    assert.deepEqual(failed.sample, sample);
    assert.equal(failed.lastErrorCode, "host_unreachable");
    assert.notEqual((await row(desk)).refresh_claimed_until, null, "a failed read keeps the claim until it expires");
    assert.equal((await claim(desk, "owner")).claimed, false);
    // A later sample clears the error.
    await record(desk, "owner", sample);
    assert.equal((await row(desk)).last_error_code, null);
    // An identity that no longer checks out drops the old numbers.
    const cleared = await record(desk, "owner", null, "binding_mismatch", true);
    assert.equal(cleared.sample, null);
    assert.equal(cleared.observedAt, null);
    assert.equal(cleared.lastErrorCode, "binding_mismatch");
    await rejects(db, "select public.record_hivra_computer_usage($1, 'owner', '{\"v\":1}'::jsonb, null, true)", [desk], /invalid computer usage record/, "sample and clear together");

    // --- Owner only, never deleted ------------------------------------------
    const other = await claim(desk, "intruder");
    assert.deepEqual(other, { claimed: false, sample: null, observedAt: null, lastErrorCode: null });
    const foreign = await agent("someone");
    assert.equal((await claim(foreign, "owner")).claimed, false);
    assert.equal(await row(foreign), undefined, "no row for someone else's computer");
    assert.equal(await record(foreign, "owner", sample), null);
    const gone = await agent("owner", "deleted");
    assert.equal((await claim(gone, "owner")).claimed, false);
    assert.equal(await row(gone), undefined, "no row for a deleted computer");

    // --- Checks ------------------------------------------------------------
    await rejects(db, "select public.claim_hivra_computer_usage_refresh($1, 'owner', 'proxmox', -1, 20)", [desk], /invalid computer usage claim/, "negative freshness");
    await rejects(db, "select public.claim_hivra_computer_usage_refresh($1, 'owner', 'proxmox', 20, 0)", [desk], /invalid computer usage claim/, "zero claim");
    const newcomer = await agent("owner");
    await rejects(db, "select public.claim_hivra_computer_usage_refresh($1, 'owner', 'somewhere', 20, 20)", [newcomer], /check constraint/, "unknown source");
    await rejects(db, "select public.record_hivra_computer_usage($1, 'owner', null, 'Host down!', false)", [desk], /check constraint/, "free-text error code");
    await rejects(db, "select public.record_hivra_computer_usage($1, 'owner', '[1,2]'::jsonb, null, false)", [desk], /check constraint/, "array sample");
    await rejects(db, "select public.record_hivra_computer_usage($1, 'owner', jsonb_build_object('pad', repeat(md5(random()::text), 400)), null, false)", [desk], /check constraint/, "oversized sample");
    await record(desk, "owner", sample);
    await rejects(db, "update public.hivra_computer_usage set observed_at = null where agent_id = $1", [desk], /check constraint/, "sample without its time");

    // --- The row goes with its computer ------------------------------------
    await db.query("delete from public.hivra_agents where id = $1", [desk]);
    assert.equal(await row(desk), undefined);

    console.log("PASS hivra computer usage cache");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
