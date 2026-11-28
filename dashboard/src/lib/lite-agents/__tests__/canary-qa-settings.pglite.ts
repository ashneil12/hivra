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

it("adds a permit variant without write grants, and exact removal preserves request claims", async () => {
  const db = new PGlite();
  const table = "public.hivra_canary_lite_qa_settings";
  const claims = "public.hivra_canary_lite_managed_qa_requests";
  const id = "00000000-0000-4000-8000-000000000111";
  const sha = "a".repeat(40);
  const signer = "b".repeat(64);
  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls");
    for (const file of ["20261128181200_canary_lite_qa_settings", "20261128184500_canary_lite_managed_qa"]) {
      await db.exec(readFileSync(`supabase/migrations/${file}.sql`, "utf8"));
    }
    await db.exec(`insert into ${table}
      (enabled,owner_id,expires_at,worker_origin,signing_secret_enc)
      values (true,'user_legacy',now()+interval '10 minutes','https://lite-agent-canary.fixture.workers.dev','fixture-encrypted')`);
    const migration = readFileSync("supabase/migrations/20261128192600_canary_lite_trusted_permit.sql", "utf8");
    await db.exec(migration);
    await db.exec(migration);
    expect((await db.query(`select credential_mode from ${table}`)).rows).toEqual([{ credential_mode: "encrypted" }]);
    await expect(db.exec(`update ${table} set credential_mode='trusted_permit'`)).rejects.toMatchObject({ code: "23514" });
    await db.exec(`delete from ${table}; insert into ${table}
      (credential_mode,enabled,managed_enabled,owner_id,expires_at,worker_origin,managed_model,managed_proxy_key_id,permit_git_sha,permit_signer_sha256)
      values ('trusted_permit',true,true,'user_fixture',now()+interval '10 minutes','https://lite-agent-canary.fixture.workers.dev','fixture-model','${id}','${sha}','${signer}')`);
    await expect(db.exec(`update ${table} set signing_secret_enc='fixture-forbidden'`)).rejects.toMatchObject({ code: "23514" });
    await db.exec("set role service_role");
    expect((await db.query(`select credential_mode,managed_proxy_key_id from ${table}`)).rows)
      .toEqual([{ credential_mode: "trusted_permit", managed_proxy_key_id: id }]);
    await expect(db.exec(`insert into ${table} default values`)).rejects.toMatchObject({ code: "42501" });
    await expect(db.exec(`update ${table} set enabled=false`)).rejects.toMatchObject({ code: "42501" });
    await expect(db.exec(`delete from ${table}`)).rejects.toMatchObject({ code: "42501" });
    await db.exec(`insert into ${claims} (owner_id,request_id,reference_id)
      values ('user_fixture','00000000-0000-4000-8000-000000000112','00000000-0000-4000-8000-000000000113')`);
    await db.exec("reset role");
    const exact = `delete from ${table} where credential_mode='trusted_permit' and owner_id=$1
      and managed_proxy_key_id=$2 and permit_git_sha=$3 returning credential_mode`;
    expect((await db.query(exact, ["user_unrelated", id, sha])).rows).toEqual([]);
    expect((await db.query(exact, ["user_fixture", id, sha])).rows).toEqual([{ credential_mode: "trusted_permit" }]);
    expect((await db.query(exact, ["user_fixture", id, sha])).rows).toEqual([]);
    expect((await db.query(`select owner_id from ${claims}`)).rows).toEqual([{ owner_id: "user_fixture" }]);
  } finally {
    await db.close();
  }
}, 30_000);
