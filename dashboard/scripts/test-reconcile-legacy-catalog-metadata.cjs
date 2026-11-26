const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const migration = (filename) => fs.readFileSync(path.join(__dirname, "../supabase/migrations", filename), "utf8");

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create table public.referral_codes (code text unique);
      create table public.workspace_cloud_handoff_codes (id int);
      create table public.workspace_cloud_subscriptions (id int);
      create table public.instance_usage_snapshots (id int);
      insert into public.referral_codes values ('fixture');
      create index idx_referral_codes_code on public.referral_codes (lower(code));
    `);
    const rows = async (sql) => (await db.query(sql)).rows;
    const snapshot = () => rows("select code, ctid::text from public.referral_codes order by code");
    const indexRows = () => rows(`select indexname from pg_indexes where schemaname='public' order by indexname`);
    const before = await snapshot();
    const sql = migration("20261126162600_reconcile_legacy_catalog_metadata.sql");

    const changed = await indexRows();
    await assert.rejects(db.exec(sql), /without its verified unique twin/);
    assert.deepEqual(await indexRows(), changed);
    await db.exec(`
      drop index public.idx_referral_codes_code;
      create index idx_referral_codes_code on public.referral_codes (code);
      alter table public.referral_codes drop constraint referral_codes_code_key;
    `);
    await assert.rejects(db.exec(sql), /without its verified unique twin/);
    assert.deepEqual(await indexRows(), [{ indexname: "idx_referral_codes_code" }]);
    await db.exec("alter table public.referral_codes add constraint referral_codes_code_key unique (code)");

    await db.exec(sql);
    await db.exec(sql);
    assert.deepEqual(await indexRows(), [{ indexname: "referral_codes_code_key" }]);
    assert.deepEqual(await snapshot(), before);
    await assert.rejects(db.exec("insert into public.referral_codes values ('fixture')"), { code: "23505" });
    const expected = [
      "20260521120000_workspace_cloud_lane.sql",
      "20260523130000_instance_usage_snapshots.sql",
    ].flatMap((file) => migration(file).match(/^comment on table [a-z_.]+ is\s*(?:'(?:[^']|'')*'\s*)+;/gim) ?? []);
    const comments = () => rows(`
      select relname, obj_description(oid, 'pg_class') as description
      from pg_class where oid in (
        'public.workspace_cloud_handoff_codes'::regclass,
        'public.workspace_cloud_subscriptions'::regclass,
        'public.instance_usage_snapshots'::regclass
      ) order by relname
    `);
    const repairedComments = await comments();
    assert.equal(repairedComments.filter((row) => row.description !== null).length, 3);
    assert.equal(expected.length, 3);
    await db.exec(expected.join("\n"));
    assert.deepEqual(await comments(), repairedComments);
    console.log("PASS legacy catalog metadata reconciliation");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
