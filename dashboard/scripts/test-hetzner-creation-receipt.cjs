// Execute the real migration + existing action gate in isolated PostgreSQL.
// No network, provider token, application credentials, or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
require("./register-server-only-noop.cjs");
require("ts-node").register({
  transpileOnly: true,
  compilerOptions: { module: "commonjs", moduleResolution: "node" },
});
const { HetznerCreationReceiptSchema } = require("../src/lib/infrastructure/hetzner-creation-receipt.ts");

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.infrastructure_connections (
        id uuid primary key, user_id text, provider text, status text, revision bigint,
        unique (id, user_id, provider)
      );
      create function public.update_updated_at() returns trigger language plpgsql as $$
        begin new.updated_at = now(); return new; end; $$;
    `);
    const directory = path.resolve(__dirname, "../supabase/migrations");
    const old = fs.readFileSync(path.join(directory, "20260826170000_hetzner_cloud_capacity_orders.sql"), "utf8");
    function existingFunction(name) {
      const found = old.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`));
      assert.ok(found, name);
      return found[0];
    }
    await db.exec(existingFunction("is_valid_hetzner_action_receipts"));
    await db.exec(old.slice(old.indexOf("create table if not exists public.infrastructure_capacity_orders"),
      old.indexOf("create or replace function public.create_hetzner_cloud_capacity_quote(")));
    await db.exec(existingFunction("record_hetzner_cloud_capacity_order_progress"));
    await db.exec(fs.readFileSync(path.join(directory, "20260827150000_hetzner_creation_resource_receipts.sql"), "utf8"));

    const connection = "11111111-1111-4111-8111-111111111111";
    const order = "22222222-2222-4222-8222-222222222222";
    const key = "33333333-3333-4333-8333-333333333333";
    const now = "2026-08-27T15:00:00Z";
    const original = {
      version: 1, serverId: "42",
      primaryIpv4: { id: "88", ip: "203.0.113.10" },
      primaryIpv6: { id: "89", ip: "2001:db8::/64" },
      action: { id: "500", command: "create_server", status: "running", resources: [{ id: "42", type: "server" }] },
      nextActions: [{ id: "501", command: "create_primary_ip", status: "running", resources: [{ id: "88", type: "primary_ip" }] }],
    };
    async function reset() {
      await db.exec("truncate public.infrastructure_capacity_orders, public.infrastructure_connections");
      await db.query("insert into public.infrastructure_connections values ($1, 'owner', 'hetzner-cloud', 'ready', 7)", [connection]);
      await db.query(`insert into public.infrastructure_capacity_orders (
        id, user_id, connection_id, active_connection_id, connection_revision, status,
        server_name, provider_labels, quote_snapshot, quote_fingerprint_sha256,
        quote_expires_at, idempotency_key, encrypted_bootstrap_bundle, bootstrap_key_version,
        bootstrap_public_key, bootstrap_public_key_fingerprint, ssh_key_post_attempted_at,
        provider_ssh_key_status, provider_ssh_key_id, server_post_attempted_at, provider_server_status
      ) values ($1, 'owner', $2, $2, 7, 'creating', 'hivra-22222222222242228222', '{}', '{}', $3,
        $4, $5, 'sealed-fixture-only', 2, 'fixture-public', $6, $4, 'accepted', '77', $4, 'pending')`,
      [order, connection, "a".repeat(64), now, key, "SHA256:" + "A".repeat(43)]);
    }
    const read = async () => (await db.query("select * from public.infrastructure_capacity_orders")).rows[0];
    const args = (receipt = original, overrides = {}) => {
      const values = { owner: "owner", connection, order, key, revision: 7, ...overrides };
      return [values.owner, values.connection, values.order, values.key, receipt.serverId,
        receipt.action.id, receipt.action.command, receipt.action.status,
        receipt.nextActions.map(({ resources, ...action }) => action), now, "off", values.revision, receipt];
    };
    const create = async (receipt = original, overrides = {}) => (await db.query(`
      select public.record_hetzner_cloud_capacity_creation_progress(
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
      ) as result`, args(receipt, overrides))).rows[0].result;
    const valid = async (receipt) => (await db.query("select public.is_valid_hetzner_creation_receipt($1) as valid", [receipt])).rows[0].valid;

    await reset();
    assert.equal(await valid(original), true);
    assert.deepEqual((await create()).provider_creation_receipt, original);
    assert.deepEqual((await create()).provider_creation_receipt, original); // Lost acknowledgement replay.
    assert.equal((await read()).provider_resource_id, "42");
    for (const overrides of [{ owner: "foreign" }, { key: connection }, { order: key }, { revision: 8 }]) {
      assert.equal(await create(original, overrides), null);
      assert.deepEqual((await read()).provider_creation_receipt, original);
    }
    const changed = structuredClone(original);
    changed.primaryIpv6.id = "90";
    await assert.rejects(() => create(changed), (error) => error.code === "22023");
    await assert.rejects(() => db.exec("update public.infrastructure_capacity_orders set provider_creation_receipt = null"));
    await assert.rejects(() => db.exec("update public.infrastructure_capacity_orders set provider_resource_id = '999'"));
    assert.deepEqual((await read()).provider_creation_receipt, original);

    for (const mutate of [
      (v) => { delete v.primaryIpv4; },
      (v) => { v.primaryIpv4.id = v.primaryIpv6.id; },
      (v) => { v.primaryIpv4.id = 88; },
      (v) => { v.primaryIpv4.ip = "203.0.113.999"; },
      (v) => { v.primaryIpv4.ip = "0203.0.113.4"; },
      (v) => { v.primaryIpv6.ip = "fe80::1%eth0/64"; },
      (v) => { v.primaryIpv6.ip = "2001:db8::/128"; },
      (v) => { v.action.resources[0].id = "99"; },
      (v) => { v.nextActions[0].resources[0].type = "volume"; },
      (v) => { v.nextActions[0].resources[0].id = "99"; },
      (v) => { v.nextActions[0].id = v.action.id; },
      (v) => { v.nextActions[0].command = "poweron"; },
      (v) => { v.nextActions[0].resources.push(v.nextActions[0].resources[0]); },
      (v) => { v.token = "must-not-store"; },
      (v) => { v.action.resources[0].token = "must-not-store"; },
      (v) => { v.action.id = "9007199254740992"; },
    ]) {
      const bad = structuredClone(original); mutate(bad);
      assert.equal(await valid(bad), false);
      assert.equal(HetznerCreationReceiptSchema.safeParse(bad).success, false);
    }
    for (const candidate of ["0.0.0.0", "203.0.113.4", "255.255.255.255", "0203.0.113.4", "1.02.3.4", "1.2.3.004", "1.2.3", "203.0.113.4\n"]) {
      const sample = structuredClone(original); sample.primaryIpv4.ip = candidate;
      assert.equal(Boolean(await valid(sample)), HetznerCreationReceiptSchema.safeParse(sample).success, "IPv4 validator parity");
    }
    for (const candidate of ["2001:db8::/64", "::/64", "fe80::1%eth0/64", "fe80::1%1/64", "2001:db8::/128", "2001:db8::/064", "::ffff:192.0.2.1/64"]) {
      const sample = structuredClone(original); sample.primaryIpv6.ip = candidate;
      assert.equal(Boolean(await valid(sample)), HetznerCreationReceiptSchema.safeParse(sample).success, "IPv6 validator parity");
    }
    assert.equal(await valid(null), null); // SQL caller uses IS NOT TRUE, never truthiness.
    assert.equal(await valid([]), false);

    await reset();
    await db.exec("update public.infrastructure_connections set revision = 8");
    assert.equal(await create(), null);
    assert.equal((await read()).provider_creation_receipt, null);
    await reset();
    await db.exec("update public.infrastructure_connections set status = 'disconnected'");
    assert.equal(await create(), null);
    await reset();
    await db.exec("update public.infrastructure_capacity_orders set provider_ssh_key_status = 'pending'");
    assert.equal(await create(), null);
    assert.equal((await read()).provider_creation_receipt, null);
    assert.equal((await read()).provider_resource_id, null); // No partial progress on failure.

    await reset();
    const legacyArgs = args().slice(0, 11);
    await db.query(`select public.record_hetzner_cloud_capacity_order_progress(
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
    )`, legacyArgs);
    assert.equal(await create(), null); // A later observation cannot backfill original ownership.
    assert.equal((await read()).provider_creation_receipt, null);

    await reset();
    const mismatched = args(); mismatched[8] = [];
    await assert.rejects(() => db.query(`select public.record_hetzner_cloud_capacity_creation_progress(
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
    )`, mismatched));
    assert.equal((await read()).provider_resource_id, null);
    const permissions = await db.query(`select
      has_function_privilege('anon', 'public.record_hetzner_cloud_capacity_creation_progress(text,uuid,uuid,uuid,text,text,text,text,jsonb,timestamptz,text,bigint,jsonb)', 'execute') as anon,
      has_function_privilege('authenticated', 'public.record_hetzner_cloud_capacity_creation_progress(text,uuid,uuid,uuid,text,text,text,text,jsonb,timestamptz,text,bigint,jsonb)', 'execute') as authenticated,
      has_function_privilege('service_role', 'public.record_hetzner_cloud_capacity_creation_progress(text,uuid,uuid,uuid,text,text,text,text,jsonb,timestamptz,text,bigint,jsonb)', 'execute') as service`);
    assert.deepEqual(permissions.rows[0], { anon: false, authenticated: false, service: true });
    console.log("PASS: Hetzner immutable original receipts, atomic progress, replay, owner/revision guards, legacy fail-closed, and service-only grants");
  } finally {
    await db.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
