import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls");
  await db.exec(readFileSync("supabase/migrations/20261127231200_canary_launch_pilots.sql", "utf8"));
}, 30_000);

afterAll(async () => {
  await db.close();
});

it("defaults to stock and exposes saved rows only to the server", async () => {
  const select = "select * from public.hivra_canary_launch_pilots";
  await db.exec("set role service_role");
  expect((await db.query(select)).rows).toEqual([]);
  await expect(db.exec("delete from public.hivra_canary_launch_pilots")).rejects.toMatchObject({ code: "42501" });
  await db.exec("reset role");
  await db.exec("insert into public.hivra_canary_launch_pilots values ('hermes', 'fixture', repeat('a', 64), 'user_fixture', true)");
  await db.exec("set role service_role");
  expect((await db.query(select)).rows).toEqual([{
    pilot: "hermes", host_id: "fixture", image_sha256: "a".repeat(64), owner_id: "user_fixture", standby_enabled: true,
  }]);
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await expect(db.query(select)).rejects.toMatchObject({ code: "42501" });
  }
  await db.exec("reset role; delete from public.hivra_canary_launch_pilots");
});

it.each([
  ["hermes", "invalid", "user_fixture", false],
  ["hermes", "a".repeat(64), null, true],
  ["bux-dependencies", "a".repeat(64), null, false],
  ["bux-dependencies", "a".repeat(64), "user_fixture", true],
])("rejects unsafe pilot settings (%s, %s, %s, %s)", async (kind, digest, owner, standby) => {
  await expect(db.query(
    "insert into public.hivra_canary_launch_pilots values ($1, 'fixture', $2, $3, $4)",
    [kind, digest, owner, standby],
  )).rejects.toMatchObject({ code: "23514" });
});
