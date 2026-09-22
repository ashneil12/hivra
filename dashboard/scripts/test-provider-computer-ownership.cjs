// Actual, in-memory PostgreSQL migrations. No application credentials or cloud
// resources. Historical enrollment fixtures do not bypass/disable any trigger.
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

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      -- Match the deployed Supabase table defaults: GRANT is additive, so
      -- private journals must explicitly revoke excessive service privileges.
      alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
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
    for (const file of fs.readdirSync(dir).filter(name =>
      /^202608(?:2[56789]|3[01])/.test(name) || [
        "20260901020000_hivra_remote_desktop_sessions.sql",
        "20260906070000_provider_workspace_sessions.sql",
        "20260906080000_provider_workspace_release.sql",
        "20260906090000_provider_node_ownership_release.sql",
        "20260906110000_agent_zero_editor_release.sql",
        "20260906120000_desktop_prepared_image_release.sql",
        "20260906130000_desktop_image_transfer_release.sql",
        "20260906140000_desktop_image_inventory_release.sql",
        "20260907153000_desktop_96_dpi_release.sql",
        "20260901031000_provider_native_remote_desktop_release.sql",
        "20260901032000_provider_bounded_remote_desktop_release.sql",
        "20260901033000_provider_immutable_remote_desktop_release.sql",
        "20260901034000_provider_remote_desktop_readiness_release.sql",
        "20260901035000_provider_remote_desktop_auth_release.sql",
        "20260901036000_provider_remote_desktop_container_readiness_release.sql",
        "20260901037000_provider_deepseek_proxmox_release.sql",
        "20260901211000_provider_desktop_renewal_release.sql",
        "20260901235500_provider_desktop_timing_release.sql",
        "20260902030000_provider_native_proxmox_handoff_release.sql",
        "20260902060000_provider_native_vmid_ssh_release.sql",
        "20260902070000_provider_native_lifecycle_ssh_release.sql",
        "20260902080000_provider_native_qga_bootstrap_release.sql",
        "20260902120000_provider_public_source_release.sql",
        "20260902170000_provider_public_source_hygiene_release.sql",
        "20260902180000_provider_public_export_review_release.sql",
        "20260902190000_provider_linux_desktop_release.sql",
        "20260903010000_hivra_computer_profiles.sql",
        "20260904130000_hivra_provider_resize_operations.sql",
        "20260904140000_provider_current_bundle_release.sql",
        "20260905070000_hivra_provider_resize_action_command.sql",
        "20260905071000_hivra_provider_resize_shutdown.sql",
        "20260905072000_hivra_provider_resize_absence.sql",
        "20260905073000_hivra_provider_resize_dispatch_version.sql",
        "20260905090000_hivra_provider_resize_readiness.sql",
        "20260905091000_hivra_provider_resize_readiness_dispatch.sql",
        "20260905110000_provider_desktop_workspace_identity_release.sql",
        "20260905130000_provider_desktop_special_modes_release.sql",
        "20260905190000_provider_resize_setup_handoff.sql",
        "20260905200000_provider_desktop_worker_release.sql",
        "20260905210000_provider_desktop_cleanup_contract.sql",
        "20260905220000_provider_desktop_lifecycle.sql",
        "20260905230000_provider_desktop_framing_release.sql",
        "20260906000000_provider_desktop_capability_refresh.sql",
        "20260906010000_provider_desktop_power_completion.sql",
        "20260906020000_provider_desktop_resize_floor.sql",
        "20260906030000_provider_usd_capacity_ceiling.sql",
        "20260906040000_provider_desktop_absent_handoff.sql",
        "20260906050000_provider_desktop_teardown_authority.sql",
        "20260906060000_provider_desktop_cold_start_release.sql",
        "20260908023000_hq_streaming_profiles_release.sql",
        "20260908080000_first_frame_streaming_profile_release.sql",
        "20260908090000_desktop_handoff_latency_release.sql",
        "20260922201510_provider_release_admission_2026_09_22.sql",
      ].includes(name)).sort()) {
      await db.exec(migration(file));
    }
    const connection = "11111111-1111-4111-8111-111111111111";
    const order = "22222222-2222-4222-8222-222222222222";
    const attempt = "33333333-3333-4333-8333-333333333333";
    const capacityKey = "44444444-4444-4444-8444-444444444444";
    const target = "55555555-5555-4555-8555-555555555555";
    const agent = "66666666-6666-4666-8666-666666666666";
    const op = "77777777-7777-4777-8777-777777777777";
    const other = "88888888-8888-4888-8888-888888888888";
    const quote = "a".repeat(64), serverName = "hivra-22222222222242228222";
    const receipt = { version: 1, serverId: "42", primaryIpv4: { id: "88", ip: "203.0.113.10" },
      primaryIpv6: { id: "89", ip: "2001:db8::/64" },
      action: { id: "500", command: "create_server", status: "success", resources: [{ id: "42", type: "server" }] }, nextActions: [] };
    const firewall = { version: 1, scope: { orderId: order, attemptId: attempt, quoteFingerprint: quote, serverId: 42 },
      firewallId: 91, createdAt: new Date().toISOString(), setRulesActionId: 601, applyActionId: 602 };
    const power = { id: 603, command: "start_server", status: "success", resources: [{ id: 42, type: "server" }] };
    const blob = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), Buffer.alloc(32, 1)]);
    const publicKey = "ssh-ed25519 " + blob.toString("base64");
    const fingerprint = "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
    const caps = { kind: "provider-vm", provider: "hetzner-cloud", capacityOrderId: order,
      enrollmentAttemptId: attempt, allocation: "exclusive-computer", launchReady: true,
      hostIdentityDigest: createHash("sha256").update(blob).digest("hex"),
      provisioner: { configured: true, ready: true, version: "2026.08.28.1", bundleSha256: "b".repeat(64), scopeSha256: "c".repeat(64) } };
    const value = async (sql, args = []) => (await db.query(sql, args)).rows[0].result;
    const readAgent = () => value("select to_jsonb(a) as result from public.hivra_agents a where id=$1", [agent]);
    const rejected = fn => assert.rejects(fn, error => ["55006", "55000", "23505", "23514", "23503"].includes(error.code));
    async function reset({ publish = true } = {}) {
      await db.exec("truncate public.hivra_agents,public.infrastructure_connections,public.infrastructure_connection_secrets,public.deployment_targets,public.infrastructure_capacity_inventory,public.infrastructure_capacity_orders,public.infrastructure_first_boot_enrollments,public.infrastructure_first_boot_operations,public.infrastructure_host_discovery_snapshots cascade");
      await db.query("insert into public.infrastructure_connections(id,user_id,name,provider,operating_mode,setup_mode,status,revision,ssh_host,ssh_port,ssh_user,ssh_host_fingerprint_sha256,config) values($1,'owner','Project','hetzner-cloud','self-managed','simple','ready',7,null,null,null,null,'{}')", [connection]);
      await db.query("insert into public.infrastructure_connection_secrets(connection_id,user_id,encrypted_bundle,key_version) values($1,'owner','sealed-project-fixture',2)", [connection]);
      await db.query("insert into public.infrastructure_capacity_orders(id,user_id,connection_id,active_connection_id,connection_revision,status,server_name,provider_labels,quote_snapshot,quote_fingerprint_sha256,quote_expires_at,idempotency_key,encrypted_bootstrap_bundle,bootstrap_key_version,bootstrap_public_key,bootstrap_public_key_fingerprint,ssh_key_post_attempted_at,provider_ssh_key_status,provider_ssh_key_id) values($1,'owner',$2,$2,7,'creating',$3,'{}','{}',$4,now()+interval '5 minutes',$5,'sealed-bootstrap-fixture',2,$6,$7,now(),'accepted','77')",
        [order, connection, serverName, quote, capacityKey, publicKey, fingerprint]);
      await db.query("insert into public.infrastructure_first_boot_enrollments(order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,capacity_idempotency_key,recipe_version,phase,issued_at,expires_at,verifier_sha256,encrypted_token) values($1,$2,'owner',$3,7,$4,$5,'2026.08.27.1','staged',now()-interval '16 minutes',now()-interval '1 minute',repeat('b',64),repeat('sealed-fixture-',10))",
        [order, attempt, connection, quote, capacityKey]);
      await db.query("update public.infrastructure_capacity_orders set status='created_off',server_post_attempted_at=now(),provider_server_status='accepted',provider_resource_id='42',provider_action_id='500',provider_action_command='create_server',provider_action_status='success',provider_next_actions='[]',observed_server_status='off',provider_observed_at=now(),provider_creation_receipt=$1 where id=$2", [receipt, order]);
      await db.exec("update public.infrastructure_first_boot_enrollments set phase='awaiting_identity',provider_server_id='42'");
      await db.query("update public.infrastructure_first_boot_enrollments set phase='enrolled',encrypted_token=null,host_public_key=$1,host_fingerprint_sha256=$2,provider_observed_at=issued_at+interval '1 minute',enrolled_at=issued_at+interval '1 minute'", [publicKey, fingerprint]);
      await db.query("insert into public.infrastructure_first_boot_operations(order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,provider_server_id,firewall_post_attempted_at,firewall_receipt,firewall_verified_at,power_on_post_attempted_at,power_on_action) values($1,$2,'owner',$3,7,$4,'42',now()-interval '15 minutes',$5,now()-interval '15 minutes',now()-interval '15 minutes',$6)", [order, attempt, connection, quote, firewall, power]);
      if (publish) await publishTarget();
    }
    async function publishTarget(changes = {}) {
      const a = { id: target, user: "owner", connection, revision: 7, order, server: "42", caps, ...changes };
      return db.query("insert into public.deployment_targets(id,user_id,connection_id,evidence_connection_revision,external_id,display_name,status,capacity,capabilities,supported_isolation_drivers,isolation_class,provider_capacity_order_id) values($1,$2,$3,$4,$5,'Computer','ready','{}',$6,array['provider-vm'],'provider-vm',$7)",
        [a.id, a.user, a.connection, a.revision, a.server, a.caps, a.order]);
    }
    async function reserve(changes = {}) {
      const a = { id: agent, user: "owner", connection, revision: 7, target, order, attempt, server: "42", op, type:"codex",profile:null, ...changes };
      return db.query(`insert into public.hivra_agents(id,user_id,type,name,cpu,ram,status,deployment_mode,proxmox_host,
        desired_state,operation_id,operation_kind,operation_started_at,allocation_operation_id,
        infrastructure_connection_id,deployment_target_id,infrastructure_connection_revision,
        infrastructure_binding_token_hash,infrastructure_binding_token_enforced,
        computer_substrate,provider_capacity_order_id,provider_enrollment_attempt_id,provider_server_id,computer_profile)
        values($1,$2,$10,'Test computer',2,4,'provisioning','self-managed','__hivra_self_managed_no_ambient_authority__',
        'running',$3,'provision',clock_timestamp(),$3,$4,$5,$6,repeat('d',64),true,'provider-vm',$7,$8,$9,$11)`,
      [a.id, a.user, a.op, a.connection, a.target, a.revision, a.order, a.attempt, a.server,a.type,a.profile]);
    }
    const retire = (changes = {}) => {
      const a = { user: "owner", connection, revision: 7, target, order, server: "42", agent: null, op: null, ...changes };
      return value("select public.retire_hivra_provider_target($1,$2,$3,$4,$5,$6,$7,$8) as result",
        [a.user, a.connection, a.revision, a.target, a.order, a.server, a.agent, a.op]);
    };
    const cleanup = () => value("select public.claim_hetzner_cleanup_with_firewall('owner',$1,7,$2,$3,$4,$5,$6,$7) as result", [connection, order, capacityKey, other, "e".repeat(64), serverName, firewall]);
    const finish = (operation = op) => value("select public.complete_hivra_agent_delete('owner',$1,$2) as result", [agent, operation]);
    const boot = () => value("select public.claim_hetzner_enrolled_guest_operation('owner',$1,7,$2,$3,$4,'42') as result", [connection, order, attempt, quote]);
    const deleteRequest = (operation = other) => value("select public.request_hivra_agent_delete('owner',$1,$2) as result", [agent, operation]);
    const release = () => value("select public.release_hivra_agent_operation('owner',$1,$2,null,false) as result", [agent, op]);
    const observe = absent => value("select public.record_hetzner_cleanup_observation('owner',$1,7,$2,$3,$4,null) as result", [connection, order, other, absent]);
    const allAbsent = { server: true, ipv4: true, ipv6: true, sshKey: true, firewall: true };
    if (process.argv.includes("--desktop-only")) {
      await require("./provider-desktop-lifecycle-sql-fixture.cjs")({db,reset,publishTarget,reserve,caps,
        agent,op,other,connection,order,attempt,quote,value,readAgent,rejected});
      return;
    }

    // Preparation publishes under the same setup lease, never from a later
    // unleased callback. Its target is visible but cannot reserve an agent.
    power.status = "running"; // Original POST accepted; enrollment beat the poll.
    await reset({ publish: false });
    power.status = "success"; // Fresh provider GET, not a replacement power POST.
    const preparationLease = (await boot()).record.lease_id;
    const observed = new Date();
    // Feed the actual discovery parser into the actual SQL publication gate.
    // A handwritten digest here concealed the incompatible identity contracts.
    const preparationSnapshot = parseProviderGuestDiscoveryOutput({
      discoveryId: preparationLease, connectionId: connection, connectionRevision: 7,
      capacityOrderId: order, enrollmentAttemptId: attempt, providerServerId: "42",
      normalizedHostFingerprint: fingerprint, observedAt: observed,
      output: guestDiscoveryOutput(),
    });
    const preparationReceipt = { version: 1, state: "bundle_installed", provisionerVersion: "2026.08.28.1",
      bundleSha256: "b".repeat(64), scopeSha256: createHash("sha256").update(JSON.stringify([
        "hivra/provider-bundle/v1", "owner", connection, 7, order, attempt, quote, "2026.08.27.1", "42",
      ])).digest("hex") };
    const prepare = (changes = {}) => {
      const a = { user: "owner", connection, revision: 7, order, attempt, quote, server: "42", lease: preparationLease,
        snapshot: preparationSnapshot, receipt: preparationReceipt, power, ...changes };
      return value("select public.publish_prepared_provider_computer($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as result",
        [a.user,a.connection,a.revision,a.order,a.attempt,a.quote,a.server,a.lease,a.snapshot,a.receipt,a.power]);
    };
    for (const changes of [{ user: "foreign" }, { revision: 8 }, { order: other }, { attempt: other }, { quote: "f".repeat(64) },
      { server: "43" }, { lease: other }, { lease: null }, { power: { ...power, id: 999 } },
      { power: { ...power, status: "running" } }, { power: { ...power, resources: [{ id: 43, type: "server" }] } },
      { snapshot: { ...preparationSnapshot, hostIdentityDigest: "f".repeat(64) } },
      { snapshot: { ...preparationSnapshot, discoveryId: other } },
      { snapshot: { ...preparationSnapshot, observedAt: new Date(observed.getTime()-31000).toISOString() } },
      { receipt: { ...preparationReceipt, scopeSha256: "f".repeat(64) } },
      { receipt: { ...preparationReceipt, state: "running" } },
      { receipt: { ...preparationReceipt, credential: "must-not-store" } }]) assert.equal(await prepare(changes), null);
    for (const invalid of [null, "2", 0, -1, 1.5, 9007199254740992]) {
      const snapshot = structuredClone(preparationSnapshot);
      snapshot.host.capacity.cpu.logicalCores = invalid;
      assert.equal(await prepare({ snapshot }), null);
    }
    for (const change of ["container", "architecture", "os", "missing_capacity", "impossible_capacity"]) {
      const snapshot = structuredClone(preparationSnapshot);
      if (change === "container") snapshot.host.environment.virtualization = "container";
      if (change === "architecture") snapshot.host.kernel.architecture = "arm64";
      if (change === "os") snapshot.host.os.versionId = "24.04";
      if (change === "missing_capacity") delete snapshot.host.capacity.memoryBytes;
      if (change === "impossible_capacity") snapshot.host.capacity.memoryBytes.available = 5000000000;
      assert.equal(await prepare({ snapshot }), null);
    }
    const prepared = await prepare();
    assert.ok(prepared, "actual provider discovery must satisfy the enrolled-key publication fence");
    assert.deepEqual(await value("select power_on_action as result from public.infrastructure_first_boot_operations where order_id=$1", [order]), power);
    assert.equal(prepared.status, "unavailable");
    assert.equal(prepared.capabilities.launchReady, false);
    assert.equal(prepared.capabilities.provisioner.ready, true);
    assert.equal(prepared.capabilities.runtimeCompatibility, null);
    assert.equal(prepared.lastErrorCode, "PROVIDER_ADAPTER_UNAVAILABLE");
    assert.equal((await prepare()).id, prepared.id);
    assert.equal(await value("select count(*)::int as result from public.deployment_targets"), 1);
    await rejected(() => reserve({ target: prepared.id }));
    const admit = (changes = {}) => {
      const a = { user: "owner", connection, revision: 7, order, attempt, server: "42", lease: preparationLease,
        target: prepared.id, receipt: preparationReceipt, ...changes };
      return value("select public.admit_prepared_provider_computer($1,$2,$3,$4,$5,$6,$7,$8,$9) as result",
        [a.user,a.connection,a.revision,a.order,a.attempt,a.server,a.lease,a.target,a.receipt]);
    };
    for (const changes of [{ user: "foreign" }, { connection: other }, { revision: 8 }, { order: other },
      { attempt: other }, { server: "43" }, { lease: other }, { lease: null }, { target: other },
      { receipt: { ...preparationReceipt, bundleSha256: "f".repeat(64) } },
      { receipt: { ...preparationReceipt, extra: true } }]) assert.equal(await admit(changes), false);
    assert.equal(await admit(), true);
    assert.equal(await admit(), true);
    assert.equal(await value("select status as result from public.deployment_targets where id=$1", [prepared.id]), "ready");
    assert.equal(await value("select capabilities->'launchReady' as result from public.deployment_targets where id=$1", [prepared.id]), true);
    await rejected(() => reserve({ target: prepared.id })); // Setup lease still owns it.
    assert.equal(await value("select public.release_hetzner_first_boot_operation('owner',$1,7,$2,$3,$4,'42',$5) as result", [connection,order,attempt,quote,preparationLease]), true);
    assert.equal(await prepare(), null); // The delayed publisher cannot renew authority.
    assert.equal(await admit(), false);
    await reserve({ target: prepared.id });
    assert.equal((await readAgent()).deployment_target_id, prepared.id);
    const bindDirect = (user,address,operation=op) => value(
      "select public.bind_hivra_provider_direct_access($1,$2,$3,$4) as result", [user,agent,operation,address]);
    for (const address of [null, "203.0.113.11", " 203.0.113.10 "]) {
      assert.equal(await bindDirect("owner",address), false);
    }
    assert.equal(await bindDirect("foreign","203.0.113.10"), false);
    assert.equal(await bindDirect("owner","127.0.0.1"), false);
    assert.equal(await bindDirect("owner","203.0.113.10"), true);
    assert.equal(await bindDirect("owner","203.0.113.10"), true);
    assert.equal(await bindDirect("owner","203.0.113.11"), false);
    assert.deepEqual((await db.query("select chat_url,ip,cf_tunnel_id,cf_hostname from public.hivra_agents where id=$1", [agent])).rows[0], {
      chat_url: "https://203-0-113-10.sslip.io", ip: "203.0.113.10", cf_tunnel_id: null, cf_hostname: null,
    });
    assert.deepEqual(await value("select jsonb_build_object('anon',has_function_privilege('anon',$1,'execute'),'auth',has_function_privilege('authenticated',$1,'execute'),'service',has_function_privilege('service_role',$1,'execute')) as result",
      ["public.publish_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,text,uuid,jsonb,jsonb,jsonb)"]), { anon: false, auth: false, service: true });
    assert.deepEqual(await value("select jsonb_build_object('anon',has_function_privilege('anon',$1,'execute'),'auth',has_function_privilege('authenticated',$1,'execute'),'service',has_function_privilege('service_role',$1,'execute')) as result",
      ["public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)"]), { anon: false, auth: false, service: true });
    assert.deepEqual(await value("select jsonb_build_object('anon',has_function_privilege('anon',$1,'execute'),'auth',has_function_privilege('authenticated',$1,'execute'),'service',has_function_privilege('service_role',$1,'execute')) as result",
      ["public.bind_hivra_provider_direct_access(text,uuid,uuid,text)"]), { anon: false, auth: false, service: true });
    console.log("PASS provider preparation SQL: same-lease publication and separate admission, exact scope, fresh capacity, replay identity, setup/launch exclusion and private grants");

    const { PORTABLE_HIVRA_PROVISIONER_VERSION } = require("../src/lib/infrastructure/portable-provisioner-contract.ts");
    const recentReleases = ["2026.09.03.1", "2026.09.03.2", "2026.09.04.1", "2026.09.04.2", "2026.09.04.3", "2026.09.04.4", "2026.09.05.1", PORTABLE_HIVRA_PROVISIONER_VERSION];
    // New fixtures must pass the real publication path. Never rewrite a
    // published target's immutable bundle identity to simulate an upgrade.
    for (const version of [...recentReleases, null, "2099.01.01.1", "2026.09.02.8", "2026.09.02.7", "2026.09.02.6", "2026.09.02.5", "2026.09.02.4", "2026.09.02.3", "2026.09.02.2", "2026.09.02.1", "2026.09.01.9", "2026.09.01.8", "2026.09.01.7", "2026.09.01.6", "2026.09.01.5", "2026.09.01.4", "2026.09.01.3", "2026.09.01.2", "2026.09.01.1", "2026.08.31.4", "2026.08.31.3", "2026.08.31.2", "2026.08.31.1", "2026.08.30.2", "2026.08.30.1", "2026.08.29.5", "2026.08.29.4", "2026.08.29.3", "2026.08.29.2", "2026.08.29.1", "2026.08.28.4", "2026.08.28.3", "2026.08.28.2", "2026.08.28.1"]) {
      await reset({ publish: false });
      const lease = (await boot()).record.lease_id;
      const checkedAt = Date.now();
      const exactReceipt = { ...preparationReceipt, provisionerVersion: version };
      const snapshot = { ...preparationSnapshot, discoveryId: lease,
        observedAt: new Date(checkedAt).toISOString(), expiresAt: new Date(checkedAt + 900000).toISOString() };
      const published = await prepare({ lease, snapshot, receipt: exactReceipt });
      if (version === null) { assert.equal(published, null); continue; }
      assert.ok(published);
      const current = { lease, target: published.id, receipt: exactReceipt };
      const shouldAdmit = [...recentReleases, "2026.09.02.8", "2026.08.28.1", "2026.08.28.2", "2026.08.28.3", "2026.08.28.4", "2026.08.29.1", "2026.08.29.2", "2026.08.29.3", "2026.08.29.4", "2026.08.29.5", "2026.08.30.1", "2026.08.30.2", "2026.08.31.1", "2026.08.31.4", "2026.08.31.3", "2026.08.31.2", "2026.09.01.1", "2026.09.01.2", "2026.09.01.3", "2026.09.01.4", "2026.09.01.5", "2026.09.01.6", "2026.09.01.7", "2026.09.01.8", "2026.09.01.9", "2026.09.02.1", "2026.09.02.2", "2026.09.02.3", "2026.09.02.4", "2026.09.02.7", "2026.09.02.6", "2026.09.02.5"].includes(version);
      assert.equal(await admit(current), shouldAdmit, `provider admission mismatch for ${String(version)}`);
      if ([...recentReleases, "2026.09.02.8", "2026.08.31.2", "2026.08.31.3", "2026.08.31.4", "2026.09.01.1", "2026.09.01.2", "2026.09.01.3", "2026.09.01.4", "2026.09.01.5", "2026.09.01.6", "2026.09.01.7", "2026.09.01.8", "2026.09.01.9", "2026.09.02.1", "2026.09.02.2", "2026.09.02.3", "2026.09.02.4", "2026.09.02.7", "2026.09.02.6", "2026.09.02.5"].includes(version)) {
        assert.equal(await admit({ ...current, receipt: preparationReceipt }), false);
        assert.equal(await admit({ ...current, user: "foreign" }), false);
        assert.equal(await admit({ ...current, lease: other }), false);
      }
    }
    console.log(`PASS provider version SQL: .28.1 through ${PORTABLE_HIVRA_PROVISIONER_VERSION} exact admission, unknown/null rejection, receipt and owner/lease fences`);

    const expireUnstarted = (user = "owner", operation = op) => value(
      "select public.expire_unstarted_provider_agent($1,$2,$3) as result", [user,agent,operation]);
    await reset(); await reserve();
    assert.equal(await expireUnstarted(), false);
    await rejected(() => db.exec("update public.hivra_agents set llm_config='{\"provider\":\"venice\"}'"));
    await rejected(() => db.exec("update public.hivra_agents set llm_api_key_encrypted='fixture-key'"));
    const installExpiresIn = Number(await value("select extract(epoch from (provider_install_not_after-clock_timestamp()))*1000 as result from public.hivra_agents where id=$1", [agent]));
    assert.ok(installExpiresIn > 0 && installExpiresIn <= 45000);
    await new Promise(resolve => setTimeout(resolve, Math.ceil(installExpiresIn)+50));
    assert.equal(await expireUnstarted("foreign"), false);
    assert.equal(await expireUnstarted("owner", other), false);
    assert.equal(await expireUnstarted(), true);
    const expiredAgent = await readAgent();
    assert.equal(expiredAgent.status, "error"); assert.equal(expiredAgent.operation_id, null);
    assert.equal(expiredAgent.provider_capacity_order_id, order);
    assert.equal(expiredAgent.provider_install_identity, null);
    assert.equal(await expireUnstarted(), false);
    assert.deepEqual(await value("select jsonb_build_object('anon',has_function_privilege('anon',$1,'execute'),'auth',has_function_privilege('authenticated',$1,'execute'),'service',has_function_privilege('service_role',$1,'execute')) as result",
      ["public.expire_unstarted_provider_agent(text,uuid,uuid)"]), { anon: false, auth: false, service: true });

    // Guest execution uses this existing operation, never a new first-boot
    // lease. SQL fences premature release even from older application writers.
    const installIdentity = { version: 1, agentId: agent, operationId: op, bundle: {
      version: 1, state: "bundle_installed", provisionerVersion: caps.provisioner.version,
      bundleSha256: caps.provisioner.bundleSha256, scopeSha256: caps.provisioner.scopeSha256,
    } };
    const beginInstall = (identity = installIdentity, user = "owner", operation = op) => value(
      "select public.begin_hivra_provider_install($1,$2,$3,$4) as result", [user, agent, operation, identity]);
    const stoppedReceipt = { version: 1, identity: installIdentity, state: "cancelled", stopped: true };
    const recordStopped = (receipt = stoppedReceipt, user = "owner", operation = op) => value(
      "select public.record_hivra_provider_install_stopped($1,$2,$3,$4) as result", [user, agent, operation, receipt]);
    await reset(); await reserve();
    await db.exec("update public.deployment_targets set capabilities=jsonb_set(capabilities,'{launchReady}','false')");
    assert.deepEqual(await beginInstall(), { outcome: "rejected" });
    await reset(); await reserve();
    assert.deepEqual(await beginInstall(installIdentity, "foreign"), { outcome: "rejected" });
    assert.deepEqual(await beginInstall(installIdentity, "owner", other), { outcome: "rejected" });
    for (const identity of [null, {}, { ...installIdentity, extra: true }, { ...installIdentity, agentId: other },
      { ...installIdentity, version: 2, nativeCleanup: { profile: "deepseek-owned-service-v1", closureSha256: "f".repeat(64) } },
      { ...installIdentity, bundle: { ...installIdentity.bundle, scopeSha256: "f".repeat(64) } },
      { ...installIdentity, bundle: { ...installIdentity.bundle, provisionerVersion: "2026.08.27.4" } },
      { ...installIdentity, bundle: { ...installIdentity.bundle, unexpected: true } }]) {
      assert.deepEqual(await beginInstall(identity), { outcome: "rejected" });
    }
    assert.deepEqual(await beginInstall(), { outcome: "dispatch", dispatchBudgetMs: 30000 });
    assert.equal(await expireUnstarted(), false);
    const originalInstall = await readAgent();
    assert.deepEqual(originalInstall.provider_install_identity, installIdentity);
    assert.deepEqual(await beginInstall(), { outcome: "observe" }); // Lost reply cannot dispatch again.
    for (const sql of ["update public.hivra_agents set provider_install_identity=null,provider_install_dispatched_at=null",
      "update public.hivra_agents set provider_install_not_after=clock_timestamp()+interval '1 hour'",
      "update public.hivra_agents set provider_install_dispatched_at=clock_timestamp()",
      "update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null",
      "update public.hivra_agents set status='error'",
      "update public.hivra_agents set status='running'"]) await rejected(() => db.exec(sql));
    await rejected(() => release());
    assert.equal(await deleteRequest(), "pending");
    assert.deepEqual(await beginInstall(), { outcome: "observe" }); // Cancellation is observation-only.
    assert.equal(await retire({ agent, op }), false);
    assert.equal((await cleanup()).outcome, "target_in_use");
    for (const receipt of [null, {}, { ...stoppedReceipt, state: "running" }, { ...stoppedReceipt, stopped: false },
      { ...stoppedReceipt, stopped: "true" }, { ...stoppedReceipt, extra: true },
      { ...stoppedReceipt, identity: { ...installIdentity, operationId: other } }]) assert.equal(await recordStopped(receipt), false);
    assert.equal(await recordStopped(stoppedReceipt, "foreign"), false);
    assert.equal(await recordStopped(stoppedReceipt, "owner", other), false);
    assert.equal(await recordStopped(), true);
    const stopTime = (await readAgent()).provider_install_stopped_at;
    assert.equal(await recordStopped(), true);
    assert.deepEqual((await readAgent()).provider_install_stopped_at, stopTime);
    assert.equal(await recordStopped({ ...stoppedReceipt, state: "succeeded" }), false);
    await rejected(() => db.exec("update public.hivra_agents set provider_install_stopped_at=null,provider_install_outcome=null"));
    await rejected(() => db.exec("update public.hivra_agents set provider_install_outcome='succeeded'"));
    assert.equal(await release(), true); // Receipt does not release the operation itself.
    assert.equal(await deleteRequest(), "claimed");
    assert.equal(await retire({ agent, op: other }), true);
    assert.equal((await cleanup()).outcome, "claimed");
    assert.equal((await observe(allAbsent)).status, "deleted");
    assert.equal(await finish(other), true);
    assert.deepEqual((await readAgent()).provider_install_identity, installIdentity);
    assert.deepEqual((await readAgent()).provider_install_stopped_at, stopTime);

    // A recovered operation's timestamp is not a new installer start grant.
    await reset(); await reserve();
    const admissionDeadline = (await readAgent()).provider_install_not_after;
    await db.exec("update public.hivra_agents set operation_started_at=clock_timestamp()-interval '11 minutes'");
    const staleStartedAt = (await readAgent()).operation_started_at;
    assert.equal(await value("select public.claim_hivra_agent_operation_recovery('owner',$1,$2,$3,clock_timestamp()) as result", [agent, op, staleStartedAt]), true);
    assert.deepEqual((await readAgent()).provider_install_not_after, admissionDeadline);
    assert.deepEqual(await beginInstall(), { outcome: "rejected" });
    await reset(); await reserve();
    assert.deepEqual(await beginInstall(), { outcome: "dispatch", dispatchBudgetMs: 30000 });
    await db.exec("update public.hivra_agents set operation_started_at=clock_timestamp()-interval '11 minutes'");
    assert.equal(await value("select public.claim_hivra_agent_operation_recovery('owner',$1,$2,$3,clock_timestamp()) as result", [agent, op, (await readAgent()).operation_started_at]), true);
    assert.deepEqual(await beginInstall(), { outcome: "observe" });
    await rejected(() => release());
    assert.equal(await recordStopped({ ...stoppedReceipt, state: "succeeded" }), true);
    assert.equal((await readAgent()).status, "provisioning"); // Worker result is not readiness.
    assert.equal((await readAgent()).operation_id, op);

    for (const outcome of [null, "failed", "cancelled", "succeeded"]) {
      await reset(); await reserve();
      if (outcome !== null) {
        assert.equal((await beginInstall()).outcome, "dispatch");
        assert.equal(await recordStopped({ ...stoppedReceipt, state: outcome }), true);
      }
      assert.equal(await release(), true);
      if (outcome === "succeeded") {
        await db.exec("update public.hivra_agents set status='running'");
        assert.equal((await readAgent()).status, "running");
      } else {
        await rejected(() => db.exec("update public.hivra_agents set status='running'"));
      }
    }

    for (const name of ["begin_hivra_provider_install", "record_hivra_provider_install_stopped"]) {
      assert.deepEqual(await value("select jsonb_build_object('anon',has_function_privilege('anon',$1,'execute'),'auth',has_function_privilege('authenticated',$1,'execute'),'service',has_function_privilege('service_role',$1,'execute')) as result", ["public." + name + "(text,uuid,uuid,jsonb)"]), { anon: false, auth: false, service: true });
    }
    console.log("PASS provider installer SQL: original-operation dispatch window, single grant, exact bundle, recovery fence, cancellation retention, stopped proof, immutable tombstone and private RPC grants");

    // Staged native identity comes from the actual typed server builder and
    // immutable release, not a second handwritten digest/profile contract.
    const { buildProviderNativeWorkerPlan } = require("../src/lib/infrastructure/provider-native-worker.ts");
    const { PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES } = require("../src/lib/infrastructure/portable-provisioner-contract.ts");
    const nativeIdentity = buildProviderNativeWorkerPlan({
      scope: { binding: { userId: "owner", connectionId: connection, connectionRevision: 7,
        orderId: order, attemptId: attempt, quoteFingerprint: quote, recipeVersion: "2026.08.27.1" }, providerServerId: "42" },
      agentId: agent, operationId: op, action: "start", journaledHostname: "native.example.test",
      assets: PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map(relativePath => ({ relativePath,
        content: fs.readFileSync(path.join(__dirname, "../provisioner", relativePath)) })),
      launch: { version: 2, agentKind: "deepseek-harness", computerSubstrate: "provider-vm", wantBrowser: false,
        modelKey: "", model: "", modelBaseUrl: "", publicOrigin: "https://native.example.test",
        tunnelToken: "fixture-native-tunnel", accessHostname: null },
    }, { bootId: other, boottimeMs: 0 }).identity;
    const historicalNativeIdentity = { ...nativeIdentity, bundle: { ...nativeIdentity.bundle,
      provisionerVersion: "2026.08.31.3",
      bundleSha256: "8f74ff4ce921d21c84784fdff6885f2ff60b1e83b9c1f3609a95422982bc16ec" } };
    const nativeIdentityValid = identity => value(
      "select public.hivra_provider_native_identity_valid($1,$2,$3) as result", [identity, agent, op]);
    assert.equal(await nativeIdentityValid(nativeIdentity), true);
    assert.equal(await nativeIdentityValid(historicalNativeIdentity), true);
    assert.equal(await nativeIdentityValid({ ...historicalNativeIdentity, bundle: { ...historicalNativeIdentity.bundle,
      bundleSha256: nativeIdentity.bundle.bundleSha256 } }), false);
    assert.equal(await nativeIdentityValid({ ...nativeIdentity, bundle: { ...nativeIdentity.bundle,
      bundleSha256: historicalNativeIdentity.bundle.bundleSha256 } }), false);
    const nativeAccess = { mode: "cloudflare-named", hostname: "native.example.test", tunnelId: other };
    const beginNative = (identity = nativeIdentity, access = nativeAccess) => value(
      "select public.begin_hivra_provider_native_install('owner',$1,$2,$3,$4) as result", [agent, op, identity, access]);
    async function nativeFixture(dispatch = true) {
      await reset({ publish: false });
      const provisioner = { configured: true, ready: true, version: nativeIdentity.bundle.provisionerVersion,
        bundleSha256: nativeIdentity.bundle.bundleSha256, scopeSha256: nativeIdentity.bundle.scopeSha256 };
      await publishTarget({ caps: { ...caps, provisioner } });
      await reserve();
      await db.query("update public.hivra_agents set type='deepseek-harness',cf_hostname=$1,cf_tunnel_id=$2", [nativeAccess.hostname, nativeAccess.tunnelId]);
      if (dispatch) assert.equal((await beginNative()).outcome, "dispatch");
    }
    const nativeReceipt = (outcome = "failed", state = "verified_stopped", bootId = other) => ({
      version: 2, identity: nativeIdentity, state: outcome, stopped: true,
      nativeCleanup: state === "pending" ? { state } : { state, bootId },
    });
    const nativeGrant = (identity = nativeIdentity, user = "owner", operation = op) => value(
      "select public.begin_hivra_provider_native_cleanup($1,$2,$3,$4) as result", [user, agent, operation, identity]);
    const nativeRecord = (grant, receipt = nativeReceipt(), user = "owner", operation = op) => value(
      "select public.record_hivra_provider_native_cleanup($1,$2,$3,$4,$5) as result", [user, agent, operation, grant.observationId, receipt]);
    const nativeJournal = () => value("select to_jsonb(j) as result from public.hivra_provider_native_cleanup j where agent_id=$1", [agent]);
    const completeNative = (ip = "203.0.113.10", chatUrl = "https://native.example.test") => value(
      "select public.complete_hivra_provider_native_running('owner',$1,$2,$3,$4,clock_timestamp()) as result", [agent, op, chatUrl, ip]);
    async function expireNativeGrant() {
      // Administrative fixture aging only, preserving table constraints. The
      // actual service role is explicitly denied these writes below. This
      // tests PostgreSQL clock_timestamp() expiry, not a substituted clock.
      await db.exec("update public.hivra_provider_native_cleanup set issued_at=issued_at-interval '31 seconds',expires_at=expires_at-interval '31 seconds',observed_at=observed_at-interval '31 seconds'");
    }

    await nativeFixture(false);
    assert.equal(await nativeGrant(), null); // Identity must be journaled first.
    await rejected(() => db.query("update public.hivra_agents set provider_install_identity=$1,provider_install_dispatched_at=clock_timestamp()", [
      { version: 1, agentId: agent, operationId: op, bundle: nativeIdentity.bundle },
    ]));
    await db.exec("update public.hivra_agents set type='codex'");
    assert.equal((await beginNative()).outcome, "rejected"); // v2 cannot dispatch on another runtime.
    await rejected(() => db.query("update public.hivra_agents set type='deepseek-harness',provider_install_identity=$1,provider_install_dispatched_at=clock_timestamp()", [nativeIdentity]));
    await nativeFixture(false);
    for (const changed of [{ ...nativeIdentity, nativeCleanup: { ...nativeIdentity.nativeCleanup, closureSha256: "f".repeat(64) } },
      { ...nativeIdentity, nativeCleanup: { ...nativeIdentity.nativeCleanup, profile: "unowned" } },
      { ...nativeIdentity, bundle: { ...nativeIdentity.bundle, provisionerVersion: "2026.08.31.2" } },
      { ...nativeIdentity, bundle: { ...nativeIdentity.bundle, bundleSha256: "f".repeat(64) } }]) {
      assert.equal((await beginNative(changed)).outcome, "rejected");
    }
    assert.equal((await beginInstall(nativeIdentity)).outcome, "rejected"); // Old RPC cannot bypass access admission.
    for (const access of [null, {}, { ...nativeAccess, hostname: "other.example.test" },
      { ...nativeAccess, tunnelId: connection }, { ...nativeAccess, mode: "direct-https", tunnelId: null }]) {
      assert.equal((await beginNative(nativeIdentity, access)).outcome, "rejected");
    }
    assert.equal((await beginNative()).outcome, "dispatch");
    assert.deepEqual((await readAgent()).provider_install_native_access, nativeAccess);
    assert.equal((await beginNative()).outcome, "observe");
    for (const sql of ["update public.hivra_agents set cf_hostname='changed.example.test'",
      `update public.hivra_agents set cf_tunnel_id='${connection}'`, "update public.hivra_agents set cf_tunnel_id=null,cf_hostname=null",
      "update public.hivra_agents set chat_url='https://changed.example.test'",
      "update public.hivra_agents set ip='203.0.113.11'",
      "update public.hivra_agents set chat_url='https://native.example.test',ip='203.0.113.10'",
      "update public.hivra_agents set provider_install_native_access=null",
      "update public.hivra_agents set provider_install_native_access=provider_install_native_access||'{\"hostname\":\"changed.example.test\"}'::jsonb"]) {
      await rejected(() => db.exec(sql));
    }
    // Only the atomic canonical readiness handoff may fill its URL and
    // provider-verified IP, not an arbitrary write during the held operation.
    assert.equal(await recordStopped(nativeReceipt("succeeded", "pending")), true);
    assert.equal(await value("select public.complete_hivra_agent_running('owner',$1,$2,'provision',null,null,null,clock_timestamp()) as result", [agent, op]), false);
    assert.equal(await value("select public.complete_hivra_agent_running('owner',$1,$2,'provision','https://native.example.test','203.0.113.10',null,clock_timestamp()) as result", [agent, op]), false);
    await rejected(() => db.exec("update public.hivra_agents set status='running',operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null"));
    await db.exec("update public.hivra_agents set api_token='native-sentinel'");
    assert.equal(await completeNative(null, null), false);
    assert.equal(await completeNative("203.0.113.10", "https://other.example.test"), false);
    assert.equal(await completeNative("203.0.113.11"), false);
    assert.equal(await completeNative(), true);
    assert.equal((await readAgent()).api_token, null);
    await nativeFixture(false);
    await db.exec("update public.hivra_agents set cf_hostname=null,cf_tunnel_id=null");
    assert.equal(await value("select public.bind_hivra_provider_direct_access('owner',$1,$2,'203.0.113.10') as result", [agent, op]), true);
    const directNative = { mode: "direct-https", hostname: "203-0-113-10.sslip.io", tunnelId: null };
    assert.equal((await beginNative(nativeIdentity, { ...directNative, hostname: "203-0-113-11.sslip.io" })).outcome, "rejected");
    assert.equal((await beginNative(nativeIdentity, directNative)).outcome, "dispatch");
    await rejected(() => db.exec("update public.hivra_agents set ip='203.0.113.11',chat_url='https://203-0-113-11.sslip.io'"));
    await rejected(() => db.query("update public.hivra_agents set cf_hostname='native.example.test',cf_tunnel_id=$1", [other]));
    for (const outcome of ["failed", "cancelled", "succeeded"]) {
      await nativeFixture();
      assert.equal(await nativeGrant(nativeIdentity, "foreign"), null);
      assert.equal(await nativeGrant(nativeIdentity, "owner", other), null);
      assert.equal(await nativeGrant({ ...nativeIdentity, operationId: other }), null);
      await rejected(() => db.exec("update public.hivra_agents set provider_install_stopped_at=clock_timestamp(),provider_install_outcome='succeeded',status='running',operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null"));
      assert.equal(await recordStopped(nativeReceipt(outcome, "pending")), true);
      const original = await readAgent();
      await rejected(() => release()); // Stopped installer alone never releases native authority.
      const grant = await nativeGrant();
      assert.equal(grant.budgetMs, 30000);
      await rejected(() => release()); // A cleanup grant is not a proof.
      const receipt = nativeReceipt(outcome);
      for (const invalid of [null, {}, nativeReceipt(outcome, "pending"), { ...receipt, nativeCleanup: { state: "verified_stopped" } },
        { ...receipt, nativeCleanup: { state: "verified_stopped", bootId: "not-a-uuid" } }, { ...receipt, stopped: false },
        { ...receipt, state: "running" }, { ...receipt, identity: { ...nativeIdentity, operationId: other } },
        { ...receipt, identity: { ...nativeIdentity, nativeCleanup: { ...nativeIdentity.nativeCleanup, profile: "unowned" } } }]) {
        assert.equal(await nativeRecord(grant, invalid), false);
      }
      assert.equal(await nativeRecord(grant, receipt, "foreign"), false);
      assert.equal(await nativeRecord(grant, receipt, "owner", other), false);
      assert.equal(await nativeRecord({ observationId: other }, receipt), false);
      assert.equal(await nativeRecord(grant, receipt), true);
      const observed = await nativeJournal();
      for (const state of ["error", "stopped"]) {
        await rejected(() => db.query("update public.hivra_agents set status=$1", [state]));
      }
      assert.equal((await readAgent()).status, "provisioning"); // Renewal remains reachable.
      assert.equal(await nativeRecord(grant, receipt), true);
      assert.deepEqual(await nativeJournal(), observed); // No timestamp/expiry refresh on lost ack.
      assert.equal(await nativeRecord(grant, nativeReceipt(outcome, "verified_stopped", connection)), false);
      assert.equal((await readAgent()).provider_install_outcome, outcome);
      assert.deepEqual((await readAgent()).provider_install_stopped_at, original.provider_install_stopped_at);
      assert.equal(await release(), true);
      await rejected(() => db.exec("update public.hivra_agents set type='codex'"));
      await rejected(() => db.exec("update public.hivra_agents set status='running'")); // No cached success after cancellation.
      assert.equal(await nativeRecord(grant, receipt), false); // Original operation was released.
    }

    await nativeFixture();
    assert.equal(await recordStopped(nativeReceipt("cancelled", "pending")), true);
    assert.equal(await nativeRecord(await nativeGrant(), nativeReceipt("cancelled", "not_started")), true);
    assert.equal(await release(), true);

    // Both serialization orders: readiness may win before a grant, but once
    // a grant exists (even expired/lost) readiness must never race a stop.
    await nativeFixture();
    assert.equal(await recordStopped(nativeReceipt("succeeded", "pending")), true);
    assert.equal(await completeNative(), true);
    assert.equal(await nativeGrant(), null);
    assert.equal((await readAgent()).status, "running");
    await nativeFixture();
    assert.equal(await recordStopped(nativeReceipt("succeeded", "pending")), true);
    const lostGrant = await nativeGrant();
    assert.equal(await completeNative(), false);
    await expireNativeGrant();
    assert.equal(await completeNative(), false);
    assert.equal(await nativeRecord(lostGrant, nativeReceipt("succeeded")), false);
    assert.equal(await deleteRequest(), "pending");
    await rejected(() => db.exec("update public.hivra_agents set desired_state='running',status='running',operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null"));
    await rejected(() => release());
    const replacementGrant = await nativeGrant();
    assert.notEqual(replacementGrant.observationId, lostGrant.observationId);
    assert.equal(await nativeRecord(lostGrant, nativeReceipt("succeeded")), false);
    assert.equal(await nativeRecord(replacementGrant, nativeReceipt("succeeded")), true);
    const supersedingGrant = await nativeGrant(); // Invalidates even a previously valid proof.
    await rejected(() => release());
    assert.equal(await nativeRecord(replacementGrant, nativeReceipt("succeeded")), false);
    assert.equal(await nativeRecord(supersedingGrant, nativeReceipt("succeeded")), true);
    await expireNativeGrant();
    await rejected(() => release());
    assert.equal(await nativeRecord(supersedingGrant, nativeReceipt("succeeded")), false);
    const finalGrant = await nativeGrant();
    assert.equal(await nativeRecord(finalGrant, nativeReceipt("succeeded")), true);
    assert.equal(await release(), true);
    assert.equal(await deleteRequest(), "claimed");
    assert.equal(await retire({ agent, op: other }), true);
    assert.equal((await cleanup()).outcome, "claimed");
    assert.equal((await observe(allAbsent)).status, "deleted");
    assert.equal(await finish(other), true); // Later whole-VM delete uses its own five-resource proof.

    for (const signature of ["begin_hivra_provider_native_install(text,uuid,uuid,jsonb,jsonb)",
      "begin_hivra_provider_install_bound(text,uuid,uuid,jsonb,jsonb)", "begin_hivra_provider_native_cleanup(text,uuid,uuid,jsonb)",
      "record_hivra_provider_native_cleanup(text,uuid,uuid,uuid,jsonb)",
      "complete_hivra_provider_native_running(text,uuid,uuid,text,text,timestamp with time zone)"]) {
      assert.deepEqual(await value("select jsonb_build_object('anon',has_function_privilege('anon',$1,'execute'),'auth',has_function_privilege('authenticated',$1,'execute'),'service',has_function_privilege('service_role',$1,'execute')) as result", ["public." + signature]), { anon: false, auth: false, service: true });
    }
    await nativeFixture();
    assert.equal(await recordStopped(nativeReceipt("failed", "pending")), true);
    await db.exec("set role service_role");
    try {
      const serviceGrant = await nativeGrant();
      assert.equal(serviceGrant.budgetMs, 30000);
      assert.equal(await nativeRecord(serviceGrant), true);
      assert.equal(await release(), true);
      for (const sql of ["delete from public.hivra_provider_native_cleanup", "truncate public.hivra_provider_native_cleanup",
        "update public.hivra_provider_native_cleanup set receipt=null", "insert into public.hivra_provider_native_cleanup select * from public.hivra_provider_native_cleanup"]) {
        await assert.rejects(() => db.exec(sql), error => error.code === "42501");
      }
    } finally { await db.exec("reset role"); }
    console.log("PASS provider native SQL: exact v2 identity, bidirectional runtime binding, stopped-versus-cleaned fencing, expiring one-observation grants, immutable outcome, cancellation/readiness exclusion, direct writer denial and later selected-computer teardown");

    await require("./provider-native-store-sql-fixture.cjs")({ db, nativeFixture, nativeIdentity, nativeReceipt,
      nativeGrant, nativeJournal, recordStopped, readAgent, release });

    // Provider power shares the original agent lease and its immutable computer
    // binding. A provider ACPI acknowledgement alone is never actual readiness.
    const powerOp = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const bootBefore = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const bootAfter = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const powerAction = (kind, status = "running") => ({ id: 701,
      command: { start: "start_server", stop: "shutdown_server", restart: "reboot_server" }[kind],
      status, resources: [{ id: 42, type: "server" }] });
    async function powerFixture(status = "running") {
      await reset(); await reserve();
      assert.equal((await beginInstall()).outcome, "dispatch");
      assert.equal(await recordStopped({ ...stoppedReceipt, state: "succeeded" }), true);
      assert.equal(await value("select public.complete_hivra_agent_running('owner',$1,$2,'provision','https://fixture.example',null,null,clock_timestamp()) as result", [agent,op]), true);
      if (status === "stopped") await db.exec("update public.hivra_agents set status='stopped',desired_state='stopped'");
    }
    const claimPower = (kind = "restart", user = "owner", operation = powerOp) => value(
      "select public.claim_hivra_provider_power_operation($1,$2,$3,$4) as result", [user,agent,operation,kind]);
    const dispatchPower = (bootId = null, user = "owner", operation = powerOp) => value(
      "select public.begin_hivra_provider_power_dispatch($1,$2,$3,$4) as result", [user,agent,operation,bootId]);
    const recordPower = (action, user = "owner", operation = powerOp) => value(
      "select public.record_hivra_provider_power_action($1,$2,$3,$4) as result", [user,agent,operation,action]);
    const verifyPower = (changes = {}) => {
      const a = { user: "owner", operation: powerOp, at: new Date().toISOString(), status: "running", bootId: bootAfter, runtime: true, public: true, ...changes };
      return value("select public.verify_hivra_provider_power_result($1,$2,$3,$4,$5,$6,$7,$8) as result",
        [a.user,agent,a.operation,a.at,a.status,a.bootId,a.runtime,a.public]);
    };
    const completePower = (desired = "running", status = desired) => value(
      "select public.complete_hivra_agent_operation('owner',$1,$2,$3,$4,null,null) as result", [agent,powerOp,desired,status]);
    const releasePower = (markError = false) => value(
      "select public.release_hivra_agent_operation('owner',$1,$2,'fixture failure',$3) as result", [agent,powerOp,markError]);
    const cancelPower = (user = "owner", operation = powerOp) => value(
      "select public.cancel_hivra_provider_power_before_dispatch($1,$2,$3) as result", [user,agent,operation]);
    const readPower = () => value("select to_jsonb(p) as result from public.hivra_provider_power_operations p where agent_id=$1 and operation_id=$2", [agent,powerOp]);

    await reset(); await reserve();
    assert.equal(await claimPower(), false); // Original installation still owns it.
    await powerFixture();
    for (const kind of [null,"reset","poweroff","resize","delete"]) assert.equal(await claimPower(kind), false);
    assert.equal(await claimPower("start"), false);
    assert.equal(await claimPower("restart", "foreign"), false);
    assert.equal(await claimPower("restart", "owner", null), false);
    assert.equal(await value("select public.claim_hivra_agent_operation('owner',$1,$2,'restart','running',null) as result", [agent,powerOp]), false);
    assert.equal(await claimPower(), true);
    const powerOriginal = await readPower();
    assert.equal(await claimPower(), true); // Idempotent claim cannot renew grant.
    assert.deepEqual(await readPower(), powerOriginal);
    assert.equal(await claimPower("stop"), false);
    assert.equal(await claimPower("restart", "owner", other), false);
    assert.equal((await readAgent()).status, "provisioning");
    assert.equal((await readAgent()).operation_kind, "restart");
    for (const sql of ["delete from public.hivra_provider_power_operations",
      "update public.hivra_provider_power_operations set provider_server_id='43'",
      "update public.hivra_provider_power_operations set user_id='foreign'",
      "update public.hivra_provider_power_operations set operation_kind='stop'",
      "update public.hivra_provider_power_operations set dispatch_not_after=dispatch_not_after+interval '1 hour'",
      "update public.hivra_provider_power_operations set original_status='stopped'",
      "update public.hivra_agents set operation_started_at=clock_timestamp()",
      "update public.hivra_agents set cpu=4",
      "update public.hivra_agents set status='running'",
      "update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null"]) await rejected(() => db.exec(sql));
    await rejected(() => releasePower());
    await rejected(() => completePower());
    assert.equal(await recordPower(powerAction("restart")), false);
    assert.equal(await verifyPower(), false);
    assert.equal(await dispatchPower(), "rejected"); // Reboot needs prior boot identity.
    assert.equal(await dispatchPower(bootBefore, "foreign"), "rejected");
    assert.equal(await dispatchPower(bootBefore, "owner", other), "rejected");
    assert.equal(await dispatchPower(bootBefore), "dispatch");
    const intent = await readPower();
    assert.equal(await dispatchPower(bootAfter), "observe");
    assert.deepEqual(await readPower(), intent); // Lost reply never redispatches.
    assert.equal(await cancelPower(), false);
    for (const sql of ["update public.hivra_provider_power_operations set before_boot_id=null",
      "update public.hivra_provider_power_operations set dispatch_intent_at=null,before_boot_id=null",
      "update public.hivra_provider_power_operations set dispatch_intent_at=clock_timestamp()",
      "update public.hivra_provider_power_operations set cancelled_at=clock_timestamp()"]) await rejected(() => db.exec(sql));
    for (const action of [null, {}, { ...powerAction("restart"), id: "701" }, { ...powerAction("restart"), id: 1.5 },
      { ...powerAction("restart"), id: 9007199254740992 }, { ...powerAction("restart"), command: "reset_server" },
      { ...powerAction("restart"), resources: [] }, { ...powerAction("restart"), resources: [{ id: 43, type: "server" }] },
      { ...powerAction("restart"), resources: [{ id: 42, type: "server", extra: true }] },
      { ...powerAction("restart"), status: "unknown" }, { ...powerAction("restart"), progress: 100 }]) assert.equal(await recordPower(action), false);
    assert.equal(await recordPower(powerAction("restart"), "foreign"), false);
    assert.equal(await recordPower(powerAction("restart"), "owner", other), false);
    assert.equal(await recordPower(powerAction("restart")), true);
    assert.equal(await verifyPower(), false); // Still only a running request.
    await rejected(() => completePower());
    assert.equal(await recordPower({ ...powerAction("restart", "success"), id: 702 }), false);
    assert.equal(await recordPower(powerAction("restart", "success")), true);
    assert.equal(await recordPower(powerAction("restart", "success")), true);
    assert.equal(await recordPower(powerAction("restart")), false);
    assert.equal(await recordPower(powerAction("restart", "error")), false);
    await rejected(() => completePower()); // ACPI acknowledgement is not a reboot.
    for (const changes of [{ user: "foreign" }, { operation: other }, { at: null }, { at: new Date(Date.now()-31000).toISOString() },
      { at: new Date(Date.now()+10000).toISOString() }, { status: null }, { status: "off" }, { bootId: null },
      { bootId: bootBefore }, { runtime: false }, { runtime: null }, { public: false }, { public: null }]) assert.equal(await verifyPower(changes), false);
    assert.equal(await verifyPower(), true);
    assert.equal(await completePower(), true);
    assert.equal((await readAgent()).status, "running");
    assert.equal((await readAgent()).operation_id, null);
    assert.equal((await readPower()).verified_boot_id, bootAfter);
    assert.equal(await claimPower(), false); // Historical operation IDs cannot be reused.
    await rejected(() => db.exec("delete from public.hivra_provider_power_operations"));

    for (const kind of ["start", "stop"]) {
      await powerFixture(kind === "start" ? "stopped" : "running");
      assert.equal(await claimPower(kind), true);
      assert.equal(await dispatchPower(bootBefore), "rejected");
      assert.equal(await dispatchPower(), "dispatch");
      assert.equal(await recordPower(powerAction(kind, "success")), true);
      const desired = kind === "stop" ? "stopped" : "running";
      await rejected(() => completePower(desired));
      if (kind === "stop") {
        assert.equal(await verifyPower(), false); // Actual server must be off.
        assert.equal(await verifyPower({ status: "off", bootId: null }), false);
        assert.equal(await verifyPower({ status: "off", bootId: null, runtime: false, public: false }), true);
      } else {
        assert.equal(await verifyPower({ runtime: false }), false);
        assert.equal(await verifyPower(), true);
      }
      assert.equal(await completePower(desired), true);
      assert.equal((await readAgent()).status, desired);
    }

    for (const deleted of [false, true]) {
      await powerFixture(); assert.equal(await claimPower(), true);
      if (deleted) assert.equal(await deleteRequest(), "pending");
      assert.equal(await cancelPower("foreign"), false);
      assert.equal(await cancelPower("owner", other), false);
      assert.equal(await cancelPower(), true);
      assert.equal((await readAgent()).status, "running");
      assert.equal((await readAgent()).desired_state, deleted ? "deleted" : "running");
      assert.equal((await readAgent()).operation_id, null);
      assert.ok((await readPower()).cancelled_at);
      assert.equal(await dispatchPower(bootBefore), "rejected");
      assert.equal(await claimPower(), false);
    }
    for (const terminal of ["success", "error"]) {
      await powerFixture(); assert.equal(await claimPower(), true);
      assert.equal(await dispatchPower(bootBefore), "dispatch");
      assert.equal(await deleteRequest(), "pending");
      assert.equal((await cleanup()).outcome, "target_in_use");
      assert.equal(await dispatchPower(bootBefore), "observe");
      assert.equal(await cancelPower(), false);
      await rejected(() => releasePower());
      assert.equal(await recordPower(powerAction("restart")), true);
      await rejected(() => releasePower());
      assert.equal(await recordPower(powerAction("restart", terminal)), true);
      assert.equal(await verifyPower(), false); // Deletion wins over readiness.
      assert.equal(await completePower(), false);
      assert.equal(await releasePower(), true);
      assert.equal((await readAgent()).desired_state, "deleted");
      assert.equal(await deleteRequest(), "claimed");
      assert.equal(await retire({ agent, op: other }), true);
      assert.equal((await cleanup()).outcome, "claimed");
      assert.equal((await observe(allAbsent)).status, "deleted");
      assert.equal(await finish(other), true);
      assert.equal((await readPower()).action_receipt.status, terminal);
    }
    await powerFixture(); assert.equal(await claimPower(), true);
    assert.equal(await dispatchPower(bootBefore), "dispatch");
    assert.equal(await recordPower(powerAction("restart", "error")), true);
    assert.equal(await verifyPower(), false);
    assert.equal(await releasePower(true), true);
    assert.equal((await readAgent()).status, "error"); // No false restoration.
    assert.equal((await readAgent()).provider_server_id, "42");

    for (const signature of ["hivra_provider_power_action_valid(jsonb,text,text)", "guard_hivra_provider_power_journal()",
      "guard_hivra_provider_power_lifecycle()", "claim_hivra_provider_power_operation(text,uuid,uuid,text)",
      "begin_hivra_provider_power_dispatch(text,uuid,uuid,uuid)", "record_hivra_provider_power_action(text,uuid,uuid,jsonb)",
      "verify_hivra_provider_power_result(text,uuid,uuid,timestamptz,text,uuid,boolean,boolean)",
      "cancel_hivra_provider_power_before_dispatch(text,uuid,uuid)"]) {
      assert.deepEqual(await value("select jsonb_build_object('anon',has_function_privilege('anon',$1,'execute'),'auth',has_function_privilege('authenticated',$1,'execute'),'service',has_function_privilege('service_role',$1,'execute')) as result",
        ["public."+signature]), { anon: false, auth: false, service: true });
    }
    assert.deepEqual(await value("select jsonb_build_object('anon',has_table_privilege('anon',$1,'select'),'auth',has_table_privilege('authenticated',$1,'select'),'service',has_table_privilege('service_role',$1,'select'),'delete',has_table_privilege('service_role',$1,'delete')) as result",
      ["public.hivra_provider_power_operations"]), { anon: false, auth: false, service: true, delete: false });
    const tablePrivileges = ["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER"];
    if (Number(await value("select current_setting('server_version_num')::int as result")) >= 170000) tablePrivileges.push("MAINTAIN");
    for (const privilege of tablePrivileges) {
      for (const role of ["anon","authenticated","service_role"]) {
        assert.equal(await value("select has_table_privilege($1,'public.hivra_provider_power_operations',$2) as result", [role,privilege]),
          role === "service_role" && ["SELECT","INSERT","UPDATE"].includes(privilege));
      }
    }
    // TRUNCATE bypasses row-delete triggers: test the actual service role, not
    // only the existence of a trigger or its apparent intended grant list.
    await db.exec("set role service_role");
    try {
      assert.equal(await value("select count(*)::int as result from public.hivra_provider_power_operations"),1);
      await assert.rejects(() => db.exec("delete from public.hivra_provider_power_operations"), error => error.code === "42501");
      await assert.rejects(() => db.exec("truncate public.hivra_provider_power_operations"), error => error.code === "42501");
    } finally { await db.exec("reset role"); }
    // Real clock, real guard: do not disable a trigger or rewrite the protected
    // deadline merely to simulate expiry. This one bounded wait is <46 seconds.
    await powerFixture(); assert.equal(await claimPower(), true);
    const expiresIn = Number(await value("select extract(epoch from (dispatch_not_after-clock_timestamp()))*1000 as result from public.hivra_provider_power_operations where agent_id=$1 and operation_id=$2", [agent,powerOp]));
    assert.ok(expiresIn > 0 && expiresIn <= 45000);
    await new Promise(resolve => setTimeout(resolve, Math.ceil(expiresIn)+50));
    assert.equal(await dispatchPower(bootBefore), "rejected");
    assert.equal(await claimPower(), true); // Replay does not reset its deadline.
    assert.equal(await dispatchPower(bootBefore), "rejected");
    assert.equal((await readPower()).dispatch_intent_at, null);
    assert.equal(await cancelPower(), true);
    console.log("PASS provider power SQL: atomic exclusive claim, single dispatch, exact terminal action, actual state and reboot proof, delete races, retained evidence and private grants");

    await reset();
    for (const change of [{ user: "foreign" }, { revision: 8 }, { connection: other }, { target: other }, { order: other }, { attempt: other }, { server: "43" }]) await rejected(() => reserve(change));
    await reserve();
    assert.equal((await readAgent()).provider_server_id, "42");
    assert.equal((await readAgent()).vmid, null);
    assert.equal(await value("select public.record_hetzner_cloud_inventory_failure('owner',$1,7,clock_timestamp(),'provider_unavailable') as result", [connection]), true);
    assert.equal(await value("select status as result from public.infrastructure_connections where id=$1", [connection]), "error");
    assert.equal(await value("select last_error_code as result from public.infrastructure_connections where id=$1", [connection]), "provider_unavailable");
    await rejected(() => db.exec("update public.infrastructure_connections set status='pending'"));
    await db.exec("update public.infrastructure_connections set status='ready',last_error_code=null");
    await rejected(() => reserve({ id: other }));
    for (const sql of ["delete from public.hivra_agents", "update public.hivra_agents set computer_substrate='proxmox-kvm',provider_capacity_order_id=null,provider_enrollment_attempt_id=null,provider_server_id=null",
      "update public.hivra_agents set provider_server_id='43'", "update public.hivra_agents set allocation_operation_id=null",
      "update public.hivra_agents set infrastructure_connection_id=null,deployment_target_id=null,infrastructure_connection_revision=null",
      "update public.hivra_agents set vmid=42", "update public.hivra_agents set status='deleted'",
      "update public.infrastructure_connections set revision=8", "delete from public.infrastructure_connections",
      "update public.infrastructure_connection_secrets set encrypted_bundle='rotated'",
      "update public.infrastructure_first_boot_enrollments set phase='revoked'",
      "delete from public.deployment_targets", "update public.deployment_targets set external_id='43'"]) await rejected(() => db.exec(sql));
    await rejected(() => boot());
    assert.equal((await cleanup()).outcome, "target_in_use");
    assert.equal(await retire(), false);
    assert.equal(await deleteRequest(), "pending");
    assert.equal((await readAgent()).operation_id, op); // Delete never steals installer ownership.
    assert.equal(await retire({ agent, op }), false); // Still an install operation.
    await rejected(() => finish()); // Null VMID is not absence of a provider computer.
    assert.equal((await readAgent()).status, "provisioning");
    assert.equal(await release(), true); // Models worker already stopped, not force-killed.
    assert.equal(await deleteRequest(), "claimed");
    for (const change of [{ user: "foreign" }, { revision: 8 }, { order: other }, { target: other }, { server: "43" }, { agent: other }, { op }]) {
      assert.equal(await retire({ agent, op: other, ...change }), false);
    }
    assert.equal(await retire({ agent, op: other }), true);
    const retired = await value("select provider_retired_at as result from public.deployment_targets where id=$1", [target]);
    assert.equal(await retire({ agent, op: other }), true);
    assert.deepEqual(await value("select provider_retired_at as result from public.deployment_targets where id=$1", [target]), retired);
    await rejected(() => db.exec("update public.deployment_targets set provider_retired_at=null,status='ready',capabilities=jsonb_set(capabilities,'{launchReady}','true')"));
    assert.equal((await cleanup()).outcome, "claimed");
    assert.equal((await cleanup()).outcome, "busy");
    await rejected(() => finish(other));
    assert.equal((await observe({ ...allAbsent, firewall: false })).status, "cleaning");
    await rejected(() => finish(other));
    assert.equal((await readAgent()).provider_capacity_order_id, order);
    assert.equal((await cleanup()).outcome, "claimed");
    assert.equal((await observe(allAbsent)).status, "deleted");
    assert.equal(await finish(other), true);
    const terminal = await readAgent();
    assert.equal(terminal.status, "deleted");
    for (const key of ["infrastructure_connection_id", "deployment_target_id", "infrastructure_connection_revision", "operation_id"]) assert.equal(terminal[key], null);
    assert.equal(terminal.provider_capacity_order_id, order); // Audit identity survives release.
    assert.equal(terminal.provider_server_id, "42");
    await rejected(() => db.exec("update public.hivra_agents set status='running'"));
    await rejected(() => reserve({ id: other }));
    await db.exec("delete from public.deployment_targets");
    assert.equal(await value("select public.delete_infrastructure_connection('owner',$1) as result", [connection]), "deleted");
    assert.equal((await readAgent()).provider_capacity_order_id, order);
    assert.equal(await value("select active_connection_id as result from public.infrastructure_capacity_orders where id=$1", [order]), null);

    // An unused prepared computer retires and cleans up through the same five-
    // resource lifecycle, without inventing an agent row merely to delete it.
    await reset();
    assert.equal(await retire(), true);
    await rejected(() => boot()); // Retirement wins even before an agent exists.
    await rejected(() => reserve());
    assert.equal((await cleanup()).outcome, "claimed");
    assert.equal((await observe(allAbsent)).status, "deleted");
    await db.exec("delete from public.deployment_targets");

    // Preparation wins the other serialization order: reservation must wait.
    await reset();
    assert.equal((await boot()).outcome, "claimed");
    await rejected(() => reserve());
    assert.equal(await retire(), false);

    await reset({ publish: false });
    for (const change of [{ server: "43" }, { user: "foreign" }, { revision: 8 }, { order: null },
      { caps: { ...caps, enrollmentAttemptId: other } }, { caps: { ...caps, hostIdentityDigest: "f".repeat(64) } }]) await rejected(() => publishTarget(change));
    assert.equal((await cleanup()).outcome, "claimed");
    await rejected(() => publishTarget());

    // Existing managed inserts remain compatible, including N-1 operation
    // normalization. Provider reservations cannot adopt their old rows.
    await db.query("insert into public.hivra_agents(id,user_id,type,name) values($1,'owner','codex','Managed')", [other]);
    assert.equal(await value("select computer_substrate as result from public.hivra_agents where id=$1", [other]), "proxmox-kvm");
    assert.equal(await value("select operation_kind as result from public.hivra_agents where id=$1", [other]), "provision");
    await rejected(() => db.query("update public.hivra_agents set computer_substrate='provider-vm',provider_capacity_order_id=$1,provider_enrollment_attempt_id=$2,provider_server_id='42' where id=$3", [order, attempt, other]));

    // Keep the existing bounded rollout's one-capacity-per-owner purchase
    // guard. Multi-computer purchase admission is a separate release gate.
    await reset();
    const secondOrder = "99999999-9999-4999-8999-999999999999";
    await assert.rejects(() => db.query("insert into public.infrastructure_capacity_orders select (jsonb_populate_record(null::public.infrastructure_capacity_orders,to_jsonb(o)||$1::jsonb)).* from public.infrastructure_capacity_orders o where id=$2",
      [{ id: secondOrder, server_name: "hivra-99999999999949998999", idempotency_key: other }, order]),
      error => error.code === "23505" && error.constraint === "infrastructure_capacity_orders_one_capacity_idx");

    // Original owner-host Proxmox lifecycle is still accepted by its unchanged
    // authority guard. Same VM number and provider server number are unrelated.
    await db.query("insert into public.infrastructure_connections(id,user_id,name,provider,operating_mode,setup_mode,status,revision,ssh_host,ssh_port,ssh_user,ssh_host_fingerprint_sha256,config) values($1,'owner','Home','proxmox','self-managed','advanced','ready',1,'203.0.113.20',22,'root',repeat('f',64),'{}')", [other]);
    await db.query("insert into public.deployment_targets(id,user_id,connection_id,evidence_connection_revision,external_id,display_name,status,capacity,capabilities,supported_isolation_drivers,isolation_class) values($1,'owner',$2,1,'pve-home','Home','ready','{}','{\"launchReady\":true}',array['proxmox-kvm'],'hardware-vm')", [op, other]);
    await db.query("insert into public.hivra_agents(id,user_id,type,name,status,deployment_mode,proxmox_host,vmid,infrastructure_connection_id,deployment_target_id,infrastructure_connection_revision,infrastructure_binding_token_enforced) values($1,'owner','codex','Home agent','running','self-managed','__hivra_self_managed_no_ambient_authority__',42,$2,$3,1,true)", [agent, other, op]);
    assert.equal(await value("select public.claim_hivra_agent_operation('owner',$1,$2,'restart','running',null) as result", [agent, capacityKey]), true);
    assert.equal(await value("select public.complete_hivra_agent_operation('owner',$1,$2,'running','running',null,null) as result", [agent, capacityKey]), true);
    const permissions = await value("select jsonb_build_object('anon',has_function_privilege('anon','public.retire_hivra_provider_target(text,uuid,bigint,uuid,uuid,text,uuid,uuid)','execute'),'auth',has_function_privilege('authenticated','public.retire_hivra_provider_target(text,uuid,bigint,uuid,uuid,text,uuid,uuid)','execute'),'service',has_function_privilege('service_role','public.retire_hivra_provider_target(text,uuid,bigint,uuid,uuid,text,uuid,uuid)','execute')) as result");
    assert.deepEqual(permissions, { anon: false, auth: false, service: true });
    console.log("PASS provider computer ownership SQL: exclusive reservation, immutable identity, shared preparation exclusion, delete intent, one-way retirement, five-resource absence, retained tombstones, and managed compatibility");
    await require("./provider-desktop-lifecycle-sql-fixture.cjs")({db,reset,publishTarget,reserve,caps,
      agent,op,other,connection,order,attempt,quote,value,readAgent,rejected});
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
