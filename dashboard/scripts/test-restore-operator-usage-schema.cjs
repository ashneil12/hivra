const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      grant usage on schema public to anon, authenticated, service_role;
      alter default privileges in schema public grant all on tables to anon, authenticated;
      alter default privileges in schema public grant execute on functions to anon, authenticated;
      create function public.get_public_stats() returns jsonb language sql as $$ select '{"preserve":true}'::jsonb $$;
      create function public.roll_token_anchor() returns void language plpgsql as $$ begin return; end $$;
    `);
    const rows = async (sql) => (await db.query(sql)).rows;
    const existingRoutines = () => rows(`
      select pg_get_functiondef('public.get_public_stats()'::regprocedure),
             pg_get_functiondef('public.roll_token_anchor()'::regprocedure) as anchor
    `);
    const before = await existingRoutines();
    const migration = fs.readFileSync(path.resolve(__dirname,
      "../supabase/migrations/20261126161000_restore_operator_usage_schema.sql"), "utf8");

    await db.exec(migration);
    await db.exec("set role service_role");
    assert.deepEqual(await rows("select public.operator_usage_tokens_total()::int as total"), [{ total: 0 }]);
    await db.exec(`
      with entered as (
        insert into public.operator_usage_sources(name, api_key_sha256)
        values ('fixture', repeat('a', 64)) returning id
      )
      insert into public.operator_usage_snapshots(source_id, stat_date, total_tokens, cache_read_tokens, reasoning_tokens)
      select id, '2026-11-26', 20, 3, 2 from entered;
    `);
    await assert.rejects(db.exec("update public.operator_usage_snapshots set total_tokens = -1"), { code: "23514" });
    await db.exec("reset role");

    await db.exec(migration);
    assert.deepEqual(await existingRoutines(), before);
    assert.deepEqual(await rows(`
      select relrowsecurity from pg_class where oid in (
        'public.operator_usage_sources'::regclass,
        'public.operator_usage_snapshots'::regclass
      )
    `), [{ relrowsecurity: true }, { relrowsecurity: true }]);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      for (const table of ["operator_usage_sources", "operator_usage_snapshots"]) {
        await assert.rejects(rows(`select * from public.${table}`), { code: "42501" });
      }
      await assert.rejects(rows("select public.operator_usage_tokens_total()"), { code: "42501" });
      await db.exec("reset role");
    }
    await db.exec("set role service_role");
    assert.deepEqual(await rows("select public.operator_usage_tokens_total()::int as total"), [{ total: 25 }]);
    console.log("PASS operator usage schema restoration");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
