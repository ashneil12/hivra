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
const storage = { ...sourceProof, checkpointSha256, storageReadbackVerified: true };
const restored = { destination, checkpointSha256, coldBootVerified: true, destinationConnectorBlocked: true };
const commit = { ...sourceProof, destination, checkpointSha256, destinationConnectorBlocked: true };
const ready = { destination, sourceFenced: true, sourceConnectorOff: true, destinationConnectorReady: true };

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
    const addAgent = (machine, customer, target) => db.query(`insert into public.hivra_agents
      (id,user_id,type,name,status,desired_state,deployment_mode,computer_substrate,seat_funding,cpu,ram,
        proxmox_host,vmid,ip,cf_hostname,cf_tunnel_id,chat_url,
        sleep_state,sleep_generation,sleep_tier_changed_at,sleep_memory_dropped_at,
        infrastructure_binding_token_enforced,infrastructure_binding_token_hash)
      values ($1,$2,'claude-code','Fixture','running','running','hivra-managed','proxmox-kvm','paid',4,8,
        $3,$4,$5,$2||'.fixture.invalid','opaque-fixture-tunnel','https://'||$2||'.fixture.invalid',
        'hibernated',8,now()-interval '2 minutes',now(),true,$6)`,
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
    await db.exec("set role authenticated");
    await assert.rejects(begin(), { code: "42501" });
    await assert.rejects(advance("claim_restore"), { code: "42501" });
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
    assert.equal(await advance("verify_storage", storage, { operation: otherOperation }), null);
    assert.equal(await advance("verify_storage", storage, { generation: 8 }), null);
    assert.equal(await advance("verify_storage", { ...storage, sourceFenced: false }), null);
    assert.equal(await advance("verify_storage", { ...storage, source: { ...source, vmid: 1234 } }), null);
    assert.equal((await advance("verify_storage", storage)).phase, "storage_verified");
    assert.equal(await advance("claim_restore", {}), null);
    assert.equal((await advance("claim_restore")).phase, "restore_claimed");
    assert.equal(await advance("claim_restore"), null);
    assert.equal(await advance("verify_destination", { ...restored, checkpointSha256: "c".repeat(64) }), null);
    assert.equal(await advance("verify_destination", { ...restored, destinationConnectorBlocked: false }), null);
    assert.equal((await advance("verify_destination", restored)).phase, "destination_verified");
    assert.equal(await advance("commit_placement", { ...commit, sourceStopped: false }), null);
    assert.equal(await advance("commit_placement", { ...commit, destination: { ...destination, vmid: 9358 } }), null);
    assert.equal((await agentState()).proxmox_host, source.hostId);

    await db.query("update public.proxmox_hosts set status='maintenance' where id=$1", [destination.hostId]);
    assert.equal(await advance("commit_placement", commit), null);
    assert.equal((await read()).phase, "destination_verified");
    await db.query("update public.proxmox_hosts set status='active' where id=$1", [destination.hostId]);
    assert.equal((await advance("commit_placement", commit)).phase, "placement_committed");
    assert.deepEqual(await agentState(), { ...before, proxmox_host: destination.hostId, vmid: destination.vmid,
      ip: destination.ip, sleep_state: "waking", sleep_generation: 9, operation_id: operation, operation_kind: "wake" });
    assert.equal((await available(source.hostId)).free_disk_gb, beforeSource.free_disk_gb);
    assert.equal((await available(destination.hostId)).free_ram_mb, beforeDestination.free_ram_mb - 8192);
    assert.equal(await advance("commit_placement", commit), null);
    assert.equal(await advance("finish_wake", { ...ready, destinationConnectorReady: false }), null);
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
    assert.deepEqual((await read()).wake_evidence, ready);
    console.log("Managed KVM portable handoff SQL passed");
  } finally {
    await db.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
