const assert = require('node:assert/strict');
module.exports = async ({db,fixture,stopped,receipt,grant,agent,op,other,connection,order,value,readAgent,rejected,release}) => {
  const allowed = () => value('select public.hivra_provider_desktop_teardown_allowed(a) as result from public.hivra_agents a where id=$1',[agent]);
  const retire = async (owner='owner',operation=op) => {
    const a=await readAgent();
    return value('select public.retire_hivra_provider_target($1,$2,7,$3,$4,\'42\',$5,$6) as result',[owner,connection,a.deployment_target_id,order,agent,operation]);
  };
  await fixture();
  assert.equal(await allowed(),false);
  await db.query("update public.hivra_agents set desired_state='deleted' where id=$1",[agent]);
  await grant();
  assert.equal(await allowed(),false,'a cancellation request is not worker termination');
  assert.equal(await retire(),false);
  await stopped(receipt());
  assert.equal(await allowed(),true);
  assert.equal(await retire('foreign'),false); assert.equal(await retire('owner',other),false);
  await db.exec('set role service_role');
  assert.equal(await retire(),true);
  const result=await value(`select public.claim_hetzner_cleanup_with_firewall('owner',$1,7,$2,$3,$4,repeat('e',64),o.server_name,b.firewall_receipt) as result
    from public.infrastructure_capacity_orders o join public.infrastructure_first_boot_operations b on b.order_id=o.id where o.id=$2`,[connection,order,agent,other]);
  assert.equal(result.outcome,'claimed');
  assert.equal((await readAgent()).operation_id,op,'original provision remains held during provider deletion');
  await rejected(()=>release());
  assert.equal((await readAgent()).provider_install_outcome,'failed');
  await db.exec('reset role');
  await fixture(); await stopped(receipt());
  await db.query("update public.hivra_agents set desired_state='deleted' where id=$1",[agent]);
  assert.equal(await allowed(),false,'no prior cancellation grant');
  assert.equal(await retire(),false);
  console.log('PASS provider desktop teardown: terminal worker plus explicit cancellation permits scoped provider cleanup, not allocation release');
};
