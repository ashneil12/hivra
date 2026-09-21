// Real prior ownership, installer and lifecycle functions; no cloud resources.
const assert = require('node:assert/strict');
module.exports = async function workspaceSql({ db, fixture, stopped, complete, receipt, agent, other, identity, access, value }) {
  const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', origin = 'https://desktop.example.test';
  const code = 'a'.repeat(64), challenge = 'b'.repeat(43), token = 'c'.repeat(64);
  const ready = async () => { await fixture(); assert.equal(await stopped(receipt('succeeded')), true); assert.equal(await complete(), true); };
  const issue = (changes = {}) => {
    const p = { owner: 'owner', computer: agent, id, surface: 'files', audience: origin, identity, access, code, challenge, ...changes };
    return value('select public.issue_hivra_workspace_session($1,$2,$3,$4,$5,$6,$7,$8,$9) as result',
      [p.owner,p.computer,p.id,p.surface,p.audience,p.identity,p.access,p.code,p.challenge]);
  };
  const exchange = (changes = {}) => {
    const p = { id, computer: agent, surface: 'files', audience: origin, code, challenge, token, ...changes };
    return value('select public.exchange_hivra_workspace_session($1,$2,$3,$4,$5,$6,$7) as result',
      [p.id,p.computer,p.surface,p.audience,p.code,p.challenge,p.token]);
  };
  const auth = (changes = {}) => {
    const p = { id, computer: agent, surface: 'files', audience: origin, token, ...changes };
    return value('select public.authorize_hivra_workspace_session($1,$2,$3,$4,$5) as result', [p.id,p.computer,p.surface,p.audience,p.token]);
  };
  await ready();
  for (const change of [{owner:'foreign'}, {computer:other}, {surface:'all'}, {audience:'https://other.test'},
    {identity:{...identity, operationId:other}}, {access:{...access,hostname:'other.test'}}, {code:null}, {challenge:'bad'}]) {
    assert.notEqual((await issue(change)).status, 'issued');
  }
  await db.exec('set role service_role');
  try {
    assert.equal((await issue()).status, 'issued');
    assert.equal((await issue()).status, 'conflict');
    assert.equal((await auth()).status, 'denied');
    for (const change of [{id:other},{computer:other},{surface:'box-terminal'},{audience:'https://other.test'},
      {code:'f'.repeat(64)},{challenge:'x'.repeat(43)},{token:null}]) assert.notEqual((await exchange(change)).status,'exchanged');
    const exchanged = await exchange();
    assert.equal(exchanged.status,'exchanged'); assert.equal(exchanged.userId,'owner');
    assert.equal(exchanged.surface,'files'); assert.equal(exchanged.computerId,agent);
    assert.equal((await exchange()).status,'denied');
    assert.equal((await auth()).status,'authorized');
    for (const change of [{id:other},{computer:other},{surface:'box-terminal'},{audience:'https://other.test'},
      {token:'f'.repeat(64)},{token:null}]) assert.equal((await auth(change)).status,'denied');
    assert.equal(await value("select public.revoke_hivra_workspace_session('foreign',$1) as result",[id]),false);
    assert.equal((await auth()).status,'authorized');
    assert.equal(await value("select public.revoke_hivra_workspace_session('owner',$1) as result",[id]),true);
    assert.equal((await auth()).status,'denied');
    assert.equal(await value("select has_table_privilege('service_role','public.hivra_workspace_sessions','UPDATE') as result"),false);
  } finally { await db.exec('reset role'); }

  await ready(); assert.equal((await issue()).status,'issued'); assert.equal((await exchange()).status,'exchanged');
  // Real lifecycle claim invalidates old authority before the power dispatch.
  assert.equal(await value("select public.claim_hivra_provider_power_operation('owner',$1,$2,'stop') as result",[agent,other]),true);
  assert.equal((await auth()).status,'denied');
  assert.equal(await value('select revoked_at is not null as result from public.hivra_workspace_sessions where id=$1',[id]),true);
  assert.equal((await issue({id:other,code:'d'.repeat(64)})).status,'computer_not_ready');
  assert.equal(await value("select public.begin_hivra_provider_power_dispatch('owner',$1,$2,null) as result",[agent,other]),'dispatch');
  assert.equal(await value("select public.record_hivra_provider_power_action('owner',$1,$2,$3) as result",
    [agent,other,{id:82,command:'shutdown_server',status:'success',resources:[{id:42,type:'server'}]}]),true);
  assert.equal(await value("select public.verify_hivra_provider_power_result('owner',$1,$2,clock_timestamp(),'off',null,false,false) as result",[agent,other]),true);
  assert.equal(await value("select public.complete_hivra_agent_operation('owner',$1,$2,'stopped','stopped',null,null) as result",[agent,other]),true);
  const start = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  assert.equal(await value("select public.claim_hivra_provider_power_operation('owner',$1,$2,'start') as result",[agent,start]),true);
  assert.equal(await value("select public.begin_hivra_provider_power_dispatch('owner',$1,$2,null) as result",[agent,start]),'dispatch');
  assert.equal(await value("select public.record_hivra_provider_power_action('owner',$1,$2,$3) as result",
    [agent,start,{id:83,command:'start_server',status:'success',resources:[{id:42,type:'server'}]}]),true);
  assert.equal(await value("select public.verify_hivra_provider_power_result('owner',$1,$2,clock_timestamp(),'running',$3,true,true) as result",[agent,start,id]),true);
  assert.equal(await value("select public.complete_hivra_provider_desktop_power('owner',$1,$2,'start',$3,'203.0.113.10') as result",[agent,start,origin]),true);
  assert.equal((await auth()).status,'denied');
  assert.equal((await issue({id:other,code:'d'.repeat(64)})).status,'issued');

  await ready(); assert.equal((await issue()).status,'issued');
  await db.exec("update public.hivra_workspace_sessions set issued_at=issued_at-interval '2 minutes',exchange_expires_at=exchange_expires_at-interval '2 minutes',expires_at=expires_at-interval '2 minutes'");
  assert.equal((await exchange()).status,'denied');
  await ready(); assert.equal((await issue()).status,'issued'); assert.equal((await exchange()).status,'exchanged');
  await db.exec("update public.hivra_workspace_sessions set issued_at=issued_at-interval '5 minutes',exchange_expires_at=exchange_expires_at-interval '5 minutes',expires_at=expires_at-interval '5 minutes'");
  assert.equal((await auth()).status,'denied');
  await ready(); assert.equal((await issue()).status,'issued'); assert.equal((await exchange()).status,'exchanged');
  // Existing parent guard already forbids disabling an allocated connection;
  // do not disable that guard merely to exercise a hypothetical transition.
  await assert.rejects(db.exec("update public.infrastructure_connections set status='disabled'"), error => error.code === '55006');
  assert.equal((await auth()).status,'authorized');
  await db.exec("update public.infrastructure_connections set status='error'");
  assert.equal((await auth()).status,'denied');
  await db.exec("update public.infrastructure_connections set status='ready'");
  assert.equal((await auth()).status,'denied');
  assert.equal((await issue({id:other,code:'d'.repeat(64)})).status,'issued');
  for (const role of ['anon','authenticated']) {
    for (const fn of ['issue_hivra_workspace_session(text,uuid,uuid,text,text,jsonb,jsonb,text,text)',
      'exchange_hivra_workspace_session(uuid,uuid,text,text,text,text,text)',
      'authorize_hivra_workspace_session(uuid,uuid,text,text,text)','revoke_hivra_workspace_session(text,uuid)']) {
      assert.equal(await value('select has_function_privilege($1,$2,\'EXECUTE\') as result',[role,'public.'+fn]),false);
    }
    assert.equal(await value('select has_table_privilege($1,\'public.hivra_workspace_sessions\',\'SELECT\') as result',[role]),false);
  }
  console.log('PASS workspace SQL: real provider authority, one-use exchange, scope binding, expiry, owner revocation, lifecycle invalidation and ACL');
};
