const assert = require("node:assert/strict");
const { openMigratedDatabase } = require("./lib/pglite-all-migrations.cjs");

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [agent, fencedAgent, otherAgent, operation, otherOperation] = [1, 2, 3, 4, 5].map(id);
const owner = "user_PortableFixture";
const fencedOwner = "user_FencedFixture";
const otherOwner = "user_UnrelatedFixture";
const hash = "a".repeat(64);
const checkpointSha256 = "b".repeat(64);
const bindingTag = `hivra-bind-${hash.slice(0, 32)}`;
const source = { hostId: "fixture-source", vmid: 9354, ip: "192.0.2.42", bindingTag };
const destination = { hostId: "fixture-destination", vmid: 9357, ip: "192.0.2.73", bindingTag };
const sourceProof = { source, sourceStopped: true, sourceFenced: true, sourceConnectorOff: true };
const storage = {
  ...sourceProof, checkpointSha256, storageReadbackVerified: true,
  configuration: { snapshotId: "c".repeat(64), sha256: "d".repeat(64) },
  disk: { key: "scsi0", snapshotId: "e".repeat(64), sha256: "f".repeat(64), bytes: 40 * 1024 ** 3 },
};
const restored = {
  destination, checkpointSha256, coldBootVerified: true, destinationConnectorBlocked: true,
  bootId: id(7), reservationSha256: "1".repeat(64),
};
const commit = { ...sourceProof, destination, checkpointSha256, destinationConnectorBlocked: true };
const connector = {
  destination, sourceFenced: true, sourceConnectorOff: true, destinationConnectorReady: true,
  bootId: restored.bootId, connectorId: id(6),
};
const ready = { ...connector, destinationLockReleased: true };
const retirement = { source, destination, sourceVmAbsent: true, sourceConnectorAbsent: true, destinationHealthy: true };
const abortProof = {
  source, destination, portableWorkQuiesced: true, destinationVmAbsent: true, destinationStorageAbsent: true,
  sourceDiskUnchanged: true, sourceStopped: true, sourceConnectorOff: true, sourceLegacyColdMarkerRestored: true,
};

