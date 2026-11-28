const assert = require("node:assert/strict");
const { openMigratedDatabase } = require("./lib/pglite-all-migrations.cjs");
const uuid = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const [agent, other, allocation, job] = [21, 22, 23, 24].map(uuid);
const owner = "user_ScopeFixture";
const binding = "a".repeat(64);
const host = "fixture-host";
const vmid = 9323;

async function main() {
  const db = await openMigratedDatabase({ through: "20261128165200_canary_deep_hibernate_scope.sql" });
  try {
    const rows = (sql, args = []) => db.query(sql, args).then(result => result.rows);
    const eligible = () => rows("select id from public.hivra_canary_deep_hibernate_candidate()").then(r => r.map(x => x.id));
    const claim = (id = agent) => rows("select public.claim_hivra_canary_deep_hibernate_store($1,$2) as claimed", [id, job]).then(r => r[0].claimed);
    await rows("insert into public.proxmox_hosts (id,status,sleep_mode,total_cpu,total_ram_mb,thinpool_size_gb) values ($1,'active','canary',40,98304,512)", [host]);

    await db.exec("begin");
    await rows("select public.canary_qa_holder_validation_backing($1,$2)", [owner,host]);
    await rows("select set_config('hivra.canary_qa_holder_insert_id',$1,true)", [agent]);
    await rows(`insert into public.hivra_agents
      (id,user_id,type,name,status,desired_state,deployment_mode,computer_substrate,seat_funding,cpu,ram,
       proxmox_host,vmid,ip,sleep_state,sleep_tier_changed_at,sleep_memory_dropped_at,always_on,
       allocation_operation_id,infrastructure_binding_token_enforced,infrastructure_binding_token_hash,canary_qa_holder_expires_at,next_wake_at)
      values($1,$2,'hermes','Canary holder QA','running','running','hivra-managed','proxmox-kvm','holder',2,4,
       $3,$4,'192.0.2.28','hibernated',now()-interval '3 minutes',now()-interval '2 minutes',false,$5,true,$6,
       now()+interval '1 hour',now()+interval '23 minutes')`, [agent,owner,host,vmid,allocation,binding]);
    await db.exec("commit");

    await rows(`insert into public.hivra_computer_backups(id,agent_id,user_id,kind,status,proxmox_host,vmid,started_at)
      values ($1,$2,$3,'store','running',$4,$5,now())`, [job,agent,owner,host,vmid]);
    assert.deepEqual(await eligible(), []);
    assert.equal(await claim(), false);
    const setScope = (ownerId) => rows(`insert into hivra_deep_hibernate_qa_private.scope
      (agent_id,owner_id,host_id,vmid,allocation_operation_id,binding_token_hash,expires_at)
      values ($1,$2,$3,$4,$5,$6,now()+interval '50 minutes')`, [agent,ownerId,host,vmid,allocation,binding]);
    await setScope("user_OtherFixture");
    assert.deepEqual(await eligible(), []);
    await db.exec("delete from hivra_deep_hibernate_qa_private.scope");
    await setScope(owner);

    await db.exec("set role service_role");
    await assert.rejects(rows("delete from hivra_deep_hibernate_qa_private.scope"), { code: "42501" });
    assert.deepEqual(await eligible(), [agent]);
    assert.equal(await claim(other), false);
    await db.exec("reset role");
    await rows("update public.hivra_agents set next_wake_at=now()+interval '5 minutes' where id=$1", [agent]);
    assert.deepEqual(await eligible(), []);
    assert.equal(await claim(), false);
    await rows("update public.hivra_agents set next_wake_at=now()+interval '23 minutes' where id=$1", [agent]);
    await rows("update public.hivra_computer_backups set vmid=9312 where id=$1", [job]);
    assert.equal(await claim(), false);
    await rows("update public.hivra_computer_backups set vmid=$2 where id=$1", [job,vmid]);
    await rows("update public.proxmox_hosts set sleep_mode='off' where id=$1", [host]);
    assert.equal(await claim(), false);
    await rows("update public.proxmox_hosts set sleep_mode='canary' where id=$1", [host]);
    assert.equal(await claim(), true);
    assert.deepEqual(await eligible(), []);
    assert.equal(await claim(), false);
    assert.deepEqual((await rows("select sleep_store_job_id from public.hivra_agents where id=$1",[agent]))[0], {sleep_store_job_id:job});
    const ordinaryOwner="user_OrdinaryFixture";
    await db.exec("delete from hivra_deep_hibernate_qa_private.scope");
    await rows("insert into public.token_tier_qualifications(user_id,tier,token_key,currently_eligible,qualifying_quantity,threshold_at_qualification,qualifying_threshold_tier) values ($1,'pro','hermesos',true,1,1,'PRO_STANDARD')", [ordinaryOwner]);
    await rows("insert into public.holder_admissions(user_id,state,tier,token_key,admitted_at,reserved_cpu,reserved_ram_mb,assigned_host_id) values ($1,'admitted','pro','hermesos',now(),4,8192,$2)", [ordinaryOwner,host]);
    await rows(`insert into public.hivra_agents
      (id,user_id,type,name,status,desired_state,deployment_mode,computer_substrate,seat_funding,cpu,ram,
       proxmox_host,vmid,ip,sleep_state,sleep_tier_changed_at,sleep_memory_dropped_at,always_on,
       allocation_operation_id,infrastructure_binding_token_enforced,infrastructure_binding_token_hash,next_wake_at)
      values($1,$2,'hermes','Ordinary holder fixture','running','running','hivra-managed','proxmox-kvm','holder',2,4,
       $3,$4,'192.0.2.29','hibernated',now()-interval '3 minutes',now()-interval '2 minutes',false,$5,true,$6,
       now()+interval '23 minutes')`, [other,ordinaryOwner,host,vmid+1,allocation,binding]);
    await rows(`insert into hivra_deep_hibernate_qa_private.scope
      (agent_id,owner_id,host_id,vmid,allocation_operation_id,binding_token_hash,expires_at)
      values ($1,$2,$3,$4,$5,$6,now()+interval '50 minutes')`, [other,ordinaryOwner,host,vmid+1,allocation,binding]);
    assert.deepEqual(await eligible(), [other], "ordinary holder uses the exact scoped test path");
    await db.exec("set hivra.seat_funding_writer='on'");
    await rows("update public.hivra_agents set seat_funding='paid' where id=$1", [other]);
    await db.exec("reset hivra.seat_funding_writer");
    assert.deepEqual(await eligible(), [], "even an exact scope cannot admit paid funding");
    console.log("PASS scoped Canary offload: exact job and holder fixture only; disabled host, wrong owner and near schedule refused.");
  } finally {
    await db.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
