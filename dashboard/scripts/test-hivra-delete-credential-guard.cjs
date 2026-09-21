// Exercise the actual trigger and existing finalization RPC in PostgreSQL/WASM.
// Entirely in memory: no application credentials or live database are used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.managed_venice_proxy_keys (id uuid primary key, user_id text, status text not null);
      create table public.hivra_agents (
        id uuid primary key, user_id text, status text, desired_state text,
        operation_id uuid, operation_kind text, operation_started_at timestamptz, operation_payload jsonb,
        infrastructure_connection_id uuid, deployment_target_id uuid, infrastructure_connection_revision bigint,
        allocation_operation_id uuid, vmid integer, ip text, chat_url text, api_token text,
        cf_tunnel_id text, cf_hostname text, error text, llm_config jsonb, llm_api_key_encrypted text
      );
    `);
    const migrations = path.resolve(__dirname, "../supabase/migrations");
    const authoritySql = fs.readFileSync(path.join(migrations, "20260826130000_hivra_agent_authority_operations.sql"), "utf8");
    const finalize = authoritySql.match(/create or replace function public\.complete_hivra_agent_delete\([\s\S]*?\n\$\$;/)[0];
    await db.exec(finalize);
    const migration = fs.readFileSync(path.join(migrations, "20260827090000_hivra_delete_credential_guard.sql"), "utf8");
    await db.exec(migration);
    await db.exec(migration); // Repeat application must preserve the guard.
    const agentId = "11111111-1111-4111-8111-111111111111";
    const operationId = "22222222-2222-4222-8222-222222222222";
    const keyId = "33333333-3333-4333-8333-333333333333";
    const managed = { provider: "venice", mode: "managed", proxyKeyId: keyId };
    async function reset(config = managed, keyOwner = "owner", keyStatus = "active") {
      await db.exec("truncate public.hivra_agents, public.managed_venice_proxy_keys");
      await db.query("insert into public.managed_venice_proxy_keys values ($1, $2, $3)", [keyId, keyOwner, keyStatus]);
      await db.query(`insert into public.hivra_agents
        (id, user_id, status, desired_state, operation_id, operation_kind, llm_config, llm_api_key_encrypted, cf_tunnel_id, vmid)
        values ($1, 'owner', 'running', 'deleted', $2, 'delete', $3, 'encrypted-test-key', 'tunnel', 401)`,
      [agentId, operationId, config]);
    }
    const read = async () => (await db.query("select * from public.hivra_agents")).rows[0];
    const finish = async (owner = "owner", op = operationId) =>
      (await db.query("select public.complete_hivra_agent_delete($1, $2, $3) as completed", [owner, agentId, op])).rows[0].completed;
    async function rejected(action) { await assert.rejects(action, (error) => error.code === "55000"); }

    await reset();
    await rejected(() => finish());
    assert.equal((await read()).cf_tunnel_id, "tunnel");
    assert.equal((await read()).llm_api_key_encrypted, "encrypted-test-key");
    assert.equal((await read()).operation_id, operationId);
    await rejected(() => db.exec("update public.hivra_agents set llm_config = null, llm_api_key_encrypted = null"));
    await rejected(() => db.exec("update public.hivra_agents set llm_api_key_encrypted = 'replacement'"));
    await rejected(() => db.exec("update public.hivra_agents set llm_config = '{\"provider\":\"venice\",\"mode\":\"byok\"}'"));
    assert.equal(await finish("foreign-owner"), false);
    assert.equal(await finish("owner", keyId), false);

    await db.exec("update public.managed_venice_proxy_keys set status = 'revoked'");
    assert.equal(await finish(), true);
    const deleted = await read();
    for (const field of ["cf_tunnel_id", "vmid", "llm_config", "llm_api_key_encrypted", "operation_id"]) assert.equal(deleted[field], null);
    assert.equal(deleted.status, "deleted");
    await rejected(() => db.exec("update public.hivra_agents set llm_api_key_encrypted = 'resurrection'"));

    await reset(managed, "foreign-owner", "revoked");
    await rejected(() => finish());
    await reset(managed);
    await db.exec("delete from public.managed_venice_proxy_keys");
    await rejected(() => finish());
    for (const incomplete of [{}, { provider: "venice", mode: "managed" }, { provider: "future", mode: "managed" }]) {
      await reset(incomplete);
      await rejected(() => finish());
    }
    for (const config of [null, { provider: "venice", mode: "byok" }]) {
      await reset(config);
      assert.equal(await finish(), true);
      assert.equal((await read()).llm_api_key_encrypted, null);
      assert.equal((await db.query("select status from public.managed_venice_proxy_keys")).rows[0].status, "active");
    }
    await reset(managed, "owner", "revoked");
    await db.exec("update public.hivra_agents set operation_kind = 'provision'");
    assert.equal(await finish(), true); // Canceled provision retains its own lease.
    await reset();
    await db.exec("update public.hivra_agents set desired_state = 'running'");
    await db.exec("update public.hivra_agents set llm_api_key_encrypted = 'new-encrypted-test-key'");
    assert.equal((await read()).llm_api_key_encrypted, "new-encrypted-test-key");
    console.log("PASS: delete credential guard, revocation evidence, transactional rollback, owner/CAS boundaries, and terminal secret erasure");
  } finally {
    await db.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
