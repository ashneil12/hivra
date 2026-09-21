const assert = require("node:assert/strict");
module.exports = async function desktopPowerSql({ db, fixture, stopped, complete, receipt, agent, op, other, value, readAgent }) {
  const boot = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", nextBoot = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const finish = (owner="owner",ip="203.0.113.10",url="https://desktop.example.test",kind="restart") => value(
    "select public.complete_hivra_provider_desktop_power($1,$2,$3,$4,$5,$6) as result",[owner,agent,other,kind,url,ip]);
  for (const fault of ["clean","unverified","same_boot","stale","owner","ip","origin","deleted"]) {
    await fixture(); assert.equal(await stopped(receipt("succeeded")),true); assert.equal(await complete(),true);
    assert.equal(await value("select public.claim_hivra_provider_power_operation('owner',$1,$2,'restart') as result",[agent,other]),true);
    assert.equal(await value("select public.begin_hivra_provider_power_dispatch('owner',$1,$2,$3) as result",[agent,other,boot]),"dispatch");
    const action={id:81,command:"reboot_server",status:"success",resources:[{id:42,type:"server"}]};
    assert.equal(await value("select public.record_hivra_provider_power_action('owner',$1,$2,$3) as result",[agent,other,action]),true);
    if(fault!=="unverified") {
      const verified=await value("select public.verify_hivra_provider_power_result('owner',$1,$2,clock_timestamp(),'running',$3,true,true) as result",
        [agent,other,fault==="same_boot"?boot:nextBoot]);
      assert.equal(verified,fault!=="same_boot");
    }
    if(fault==="stale") {
      // Isolated test-data aging only; the actual completion function stays
      // byte-for-byte unchanged. Restore the journal guard before acceptance.
      await db.exec("alter table public.hivra_provider_power_operations disable trigger hivra_provider_power_journal_guard");
      try { await db.query("update public.hivra_provider_power_operations set verified_at=verified_at-interval '1 minute' where agent_id=$1 and operation_id=$2",[agent,other]); }
      finally { await db.exec("alter table public.hivra_provider_power_operations enable trigger hivra_provider_power_journal_guard"); }
    }
    if(fault==="deleted") await value("select public.request_hivra_agent_delete('owner',$1,$2) as result",[agent,op]);
    try {
      await db.exec("set role service_role");
      assert.equal(await finish(fault==="owner"?"other":"owner",fault==="ip"?"203.0.113.11":"203.0.113.10",
        fault==="origin"?"https://other.example.test":"https://desktop.example.test"),fault==="clean");
      const row=await readAgent();
      assert.equal(row.operation_id,fault==="clean"?null:other);
      assert.equal(row.allocation_operation_id,op);
      if(fault==="clean") {assert.equal(row.status,"running");assert.equal(row.api_token,null);}
    } finally {
      await db.exec("reset role");
    }
  }
  await fixture();assert.equal(await stopped(receipt("succeeded")),true);assert.equal(await complete(),true);
  const stopOp="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  assert.equal(await value("select public.claim_hivra_provider_power_operation('owner',$1,$2,'stop') as result",[agent,stopOp]),true);
  assert.equal(await value("select public.begin_hivra_provider_power_dispatch('owner',$1,$2,null) as result",[agent,stopOp]),"dispatch");
  assert.equal(await value("select public.record_hivra_provider_power_action('owner',$1,$2,$3) as result",
    [agent,stopOp,{id:82,command:"shutdown_server",status:"success",resources:[{id:42,type:"server"}]}]),true);
  assert.equal(await value("select public.verify_hivra_provider_power_result('owner',$1,$2,clock_timestamp(),'off',null,false,false) as result",[agent,stopOp]),true);
  assert.equal(await value("select public.complete_hivra_agent_operation('owner',$1,$2,'stopped','stopped',null,null) as result",[agent,stopOp]),true);
  assert.equal((await readAgent()).status,"stopped");
  assert.equal(await value("select public.claim_hivra_provider_power_operation('owner',$1,$2,'start') as result",[agent,other]),true);
  assert.equal(await value("select public.begin_hivra_provider_power_dispatch('owner',$1,$2,null) as result",[agent,other]),"dispatch");
  assert.equal(await value("select public.record_hivra_provider_power_action('owner',$1,$2,$3) as result",
    [agent,other,{id:83,command:"start_server",status:"success",resources:[{id:42,type:"server"}]}]),true);
  assert.equal(await finish("owner","203.0.113.10","https://desktop.example.test","start"),false);
  assert.equal(await value("select public.verify_hivra_provider_power_result('owner',$1,$2,clock_timestamp(),'running',$3,true,true) as result",[agent,other,nextBoot]),true);
  assert.equal(await finish("owner","203.0.113.10","https://desktop.example.test","start"),true);
  const restarted=await readAgent();assert.equal(restarted.status,"running");assert.equal(restarted.allocation_operation_id,op);assert.equal(restarted.api_token,null);
  for(const role of ["anon","authenticated"]) {
    assert.equal(await value("select has_function_privilege($1,'public.complete_hivra_provider_desktop_power(text,uuid,uuid,text,text,text)','EXECUTE') as result",[role]),false);
  }
  console.log("PASS desktop power SQL: original allocation, boot proof, fresh finalization, owner/access/delete rejection and service-only ACL");
};
