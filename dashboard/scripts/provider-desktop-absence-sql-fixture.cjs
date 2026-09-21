const assert = require("node:assert/strict");
module.exports = async ({ db, fixture, stopped, receipt, agent, op, other, connection, order, attempt, value, readAgent, rejected }) => {
  const setup = async (terminal = true, deleting = true) => {
    await fixture();
    if (terminal) assert.equal(await stopped(receipt()), true);
    if (deleting) await db.query("update public.hivra_agents set desired_state='deleted' where id=$1", [agent]);
    return readAgent();
  };
  const handoff = async (changes = {}) => {
    const a = await readAgent();
    const p = { user: "owner", agent, op, connection, revision: 7, target: a.deployment_target_id,
      order, attempt, server: "42", observed: new Date().toISOString(), ...changes };
    return value("select public.handoff_hivra_absent_desktop_provision($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as result",
      [p.user,p.agent,p.op,p.connection,p.revision,p.target,p.order,p.attempt,p.server,p.observed]);
  };
  for (const [key,changed] of [["user","foreign"],["op",other],["connection",other],["revision",8],
    ["target",other],["order",other],["attempt",other],["server","43"],["observed",null],
    ["observed","2020-01-01T00:00:00Z"],["observed","2099-01-01T00:00:00Z"]]) {
    await setup(); assert.equal(await handoff({[key]:changed}),false,key);
    assert.equal((await readAgent()).operation_id,op);
  }
  await setup(false); assert.equal(await handoff(),false,"unfinished installer");
  await setup(true,false); assert.equal(await handoff(),false,"no delete intent");
  const before = await setup();
  await rejected(()=>db.exec("update public.hivra_agents set status='error',operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null"));
  await db.exec("set role service_role");
  for (const sql of ["delete from public.hivra_provider_desktop_absence", "update public.hivra_provider_desktop_absence set observed_at=clock_timestamp()",
    "insert into public.hivra_provider_desktop_absence select * from public.hivra_provider_desktop_absence"]) {
    await assert.rejects(()=>db.exec(sql),e=>e.code==="42501");
  }
  assert.equal(await handoff(),true);
  const after = await readAgent();
  assert.equal(after.status,"error"); assert.equal(after.desired_state,"deleted"); assert.equal(after.operation_id,null);
  assert.equal(after.allocation_operation_id,op);
  for (const field of ["provider_install_identity","provider_install_outcome","provider_install_stopped_at",
    "provider_capacity_order_id","provider_server_id","deployment_target_id"]) assert.deepEqual(after[field],before[field]);
  assert.equal(await handoff(),false,"completed handoff is not reusable");
  await db.exec("reset role");
  const stale = await setup();
  await db.query(`insert into public.hivra_provider_desktop_absence values
    ($1,'owner',$2,$3,$4,7,$5,$6,$7,'42',clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 minute')`,
    [agent,op,stale.provider_install_identity,connection,stale.deployment_target_id,order,attempt]);
  await db.exec("set role service_role");
  assert.equal(await handoff(),true,"fresh observation replaces only the same stale binding");
  await db.exec("reset role");
  await setup();
  await db.exec(`create function public.fixture_expire_absence() returns trigger language plpgsql as $$
    begin new.observed_at:=clock_timestamp()-interval '1 minute'; return new; end; $$;
    create trigger fixture_expire_absence before insert on public.hivra_provider_desktop_absence
      for each row execute function public.fixture_expire_absence()`);
  await rejected(()=>handoff());
  assert.equal(await value("select count(*)::int as result from public.hivra_provider_desktop_absence"),0,"expired publication rolls back");
  assert.equal((await readAgent()).operation_id,op);
  await db.exec("drop trigger fixture_expire_absence on public.hivra_provider_desktop_absence; drop function public.fixture_expire_absence()");
  assert.equal(await handoff(),true,"fresh retry after expiration can hand off");
  for (const role of ["anon","authenticated"]) {
    await setup(); await db.exec("set role "+role);
    await assert.rejects(()=>handoff(),e=>e.code==="42501"); await db.exec("reset role");
  }
  console.log("PASS desktop absence SQL: original stopped provision, explicit delete, exact binding, freshness, private proof and non-terminal handoff");
};
