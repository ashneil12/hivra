const assert = require("node:assert/strict");
const { openMigratedDatabase } = require("./lib/pglite-all-migrations.cjs");

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const host = "pve11";
const owner = "test-paid-warm-owner";
const digest = "a".repeat(64);
const ip = "192.0.2.42";
const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const [generation, agentId, operation, alternateId, alternateOp, baselineId, next, last] =
  [1, 2, 3, 4, 5, 6, 7, 8].map(id);

async function main() {
  const db = await openMigratedDatabase({
    setup: "alter default privileges in schema public grant execute on functions to anon, authenticated, service_role",
  });
  try {
    const row = async (sql, args = []) => (await db.query(sql, args)).rows[0];
    const rpc = async (name, ...args) =>
      (await row(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) result`, args)).result;
    const avail = () => row(`select free_cpu::int cpu, free_ram_mb::int ram, free_disk_gb::int disk
      from public.holder_admission_host_availability(array[$1],null,false,'{}',null)`, [host]);
    const reserve = (overrides = {}) => {
      const p = { owner, host, generation, vmid: 9354, ip, digest, expires, ...overrides };
      return rpc("reserve_hivra_hermes_standby", p.owner, p.host, p.generation, p.vmid, p.ip, p.digest, 2, 4096, 40, p.expires);
    };
    const read = (asOwner = owner, onHost = host, withDigest = digest) =>
      rpc("read_hivra_hermes_standby", asOwner, onHost, withDigest);
    const advance = (action, gen = generation) => rpc("advance_hivra_hermes_standby", gen, action);
    const claim = (overrides = {}) => {
      const p = { owner, agentId, operation, host, generation, vmid: 9354, ip, digest, ...overrides };
      return rpc("claim_hivra_hermes_standby", p.owner, p.agentId, p.operation, p.host, p.generation, p.vmid, p.ip, p.digest);
    };
    const assign = (op = operation) => rpc("assign_hivra_hermes_standby", owner, agentId, op, generation);
    const agent = (id, op, extra = {}) => JSON.stringify({
      id, user_id: owner, name: "Standby fixture", type: "hermes", proxmox_host: "",
      status: "provisioning", deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm",
      managed_provisioner_channel: "canary", seat_funding: "paid", cpu: 2, ram: 4, cpu_max: 2, ram_max: 4,
      desired_state: "running", operation_id: op, operation_kind: "provision",
      operation_started_at: new Date().toISOString(), operation_payload: { stage: "pre_allocation_access" },
      infrastructure_binding_token_hash: "b".repeat(64), infrastructure_binding_token_enforced: true, ...extra,
    });
    const insert = (json, limit = 5) => rpc("insert_hivra_managed_agent", json, limit, null, false);
    const slot = { generation, vmid: 9354, privateIp: ip, cpu: 2, ramMb: 4096, diskGb: 40 };
    const claimed = { status: "claimed", vmid: 9354, privateIp: ip };
    const noMatch = { status: "no_match" };
    const inDoubt = { status: "claim_in_doubt" };

    await db.exec(`insert into public.proxmox_hosts
      (id,total_cpu,total_ram_mb,reserved_cpu,reserved_ram_mb,wake_headroom_ram_mb,cpu_overcommit_ratio,thinpool_size_gb,thinpool_overcommit_ratio)
      values ('pve11',10,16384,0,0,0,1,100,1)`);
    const empty = await avail();
    assert.deepEqual(empty, { cpu: 10, ram: 16384, disk: 100 });

    await db.query(`insert into public.hivra_agents(id,user_id,name,type,proxmox_host,status,cpu,ram,vmid)
      values($1,'baseline-owner','Baseline','hermes','pve11','running',2,4,1210)`, [baselineId]);
    const baseline = await avail();
    assert.deepEqual(baseline, { cpu: 8, ram: 12288, disk: 60 });
    assert.equal(await reserve({ vmid: 1210 }), "target_in_use");
    await db.query("delete from public.hivra_agents where id=$1", [baselineId]);

    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      for (const call of [read, claim, reserve, assign]) await assert.rejects(call(), { code: "42501" });
      await assert.rejects(advance("quarantine"), { code: "42501" });
    }
    await db.exec("set role service_role");
    await assert.rejects(db.query("select * from hivra_hermes_standby_private.slot"), { code: "42501" });
    await assert.rejects(reserve({ host: "production" }), { code: "22023" });
    assert.equal(await reserve(), "reserved");
    assert.equal(await reserve(), "reserved");
    assert.equal(await reserve({ digest: "b".repeat(64) }), "generation_conflict");
    assert.equal(await reserve({ generation: next }), "busy");
    assert.equal(await read(), null);
    assert.deepEqual(await avail(), baseline);
    assert.equal(await advance("make_available"), "available");
    assert.deepEqual(await avail(), baseline);
    assert.deepEqual(await read(), slot);
    assert.equal(await read("different-owner"), null);
    assert.equal(await read(owner, "elsewhere"), null);
    assert.equal(await read(owner, host, "b".repeat(64)), null);

    await assert.rejects(insert(agent(last, id(99), { proxmox_host: host, cpu: 1, ram: 13, user_id: "other-paid" })), { code: "P0058" });
    assert.equal((await insert(agent(agentId, operation), 0)).status, "plan_agent_limit");
    assert.equal((await insert(agent(agentId, operation), 2)).status, "inserted");
    assert.equal((await rpc("insert_hivra_managed_agent_bridge_v1", "placement",
      agent(alternateId, alternateOp), 2, null, false)).status, "inserted");
    assert.deepEqual(await avail(), baseline);
    assert.equal(await assign(), false);
    for (const override of [
      { owner: "different-owner" }, { operation: id(99) }, { digest: "b".repeat(64) },
      { generation: next }, { host: "elsewhere" }, { ip: "192.0.2.43" }, { vmid: 9355 },
    ]) assert.deepEqual(await claim(override), noMatch);

    // PGlite queues independent queries on one connection. This regression
    // checks competing RPC/replay outcomes; the shared lock itself is SQL.
    const contenders = await Promise.all([
      claim(), claim({ agentId: alternateId, operation: alternateOp }),
      insert(agent(last, id(100), { proxmox_host: host, cpu: 1, ram: 13, user_id: "other-paid" }))
        .then(() => "admitted", (error) => error.code),
    ]);
    assert.deepEqual(contenders, [claimed, noMatch, "P0058"]);
    assert.deepEqual(await claim(), claimed);
    assert.deepEqual(await claim({ vmid: 9355 }), inDoubt);
    assert.equal(await read(), null);
    assert.deepEqual(await avail(), baseline);
    assert.deepEqual(await row("select proxmox_host,vmid,ip from public.hivra_agents where id=$1", [agentId]), {
      proxmox_host: host, vmid: null, ip: null,
    });

    assert.equal(await assign(), false);
    assert.equal(await rpc("persist_hivra_agent_provision_identity", owner, agentId, operation, 9354, ip), true);
    assert.equal(await assign(alternateOp), false);
    assert.equal(await assign(), true);
    assert.equal(await assign(), true);
    assert.deepEqual(await claim(), { status: "assigned" });
    assert.deepEqual(await avail(), baseline);
    assert.equal(await reserve({ generation: next }), "target_in_use");

    await db.exec("reset role");
    await db.query("delete from public.hivra_agents where id=$1 or id=$2", [agentId, alternateId]);
    assert.deepEqual(await avail(), empty);
    await db.exec(`update public.proxmox_hosts set capacity_reading=jsonb_build_object('v',1,'at',now(),
      'pool',jsonb_build_object('sizeMb',102400,'usedPercent',5))`);
    assert.deepEqual(await avail(), { cpu: 10, ram: 16384, disk: 80 });
    assert.equal(await reserve({ generation: next }), "reserved");
    assert.equal((await avail()).disk, 60, "reserve pending allocation against an earlier thin-pool sample");
    assert.equal(await advance("make_available", next), "available");
    assert.equal((await avail()).disk, 60, "stale-but-fresh sample cannot account for the just-staged disk");
    await db.exec(`update public.proxmox_hosts set capacity_reading=jsonb_build_object('v',1,'at',now(),
      'pool',jsonb_build_object('sizeMb',102400,'usedPercent',10))`);
    assert.equal((await avail()).disk, 75, "post-readiness thin-pool sample already includes the staged disk");

    const quarantinedAttempt = { generation: next, operation: id(101) };
    assert.equal((await insert(agent(agentId, quarantinedAttempt.operation))).status, "inserted");
    assert.deepEqual(await claim(quarantinedAttempt), claimed);
    assert.equal((await avail()).disk, 55, "ordinary provisioning holds its single pending disk allowance");
    await db.query("update hivra_hermes_standby_private.slot set expires_at=now()-interval '1 second' where generation=$1", [next]);
    assert.equal(await read(), null);
    assert.equal(await reserve({ generation: last }), "busy");
    assert.equal(await advance("quarantine", next), "quarantined");
    assert.equal(await rpc("assign_hivra_hermes_standby", owner, agentId, quarantinedAttempt.operation, next), false);
    assert.deepEqual(await claim(quarantinedAttempt), inDoubt);
    await db.query("delete from public.hivra_agents where id=$1", [agentId]);
    assert.deepEqual(await claim(quarantinedAttempt), inDoubt);
    assert.deepEqual(await avail(), { cpu: 8, ram: 12288, disk: 75 });
    assert.equal(await advance("release_absent", next), "released");
    assert.deepEqual(await claim(quarantinedAttempt), inDoubt);
    assert.equal((await avail()).ram, empty.ram);

    // A Pro seat fits the 20% holder slice but not the host while standby
    // occupies the last 4 GiB; releasing standby admits the same waiter.
    await db.exec(`update public.proxmox_hosts set capacity_reading=null,total_ram_mb=20480,sleep_mode='canary';
      insert into public.hivra_agents(user_id,name,type,proxmox_host,status,cpu,ram)
      values('fixture-filler','Filler','hermes','pve11','running',1,13);
      insert into public.token_tier_qualifications
        (user_id,tier,token_key,currently_eligible,qualifying_quantity,threshold_at_qualification,qualifying_threshold_tier)
      values('fixture-holder','pro','hermesos',true,1,1,'PRO_STANDARD')`);
    assert.equal(await reserve({ generation: last }), "reserved");
    assert.equal((await rpc("advance_holder_admissions")).blockReason, "no_single_host_fit");
    assert.equal(await advance("make_available", last), "available");
    assert.ok(await read());
    await db.query("update hivra_hermes_standby_private.slot set expires_at=now()-interval '1 second' where generation=$1", [last]);
    assert.equal(await read(), null);
    assert.equal(await advance("quarantine", last), "quarantined");
    assert.equal((await rpc("advance_holder_admissions")).blockReason, "no_single_host_fit");
    assert.equal(await advance("release_absent", last), "released");
    assert.equal((await rpc("advance_holder_admissions")).advanced, 1);
    assert.equal((await row("select assigned_host_id from public.holder_admissions where user_id='fixture-holder'")).assigned_host_id, host);
    console.log("Canary Hermes standby accounting and custody RPCs passed");
  } finally {
    await db.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
