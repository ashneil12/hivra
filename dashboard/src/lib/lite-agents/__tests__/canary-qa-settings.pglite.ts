import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

it("leaves Lite QA off by default and restricts runtime settings custody", async () => {
  const db = new PGlite();
  const table = "public.hivra_canary_lite_qa_settings";
  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls");
    await db.exec(readFileSync("supabase/migrations/20261128181200_canary_lite_qa_settings.sql", "utf8"));
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
    await db.exec(`insert into ${table} default values`);
    await expect(db.exec(`insert into ${table} default values`)).rejects.toMatchObject({ code: "23505" });
    await db.exec("set role service_role");
    expect((await db.query(`select enabled from ${table}`)).rows).toEqual([{ enabled: false }]);
    await expect(db.exec(`update ${table} set enabled = true`)).rejects.toMatchObject({ code: "42501" });
  } finally {
    await db.close();
  }
}, 30_000);
