import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const host = "fixture-node-a";
const otherHost = "fixture-node-b";
const version = "2026.09.01.2";
const holds = "public.hivra_canary_bundle_sync_holds";
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create role unrelated;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  const migration = readFileSync("supabase/migrations/20261128172900_canary_bundle_sync_holds.sql", "utf8");
  await db.exec(migration);
  await db.exec(migration);
}, 30_000);

beforeEach(async () => {
  await db.exec(`reset role; truncate ${holds}`);
});

afterAll(async () => {
  await db.close();
});

async function isHeld(target: string | null = host, installed: string | null = version) {
  const { rows: [row] } = await db.query<{ held: boolean }>(
    "select public.get_hivra_canary_bundle_sync_held($1, $2) as held",
    [target, installed],
  );
  return row.held;
}

it("is unseeded and allows only the service role to check holds", async () => {
  await db.exec("set role service_role");
  expect(await isHeld()).toBe(false);
  expect(await isHeld(host, null)).toBe(false);
  await expect(db.query(`select * from ${holds}`)).rejects.toMatchObject({ code: "42501" });
  await expect(db.exec(`delete from ${holds}`)).rejects.toMatchObject({ code: "42501" });
  for (const role of ["anon", "authenticated", "unrelated"]) {
    await db.exec(`reset role; set role ${role}`);
    await expect(isHeld()).rejects.toMatchObject({ code: "42501" });
  }
});

it("holds only an exact active host/version, including an unknown observed version", async () => {
  await db.query(`
    insert into ${holds} (host_id, version, expires_at) values
      ($1, $2, statement_timestamp() + interval '10 minutes'),
      ($3, $2, statement_timestamp() - interval '1 second')
  `, [host, version, otherHost]);
  await db.exec("set role service_role");
  expect(await isHeld()).toBe(true);
  expect(await isHeld(host, null)).toBe(true);
  expect(await isHeld(host, "2026.9.1.2")).toBe(false);
  expect(await isHeld(host, "")).toBe(false);
  expect(await isHeld(host.toUpperCase(), null)).toBe(false);
  expect(await isHeld(otherHost)).toBe(false);
  expect(await isHeld(otherHost, null)).toBe(false);
  expect(await isHeld(null, null)).toBe(false);
  expect(await isHeld("fixture-node-c", null)).toBe(false);
  await db.exec(`reset role; update ${holds} set expires_at = statement_timestamp() where host_id = '${host}'; set role service_role`);
  expect(await isHeld()).toBe(false);
  expect(await isHeld(host, null)).toBe(false);
});

it.each([
  ["Fixture-Node-A", version, "2026-12-01T00:00:00Z"],
  ["fixture node", version, "2026-12-01T00:00:00Z"],
  [host, "2026.09.01", "2026-12-01T00:00:00Z"],
  [host, "2026.09.01.2.3", "2026-12-01T00:00:00Z"],
  [host, "2026.09.01.2 ", "2026-12-01T00:00:00Z"],
  [host, "2026.09.01.2-build", "2026-12-01T00:00:00Z"],
  [host, version, "infinity"],
  [host, version, "-infinity"],
])("rejects an invalid host, version or expiry: %s %s %s", async (target, value, expires) => {
  await expect(db.query(`insert into ${holds} values ($1, $2, $3)`, [target, value, expires]))
    .rejects.toMatchObject({ code: "23514" });
});

it("allows only one hold per exact host", async () => {
  await db.query(`insert into ${holds} values ($1, $2, statement_timestamp())`, [host, version]);
  await expect(db.query(`insert into ${holds} values ($1, '2026.09.01.3', statement_timestamp())`, [host]))
    .rejects.toMatchObject({ code: "23505" });
});
