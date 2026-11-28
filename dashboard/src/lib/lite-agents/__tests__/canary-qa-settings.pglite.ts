import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

it("leaves Lite QA off by default and restricts runtime settings custody", async () => {
  const db = new PGlite();
  const table = "public.hivra_canary_lite_qa_settings";
  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls");
    const migration = readFileSync("supabase/migrations/20261128181200_canary_lite_qa_settings.sql", "utf8");
    await db.exec(migration);
    await db.exec(migration);
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

it("creates no managed grant and enforces insert-only exclusive request claims", async () => {
  const db = new PGlite();
  const table = "public.hivra_canary_lite_qa_settings";
  const claims = "public.hivra_canary_lite_managed_qa_requests";
  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls");
    await db.exec(readFileSync("supabase/migrations/20261128181200_canary_lite_qa_settings.sql", "utf8"));
    const migration = readFileSync("supabase/migrations/20261128184500_canary_lite_managed_qa.sql", "utf8");
    await db.exec(migration);
    await db.exec(migration);
    await expect(db.exec(`insert into ${table} (managed_enabled) values (true)`)).rejects.toMatchObject({ code: "23514" });
    await db.exec(`insert into ${table} default values`);
    const values = "('user_fixture','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002')";
    await db.exec("set role authenticated");
    await expect(db.exec(`insert into ${claims} (owner_id, request_id, reference_id) values ${values}`)).rejects.toMatchObject({ code: "42501" });
    await db.exec("set role service_role");
    expect((await db.query(`select managed_enabled from ${table}`)).rows).toEqual([{ managed_enabled: false }]);
    await db.exec(`insert into ${claims} (owner_id, request_id, reference_id) values ${values}`);
    await expect(db.exec(`insert into ${claims} (owner_id, request_id, reference_id) values ${values}`)).rejects.toMatchObject({ code: "23505" });
    await expect(db.query(`select * from ${claims}`)).rejects.toMatchObject({ code: "42501" });
  } finally {
    await db.close();
  }
}, 30_000);
