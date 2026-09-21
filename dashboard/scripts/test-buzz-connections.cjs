// Real PostgreSQL/WASM contract test for the Buzz identity journal. Synthetic
// ciphertext only; no network, environment loading, cloud resources or live DB.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { PGlite } = require("@electric-sql/pglite");

async function main() {
  const db = new PGlite();
  let checks = 0;
  const eq = (actual, expected) => { assert.deepEqual(actual, expected); checks += 1; };
  const value = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.result;
  const blocked = async (action) => {
    await assert.rejects(action, (error) => ["22023", "42501", "55006", "23505", "23514"].includes(error.code));
    checks += 1;
  };
  try {
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create table public.hivra_agents(
        id uuid primary key,user_id text not null,status text not null,desired_state text not null,
        ip text,computer_substrate text,operation_id uuid,operation_kind text,vmid integer,
        infrastructure_binding_token_enforced boolean,infrastructure_binding_token_hash text
      );
      create table public.hivra_agent_snapshots(
        id uuid primary key,user_id text not null,agent_id uuid not null,status text not null default 'creating'
      );
    `);
    const migration = fs.readFileSync(path.resolve(
      __dirname,
      "../supabase/migrations/20260901000000_hivra_buzz_connections.sql",
    ), "utf8");
    await db.exec(migration);
    const runtimeMigration = fs.readFileSync(path.resolve(
      __dirname,
      "../supabase/migrations/20260901010000_hivra_buzz_runtime.sql",
    ), "utf8");
    await db.exec(runtimeMigration);
    const veniceRuntimeMigration = fs.readFileSync(path.resolve(
      __dirname,
      "../supabase/migrations/20260902010000_hivra_buzz_venice_runtime.sql",
    ), "utf8");
    await db.exec(veniceRuntimeMigration);
    const sprigPinMigration = fs.readFileSync(path.resolve(
      __dirname,
      "../supabase/migrations/20260902020000_hivra_buzz_sprig_pin.sql",
    ), "utf8");
    await db.exec(sprigPinMigration);

    const owner = "owner";
    const connectionId = randomUUID();
    const firstAgent = randomUUID();
    const secondAgent = randomUUID();
    const thirdAgent = randomUUID();
    const relayKey = "a".repeat(64);
    const nextRelayKey = "b".repeat(64);
    const relayUrl = "wss://relay.example.com";
    const httpOrigin = "https://relay.example.com";
    await db.query("insert into public.hivra_agents(id,user_id,status,desired_state,ip,computer_substrate,vmid,infrastructure_binding_token_enforced,infrastructure_binding_token_hash) values($1,$4,'running','running','10.241.30.40','proxmox-kvm',101,true,$5),($2,$4,'stopped','stopped',null,'proxmox-kvm',102,true,$5),($3,$4,'provisioning','running',null,'proxmox-kvm',103,true,$5)", [firstAgent, secondAgent, thirdAgent, owner, "9".repeat(64)]);

    const upsert = (key = relayKey, user = owner) => value(
      "select public.upsert_hivra_buzz_connection($1,$2,$3,$4,$5,'Fixture Buzz','https://github.com/block/buzz','0.5.20',true) as result",
      [user, connectionId, relayUrl, httpOrigin, key],
    );
    await db.exec("set role service_role");
    eq(await upsert(), connectionId);
    eq(await upsert(), connectionId);
    await db.exec("begin");
    const ipv6Connection = randomUUID();
    eq(await value(
      "select public.upsert_hivra_buzz_connection($1,$2,'wss://[2606:4700:4700::1111]:8443','https://[2606:4700:4700::1111]:8443',$3,'IPv6 Buzz','https://github.com/block/buzz','0.5.20',true) as result",
      [owner, ipv6Connection, "c".repeat(64)],
    ), ipv6Connection);
    await db.exec("rollback");

    const bind = (agentId, publicKey, operationId = randomUUID(), bindingId = randomUUID(), user = owner) => ({
      bindingId,
      operationId,
      run: () => value(
        "select public.admit_hivra_buzz_binding($1,$2,$3,$4,$5,$6,$7,$8,$9) as result",
        [user, bindingId, connectionId, agentId, operationId, "d".repeat(64), publicKey, "sealed-private", "sealed-invite"],
      ),
    });
    const first = bind(firstAgent, "1".repeat(64));
    eq(await first.run(), { status: "claim_pending", bindingId: first.bindingId });
    eq(await first.run(), { status: "claim_pending", bindingId: first.bindingId });
    const duplicate = bind(firstAgent, "2".repeat(64));
    eq(await duplicate.run(), { status: "already_bound", bindingId: first.bindingId });
    const conflict = bind(secondAgent, "3".repeat(64), first.operationId);
    eq(await conflict.run(), { status: "operation_conflict" });
    eq((await bind(randomUUID(), "4".repeat(64)).run()).status, "agent_not_found");
    eq((await bind(firstAgent, relayKey).run()).status, "invalid_request");

    const claim = (bindingId, user = owner) => value(
      "select public.claim_hivra_buzz_membership($1,$2) as result",
      [user, bindingId],
    );
    const firstLease = await claim(first.bindingId);
    assert.match(firstLease.lease_id, /^[a-f0-9-]{36}$/); checks += 1;
    eq(firstLease.encrypted_private_key, "sealed-private");
    eq(firstLease.encrypted_invite_code, "sealed-invite");
    eq(await claim(first.bindingId), null);
    eq(await claim(first.bindingId, "foreign"), null);

    const receipt = {
      protocol: "hivra-buzz-claim-v1",
      connectionId,
      connectionRevision: 1,
      relayPublicKey: relayKey,
      relayUrl,
      publicKey: "1".repeat(64),
      status: "joined",
      communityId: "018f6d3c-1d91-7c65-9d86-37fc915b8377",
      host: "relay.example.com",
      role: "member",
      rosterEventId: "e".repeat(64),
      rosterCreatedAt: 100,
      rosterMember: true,
    };
    const settle = (leaseId, candidate = receipt, user = owner) => value(
      "select public.settle_hivra_buzz_membership($1,$2,$3,$4) as result",
      [user, first.bindingId, leaseId, candidate],
    );
    eq(await settle(firstLease.lease_id, {}), false);
    for (const key of Object.keys(receipt)) {
      const missing = { ...receipt };
      delete missing[key];
      eq(await settle(firstLease.lease_id, missing), false);
      eq(await settle(firstLease.lease_id, { ...receipt, [key]: null }), false);
      const wrongType = typeof receipt[key] === "string" ? 7
        : typeof receipt[key] === "number" ? "100" : "true";
      eq(await settle(firstLease.lease_id, { ...receipt, [key]: wrongType }), false);
    }
    eq(await settle(firstLease.lease_id, { ...receipt, extra: true }), false);
    eq(await settle(firstLease.lease_id, { ...receipt, publicKey: "9".repeat(64) }), false);
    eq(await settle(randomUUID()), false);
    eq(await settle(firstLease.lease_id, receipt, "foreign"), false);
    eq(await settle(firstLease.lease_id), true);
    eq(await settle(firstLease.lease_id), true);
    const joined = await value("select to_jsonb(b) as result from public.hivra_buzz_agent_bindings b where id=$1", [first.bindingId]);
    eq(joined.status, "joined");
    eq(joined.encrypted_invite_code, null);
    eq(joined.encrypted_private_key, "sealed-private");
    eq(joined.claim_receipt, receipt);
    await blocked(() => upsert(nextRelayKey));

    const second = bind(secondAgent, "2".repeat(64));
    eq((await second.run()).status, "claim_pending");
    const secondLease = await claim(second.bindingId);
    const secondReceipt = { ...receipt, publicKey: "2".repeat(64), status: "already_member" };
    eq(await value("select public.settle_hivra_buzz_membership($1,$2,$3,$4) as result", [owner, second.bindingId, secondLease.lease_id, secondReceipt]), true);
    const liveKeys = (await db.query("select public_key from public.hivra_buzz_agent_bindings where status='joined' order by public_key")).rows;
    eq(liveKeys, [{ public_key: "1".repeat(64) }, { public_key: "2".repeat(64) }]);
    const healthReceipt = {
      protocol: "hivra-buzz-health-v1",
      connectionId,
      connectionRevision: 1,
      relayPublicKey: relayKey,
      relayUrl,
      publicKey: "1".repeat(64),
      status: "member",
      rosterEventId: "8".repeat(64),
      rosterCreatedAt: 100,
      rosterMember: true,
    };
    eq(await value("select public.confirm_hivra_buzz_health($1,$2,$3) as result", [owner, first.bindingId, {}]), false);
    eq(await value("select public.confirm_hivra_buzz_health($1,$2,$3) as result", [owner, first.bindingId, { ...healthReceipt, relayPublicKey: nextRelayKey }]), false);
    eq(await value("select public.confirm_hivra_buzz_health($1,$2,$3) as result", [owner, first.bindingId, healthReceipt]), true);
    eq((await value("select to_jsonb(b) as result from public.hivra_buzz_agent_bindings b where id=$1", [first.bindingId])).health_receipt, healthReceipt);

    const runtimeOperation = randomUUID();
    const runtimeOwner = "7".repeat(64);
    const beginRuntime = (operationId = runtimeOperation, digest = "6".repeat(64), user = owner) => value(
      "select public.begin_hivra_buzz_runtime_install($1,$2,$3,$4,'openai','gpt-5',$5,'sealed-provider-key') as result",
      [user, first.bindingId, operationId, digest, runtimeOwner],
    );
    await db.exec("reset role");
    await db.query("update public.hivra_agents set operation_id=$2,operation_kind='snapshot' where id=$1", [firstAgent, randomUUID()]);
    await db.exec("set role service_role");
    eq((await beginRuntime()).status, "agent_not_ready");
    await db.exec("reset role");
    await db.query("update public.hivra_agents set operation_id=null,operation_kind=null where id=$1", [firstAgent]);
    await db.exec("set role service_role");
    const veniceOperation = randomUUID();
    eq(await value(
      "select public.begin_hivra_buzz_runtime_install($1,$2,$3,$4,'venice','qwen3-4b',$5,'sealed-venice-key') as result",
      [owner, first.bindingId, veniceOperation, "3".repeat(64), runtimeOwner],
    ), { status: "install_pending", bindingId: first.bindingId });
    const veniceLease = await value("select public.claim_hivra_buzz_runtime_install($1,$2) as result", [owner, first.bindingId]);
    eq(veniceLease.runtime_provider, "venice");
    eq(await value("select public.settle_hivra_buzz_runtime_remove($1,$2,$3,$4) as result", [owner, first.bindingId, randomUUID(), {}]), false);
    await db.exec("reset role");
    await db.query("update public.hivra_buzz_agent_bindings set runtime_status='not_installed',runtime_operation_id=null,runtime_request_digest=null,runtime_provider=null,runtime_model=null,runtime_owner_public_key=null,encrypted_runtime_api_key=null,runtime_lease_id=null,runtime_lease_expires_at=null where id=$1", [first.bindingId]);
    await db.exec("set role service_role");
    eq(await beginRuntime(), { status: "install_pending", bindingId: first.bindingId });
    eq(await beginRuntime(), { status: "install_pending", bindingId: first.bindingId });
    eq((await beginRuntime(runtimeOperation, "5".repeat(64))).status, "operation_conflict");
    eq((await beginRuntime(randomUUID(), "5".repeat(64), "foreign")).status, "not_found");
    const runtimeLease = await value(
      "select public.claim_hivra_buzz_runtime_install($1,$2) as result",
      [owner, first.bindingId],
    );
    eq(runtimeLease.encrypted_runtime_api_key, "sealed-provider-key");
    eq(await value("select public.claim_hivra_buzz_runtime_install($1,$2) as result", [owner, first.bindingId]), null);
    const runtimeReceipt = {
      protocol: "hivra-buzz-runtime-v1",
      action: "installed",
      bindingId: first.bindingId,
      agentId: firstAgent,
      publicKey: "1".repeat(64),
      serviceName: `hivra-buzz-${first.bindingId}.service`,
      sourceGitSha: "1c8321cd08feb597f8bcff5195c21148fb3e98ed",
      observedAt: "2026-09-01T12:00:00Z",
      state: "active",
      architecture: "x86_64",
      archiveSha256: "2f73c2bf2ad69aa515f7821d73666583bff300099c638145a3f77bc0dcf2d916",
      binarySha256: "0e1062f1ae58c92f312f4445df3291c0269e0fa8a08f452bf5bfa95dd3611356",
      provider: "openai",
      model: "gpt-5",
      ownerPublicKey: runtimeOwner,
      operationId: runtimeOperation,
      requestDigest: "6".repeat(64),
      leaseId: runtimeLease.runtime_lease_id,
      mainPid: 42,
    };
    const settleRuntime = (candidate) => value(
      "select public.settle_hivra_buzz_runtime_install($1,$2,$3,$4) as result",
      [owner, first.bindingId, runtimeLease.runtime_lease_id, candidate],
    );
    eq(await settleRuntime({ ...runtimeReceipt, sourceGitSha: "0".repeat(40) }), false);
    eq(await settleRuntime({ ...runtimeReceipt, binarySha256: "0".repeat(64) }), false);
    eq(await settleRuntime({ ...runtimeReceipt, operationId: randomUUID() }), false);
    eq(await settleRuntime({ ...runtimeReceipt, requestDigest: "0".repeat(64) }), false);
    eq(await settleRuntime({ ...runtimeReceipt, leaseId: randomUUID() }), false);
    eq(await settleRuntime({ ...runtimeReceipt, extra: true }), false);
    eq(await settleRuntime(runtimeReceipt), true);
    eq(await settleRuntime(runtimeReceipt), true);
    const activeRuntime = await value("select to_jsonb(b) as result from public.hivra_buzz_agent_bindings b where id=$1", [first.bindingId]);
    eq(activeRuntime.runtime_status, "active");
    eq(activeRuntime.encrypted_runtime_api_key, null);
    eq(activeRuntime.runtime_install_receipt, runtimeReceipt);
    const runtimeHealthReceipt = {
      protocol: "hivra-buzz-runtime-v1",
      action: "observed",
      bindingId: first.bindingId,
      agentId: firstAgent,
      publicKey: "1".repeat(64),
      serviceName: `hivra-buzz-${first.bindingId}.service`,
      sourceGitSha: "1c8321cd08feb597f8bcff5195c21148fb3e98ed",
      observedAt: "2026-09-01T12:01:00Z",
      state: "active",
      architecture: "x86_64",
      binarySha256: "0e1062f1ae58c92f312f4445df3291c0269e0fa8a08f452bf5bfa95dd3611356",
      mainPid: 43,
    };
    eq(await value("select public.confirm_hivra_buzz_runtime_health($1,$2,$3) as result", [owner, first.bindingId, { ...runtimeHealthReceipt, binarySha256: "0".repeat(64) }]), false);
    eq(await value("select public.confirm_hivra_buzz_runtime_health($1,$2,$3) as result", [owner, first.bindingId, runtimeHealthReceipt]), true);
    const runtimeRemoveLease = await value("select public.claim_hivra_buzz_runtime_remove($1,$2) as result", [owner, first.bindingId]);
    const runtimeRemoveReceipt = {
      protocol: "hivra-buzz-runtime-v1",
      action: "removed",
      bindingId: first.bindingId,
      agentId: firstAgent,
      publicKey: "1".repeat(64),
      serviceName: `hivra-buzz-${first.bindingId}.service`,
      sourceGitSha: "1c8321cd08feb597f8bcff5195c21148fb3e98ed",
      observedAt: "2026-09-01T12:02:00Z",
      state: "absent",
      operationId: runtimeOperation,
      requestDigest: "6".repeat(64),
      leaseId: runtimeRemoveLease.runtime_lease_id,
    };
    eq(await value("select public.settle_hivra_buzz_runtime_remove($1,$2,$3,$4) as result", [owner, first.bindingId, runtimeRemoveLease.runtime_lease_id, { ...runtimeRemoveReceipt, leaseId: randomUUID() }]), false);
    eq(await value("select public.settle_hivra_buzz_runtime_remove($1,$2,$3,$4) as result", [owner, first.bindingId, runtimeRemoveLease.runtime_lease_id, { ...runtimeRemoveReceipt, extra: true }]), false);
    eq(await value("select public.settle_hivra_buzz_runtime_remove($1,$2,$3,$4) as result", [owner, first.bindingId, runtimeRemoveLease.runtime_lease_id, runtimeRemoveReceipt]), true);
    eq((await value("select to_jsonb(b) as result from public.hivra_buzz_agent_bindings b where id=$1", [first.bindingId])).runtime_status, "removed");

    const deleteBoundaryOperation = randomUUID();
    const safeSnapshot = randomUUID();
    await db.exec("reset role");
    await db.query("insert into public.hivra_agent_snapshots(id,user_id,agent_id,status) values($1,$2,$3,'ready')", [safeSnapshot, owner, firstAgent]);
    await db.exec("set role service_role");
    const nextRuntimeOperation = randomUUID();
    const nextRuntimeDigest = "4".repeat(64);
    eq((await beginRuntime(nextRuntimeOperation, nextRuntimeDigest)).status, "install_pending");
    const deleteBoundaryLease = await value("select public.claim_hivra_buzz_runtime_install($1,$2) as result", [owner, first.bindingId]);
    eq(await value("select public.settle_hivra_buzz_runtime_install($1,$2,$3,$4) as result", [owner, first.bindingId, deleteBoundaryLease.runtime_lease_id, runtimeReceipt]), false);
    const nextRuntimeReceipt = { ...runtimeReceipt, operationId: nextRuntimeOperation,
      requestDigest: nextRuntimeDigest, leaseId: deleteBoundaryLease.runtime_lease_id };
    eq(await value("select public.settle_hivra_buzz_runtime_install($1,$2,$3,$4) as result", [owner, first.bindingId, deleteBoundaryLease.runtime_lease_id, nextRuntimeReceipt]), true);
    await db.exec("reset role");
    await blocked(() => db.query("insert into public.hivra_agent_snapshots(id,user_id,agent_id,status) values($1,$2,$3,'creating')", [randomUUID(), owner, firstAgent]));
    await blocked(() => db.query("update public.hivra_agent_snapshots set status='restoring' where id=$1", [safeSnapshot]));
    await db.query("update public.hivra_agents set operation_id=$2,vmid=101 where id=$1", [firstAgent, deleteBoundaryOperation]);
    await db.query("update public.hivra_agents set status='deleted',desired_state='deleted',operation_id=null,vmid=null where id=$1", [firstAgent]);
    await db.exec("set role service_role");
    const retiredByDelete = await value("select to_jsonb(b) as result from public.hivra_buzz_agent_bindings b where id=$1", [first.bindingId]);
    eq(retiredByDelete.runtime_status, "removed");
    eq(retiredByDelete.encrypted_runtime_api_key, null);
    eq(retiredByDelete.runtime_remove_receipt.protocol, "hivra-buzz-runtime-agent-delete-v1");
    eq(retiredByDelete.runtime_remove_receipt.agentOperationId, deleteBoundaryOperation);
    eq(retiredByDelete.runtime_remove_receipt.vmid, 101);

    const third = bind(thirdAgent, "3".repeat(64));
    eq((await third.run()).status, "claim_pending");
    const thirdLease = await claim(third.bindingId);
    eq(await value("select public.abandon_hivra_buzz_membership($1,$2,$3,'invalid_invite') as result", [owner, third.bindingId, thirdLease.lease_id]), true);
    const abandoned = await value("select to_jsonb(b) as result from public.hivra_buzz_agent_bindings b where id=$1", [third.bindingId]);
    eq(abandoned.status, "revoked");
    eq(abandoned.encrypted_private_key, null);
    eq(abandoned.encrypted_invite_code, null);

    const leaveLease = await value("select public.claim_hivra_buzz_leave($1,$2) as result", [owner, first.bindingId]);
    eq(leaveLease.status, "leave_pending");
    const leaveReceipt = {
      protocol: "hivra-buzz-leave-v1",
      connectionId,
      connectionRevision: 1,
      relayPublicKey: relayKey,
      relayUrl,
      publicKey: "1".repeat(64),
      status: "left",
      eventId: null,
      rosterEventId: "f".repeat(64),
      // Nostr timestamps have one-second resolution. A different signed event
      // at the claim second is fresh evidence even when created_at is equal.
      rosterCreatedAt: 100,
      rosterMember: false,
      observerPublicKey: "2".repeat(64),
    };
    eq(await value("select public.settle_hivra_buzz_leave($1,$2,$3,$4) as result", [owner, first.bindingId, leaveLease.lease_id, {}]), false);
    for (const key of Object.keys(leaveReceipt)) {
      const missing = { ...leaveReceipt };
      delete missing[key];
      eq(await value("select public.settle_hivra_buzz_leave($1,$2,$3,$4) as result", [owner, first.bindingId, leaveLease.lease_id, missing]), false);
      if (key !== "eventId") {
        eq(await value("select public.settle_hivra_buzz_leave($1,$2,$3,$4) as result", [owner, first.bindingId, leaveLease.lease_id, { ...leaveReceipt, [key]: null }]), false);
      }
      const wrongType = key === "eventId" ? 7
        : typeof leaveReceipt[key] === "string" ? 7
          : typeof leaveReceipt[key] === "number" ? "101" : "false";
      eq(await value("select public.settle_hivra_buzz_leave($1,$2,$3,$4) as result", [owner, first.bindingId, leaveLease.lease_id, { ...leaveReceipt, [key]: wrongType }]), false);
    }
    eq(await value("select public.settle_hivra_buzz_leave($1,$2,$3,$4) as result", [owner, first.bindingId, leaveLease.lease_id, { ...leaveReceipt, extra: true }]), false);
    eq(await value("select public.settle_hivra_buzz_leave($1,$2,$3,$4) as result", [owner, first.bindingId, leaveLease.lease_id, { ...leaveReceipt, relayPublicKey: nextRelayKey }]), false);
    eq(await value("select public.settle_hivra_buzz_leave($1,$2,$3,$4) as result", [owner, first.bindingId, leaveLease.lease_id, { ...leaveReceipt, rosterEventId: receipt.rosterEventId }]), false);
    eq(await value("select public.settle_hivra_buzz_leave($1,$2,$3,$4) as result", [owner, first.bindingId, leaveLease.lease_id, { ...leaveReceipt, rosterCreatedAt: 99 }]), false);
    eq(await value("select public.settle_hivra_buzz_leave($1,$2,$3,$4) as result", [owner, first.bindingId, leaveLease.lease_id, leaveReceipt]), true);
    eq(await value("select public.settle_hivra_buzz_leave($1,$2,$3,$4) as result", [owner, first.bindingId, leaveLease.lease_id, leaveReceipt]), true);
    const revoked = await value("select to_jsonb(b) as result from public.hivra_buzz_agent_bindings b where id=$1", [first.bindingId]);
    eq(revoked.status, "revoked");
    eq(revoked.encrypted_private_key, null);
    eq(revoked.lease_id, null);
    eq(revoked.leave_receipt, leaveReceipt);
    eq(await value("select public.settle_hivra_buzz_leave($1,$2,$3,$4) as result", [owner, first.bindingId, leaveLease.lease_id, {}]), false);

    // The remaining joined observer prevents relay-key or membership-posture
    // changes. Last-identity cleanup deliberately needs external operator
    // evidence rather than fabricating a local absence receipt.
    await blocked(() => upsert(nextRelayKey));
    eq((await value("select to_jsonb(b) as result from public.hivra_buzz_agent_bindings b where id=$1", [first.bindingId])).relay_public_key, relayKey);
    await blocked(() => value(
      "select public.upsert_hivra_buzz_connection($1,$2,$3,$4,$5,'Fixture Buzz','https://github.com/block/buzz','0.5.20',false) as result",
      [owner, connectionId, relayUrl, httpOrigin, relayKey],
    ));

    // The service-role API can read public metadata but cannot bypass the
    // journal with direct table mutations.
    eq(Number(await value("select count(*)::int as result from public.hivra_buzz_connections")), 1);
    await blocked(() => db.exec("update public.hivra_buzz_agent_bindings set encrypted_private_key=null"));
    await blocked(() => db.exec("delete from public.hivra_buzz_agent_bindings"));
    await blocked(() => db.exec("insert into public.hivra_buzz_connections(id,user_id,relay_url,http_origin,relay_public_key,display_name,requires_membership) values(gen_random_uuid(),'owner','wss://other.example.com','https://other.example.com','" + "f".repeat(64) + "','Other',true)"));

    await db.exec("reset role; set role anon");
    await blocked(() => db.exec("select * from public.hivra_buzz_connections"));
    await blocked(() => db.query("select public.claim_hivra_buzz_membership('owner',$1)", [second.bindingId]));
    await db.exec("reset role");

    console.log(`PASS Buzz connection journal: ${checks} ownership, identity, lease, receipt, snapshot, deletion and privilege checks`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
