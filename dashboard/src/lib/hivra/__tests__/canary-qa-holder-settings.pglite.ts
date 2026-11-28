import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

it("defaults to no enrollment and only lets operator SQL manage the singleton", async () => {
  const db = new PGlite();
  const table = "public.hivra_canary_qa_holder_settings";
  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls");
    await db.exec(readFileSync("supabase/migrations/20261128171500_canary_qa_holder_settings.sql", "utf8"));
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await expect(db.query(`select * from ${table}`)).rejects.toMatchObject({ code: "42501" });
    }
    await db.exec("set role service_role");
    expect((await db.query(`select * from ${table}`)).rows).toEqual([]);
    await expect(db.exec(`insert into ${table} default values`)).rejects.toMatchObject({ code: "42501" });
    await db.exec("reset role");
    await expect(db.exec(`insert into ${table} (enabled) values (true)`)).rejects.toMatchObject({ code: "23514" });
    await expect(db.exec(`insert into ${table} (singleton) values (false)`)).rejects.toMatchObject({ code: "23514" });
    await db.exec(`insert into ${table} (enabled,owner_id,expires_at) values (true,'user_fixture',now() + interval '1 hour')`);
    await expect(db.exec(`insert into ${table} default values`)).rejects.toMatchObject({ code: "23505" });
    await db.exec("set role service_role");
    expect((await db.query(`select enabled,owner_id from ${table}`)).rows).toEqual([{ enabled: true, owner_id: "user_fixture" }]);
    await expect(db.exec(`update ${table} set enabled=false`)).rejects.toMatchObject({ code: "42501" });
  } finally {
    await db.close();
  }
}, 30_000);
