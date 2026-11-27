/** @jest-environment node */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

it("keeps durable checkpoints service-only and removes them with the quote", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create table public.yearly_token_quotes (id uuid primary key);
    `);
    const sql = readFileSync(path.join(__dirname, "../../supabase/migrations/20261127093245_yearly_token_attribution_checkpoints.sql"), "utf8");
    await db.exec(sql);
    await db.exec(sql);
    const [{ rls, public_read, authenticated_read, service_write }] = (await db.query<{
      rls: boolean; public_read: boolean; authenticated_read: boolean; service_write: boolean;
    }>(`
      select relrowsecurity as rls,
        has_table_privilege('anon',oid,'select') public_read,
        has_table_privilege('authenticated',oid,'select') authenticated_read,
        has_table_privilege('service_role',oid,'insert') service_write
      from pg_class where oid='public.yearly_token_attribution_checkpoints'::regclass
    `)).rows;
    expect({ rls, public_read, authenticated_read, service_write }).toEqual({
      rls: true, public_read: false, authenticated_read: false, service_write: true,
    });
    await db.exec(`
      insert into public.yearly_token_quotes values ('00000000-0000-0000-0000-000000000001');
      set role service_role;
      insert into public.yearly_token_attribution_checkpoints
      values ('00000000-0000-0000-0000-000000000001',gen_random_uuid(),'{"nextBlock":24}',now());
      reset role;
      delete from public.yearly_token_quotes where id='00000000-0000-0000-0000-000000000001';
    `);
    expect((await db.query("select quote_id from public.yearly_token_attribution_checkpoints")).rows).toEqual([]);
  } finally {
    await db.close();
  }
}, 30_000);