async function main() {
  const db = await openMigratedDatabase({
    setup: "alter default privileges in schema public grant execute on functions to anon, authenticated, service_role",
  });
  try {
    const row = async (sql, args = []) => (await db.query(sql, args)).rows[0];
    const rpc = async (name, ...args) =>
      (await row(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as result`, args)).result;
    const agentState = (agentId = agent) => row(`select proxmox_host,vmid,ip,status,sleep_state,
      sleep_generation::int,operation_id,operation_kind,cf_hostname,cf_tunnel_id,chat_url
      from public.hivra_agents where id=$1`, [agentId]);
    const available = (host) => row(`select free_cpu::int,free_ram_mb::int,free_disk_gb::int
      from public.holder_admission_host_availability(array[$1],null,false,'{}',null)`, [host]);
    const expiry = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const begin = (overrides = {}) => {
      const p = { owner, agent, operation, generation: 8, source, destination, expiry, ...overrides };
      return rpc("begin_hivra_kvm_portable_handoff", p.owner, p.agent, p.operation, p.generation, p.source, p.destination, p.expiry);
    };
    const read = (customer = owner, machine = agent) => rpc("read_hivra_kvm_portable_handoff", customer, machine);
    const advance = (action, evidence = null, overrides = {}) => {
      const p = { owner, agent, operation, generation: 9, ...overrides };
      return rpc("advance_hivra_kvm_portable_handoff", p.owner, p.agent, p.operation, p.generation, action, evidence);
    };
    const retire = (evidence = retirement, overrides = {}) => {
      const p = { owner, agent, operation, generation: 9, ...overrides };
      return rpc("finish_hivra_kvm_portable_retirement", p.owner, p.agent, p.operation, p.generation, evidence);
    };
    const abort = (evidence = abortProof, overrides = {}) => {
      const p = { owner, agent, operation, generation: 9, ...overrides };
      return rpc("abort_hivra_kvm_portable_handoff", p.owner, p.agent, p.operation, p.generation, evidence);
    };
    const addAgent = (machine, customer, target) => db.query(`insert into public.hivra_agents
      (id,user_id,type,name,status,desired_state,deployment_mode,computer_substrate,seat_funding,cpu,ram,
        proxmox_host,vmid,ip,cf_hostname,cf_tunnel_id,chat_url,
        sleep_policy,sleep_state,sleep_generation,sleep_tier_changed_at,sleep_memory_dropped_at,
        infrastructure_binding_token_enforced,infrastructure_binding_token_hash)
      values ($1,$2,'claude-code','Fixture','running','running','hivra-managed','proxmox-kvm','paid',4,8,
        $3,$4,$5,$2||'.fixture.invalid','opaque-fixture-tunnel','https://'||$2||'.fixture.invalid',
        'full','hibernated',8,now()-interval '2 minutes',now(),true,$6)`,
    [machine, customer, target.hostId, target.vmid, target.ip, hash]);
    await db.query(`insert into public.proxmox_hosts (id,total_cpu,total_ram_mb,thinpool_size_gb)
      values ($1,16,65536,256),($2,16,65536,256)`, [source.hostId, destination.hostId]);
    await addAgent(agent, owner, source);
    const fencedSource = { ...source, vmid: 9355, ip: "192.0.2.43" };
    await addAgent(fencedAgent, fencedOwner, fencedSource);
    await addAgent(otherAgent, otherOwner, { ...source, vmid: 9356, ip: "192.0.2.44" });
    await db.query("select canary_qa_writer_private.set_scope($1,$2,$3,null,null)",
      [fencedOwner, fencedSource.hostId, fencedSource.vmid]);

    await db.exec("set role anon");
    await assert.rejects(read(), { code: "42501" });
    await assert.rejects(retire(), { code: "42501" });
    await assert.rejects(abort(), { code: "42501" });
    await db.exec("set role authenticated");
    await assert.rejects(begin(), { code: "42501" });
    await assert.rejects(advance("claim_restore"), { code: "42501" });
    await assert.rejects(retire(), { code: "42501" });
    await assert.rejects(abort(), { code: "42501" });
    await db.exec("set role service_role");
    await assert.rejects(db.query("select * from hivra_kvm_portable_private.handoff"), { code: "42501" });
    const epoch = await rpc("managed_launch_bridge_epoch");
    const beforeDestination = await available(destination.hostId);
    const beforeSource = await available(source.hostId);
    for (const overrides of [
      { owner: otherOwner }, { generation: 7 }, { expiry: "2000-01-01T00:00:00Z" },
      { destination: { ...destination, hostId: source.hostId } },
      { destination: { ...destination, ip: "192.0.2.999" } },
      { destination: { ...destination, vmid: 9500 } },
      { destination: { ...destination, vmid: 9302 } },
      { destination: { ...destination, bindingTag: "hivra-bind-" + "f".repeat(32) } },
      { source: { ...source, vmid: source.vmid + 1 } },
      { owner: fencedOwner, agent: fencedAgent, source: fencedSource },
    ]) assert.equal(await begin(overrides), null);
    await assert.rejects(db.query("update public.hivra_agents set proxmox_host=$1 where id=$2",
      [destination.hostId, fencedAgent]), { code: "P0060" });

    for (const vmid of [9299, 9302, 9400]) {
      await db.query("update public.hivra_agents set vmid=$1 where id=$2", [vmid, agent]);
      assert.equal(await begin({ source: { ...source, vmid } }), null);
    }
    await db.query("update public.hivra_agents set vmid=$1 where id=$2", [source.vmid, agent]);
    await db.query("update public.hivra_agents set sleep_policy='t3' where id=$1", [agent]);
    assert.equal(await begin(), null);
    await db.query("update public.hivra_agents set sleep_policy='full' where id=$1", [agent]);

    await db.query("update public.hivra_agents set next_wake_at=now() where id=$1", [agent]);
    assert.equal(await begin(), null);
    await db.query("update public.hivra_agents set next_wake_at=null where id=$1", [agent]);
    await db.query("update public.hivra_agents set proxmox_host=$1,vmid=$2 where id=$3",
      [destination.hostId, destination.vmid, otherAgent]);
    assert.equal(await begin(), null);
    await db.query("update public.hivra_agents set proxmox_host=$1,vmid=9356 where id=$2", [source.hostId, otherAgent]);
    assert.equal(await rpc("claim_hivra_agent_wake", otherAgent, otherOperation), "claimed");
    assert.equal(await rpc("finish_hivra_agent_wake", otherAgent, otherOperation, "awake"), true);

    await db.query("update public.proxmox_hosts set total_ram_mb=13000 where id=$1", [destination.hostId]);
    await assert.rejects(begin(), { code: "P0058" });
    await db.query("update public.proxmox_hosts set total_ram_mb=65536 where id=$1", [destination.hostId]);
    const before = await agentState();
    const opened = await begin();
    assert.equal(opened.phase, "checkpointing");
    assert.equal(opened.generation, 9);
    assert.deepEqual(opened.source, source);
    assert.deepEqual(opened.destination, destination);
    assert.equal(await retire(), null);
    for (const overrides of [{ owner: otherOwner }, { agent: otherAgent }, { operation: otherOperation }, { generation: 8 }]) {
      assert.equal(await abort(abortProof, overrides), null);
    }
    for (const flag of Object.keys(abortProof).filter(key => key !== "source" && key !== "destination")) {
      assert.equal(await abort({ ...abortProof, [flag]: false }), null);
      assert.equal(await abort({ ...abortProof, [flag]: undefined }), null);
    }
    assert.equal(await abort({ ...abortProof, source: destination }), null);
    assert.equal(await abort({ ...abortProof, destination: source }), null);
    assert.equal(await abort({ ...abortProof, extra: true }), null);
    assert.equal(await begin(), null);
    assert.equal(await read(otherOwner), null);
    assert.equal(await read(owner, otherAgent), null);
    assert.deepEqual(await read(), opened);
    assert.equal((await agentState()).operation_id, operation);
    assert.equal((await agentState()).sleep_state, "waking");
    assert.equal(await rpc("claim_hivra_agent_wake", agent, otherOperation), "busy");
    assert.equal(await rpc("claim_hivra_agent_sleep", agent, otherOperation, "hibernate", 9), null);
    assert.equal(await rpc("claim_hivra_agent_idle_sleep", agent, otherOperation, "hibernate", 9), null);
    await assert.rejects(rpc("finish_hivra_agent_wake", agent, operation, "awake"), { code: "55000" });
    await assert.rejects(db.query("update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null where id=$1",
      [agent]), { code: "55000" });
    await assert.rejects(db.query("delete from public.hivra_agents where id=$1", [agent]), { code: "55000" });
    await assert.rejects(db.query("update public.hivra_agents set proxmox_host=$1,ip=$2 where id=$3",
      [destination.hostId, destination.ip, otherAgent]), { code: "P0058" });
    await assert.rejects(db.query(`insert into public.hermes_instances
      (user_id,name,status,lifecycle_state,infrastructure_provider,proxmox_node,proxmox_vmid)
      values ($1,'Fixture','running','active','proxmox',$2,$3)`,
    [otherOwner, destination.hostId, destination.vmid]), { code: "P0058" });
    await assert.rejects(db.query("insert into public.hivra_agent_ingress(agent_id,host_id,vmid) values ($1,$2,$3)",
      [agent, source.hostId, source.vmid]), { code: "55000" });
    await assert.rejects(db.query("insert into public.hivra_agent_channel_wake(agent_id,channel,enabled) values ($1,'test',true)",
      [agent]), { code: "55000" });
    assert.deepEqual(await available(destination.hostId), {
      free_cpu: beforeDestination.free_cpu - 4,
      free_ram_mb: beforeDestination.free_ram_mb - 8192,
      free_disk_gb: beforeDestination.free_disk_gb - 40,
    });

    await db.exec("reset role; update hivra_kvm_portable_private.handoff set expires_at=clock_timestamp()-interval '1 second'; set role service_role");
    assert.equal(await advance("verify_storage", storage), null);
    assert.equal(await rpc("claim_hivra_agent_wake", agent, otherOperation), "busy");
    assert.equal((await read()).phase, "checkpointing");
    await db.exec("reset role");
    await db.query("update hivra_kvm_portable_private.handoff set expires_at=$1", [expiry]);
    await db.exec("set role service_role");

    assert.equal(await advance("claim_restore"), null);
    assert.equal(await advance("commit_placement", commit), null);
    assert.equal(await advance("confirm_connector", connector), null);
    assert.equal(await advance("verify_storage", storage, { operation: otherOperation }), null);
    assert.equal(await advance("verify_storage", storage, { generation: 8 }), null);
    assert.equal(await advance("verify_storage", { ...storage, sourceFenced: false }), null);
    assert.equal(await advance("verify_storage", { ...storage, source: { ...source, vmid: 1234 } }), null);
    for (const invalid of [
      { ...storage, configuration: undefined },
      { ...storage, fence: { extra: true } },
      { ...storage, configuration: { ...storage.configuration, extra: true } },
      { ...storage, configuration: { ...storage.configuration, snapshotId: storage.disk.snapshotId } },
      { ...storage, configuration: { ...storage.configuration, sha256: "A".repeat(64) } },
      { ...storage, disk: { ...storage.disk, sha256: 1 } },
      { ...storage, disk: { ...storage.disk, snapshotId: "a".repeat(63) } },
      { ...storage, disk: { ...storage.disk, key: "scsi1" } },
      ...[0, -512, 513, 511.5, 40 * 1024 ** 3 + 512, "512", true, null].map(bytes =>
        ({ ...storage, disk: { ...storage.disk, bytes } })),
    ]) assert.equal(await advance("verify_storage", invalid), null);
    assert.deepEqual(await read(), opened);
    const verified = await advance("verify_storage", storage);
    assert.equal(verified.phase, "storage_verified");
    assert.deepEqual(verified.storage_evidence, storage);
    assert.equal(await advance("verify_storage", { ...storage, disk: { ...storage.disk, bytes: 512 } }), null);
    assert.deepEqual(await read(), verified);
    assert.equal(await advance("claim_restore", {}), null);
    assert.equal((await advance("claim_restore")).phase, "restore_claimed");
    assert.equal(await advance("claim_restore"), null);
    assert.equal(await advance("verify_destination", { ...restored, checkpointSha256: "c".repeat(64) }), null);
    assert.equal(await advance("verify_destination", { ...restored, destinationConnectorBlocked: false }), null);
    for (const evidence of [
      { ...restored, bootId: undefined },
      { ...restored, bootId: "00000000-0000-0000-0000-000000000000" },
      { ...restored, bootId: "00000000-0000-4000-0000-000000000001" },
      { ...restored, bootId: "00000000-0000-9000-8000-000000000001" },
      { ...restored, bootId: "invalid" }, { ...restored, reservationSha256: undefined },
      { ...restored, reservationSha256: "a".repeat(63) }, { ...restored, reservationSha256: "A".repeat(64) },
      { ...restored, hostReceipt: {} },
    ]) assert.equal(await advance("verify_destination", evidence), null);
    assert.equal((await read()).destination_evidence, null);
    const destinationVerified = await advance("verify_destination", restored);
    assert.equal(destinationVerified.phase, "destination_verified");
    assert.deepEqual(destinationVerified.destination_evidence, restored);
    assert.equal(await advance("verify_destination", { ...restored, bootId: id(8) }), null);
    assert.deepEqual(await read(), destinationVerified);
    assert.equal(await advance("commit_placement", { ...commit, sourceStopped: false }), null);
    assert.equal(await advance("commit_placement", { ...commit, destination: { ...destination, vmid: 9358 } }), null);
    assert.equal((await agentState()).proxmox_host, source.hostId);

    await db.query("update public.proxmox_hosts set status='maintenance' where id=$1", [destination.hostId]);
    assert.equal(await advance("commit_placement", commit), null);
    assert.equal((await read()).phase, "destination_verified");
    await db.query("update public.proxmox_hosts set status='active' where id=$1", [destination.hostId]);
    assert.equal((await advance("commit_placement", commit)).phase, "placement_committed");
    assert.equal(await retire(), null);
    assert.equal(await abort(), null);
    assert.deepEqual(await agentState(), { ...before, proxmox_host: destination.hostId, vmid: destination.vmid,
      ip: destination.ip, sleep_state: "waking", sleep_generation: 9, operation_id: operation, operation_kind: "wake" });
    assert.equal((await available(source.hostId)).free_disk_gb, beforeSource.free_disk_gb);
    assert.equal((await available(destination.hostId)).free_ram_mb, beforeDestination.free_ram_mb - 8192);
    const committedSourceCapacity = await available(source.hostId);
    const committedDestinationCapacity = await available(destination.hostId);
    assert.equal(await advance("commit_placement", commit), null);
    assert.equal(await advance("finish_wake", ready), null);
    for (const invalid of [
      { ...connector, destination: source }, { ...connector, sourceConnectorOff: false },
      { ...connector, destinationConnectorReady: false }, { ...connector, bootId: id(8) },
      { ...connector, connectorId: "00000000-0000-0000-0000-000000000000" },
      { ...connector, connectorId: "not-uuid" }, { ...connector, destinationLockReleased: true },
    ]) assert.equal(await advance("confirm_connector", invalid), null);
    assert.equal((await read()).connector_evidence, null);
    const connectorVerified = await advance("confirm_connector", connector);
    assert.equal(connectorVerified.phase, "connector_verified");
    assert.deepEqual(connectorVerified.connector_evidence, connector);
    assert.equal(await advance("confirm_connector", { ...connector, connectorId: id(8) }), null);
    assert.deepEqual(await read(), connectorVerified);
    assert.equal(await retire(), null);
    assert.equal(await abort(), null);
    assert.deepEqual(await available(source.hostId), committedSourceCapacity);
    assert.deepEqual(await available(destination.hostId), committedDestinationCapacity);
    await assert.rejects(db.query("update public.hivra_agents set vmid=$1 where id=$2", [source.vmid, otherAgent]),
      { code: "P0058" });
    for (const invalid of [
      connector, { ...ready, destinationLockReleased: false }, { ...ready, connectorId: id(8) },
      { ...ready, bootId: id(8) }, { ...ready, destinationConnectorReady: false },
    ]) assert.equal(await advance("finish_wake", invalid), null);
    assert.equal(await rpc("claim_hivra_agent_wake", agent, otherOperation), "busy");
    assert.equal((await advance("finish_wake", ready)).phase, "finished");
    assert.equal(await advance("finish_wake", ready), null);
    assert.deepEqual(await agentState(), { ...before, proxmox_host: destination.hostId,
      vmid: destination.vmid, ip: destination.ip, sleep_state: "awake", sleep_generation: 10 });
    assert.equal(await rpc("claim_hivra_agent_wake", agent, otherOperation), "awake");
    assert.equal(await rpc("managed_launch_bridge_epoch"), epoch);
    await assert.rejects(db.query("update public.hivra_agents set vmid=$1 where id=$2", [source.vmid, otherAgent]),
      { code: "P0058" });
    assert.deepEqual((await read()).storage_evidence, storage);
    assert.deepEqual((await read()).destination_evidence, restored);
    assert.deepEqual((await read()).commit_evidence, commit);
    assert.deepEqual((await read()).connector_evidence, connector);
    assert.deepEqual((await read()).wake_evidence, ready);
    const unretired = await read();
    assert.equal(unretired.retired_at, null);
    assert.equal(await abort(), null);
    await assert.rejects(db.query("delete from public.hivra_agents where id=$1", [agent]),
      { code: "23001", constraint: "handoff_active_agent_id_fkey" });
    assert.equal(await begin({ owner: fencedOwner, agent: fencedAgent, source: fencedSource }), null);
    for (const overrides of [{ owner: otherOwner }, { agent: otherAgent }, { operation: otherOperation }, { generation: 10 }]) {
      assert.equal(await retire(retirement, overrides), null);
    }
    for (const evidence of [
      null, { ...retirement, sourceVmAbsent: false }, { ...retirement, sourceConnectorAbsent: undefined },
      { ...retirement, destinationHealthy: false }, { ...retirement, destinationHealthy: "true" },
      { ...retirement, source: { ...source, vmid: source.vmid + 1 } },
      { ...retirement, destination: { ...destination, ip: source.ip } }, { ...retirement, extra: true },
    ]) assert.equal(await retire(evidence), null);
    await db.query("update public.hivra_agents set ip=$1 where id=$2", [source.ip, agent]);
    assert.equal(await retire(), null);
    await db.query("update public.hivra_agents set ip=$1 where id=$2", [destination.ip, agent]);
    await db.query("update public.hivra_agents set sleep_generation=11 where id=$1", [agent]);
    assert.equal(await retire(), null);
    await db.query("update public.hivra_agents set sleep_generation=10 where id=$1", [agent]);
    await db.query("update public.hivra_agents set desired_state='stopped' where id=$1", [agent]);
    assert.equal(await retire(), null);
    await db.query("update public.hivra_agents set desired_state='running' where id=$1", [agent]);
    await db.query("update public.proxmox_hosts set status='maintenance' where id=$1", [destination.hostId]);
    assert.equal(await retire(), null);
    await db.query("update public.proxmox_hosts set status='active' where id=$1", [destination.hostId]);
    assert.deepEqual(await read(), unretired);
    assert.equal((await available(source.hostId)).free_disk_gb, beforeSource.free_disk_gb);

    await db.exec("reset role; update hivra_kvm_portable_private.handoff set expires_at=clock_timestamp()-interval '1 second'; set role service_role");
    assert.equal(await retire({ ...retirement, sourceConnectorAbsent: false }), null);
    assert.equal((await available(source.hostId)).free_disk_gb, beforeSource.free_disk_gb);
    const liveBeforeRetirement = await agentState();
    const retired = await retire();
    assert.equal(retired.phase, "finished");
    assert.ok(retired.retired_at);
    assert.deepEqual(retired.retirement_evidence, retirement);
    assert.deepEqual(await agentState(), liveBeforeRetirement);
    assert.equal(await read(), null);
    assert.equal(await retire(), null);
    assert.equal(await advance("finish_wake", ready), null);
    assert.equal((await available(source.hostId)).free_disk_gb, beforeSource.free_disk_gb + 40);
    await db.query("update public.hivra_agents set vmid=$1 where id=$2", [source.vmid, otherAgent]);
    await db.query("update public.hivra_agents set vmid=9356 where id=$1", [otherAgent]);

    for (let cycle = 1; cycle < 5; cycle++) {
      const [from, to] = cycle % 2 ? [destination, source] : [source, destination];
      const awakeGeneration = 10 + (cycle - 1) * 4;
      const sleepOperation = id(20 + cycle);
      assert.equal(await rpc("claim_hivra_agent_sleep", agent, sleepOperation, "hibernate", awakeGeneration), awakeGeneration + 1);
      assert.equal(await rpc("finish_hivra_agent_sleep", agent, sleepOperation, "hibernated"), true);
      const generation = awakeGeneration + 2;
      const wakeOperation = id(30 + cycle);
      const placement = { source: from, destination: to, generation };
      assert.equal(await begin({ ...placement, operation }), null);
      assert.equal(await begin({ ...placement, operation: wakeOperation }), null);
      await db.query("update public.hivra_agents set sleep_memory_dropped_at=clock_timestamp() where id=$1", [agent]);
      assert.equal(await begin({ ...placement, generation: generation - 1, operation: wakeOperation }), null);
      assert.equal(await begin({ ...placement, operation }), null);
      assert.equal((await begin({ ...placement, operation: wakeOperation })).generation, generation + 1);
      const lease = { operation: wakeOperation, generation: generation + 1 };
      const cycleStorage = { ...storage, source: from, disk: { ...storage.disk, bytes: 512 * cycle } };
      assert.equal(await advance("verify_storage", cycleStorage), null);
      assert.equal(await retire(), null);
      assert.deepEqual((await advance("verify_storage", cycleStorage, lease)).storage_evidence, cycleStorage);
      assert.equal((await advance("claim_restore", null, lease)).phase, "restore_claimed");
      assert.equal((await advance("verify_destination", { ...restored, destination: to }, lease)).phase, "destination_verified");
      assert.equal((await advance("commit_placement", { ...commit, source: from, destination: to }, lease)).phase, "placement_committed");
      assert.equal((await advance("confirm_connector", { ...connector, destination: to }, lease)).phase, "connector_verified");
      assert.equal((await advance("finish_wake", { ...ready, destination: to }, lease)).phase, "finished");
      assert.equal((await agentState()).sleep_generation, generation + 2);
      assert.equal(await retire({ ...retirement, source: from, destination: to }, { ...lease, operation }), null);
      assert.ok((await retire({ ...retirement, source: from, destination: to }, lease)).retired_at);
      assert.equal(await read(), null);
    }
    assert.equal(await rpc("managed_launch_bridge_epoch"), epoch);
    await assert.rejects(db.query("update public.hivra_agents set proxmox_host=$1 where id=$2",
      [destination.hostId, fencedAgent]), { code: "P0060" });

    const sleepOperation = id(50);
    assert.equal(await rpc("claim_hivra_agent_sleep", agent, sleepOperation, "hibernate", 26), 27);
    assert.equal(await rpc("finish_hivra_agent_sleep", agent, sleepOperation, "hibernated"), true);
    await db.query("update public.hivra_agents set sleep_memory_dropped_at=clock_timestamp() where id=$1", [agent]);
    const abortPhases = ["checkpointing", "storage_verified", "restore_claimed", "destination_verified"];
    const abortEvidence = { ...abortProof, source: destination, destination: source };
    for (const [step, phase] of abortPhases.entries()) {
      const cooled = await agentState();
      const abortOperation = id(51 + step);
      const placement = { source: destination, destination: source, generation: cooled.sleep_generation, operation: abortOperation };
      const unreserved = await available(source.hostId);
      assert.equal((await begin(placement)).phase, "checkpointing");
      const lease = { operation: abortOperation, generation: cooled.sleep_generation + 1 };
      assert.equal(await abort(abortEvidence, { ...lease, operation: id(50 + step) }), null);
      assert.equal(await retire(retirement, lease), null);
      if (step >= 1) await advance("verify_storage", { ...storage, source: destination }, lease);
      if (step >= 2) await advance("claim_restore", null, lease);
      if (step >= 3) await advance("verify_destination", { ...restored, destination: source }, lease);
      assert.equal((await read()).phase, phase);
      assert.equal((await available(source.hostId)).free_disk_gb, unreserved.free_disk_gb - 40);
      await db.exec("reset role");
      await db.query("update hivra_kvm_portable_private.handoff set expires_at=clock_timestamp()-interval '1 second' where operation_id=$1", [abortOperation]);
      await db.exec("set role service_role");
      assert.equal(await advance("commit_placement", { ...commit, source: destination, destination: source }, lease), null);
      assert.equal(await abort({ ...abortEvidence, destinationStorageAbsent: false }, lease), null);
      const aborted = await abort(abortEvidence, lease);
      assert.equal(aborted.phase, "aborted");
      assert.ok(aborted.retired_at);
      assert.deepEqual(aborted.abort_evidence, abortEvidence);
      assert.equal(aborted.retirement_evidence, null);
      assert.deepEqual(await agentState(), { ...cooled, sleep_generation: cooled.sleep_generation + 2 });
      assert.deepEqual(await available(source.hostId), unreserved);
      assert.equal(await read(), null);
      assert.equal(await abort(abortEvidence, lease), null);
      assert.equal(await begin({ ...placement, generation: cooled.sleep_generation + 2 }), null);
    }
    assert.deepEqual(await row("delete from public.hivra_agents where id=$1 returning id", [agent]), { id: agent });
    assert.equal(await agentState(), undefined);
    await db.exec("reset role");
    const history = (await db.query(`select operation_id,generation::int,phase,retired_at,storage_evidence,destination_evidence,connector_evidence from
      hivra_kvm_portable_private.handoff order by generation`)).rows;
    assert.deepEqual(history.map(entry => entry.generation), [9, 13, 17, 21, 25, 29, 31, 33, 35]);
    assert.deepEqual(history.map(entry => entry.phase), [...Array(5).fill("finished"), ...Array(4).fill("aborted")]);
    assert.equal(history[0].operation_id, operation);
    assert.deepEqual(history[0].storage_evidence, storage);
    assert.deepEqual(history[0].destination_evidence, restored);
    assert.deepEqual(history[0].connector_evidence, connector);
    assert.ok(history.every(entry => entry.retired_at));
    console.log("Managed KVM portable handoff SQL passed");
  } finally {
    await db.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
