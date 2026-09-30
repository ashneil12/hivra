// Apply the Hetzner capacity, cleanup and first-boot migrations and then
// 20260924171100 (twice, proving it re-runs) in PostgreSQL/WASM, and check the
// same-project token replacement against the real secret-change triggers:
// - a plain secret change still revokes setup enrollments and is still refused
//   once setup has started;
// - the replacement swaps only the exact envelope at the same revision, keeps
//   enrollments, the generated SSH key bundle and the order, and upgrades a
//   legacy envelope to key version 2;
// - it is refused while cleanup, a leased setup step or a server request still
//   inside its create call holds the credential (a dead request older than 2
//   minutes does not block), and its trigger bypass does not outlive the swap;
// - only service_role can execute it.
// Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

const TARGET = "20260924171100_hetzner_same_project_token_replacement.sql";

async function main() {
  const db = new PGlite();
  try {
    await db.exec([
      "create role anon; create role authenticated; create role service_role bypassrls;",
      "create table public.infrastructure_connections (id uuid primary key,user_id text,provider text,status text,revision bigint,preflight_run_id uuid,last_checked_at timestamptz,last_error_code text,unique(id,user_id,provider));",
      "create table public.infrastructure_connection_secrets (connection_id uuid primary key references public.infrastructure_connections(id) on delete cascade,user_id text,encrypted_bundle text not null,key_version smallint not null default 1);",
      "create table public.infrastructure_capacity_inventory (user_id text,connection_id uuid,provider_resource_id text,provider text,name text,provider_status text,server_type jsonb,location jsonb,public_network jsonb,provider_created_at timestamptz,discovered_at timestamptz,created_at timestamptz default now(),unique(connection_id,provider_resource_id));",
      "create table public.deployment_targets(id uuid primary key default gen_random_uuid(),connection_id uuid,status text default 'ready');",
      "create function public.update_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;",
    ].join("\n"));
    const dir = path.resolve(__dirname, "../supabase/migrations");
    const original = fs.readFileSync(path.join(dir, "20260826170000_hetzner_cloud_capacity_orders.sql"), "utf8");
    const extract = (name) => {
      const start = original.indexOf("create or replace function public." + name + "(");
      assert.ok(start >= 0);
      return original.slice(start, original.indexOf("\n$$;", start) + 4);
    };
    await db.exec(extract("is_valid_hetzner_action_receipts"));
    await db.exec(original.slice(original.indexOf("create table if not exists public.infrastructure_capacity_orders"),
      original.indexOf("create or replace function public.create_hetzner_cloud_capacity_quote(")));
    for (const name of ["delete_infrastructure_connection", "force_forget_hetzner_cloud_connection",
      "reconcile_hetzner_cloud_inventory", "upsert_hetzner_cloud_inventory_server"]) await db.exec(extract(name));
    for (const file of ["20260827150000_hetzner_creation_resource_receipts.sql", "20260827160000_hetzner_scoped_cleanup.sql",
      "20260827190000_hetzner_first_boot_enrollment.sql", "20260827200000_hetzner_first_boot_operations.sql",
      "20260827210000_hetzner_first_boot_cleanup.sql", "20260827220000_hetzner_first_boot_recipe_admission.sql",
      "20260827230000_hetzner_enrolled_guest_lease.sql", TARGET, TARGET, "20260924190000_hetzner_first_boot_arm_at_start.sql"]) {
      await db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
    }

    const connection = "11111111-1111-4111-8111-111111111111", order = "22222222-2222-4222-8222-222222222222";
    const attempt = "33333333-3333-4333-8333-333333333333", capacityKey = "44444444-4444-4444-8444-444444444444";
    const other = "55555555-5555-4555-8555-555555555555", quote = "a".repeat(64), serverName = "hivra-22222222222242228222";
    const receipt = { version: 1, serverId: "42", primaryIpv4: { id: "88", ip: "203.0.113.10" }, primaryIpv6: { id: "89", ip: "2001:db8::/64" },
      action: { id: "500", command: "create_server", status: "success", resources: [{ id: "42", type: "server" }] }, nextActions: [] };
    const firewall = { version: 1, scope: { orderId: order, attemptId: attempt, quoteFingerprint: quote, serverId: 42 },
      firewallId: 91, createdAt: new Date().toISOString(), setRulesActionId: 601, applyActionId: 602 };
    const power = { id: 603, command: "start_server", status: "success", resources: [{ id: 42, type: "server" }] };
    const blob = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), Buffer.alloc(32, 1)]);
    const publicKey = "ssh-ed25519 " + blob.toString("base64");
    const fingerprint = "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
    const value = async (sql, args = []) => (await db.query(sql, args)).rows[0].result;
    const blocked = (fn) => assert.rejects(fn, (error) => error.code === "55006");
    const secret = () => value("select jsonb_build_object('bundle',encrypted_bundle,'version',key_version) as result from public.infrastructure_connection_secrets");
    const phase = () => value("select phase as result from public.infrastructure_first_boot_enrollments where order_id=$1", [order]);
    const replace = (expected, next, overrides = {}) => {
      const a = { user: "owner", connection, revision: 7, expected, next, ...overrides };
      return value("select public.replace_hetzner_cloud_connection_token($1,$2,$3,$4,$5) as result",
        [a.user, a.connection, a.revision, a.expected, a.next]);
    };

    // A created, powered-off server whose setup key has not been used yet.
    async function reset({ keyVersion = 2, envelope = "sealed-old-token", creating = false } = {}) {
      await db.exec("truncate public.deployment_targets,public.infrastructure_first_boot_operations,public.infrastructure_first_boot_enrollments,public.infrastructure_capacity_orders,public.infrastructure_connection_secrets,public.infrastructure_capacity_inventory,public.infrastructure_connections");
      await db.query("insert into public.infrastructure_connections(id,user_id,provider,status,revision) values($1,'owner','hetzner-cloud','ready',7)", [connection]);
      await db.query("insert into public.infrastructure_connection_secrets(connection_id,user_id,encrypted_bundle,key_version) values($1,'owner',$2,$3)", [connection, envelope, keyVersion]);
      await db.query("insert into public.infrastructure_capacity_orders(id,user_id,connection_id,active_connection_id,connection_revision,status,server_name,provider_labels,quote_snapshot,quote_fingerprint_sha256,quote_expires_at,idempotency_key,encrypted_bootstrap_bundle,bootstrap_key_version,bootstrap_public_key,bootstrap_public_key_fingerprint,ssh_key_post_attempted_at,provider_ssh_key_status,provider_ssh_key_id) values($1,'owner',$2,$2,7,'creating',$3,'{}','{}',$4,now()+interval '5 minutes',$5,'sealed-bootstrap-fixture',2,$6,$7,now(),'accepted','77')",
        [order, connection, serverName, quote, capacityKey, publicKey, fingerprint]);
      await db.query("with stamp as (select clock_timestamp() as issued) insert into public.infrastructure_first_boot_enrollments(order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,capacity_idempotency_key,recipe_version,phase,issued_at,expires_at,verifier_sha256,encrypted_token) select $1,$2,'owner',$3,7,$4,$5,'2026.08.27.1','staged',issued,issued+interval '15 minutes',repeat('b',64),repeat('sealed-fixture-',10) from stamp",
        [order, attempt, connection, quote, capacityKey]);
      if (creating) return;
      await db.query("update public.infrastructure_capacity_orders set status='created_off',server_post_attempted_at=now(),provider_server_status='accepted',provider_resource_id='42',provider_action_id='500',provider_action_command='create_server',provider_action_status='success',provider_next_actions='[]',observed_server_status='off',provider_observed_at=now(),provider_creation_receipt=$1 where id=$2", [receipt, order]);
    }
    // The same server after setup: enrolled, with a completed (unleased) step
    // history that retains the provider credential.
    async function setUp({ leased = false } = {}) {
      await reset();
      await db.exec("update public.infrastructure_first_boot_enrollments set phase='awaiting_identity',provider_server_id='42'");
      await db.query("update public.infrastructure_first_boot_enrollments set phase='enrolled',encrypted_token=null,host_public_key=$1,host_fingerprint_sha256=$2,provider_observed_at=issued_at+interval '1 minute',enrolled_at=issued_at+interval '1 minute'", [publicKey, fingerprint]);
      await db.query(leased
        ? "insert into public.infrastructure_first_boot_operations(order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,provider_server_id,lease_id,lease_expires_at,firewall_post_attempted_at,firewall_receipt,firewall_verified_at,power_on_post_attempted_at,power_on_action) values($1,$2,'owner',$3,7,$4,'42',$7,clock_timestamp()+interval '90 seconds',now()-interval '5 minutes',$5,now()-interval '5 minutes',now()-interval '5 minutes',$6)"
        : "insert into public.infrastructure_first_boot_operations(order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,provider_server_id,firewall_post_attempted_at,firewall_receipt,firewall_verified_at,power_on_post_attempted_at,power_on_action) values($1,$2,'owner',$3,7,$4,'42',now()-interval '5 minutes',$5,now()-interval '5 minutes',now()-interval '5 minutes',$6)",
      leased ? [order, attempt, connection, quote, firewall, power, other] : [order, attempt, connection, quote, firewall, power]);
    }

    // Before setup: a plain secret change still revokes the setup key...
    await reset();
    await db.exec("update public.infrastructure_connection_secrets set encrypted_bundle='rotated-without-proof'");
    assert.equal(await phase(), "revoked");
    // ...while a proven same-project replacement keeps it.
    await reset();
    assert.equal(await replace("sealed-old-token", "sealed-new-token"), "replaced");
    assert.equal(await phase(), "staged");
    assert.deepEqual(await secret(), { bundle: "sealed-new-token", version: 2 });

    // After setup started, a plain change is still refused.
    await setUp();
    await blocked(() => db.exec("update public.infrastructure_connection_secrets set encrypted_bundle='rotated-without-proof'"));
    // Every mismatch leaves the envelope untouched.
    assert.equal(await replace("some-other-envelope", "sealed-new-token"), "envelope_changed");
    assert.equal(await replace("sealed-old-token", "sealed-new-token", { revision: 8 }), "connection_changed");
    assert.equal(await replace("sealed-old-token", "sealed-new-token", { user: "foreign" }), "not_found");
    assert.equal(await replace("sealed-old-token", "sealed-new-token", { connection: other }), "not_found");
    await assert.rejects(() => replace("sealed-old-token", "sealed-old-token"), (error) => error.code === "22023");
    await assert.rejects(() => replace("sealed-old-token", " "), (error) => error.code === "22023");
    assert.deepEqual(await secret(), { bundle: "sealed-old-token", version: 2 });
    // The proven swap keeps the revision, the enrollment pin, the order and its generated key.
    const before = await value("select jsonb_build_object('order',to_jsonb(o),'enrollment',(select to_jsonb(e) from public.infrastructure_first_boot_enrollments e),'operation',(select to_jsonb(f) from public.infrastructure_first_boot_operations f)) as result from public.infrastructure_capacity_orders o");
    assert.equal(await replace("sealed-old-token", "sealed-new-token"), "replaced");
    const after = await value("select jsonb_build_object('order',to_jsonb(o),'enrollment',(select to_jsonb(e) from public.infrastructure_first_boot_enrollments e),'operation',(select to_jsonb(f) from public.infrastructure_first_boot_operations f)) as result from public.infrastructure_capacity_orders o");
    assert.deepEqual(after, before);
    assert.equal(await phase(), "enrolled");
    assert.equal(await value("select revision as result from public.infrastructure_connections"), 7);
    assert.equal(await value("select encrypted_bootstrap_bundle as result from public.infrastructure_capacity_orders"), "sealed-bootstrap-fixture");
    assert.deepEqual(await secret(), { bundle: "sealed-new-token", version: 2 });
    // A second swap needs the new envelope; replaying the old one fails.
    assert.equal(await replace("sealed-old-token", "sealed-third-token"), "envelope_changed");
    // The bypass does not outlive the swap inside one transaction.
    await assert.rejects(() => db.transaction(async (tx) => {
      await tx.query("select public.replace_hetzner_cloud_connection_token('owner',$1,7,'sealed-new-token','sealed-third-token')", [connection]);
      await tx.exec("update public.infrastructure_connection_secrets set encrypted_bundle='rotated-without-proof'");
    }), (error) => error.code === "55006");
    assert.deepEqual(await secret(), { bundle: "sealed-new-token", version: 2 });

    // A running setup step keeps the credential.
    await setUp({ leased: true });
    assert.equal(await replace("sealed-old-token", "sealed-new-token"), "setup_step_running");
    assert.deepEqual(await secret(), { bundle: "sealed-old-token", version: 2 });

    // A server removal in progress keeps the credential.
    await reset();
    assert.equal((await value("select public.claim_hetzner_cleanup('owner',$1,7,$2,$3,$4,$5,$6) as result",
      [connection, order, other, capacityKey, "d".repeat(64), serverName])).outcome, "claimed");
    assert.equal(await replace("sealed-old-token", "sealed-new-token"), "cleanup_in_progress");
    assert.deepEqual(await secret(), { bundle: "sealed-old-token", version: 2 });

    // A server request still inside its create call keeps the token it started with...
    await reset({ creating: true });
    assert.equal(await replace("sealed-old-token", "sealed-new-token"), "server_request_in_progress");
    assert.deepEqual(await secret(), { bundle: "sealed-old-token", version: 2 });
    assert.equal(await phase(), "staged");
    // ...while a dead one (untouched for over 2 minutes) needs a working token
    // to resolve, so it does not block the replacement.
    await db.exec("alter table public.infrastructure_capacity_orders disable trigger infrastructure_capacity_orders_updated_at");
    await db.exec("update public.infrastructure_capacity_orders set updated_at = clock_timestamp() - interval '3 minutes'");
    await db.exec("alter table public.infrastructure_capacity_orders enable trigger infrastructure_capacity_orders_updated_at");
    assert.equal(await replace("sealed-old-token", "sealed-new-token"), "replaced");
    assert.deepEqual(await secret(), { bundle: "sealed-new-token", version: 2 });
    // Another account's request in flight doesn't block this connection.
    await reset({ creating: true });
    await db.exec("alter table public.infrastructure_capacity_orders disable trigger all");
    await db.query("update public.infrastructure_capacity_orders set user_id='someone-else'");
    await db.exec("alter table public.infrastructure_capacity_orders enable trigger all");
    assert.equal(await replace("sealed-old-token", "sealed-new-token"), "replaced");

    // A legacy envelope is upgraded to the revision-bound version.
    await reset({ keyVersion: 1, envelope: "sealed-legacy-token" });
    assert.equal(await replace("sealed-legacy-token", "sealed-new-token"), "replaced");
    assert.deepEqual(await secret(), { bundle: "sealed-new-token", version: 2 });

    const access = await value("select jsonb_build_object('anon',has_function_privilege('anon','public.replace_hetzner_cloud_connection_token(text,uuid,bigint,text,text)','execute'),'auth',has_function_privilege('authenticated','public.replace_hetzner_cloud_connection_token(text,uuid,bigint,text,text)','execute'),'service',has_function_privilege('service_role','public.replace_hetzner_cloud_connection_token(text,uuid,bigint,text,text)','execute'),'definer',(select prosecdef from pg_proc where oid='public.replace_hetzner_cloud_connection_token(text,uuid,bigint,text,text)'::regprocedure)) as result");
    assert.deepEqual(access, { anon: false, auth: false, service: true, definer: false });
    console.log("PASS hetzner token replacement SQL: exact-envelope swap at the same revision, enrollments and generated key kept, plain changes still revoked or refused, cleanup, leased steps and in-flight server requests block, dead requests don't, bypass scoped to the swap, legacy upgrade, service-only");
  } finally {
    await db.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
