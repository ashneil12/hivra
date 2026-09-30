// Apply the Hetzner first-boot, provider-computer and workspace migrations and
// then 20260924190000 (twice, proving it re-runs) in PostgreSQL/WASM, and check
// the INF-02 rule against the real RPCs, triggers and constraints:
// - recipe gating: both recipes stage; an unknown one does not; a legacy row
//   can never carry an armed window;
// - a current-recipe server started hours after creation can still enroll:
//   it is refused while unarmed, armed only by the setup power-on checkpoint
//   (never by a direct write, even one that fakes the checkpoint's marker, and
//   never without the power-on), enrolls inside its window, and then passes
//   every downstream enrolled-window check (enrolled-guest lease, preparation
//   publish with its own recipe in the scope digest, admission, reservation);
// - an armed window that has passed refuses the proof and every setup step,
//   and nothing re-arms it once a power-on is recorded;
// - legacy (2026.08.27.1) servers keep 15 minutes from creation, are never
//   armed and enroll exactly as before;
// - the helpers are service-role only and the file is a no-op when rerun.
// Entirely in memory: no credentials or live database.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
require("./register-server-only-noop.cjs");
require("ts-node").register({
  transpileOnly: true,
  compilerOptions: { module: "commonjs", moduleResolution: "node", jsx: "react-jsx" },
});
require("tsconfig-paths/register");
const { parseProviderGuestDiscoveryOutput } = require("../src/lib/infrastructure/host-discovery.ts");
const { guestDiscoveryOutput } = require("../src/lib/infrastructure/__tests__/provider-guest-discovery.fixtures.ts");

