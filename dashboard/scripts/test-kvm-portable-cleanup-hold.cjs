const assert = require("node:assert/strict");
const { openMigratedDatabase } = require("./lib/pglite-all-migrations.cjs");

const migration = "20261128081500_kvm_portable_cleanup_hold.sql";
const schema = "hivra_kvm_portable_private";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [agent, abortOperation, retireOperation, allocation, unrelatedAgent, staleReceipt, bootId, connectorId] =
  [1, 2, 3, 4, 5, 6, 7, 8].map(uuid);
const owner = "user_CleanupFixture";
const hash = "a".repeat(64);
const bindingTag = `hivra-bind-${hash.slice(0, 32)}`;
const source = { hostId: "fixture-source", vmid: 9310, ip: "192.0.2.42", bindingTag };
const destination = { ...source, hostId: "fixture-destination", vmid: 9311 };
const abortEvidence = {
  source, destination, portableWorkQuiesced: true, destinationVmAbsent: true, destinationStorageAbsent: true,
  sourceDiskUnchanged: true, sourceStopped: true, sourceConnectorOff: true, sourceLegacyColdMarkerRestored: true,
};
const retireEvidence = { source, destination, sourceVmAbsent: true, sourceConnectorAbsent: true, destinationHealthy: true };

async function main() {
  const db = await openMigratedDatabase({
    through: migration,
    setup: "alter default privileges in schema public grant execute on functions to anon, authenticated, service_role",
  });
  try {
    const row = async (sql, args = []) => (await db.query(sql, args)).rows[0];
    const rpc = async (name, ...args) => (await row(
      `select ${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as result`, args,
    )).result;
    const pub = (name, ...args) => rpc(`public.${name}`, ...args);
    const begin = (operation, generation) => pub("begin_hivra_kvm_portable_handoff", owner, agent, operation,
      generation, source, destination, new Date(Date.now() + 3600_000).toISOString());
    const journal = () => pub("read_hivra_kvm_portable_handoff", owner, agent);
    const selector = () => pub("read_hivra_kvm_portable_pilot", owner, agent);
    const available = () => db.query(`select host_id,free_cpu,free_ram_mb,free_disk_gb
      from public.holder_admission_host_availability(array[$1,$2],null,false,'{}',null) order by host_id`,
    [source.hostId, destination.hostId]).then((result) => result.rows);
    const arm = () => db.exec(`update ${schema}.pilot_enrollment
      set runtime_profile='{}',runtime_expires_at=enrolled_at+interval '1 hour'`);
    const disarm = () => db.exec(`update ${schema}.pilot_enrollment set runtime_profile=null,runtime_expires_at=null`);
    const claim = (args) => rpc(`${schema}.claim_cleanup`, ...args);
    const read = (receipt, args) => rpc(`${schema}.read_cleanup`, receipt, ...args);
    const finish = (receipt, args, evidence) => rpc(`${schema}.finish_cleanup`, receipt, ...args, evidence);
    const publicAbort = () => pub("abort_hivra_kvm_portable_handoff", owner, agent, abortOperation, 9, abortEvidence);
    const publicRetire = () => pub("finish_hivra_kvm_portable_retirement", owner, agent, retireOperation, 11, retireEvidence);
    const abort = ["abort", owner, agent, abortOperation, 9, allocation, hash, "checkpointing", source, destination];
    const retire = ["retire", owner, agent, retireOperation, 11, allocation, hash, "finished", destination, source];

    await db.query(`insert into public.proxmox_hosts (id,env_prefix,total_cpu,total_ram_mb,thinpool_size_gb)
      values ($1,'FIXTURE_SOURCE',16,65536,256),($2,'FIXTURE_DESTINATION',16,65536,256)`,
    [source.hostId, destination.hostId]);
    await db.query(`insert into public.hivra_agents
      (id,user_id,type,name,status,desired_state,deployment_mode,computer_substrate,seat_funding,cpu,ram,
        proxmox_host,vmid,ip,cf_hostname,cf_tunnel_id,chat_url,allocation_operation_id,
        sleep_policy,sleep_state,sleep_generation,sleep_tier_changed_at,sleep_memory_dropped_at,
        infrastructure_binding_token_enforced,infrastructure_binding_token_hash)
      values ($1,$2,'claude-code','Fixture','running','running','hivra-managed','proxmox-kvm','paid',4,8,
        $3,$4,$5,'cleanup.fixture.invalid','opaque-fixture-tunnel','https://cleanup.fixture.invalid',$6,
        'full','hibernated',8,now()-interval '2 minutes',now(),true,$7)`,
    [agent, owner, source.hostId, source.vmid, source.ip, allocation, hash]);
    await db.query(`insert into public.hivra_agents
      (id,user_id,type,name,status,desired_state,deployment_mode,computer_substrate,seat_funding,cpu,ram)
      values ($1,'user_OtherCleanupFixture','claude-code','Other fixture','running','running',
        'hivra-managed','proxmox-kvm','paid',2,4)`, [unrelatedAgent]);
    assert.equal(await rpc(`${schema}.enroll_pilot`, owner, agent, source, destination, {
      placementA: source, placementB: destination, placementAReservedForBinding: true, placementBReservedForBinding: true,
    }), true);
    await arm();
    assert.ok(await selector());
    assert.equal((await begin(abortOperation, 8)).phase, "checkpointing");
    assert.equal(await claim(abort), null, "an armed runtime cannot claim cleanup");
    await disarm();
    assert.equal(await selector(), null);
    await arm();
    await disarm();
    await db.exec("begin isolation level repeatable read");
    await assert.rejects(arm(), { code: "25001" });
    await db.exec("rollback");
    const scopeCompetingWriter = () => rpc("canary_qa_writer_private.set_scope", owner, source.hostId, source.vmid, null, null);
    await db.exec("begin");
    await scopeCompetingWriter();
    assert.equal(await claim(abort), null);
    await db.exec("rollback");

    for (const role of ["anon", "authenticated", "service_role"]) {
      await db.exec(`set role ${role}`);
      for (const call of [() => claim(abort), () => read(staleReceipt, abort), () => finish(staleReceipt, abort, abortEvidence)]) {
        await assert.rejects(call(), { code: "42501" });
      }
      await assert.rejects(db.exec(`select * from ${schema}.cleanup_hold`), { code: "42501" });
      await db.exec("reset role");
    }

    const capacityBeforeAbort = await available();
    for (const [index, wrong] of [[0, "retire"], [1, "wrong_owner"], [2, unrelatedAgent], [3, retireOperation],
      [4, 8], [5, staleReceipt], [6, hash.slice(0, 32) + "b".repeat(32)], [7, "storage_verified"],
      [8, destination], [9, { ...destination, vmid: 9312 }]]) {
      const stale = abort.with(index, wrong);
      assert.equal(await claim(stale), null);
    }
    assert.equal(await read(staleReceipt, abort), null, "pre-dispatch read cannot create a hold");
    assert.equal(await finish(staleReceipt, abort, abortEvidence), null, "finish requires a claim");
    const abortReceipt = await claim(abort);
    assert.deepEqual(abortReceipt, {
      receiptId: abortReceipt.receiptId, action: "abort", ownerId: owner, agentId: agent, operationId: abortOperation,
      generation: 9, allocationOperationId: allocation, bindingTag, phase: "checkpointing",
      authoritative: source, cleanupTarget: destination, checkpointSha256: null, reservationSha256: null, bootId: null, connectorId: null,
    });
    assert.match(abortReceipt.receiptId, /^[a-f0-9-]{36}$/);
    assert.deepEqual(await claim(abort), abortReceipt);
    assert.deepEqual(await read(abortReceipt.receiptId, abort), abortReceipt);
    await db.exec("begin");
    await scopeCompetingWriter();
    assert.equal(await read(abortReceipt.receiptId, abort), null);
    assert.equal(await finish(abortReceipt.receiptId, abort, abortEvidence), null);
    await db.exec("rollback");
    assert.equal(await read(abortReceipt.receiptId, abort.with(8, destination)), null);
    assert.equal(await read(staleReceipt, abort), null);
    assert.equal((await journal()).phase, "checkpointing");
    assert.deepEqual(await available(), capacityBeforeAbort);
    await assert.rejects(arm(), { code: "55000" });
    await assert.rejects(db.query(`update ${schema}.handoff set expires_at=now() where operation_id=$1`,
      [abortOperation]), { code: "55000" });
    await assert.rejects(db.query(`delete from ${schema}.handoff where operation_id=$1`, [abortOperation]), { code: "55000" });
    await assert.rejects(pub("request_hivra_kvm_portable_wake", owner, agent, abortOperation, 9), { code: "55000" });
    await assert.rejects(db.query("update public.hivra_agents set name='changed' where id=$1", [agent]), { code: "55000" });
    await assert.rejects(db.query("delete from public.hivra_agents where id=$1", [agent]), { code: "55000" });
    await db.query("update public.hivra_agents set name='unrelated remains writable' where id=$1", [unrelatedAgent]);
    await db.exec("set role service_role");
    await assert.rejects(publicAbort(), { code: "55000" });
    await db.exec("reset role");
    assert.equal(await finish(abortReceipt.receiptId, abort, { ...abortEvidence, destinationStorageAbsent: false }), null);
    assert.deepEqual(await read(abortReceipt.receiptId, abort), abortReceipt, "bad evidence must roll back hold release");
    await db.query("update public.proxmox_hosts set env_prefix='WRONG_PIN' where id=$1", [destination.hostId]);
    assert.equal(await read(abortReceipt.receiptId, abort), null, "registry repoint invalidates pre-dispatch read");
    assert.equal(await claim(abort), null);
    assert.equal(await finish(abortReceipt.receiptId, abort, abortEvidence), null);
    await db.query("update public.proxmox_hosts set env_prefix='FIXTURE_DESTINATION' where id=$1", [destination.hostId]);
    const aborted = await finish(abortReceipt.receiptId, abort, abortEvidence);
    assert.equal(aborted.phase, "aborted");
    assert.deepEqual(await finish(abortReceipt.receiptId, abort, abortEvidence), aborted);
    assert.equal(await finish(abortReceipt.receiptId, abort.with(5, staleReceipt), abortEvidence), null);
    assert.equal(await finish(abortReceipt.receiptId, abort, retireEvidence), null);
    assert.equal(await claim(abort), null);
    assert.equal(await read(abortReceipt.receiptId, abort), null);
    assert.equal(await journal(), null);
    await db.query("update public.hivra_agents set name='abort released the agent' where id=$1", [agent]);
    await arm();
    await disarm();

    assert.equal((await begin(retireOperation, 10)).phase, "checkpointing");
    const advance = (action, evidence) =>
      pub("advance_hivra_kvm_portable_handoff", owner, agent, retireOperation, 11, action, evidence);
    const checkpointSha256 = "b".repeat(64);
    const sourceProof = { source, sourceStopped: true, sourceFenced: true, sourceConnectorOff: true };
    assert.ok(await pub("request_hivra_kvm_portable_wake", owner, agent, retireOperation, 11));
    assert.ok(await advance("verify_storage", {
      ...sourceProof, checkpointSha256, storageReadbackVerified: true,
      configuration: { snapshotId: "c".repeat(64), sha256: "d".repeat(64) },
      disk: { key: "scsi0", snapshotId: "e".repeat(64), sha256: "f".repeat(64), bytes: 40 * 1024 ** 3 },
    }));
    assert.ok(await advance("claim_restore", null));
    assert.ok(await advance("verify_destination", {
      destination, checkpointSha256, coldBootVerified: true, destinationConnectorBlocked: true,
      bootId, reservationSha256: "1".repeat(64),
    }));
    assert.equal(await claim(retire), null, "retire cannot claim pre-CAS authority");
    assert.ok(await advance("commit_placement", { ...sourceProof, destination, checkpointSha256, destinationConnectorBlocked: true }));
    assert.equal(await claim(abort.with(3, retireOperation).with(4, 11).with(7, "placement_committed")), null);
    const connector = { destination, sourceFenced: true, sourceConnectorOff: true, destinationConnectorReady: true, bootId, connectorId };
    assert.ok(await advance("confirm_connector", connector));
    assert.equal((await advance("finish_wake", { ...connector, destinationLockReleased: true })).phase, "finished");
    await arm();
    await disarm();
    const capacityBeforeRetire = await available();
    const retireReceipt = await claim(retire);
    await assert.rejects(arm(), { code: "55000" });
    assert.equal(retireReceipt.action, "retire");
    assert.deepEqual(retireReceipt.authoritative, destination);
    assert.deepEqual(retireReceipt.cleanupTarget, source);
    assert.equal(retireReceipt.checkpointSha256, checkpointSha256);
    assert.equal(retireReceipt.reservationSha256, "1".repeat(64));
    assert.equal(retireReceipt.bootId, bootId);
    assert.equal(retireReceipt.connectorId, connectorId);
    assert.deepEqual(await claim(retire), retireReceipt);
    assert.deepEqual(await read(retireReceipt.receiptId, retire), retireReceipt);
    assert.notEqual(retireReceipt.receiptId, abortReceipt.receiptId);
    assert.deepEqual(await available(), capacityBeforeRetire);
    await assert.rejects(db.query("update public.hivra_agents set name='changed' where id=$1", [agent]), { code: "55000" });
    await assert.rejects(db.query("delete from public.hivra_agents where id=$1", [agent]), { code: "55000" });
    await db.exec("set role service_role");
    await assert.rejects(publicRetire(), { code: "55000" });
    await db.exec("reset role");
    assert.equal(await finish(retireReceipt.receiptId, retire, abortEvidence), null);
    assert.equal((await journal()).phase, "finished");
    const retired = await finish(retireReceipt.receiptId, retire, retireEvidence);
    assert.ok(retired.retired_at);
    assert.equal(retired.phase, "finished");
    assert.equal(await journal(), null);
    assert.equal(await read(retireReceipt.receiptId, retire), null);
    assert.equal(await claim(retire), null);
    await db.query("update public.hivra_agents set name='retirement released the agent' where id=$1", [agent]);
    await arm();
    assert.ok(await selector());
    assert.deepEqual(await finish(retireReceipt.receiptId, retire, retireEvidence), retired);
    assert.equal(await finish(abortReceipt.receiptId, retire, retireEvidence), null);
    console.log("KVM portable guarded cleanup SQL passed");
  } finally {
    await db.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