const TARGET = "20260924190000_hetzner_first_boot_arm_at_start.sql";
const LEGACY = "2026.08.27.1", CURRENT = "2026.09.24.1";
// The provider-computer lifecycle the enrolled-window checks live in, as the
// ownership regression applies it (scripts/test-provider-computer-ownership.cjs).
const LATER = [
  "20260901020000_hivra_remote_desktop_sessions.sql", "20260901031000_provider_native_remote_desktop_release.sql",
  "20260901032000_provider_bounded_remote_desktop_release.sql", "20260901033000_provider_immutable_remote_desktop_release.sql",
  "20260901034000_provider_remote_desktop_readiness_release.sql", "20260901035000_provider_remote_desktop_auth_release.sql",
  "20260901036000_provider_remote_desktop_container_readiness_release.sql", "20260901037000_provider_deepseek_proxmox_release.sql",
  "20260901211000_provider_desktop_renewal_release.sql", "20260901235500_provider_desktop_timing_release.sql",
  "20260902030000_provider_native_proxmox_handoff_release.sql", "20260902060000_provider_native_vmid_ssh_release.sql",
  "20260902070000_provider_native_lifecycle_ssh_release.sql", "20260902080000_provider_native_qga_bootstrap_release.sql",
  "20260902120000_provider_public_source_release.sql", "20260902170000_provider_public_source_hygiene_release.sql",
  "20260902180000_provider_public_export_review_release.sql", "20260902190000_provider_linux_desktop_release.sql",
  "20260903010000_hivra_computer_profiles.sql", "20260904130000_hivra_provider_resize_operations.sql",
  "20260904140000_provider_current_bundle_release.sql", "20260905070000_hivra_provider_resize_action_command.sql",
  "20260905071000_hivra_provider_resize_shutdown.sql", "20260905072000_hivra_provider_resize_absence.sql",
  "20260905073000_hivra_provider_resize_dispatch_version.sql", "20260905090000_hivra_provider_resize_readiness.sql",
  "20260905091000_hivra_provider_resize_readiness_dispatch.sql", "20260905110000_provider_desktop_workspace_identity_release.sql",
  "20260905130000_provider_desktop_special_modes_release.sql", "20260905190000_provider_resize_setup_handoff.sql",
  "20260905200000_provider_desktop_worker_release.sql", "20260905210000_provider_desktop_cleanup_contract.sql",
  "20260905220000_provider_desktop_lifecycle.sql", "20260905230000_provider_desktop_framing_release.sql",
  "20260906000000_provider_desktop_capability_refresh.sql", "20260906010000_provider_desktop_power_completion.sql",
  "20260906020000_provider_desktop_resize_floor.sql", "20260906030000_provider_usd_capacity_ceiling.sql",
  "20260906040000_provider_desktop_absent_handoff.sql", "20260906050000_provider_desktop_teardown_authority.sql",
  "20260906060000_provider_desktop_cold_start_release.sql", "20260906070000_provider_workspace_sessions.sql",
  "20260906080000_provider_workspace_release.sql", "20260906090000_provider_node_ownership_release.sql",
  "20260906110000_agent_zero_editor_release.sql", "20260906120000_desktop_prepared_image_release.sql",
  "20260906130000_desktop_image_transfer_release.sql", "20260906140000_desktop_image_inventory_release.sql",
  "20260907153000_desktop_96_dpi_release.sql", "20260908023000_hq_streaming_profiles_release.sql",
  "20260908080000_first_frame_streaming_profile_release.sql", "20260908090000_desktop_handoff_latency_release.sql",
  "20260922201510_provider_release_admission_2026_09_22.sql", "20260924180000_provider_release_admission_2026_09_24.sql",
];
const PATCHED = [
  "public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)",
  "public.guard_hivra_provider_agent()",
  "public.hivra_workspace_binding_current(public.hivra_workspace_sessions)",
];

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
      alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;
      create function public.update_updated_at() returns trigger language plpgsql as $$
        begin new.updated_at=now(); return new; end; $$;
      create function public.requesting_user_id() returns text language sql as $$ select 'owner'::text; $$;
      create function public.digest(text,text) returns bytea language sql as $$ select sha256(convert_to($1,'UTF8')); $$;
      create table public.managed_venice_proxy_keys(id uuid primary key,user_id text,status text);
    `);
    const dir = path.resolve(__dirname, "../supabase/migrations");
    const migration = name => fs.readFileSync(path.join(dir, name), "utf8");
    await db.exec(migration("20260605120000_hivra_agents.sql"));
    await db.exec("alter table public.hivra_agents add column llm_config jsonb, add column llm_api_key_encrypted text");
    for (const file of fs.readdirSync(dir).filter(name => /^202608(?:2[56789]|3[01])/.test(name) || LATER.includes(name)).sort()) {
      await db.exec(migration(file));
    }
    const value = async (sql, args = []) => (await db.query(sql, args)).rows[0].result;
    const definitions = async () => {
      const out = {};
      for (const signature of [...PATCHED, "public.guard_first_boot_enrollment()", "public.consume_hetzner_first_boot(text,uuid,bigint,uuid,uuid,text,text,text,text,timestamptz)",
        "public.checkpoint_hetzner_first_boot_operation(text,uuid,bigint,uuid,uuid,text,text,uuid,text,jsonb,timestamptz)"]) {
        out[signature] = await value("select pg_get_functiondef($1::regprocedure) as result", [signature]);
      }
      out.constraints = await value("select jsonb_agg(conname order by conname) as result from pg_constraint where conrelid='public.infrastructure_first_boot_enrollments'::regclass and contype='c'");
      out.triggers = await value("select jsonb_agg(tgname order by tgname) as result from pg_trigger where tgrelid in ('public.infrastructure_first_boot_enrollments'::regclass,'public.infrastructure_first_boot_operations'::regclass) and not tgisinternal");
      return out;
    };
    const before = await definitions();
    await db.exec(migration(TARGET));
    const once = await definitions();
    await db.exec(migration(TARGET));
    assert.deepEqual(await definitions(), once, "rerunning the migration must change nothing");
    for (const signature of PATCHED) {
      assert.notEqual(once[signature], before[signature], signature + " must be patched");
      assert.ok(once[signature].includes("public.hetzner_first_boot_window_contains("), signature);
      assert.ok(!/enrolled_at\s*>=\s*[a-z_.]*issued_at|enrolled_at\s*<\s*[a-z_.]*issued_at/.test(once[signature]), signature);
    }
    assert.ok(once.triggers.includes("infrastructure_first_boot_operations_arming_guard"));
    assert.ok(once.triggers.includes("infrastructure_first_boot_enrollments_armed_power_on"));
    assert.equal(once.constraints.filter(name => name === "infrastructure_first_boot_armed_state").length, 1);

    const connection = "11111111-1111-4111-8111-111111111111", order = "22222222-2222-4222-8222-222222222222";
    const attempt = "33333333-3333-4333-8333-333333333333", capacityKey = "44444444-4444-4444-8444-444444444444";
    const agent = "66666666-6666-4666-8666-666666666666", op = "77777777-7777-4777-8777-777777777777";
    const quote = "a".repeat(64), verifier = "b".repeat(64), serverName = "hivra-22222222222242228222";
    const receipt = { version: 1, serverId: "42", primaryIpv4: { id: "88", ip: "203.0.113.10" },
      primaryIpv6: { id: "89", ip: "2001:db8::/64" },
      action: { id: "500", command: "create_server", status: "success", resources: [{ id: "42", type: "server" }] }, nextActions: [] };
    const firewall = { version: 1, scope: { orderId: order, attemptId: attempt, quoteFingerprint: quote, serverId: 42 },
      firewallId: 91, createdAt: new Date().toISOString(), setRulesActionId: 601, applyActionId: 602 };
    const power = { id: 603, command: "start_server", status: "success", resources: [{ id: 42, type: "server" }] };
    const key = seed => {
      const blob = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), Buffer.alloc(32, seed)]);
      return { blob, key: "ssh-ed25519 " + blob.toString("base64"),
        fingerprint: "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "") };
    };
    const host = key(1), otherHost = key(2);
    const refused = (fn, code = "55006") => assert.rejects(fn, error => error.code === code);
    const row = async (sql, args) => (await db.query(sql, args)).rows[0]?.result ?? null;
    const read = () => row("select to_jsonb(e) as result from public.infrastructure_first_boot_enrollments e where order_id=$1", [order]);
    const readOp = () => row("select to_jsonb(o) as result from public.infrastructure_first_boot_operations o where order_id=$1", [order]);
    // A transaction the database must refuse, at a statement or at COMMIT.
    async function refusedTransaction(sql, code = "55006") {
      await assert.rejects(() => db.exec("begin;\n" + sql + "\ncommit;"), error => error.code === code);
      await db.exec("rollback");
    }

    async function reset({ recipe = CURRENT, issuedAgo = null } = {}) {
      await db.exec("truncate public.hivra_agents,public.infrastructure_connections,public.infrastructure_connection_secrets,public.deployment_targets,public.infrastructure_capacity_inventory,public.infrastructure_capacity_orders,public.infrastructure_first_boot_enrollments,public.infrastructure_first_boot_operations,public.infrastructure_host_discovery_snapshots cascade");
      await db.query("insert into public.infrastructure_connections(id,user_id,name,provider,operating_mode,setup_mode,status,revision,ssh_host,ssh_port,ssh_user,ssh_host_fingerprint_sha256,config) values($1,'owner','Project','hetzner-cloud','self-managed','simple','ready',7,null,null,null,null,'{}')", [connection]);
      await db.query("insert into public.infrastructure_connection_secrets(connection_id,user_id,encrypted_bundle,key_version) values($1,'owner','sealed-project-fixture',2)", [connection]);
      await db.query("insert into public.infrastructure_capacity_orders(id,user_id,connection_id,active_connection_id,connection_revision,status,server_name,provider_labels,quote_snapshot,quote_fingerprint_sha256,quote_expires_at,idempotency_key,encrypted_bootstrap_bundle,bootstrap_key_version,bootstrap_public_key,bootstrap_public_key_fingerprint,ssh_key_post_attempted_at,provider_ssh_key_status,provider_ssh_key_id) values($1,'owner',$2,$2,7,'creating',$3,'{}','{}',$4,now()+interval '5 minutes',$5,'sealed-bootstrap-fixture',2,$6,$7,now(),'accepted','77')",
        [order, connection, serverName, quote, capacityKey, host.key, host.fingerprint]);
      if (issuedAgo === null) return;
      // Direct fixture insertion models a past attempt without weakening any
      // trigger, changing the clock or sleeping for hours.
      await db.query("with stamp as (select clock_timestamp()-$7::interval as issued) insert into public.infrastructure_first_boot_enrollments(order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,capacity_idempotency_key,recipe_version,phase,issued_at,expires_at,verifier_sha256,encrypted_token) select $1,$2,'owner',$3,7,$4,$5,$6,'staged',issued,issued+interval '15 minutes',repeat('b',64),repeat('sealed-fixture-',10) from stamp",
        [order, attempt, connection, quote, capacityKey, recipe, issuedAgo]);
      await created();
    }
    const created = () => db.query("update public.infrastructure_capacity_orders set status='created_off',server_post_attempted_at=now(),provider_server_status='accepted',provider_resource_id='42',provider_action_id='500',provider_action_command='create_server',provider_action_status='success',provider_next_actions='[]',observed_server_status='off',provider_observed_at=now(),provider_creation_receipt=$1 where id=$2", [receipt, order]);
    const stage = (recipe, issued = new Date()) => value(
      "select public.stage_hetzner_first_boot('owner',$1,7,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Prepare this computer for agent launch') as result",
      [connection, order, capacityKey, attempt, quote, recipe, issued.toISOString(), new Date(issued.getTime() + 900_000).toISOString(),
        verifier, "sealed-fixture-".repeat(10)]);
    const arm = () => value("select public.arm_hetzner_first_boot('owner',$1,7,$2,$3,$4,'42',$5) as result", [connection, order, attempt, capacityKey, receipt]);
    const claim = () => value("select public.claim_hetzner_first_boot_operation('owner',$1,7,$2,$3,$4,'42') as result", [connection, order, attempt, quote]);
    const checkpoint = (lease, event, evidence = null, observed = null) => value(
      "select public.checkpoint_hetzner_first_boot_operation('owner',$1,7,$2,$3,$4,'42',$5,$6,$7,$8) as result",
      [connection, order, attempt, quote, lease, event, evidence, observed]);
    const release = lease => value("select public.release_hetzner_first_boot_operation('owner',$1,7,$2,$3,$4,'42',$5) as result", [connection, order, attempt, quote, lease]);
    const consume = (identity = host) => value(
      "select public.consume_hetzner_first_boot('owner',$1,7,$2,$3,'42',$4,$5,$6,clock_timestamp()) as result",
      [connection, order, attempt, verifier, identity.key, identity.fingerprint]);
    const enrolledGuest = () => value("select public.claim_hetzner_enrolled_guest_operation('owner',$1,7,$2,$3,$4,'42') as result", [connection, order, attempt, quote]);
    const directArm = (minutesAgo = 0) => [
      `select set_config('hivra.first_boot_power_dispatch','${order}',true);`,
      `update public.infrastructure_first_boot_enrollments set armed_at=clock_timestamp()-interval '${minutesAgo} minutes',`,
      `armed_expires_at=clock_timestamp()-interval '${minutesAgo} minutes'+interval '17 minutes' where order_id='${order}';`,
    ].join("\n");
    async function firewallVerified() {
      const claimed = await claim();
      assert.equal(claimed.outcome, "claimed");
      const lease = claimed.record.lease_id;
      assert.equal(await checkpoint(lease, "firewall_dispatch"), true);
      assert.equal(await checkpoint(lease, "firewall_receipt", firewall), true);
      assert.equal(await checkpoint(lease, "firewall_verified", firewall, new Date().toISOString()), true);
      return lease;
    }
    // An armed challenge in the past: enrollment and its matching recorded
    // power-on inserted together (the deferred check runs at COMMIT).
    async function armedFixture(minutesAgo) {
      await reset();
      await db.query("update public.infrastructure_capacity_orders set status='created_off',server_post_attempted_at=now()-interval '2 hours',provider_server_status='accepted',provider_resource_id='42',provider_action_id='500',provider_action_command='create_server',provider_action_status='success',provider_next_actions='[]',observed_server_status='off',provider_observed_at=now(),provider_creation_receipt=$1 where id=$2", [receipt, order]);
      await db.exec("begin");
      try {
        await db.query("with s as (select date_trunc('milliseconds',clock_timestamp()) as stamp) insert into public.infrastructure_first_boot_enrollments(order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,capacity_idempotency_key,recipe_version,phase,issued_at,expires_at,verifier_sha256,encrypted_token,provider_server_id,armed_at,armed_expires_at) select $1,$2,'owner',$3,7,$4,$5,$6,'awaiting_identity',stamp-interval '2 hours',stamp-interval '105 minutes',repeat('b',64),repeat('sealed-fixture-',10),'42',stamp-$7::interval,stamp-$7::interval+interval '17 minutes' from s",
          [order, attempt, connection, quote, capacityKey, CURRENT, minutesAgo + " minutes"]);
        await db.query("insert into public.infrastructure_first_boot_operations(order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,provider_server_id,firewall_post_attempted_at,firewall_receipt,firewall_verified_at,power_on_post_attempted_at,power_on_action) select $1,$2,'owner',$3,7,$4,'42',armed_at-interval '1 minute',$5,armed_at-interval '30 seconds',armed_at,$6 from public.infrastructure_first_boot_enrollments where order_id=$1",
          [order, attempt, connection, quote, firewall, power]);
        await db.exec("commit");
      } catch (error) { await db.exec("rollback"); throw error; }
    }

    // --- Recipe gating ---------------------------------------------------
    await reset();
    assert.equal((await stage(CURRENT)).outcome, "staged");
    assert.equal((await read()).recipe_version, CURRENT);
    assert.equal((await read()).armed_at, null);
    await reset();
    assert.equal((await stage(LEGACY)).outcome, "staged"); // The previous deployment keeps working.
    await reset();
    await refused(() => stage("2026.09.99.1"), "22023");
    await refused(() => stage(null), "22023");
    // A legacy record can never hold an armed window, however it is written.
    await refusedTransaction(`insert into public.infrastructure_first_boot_enrollments(order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,capacity_idempotency_key,recipe_version,phase,issued_at,expires_at,verifier_sha256,encrypted_token,provider_server_id,armed_at,armed_expires_at)
      values('${order}','${attempt}','owner','${connection}',7,'${quote}','${capacityKey}','${LEGACY}','awaiting_identity',now(),now()+interval '15 minutes',repeat('b',64),repeat('sealed-fixture-',10),'42',now(),now()+interval '17 minutes');`, "23514");
    // The window is exactly 15 minutes plus 2 of boot slack, and never staged.
    await refusedTransaction(`insert into public.infrastructure_first_boot_enrollments(order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,capacity_idempotency_key,recipe_version,phase,issued_at,expires_at,verifier_sha256,encrypted_token,provider_server_id,armed_at,armed_expires_at)
      values('${order}','${attempt}','owner','${connection}',7,'${quote}','${capacityKey}','${CURRENT}','awaiting_identity',now(),now()+interval '15 minutes',repeat('b',64),repeat('sealed-fixture-',10),'42',now(),now()+interval '1 day');`, "23514");
    // An armed record without the matching recorded power-on fails at COMMIT.
    await refusedTransaction(`insert into public.infrastructure_first_boot_enrollments(order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,capacity_idempotency_key,recipe_version,phase,issued_at,expires_at,verifier_sha256,encrypted_token,provider_server_id,armed_at,armed_expires_at)
      values('${order}','${attempt}','owner','${connection}',7,'${quote}','${capacityKey}','${CURRENT}','awaiting_identity',now(),now()+interval '15 minutes',repeat('b',64),repeat('sealed-fixture-',10),'42',now(),now()+interval '17 minutes');`);
    assert.equal(await read(), null);

    // --- Start setup two hours after creation (current recipe) ------------
    await reset({ recipe: CURRENT, issuedAgo: "2 hours" });
    assert.equal(await consume(), "rejected"); // Staged: not even eligible.
    assert.equal(await arm(), true); // Eligible long after the 15-minute delivery window.
    assert.equal((await read()).phase, "awaiting_identity");
    assert.equal(await consume(), "rejected"); // Unarmed: Hivra has not powered it on.
    assert.equal((await read()).host_public_key, null);
    // Arming is only the power-on checkpoint's: not a direct write, not a
    // write that fakes its marker without the power-on, not a power-on alone.
    await refused(() => db.exec(`update public.infrastructure_first_boot_enrollments set armed_at=now(),armed_expires_at=now()+interval '17 minutes' where order_id='${order}'`));
    await refusedTransaction(directArm());
    assert.equal((await read()).armed_at, null);
    const lease = await firewallVerified();
    assert.ok(Date.parse((await readOp()).lease_expires_at) - Date.now() > 100_000, "an unarmed lease is not bounded by the delivery window");
    await assert.rejects(() => db.query("update public.infrastructure_first_boot_operations set power_on_post_attempted_at=clock_timestamp() where order_id=$1", [order]),
      error => error.code === "55006" && /open the setup window/.test(error.message));
    assert.equal((await readOp()).power_on_post_attempted_at, null);
    assert.equal(await consume(), "rejected");
    assert.equal(await checkpoint(lease, "power_dispatch"), true);
    const armed = await read(), powered = await readOp();
    assert.ok(armed.armed_at, "the setup power-on arms the challenge");
    assert.equal(Date.parse(armed.armed_at), Date.parse(powered.power_on_post_attempted_at));
    assert.equal(Date.parse(armed.armed_expires_at) - Date.parse(armed.armed_at), 17 * 60_000);
    assert.ok(Date.parse(armed.armed_at) > Date.parse(armed.expires_at), "the window opens after the delivery deadline");
    // Nothing re-arms a challenge whose power-on is recorded.
    assert.equal(await checkpoint(lease, "power_dispatch"), false);
    await refusedTransaction(directArm(1));
    assert.equal((await read()).armed_at, armed.armed_at);
    assert.equal(await checkpoint(lease, "power_receipt", power), true);
    assert.equal(await consume(), "enrolled");
    const enrolled = await read();
    assert.equal(enrolled.host_public_key, host.key);
    assert.equal(enrolled.encrypted_token, null);
    assert.ok(Date.parse(enrolled.enrolled_at) >= Date.parse(armed.armed_at) && Date.parse(enrolled.enrolled_at) < Date.parse(armed.armed_expires_at));
    assert.equal(await consume(), "acknowledgement_replay");
    assert.equal(await consume(otherHost), "identity_changed");
    await refusedTransaction(directArm()); // Not after enrollment either.
    assert.equal(await release(lease), true);
    // Every downstream enrolled-window check honours the armed window.
    const guestLease = await enrolledGuest();
    assert.equal(guestLease.outcome, "claimed");
    const preparationLease = guestLease.record.lease_id, observed = new Date();
    const snapshot = parseProviderGuestDiscoveryOutput({
      discoveryId: preparationLease, connectionId: connection, connectionRevision: 7,
      capacityOrderId: order, enrollmentAttemptId: attempt, providerServerId: "42",
      normalizedHostFingerprint: host.fingerprint, observedAt: observed, output: guestDiscoveryOutput(),
    });
    const scopeFor = recipe => createHash("sha256").update(JSON.stringify([
      "hivra/provider-bundle/v1", "owner", connection, 7, order, attempt, quote, recipe, "42"])).digest("hex");
    const bundle = { version: 1, state: "bundle_installed", provisionerVersion: "2026.08.28.1", bundleSha256: "b".repeat(64) };
    const publish = scopeSha256 => value("select public.publish_prepared_provider_computer('owner',$1,7,$2,$3,$4,'42',$5,$6,$7,$8) as result",
      [connection, order, attempt, quote, preparationLease, snapshot, { ...bundle, scopeSha256 }, power]);
    assert.equal(await publish(scopeFor(LEGACY)), null, "the scope digest binds the attempt's own recipe");
    const prepared = await publish(scopeFor(CURRENT));
    assert.ok(prepared, "a late-started server publishes its prepared computer");
    const admit = () => value("select public.admit_prepared_provider_computer('owner',$1,7,$2,$3,'42',$4,$5,$6) as result",
      [connection, order, attempt, preparationLease, prepared.id, { ...bundle, scopeSha256: scopeFor(CURRENT) }]);
    assert.equal(await admit(), true);
    assert.equal(await release(preparationLease), true);
    await db.query(`insert into public.hivra_agents(id,user_id,type,name,cpu,ram,status,deployment_mode,proxmox_host,
      desired_state,operation_id,operation_kind,operation_started_at,allocation_operation_id,
      infrastructure_connection_id,deployment_target_id,infrastructure_connection_revision,
      infrastructure_binding_token_hash,infrastructure_binding_token_enforced,
      computer_substrate,provider_capacity_order_id,provider_enrollment_attempt_id,provider_server_id,computer_profile)
      values($1,'owner','codex','Test computer',2,4,'provisioning','self-managed','__hivra_self_managed_no_ambient_authority__',
      'running',$2,'provision',clock_timestamp(),$2,$3,$4,7,repeat('d',64),true,'provider-vm',$5,$6,'42',null)`,
    [agent, op, connection, prepared.id, order, attempt]);
    assert.equal(await value("select provider_enrollment_attempt_id as result from public.hivra_agents where id=$1", [agent]), attempt);

    // --- Armed, then the window passed ------------------------------------
    await armedFixture(18);
    assert.equal(await consume(), "rejected");
    assert.equal((await read()).phase, "awaiting_identity");
    assert.equal((await claim()).outcome, "rejected");
    assert.equal(await arm(), false);
    const lapsed = await read();
    await refusedTransaction(directArm()); // No re-arm after a recorded power-on.
    assert.deepEqual(await read(), lapsed);
    assert.equal(Date.parse(lapsed.armed_at), Date.parse((await readOp()).power_on_post_attempted_at));
    // 16 minutes after power-on is inside the 2-minute boot slack.
    await armedFixture(16);
    assert.equal(await consume(), "enrolled");
    assert.equal((await enrolledGuest()).outcome, "claimed");

    // --- Legacy servers keep today's rules ---------------------------------
    await reset({ recipe: LEGACY, issuedAgo: "0 seconds" });
    assert.equal(await arm(), true);
    await refusedTransaction(directArm());
    const legacyLease = await firewallVerified();
    assert.equal(await checkpoint(legacyLease, "power_dispatch"), true);
    assert.equal((await read()).armed_at, null, "a legacy challenge is never armed");
    assert.ok((await readOp()).power_on_post_attempted_at);
    assert.equal(await consume(), "enrolled");
    assert.equal(await checkpoint(legacyLease, "power_receipt", power), true);
    assert.equal(await release(legacyLease), true);
    assert.equal((await enrolledGuest()).outcome, "claimed");
    await reset({ recipe: LEGACY, issuedAgo: "16 minutes" });
    assert.equal(await arm(), false);
    await reset({ recipe: LEGACY, issuedAgo: "14 minutes 20 seconds" });
    assert.equal(await arm(), true);
    assert.equal((await claim()).outcome, "rejected"); // Less than a minute left.
    await reset({ recipe: LEGACY, issuedAgo: "16 minutes" });
    await db.exec("update public.infrastructure_first_boot_enrollments set phase='awaiting_identity',provider_server_id='42'");
    assert.equal(await consume(), "rejected");
    assert.equal((await claim()).outcome, "rejected");

    // --- The helpers, unknown recipes and privileges ------------------------
    assert.equal(await value("select public.hetzner_first_boot_window_contains('later',now()-interval '1 minute',now()+interval '1 minute',null,null,now()) as result"), false);
    assert.equal(await value("select public.hetzner_first_boot_window_contains($1,now()-interval '1 minute',now()+interval '1 minute',null,null,now()) as result", [CURRENT]), false);
    assert.equal(await value("select public.hetzner_first_boot_deadline('later',now(),now()) = '-infinity'::timestamptz as result"), true);
    assert.equal(await value("select public.hetzner_first_boot_deadline($1,now(),null) = 'infinity'::timestamptz as result", [CURRENT]), true);
    for (const signature of ["public.hetzner_first_boot_deadline(text,timestamptz,timestamptz)",
      "public.hetzner_first_boot_window_contains(text,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz)",
      "public.consume_hetzner_first_boot(text,uuid,bigint,uuid,uuid,text,text,text,text,timestamptz)",
      "public.checkpoint_hetzner_first_boot_operation(text,uuid,bigint,uuid,uuid,text,text,uuid,text,jsonb,timestamptz)",
      "public.claim_hetzner_enrolled_guest_operation(text,uuid,bigint,uuid,uuid,text,text)"]) {
      assert.deepEqual(await value("select jsonb_build_object('anon',has_function_privilege('anon',$1,'execute'),'auth',has_function_privilege('authenticated',$1,'execute'),'service',has_function_privilege('service_role',$1,'execute'),'definer',(select prosecdef from pg_proc where oid=$1::regprocedure)) as result", [signature]),
        { anon: false, auth: false, service: true, definer: false }, signature);
    }
    for (const signature of ["public.guard_first_boot_power_on_arming()", "public.assert_first_boot_armed_with_power_on()"]) {
      assert.deepEqual(await value("select jsonb_build_object('anon',has_function_privilege('anon',$1,'execute'),'auth',has_function_privilege('authenticated',$1,'execute')) as result", [signature]),
        { anon: false, auth: false }, signature);
    }
    console.log("PASS hetzner first-boot arm at start SQL: recipe gating, unarmed refusal, arming only with the recorded setup power-on, late start enrolls and passes every enrolled-window check, expired armed window refused, no re-arm, legacy unchanged, service-only helpers, rerun no-op");
  } finally {
    await db.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
