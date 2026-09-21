// Actual legacy lifecycle and canonical migrations; isolated PostgreSQL only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
async function main() {
  const db = new PGlite();
  const dir = path.resolve(__dirname, '../supabase/migrations');
  const migration = name => fs.readFileSync(path.join(dir, name), 'utf8');
  const value = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.result;
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
      create function public.update_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end; $$;
      create function public.requesting_user_id() returns text language sql as $$ select 'owner'::text; $$;
      create function public.digest(text,text) returns bytea language sql as $$ select sha256(convert_to($1,'UTF8')); $$;
      create table public.managed_venice_proxy_keys(id uuid primary key,user_id text,status text);`);
    await db.exec(migration('20260605120000_hivra_agents.sql'));
    await db.exec('alter table public.hivra_agents add column llm_config jsonb, add column llm_api_key_encrypted text');
    for (const file of fs.readdirSync(dir).filter(name => /^202608(?:2[56789]|3[01])/.test(name)
      || ['20260901020000_hivra_remote_desktop_sessions.sql','20260903010000_hivra_computer_profiles.sql'].includes(name)).sort()) await db.exec(migration(file));
    // Pool billing and channel deployment are independent of lease admission.
    await db.exec(`alter table public.hivra_agents add column pool_id uuid,
      add column managed_provisioner_channel text not null default 'default';
      create table public.hermes_instances(id uuid primary key,user_id text,name text,status text,
        lifecycle_state text,backend text,agent_type text,host_id uuid,pool_id uuid,product_surface text,
        infrastructure_provider text,proxmox_node text,proxmox_vmid integer,cpu_limit integer,ram_limit integer);`);
    for (const file of ['20260904100000_hivra_canonical_resource_shadow.sql',
      '20260905150000_hivra_desktop_prepare_lifecycle.sql',
      '20260906150000_hivra_canonical_binding_provenance.sql',
      '20260906160000_hivra_canonical_parity_coverage.sql',
      '20260906170000_hivra_canonical_relationship_authority.sql']) {
      try { await db.exec(migration(file)); } catch (error) { throw new Error(`${file}: ${error.message}`); }
    }
    await db.exec(migration('20260906190000_hivra_attachment_lease.sql'));
    await db.exec(migration('20260906200000_hivra_attachment_dispatch.sql'));
    await db.exec(migration('20260906210000_hivra_attachment_installation_reservation.sql'));
    await db.exec(migration('20260906220000_hivra_attachment_guest_observation.sql'));
    await db.exec(migration('20260906230000_hivra_attachment_staging_result.sql'));
    await db.exec(migration('20260906233000_hivra_attachment_execution_snapshot.sql'));
    await db.exec(migration('20260906234000_hivra_attachment_activation_dispatch.sql'));
    await db.exec(migration('20260906235000_hivra_attachment_activation_observations.sql'));
    await db.exec(migration('20260907010000_hivra_attachment_native_observations.sql'));
    const snapshots = [];
    let activationEvidence;
    const readExecution = (operation, owner='owner') => value(
      'select public.read_hivra_attachment_execution($1,$2) as result', [owner,operation]);
    let id='11111111-1111-4111-8111-111111111111';
    const op='22222222-2222-4222-8222-222222222222';
    const transfer='33333333-3333-4333-8333-333333333333', next='44444444-4444-4444-8444-444444444444';
    const identity='55555555-5555-4555-8555-555555555555';
    await db.query(`insert into public.hivra_agents(id,user_id,type,name,status,desired_state,computer_profile,
      computer_substrate,proxmox_host,vmid,ip,infrastructure_binding_token_hash,infrastructure_binding_token_enforced,
      managed_provisioner_channel) values($1,'owner','linux-desktop','Ubuntu','running','running','ubuntu-desktop',
      'proxmox-kvm','local',1123,'10.241.0.23',repeat('a',64),true,'canary')`,[id]);
    let mapping = await value('select to_jsonb(m) as result from public.hivra_canonical_source_mappings m where source_id=$1',[id]);
    let authority = await value('select public.hivra_desktop_prepare_authority(a) as result from public.hivra_agents a where id=$1',[id]);
    const intent = { agentIdentityId:identity, runtimeId:'codex', agentName:'Attached agent', installerSha256:'77d72e2e8346cc19ef74264e8458bbca8802772d1c668c3fdffa653c4273d375' };
    const begin = (operation=op, owner='owner', generation=2, expected=authority, requested=intent) => value(
      'select public.begin_hivra_agent_attachment($1,$2,$3,$4,$5::jsonb,$6::jsonb) as result',
      [owner,mapping.computer_id,operation,generation,JSON.stringify(expected),JSON.stringify(requested)]);
    assert.equal(await begin(),null,'legacy relationship authority cannot admit attachment');
    await value('select public.transfer_hivra_canonical_relationship_authority($1,$2,$3,1,$4) as result',
      ['owner',mapping.computer_id,mapping.last_source_event_id,transfer]);
    assert.equal((await value("select public.begin_hivra_desktop_prepare('owner',$1,$2,$3::jsonb) as result",
      [id,next,JSON.stringify(authority)])).phase,'claimed','existing preparation still admits after the new migration');
    assert.equal(await begin(),null,'desktop preparation and attachment share one slot');
    assert.equal(await value("select public.cancel_undispatched_hivra_desktop_prepare('owner',$1) as result",[next]),true);
    assert.equal(await begin(op,'other'),null);
    assert.equal(await begin(op,'owner',1),null);
    assert.equal(await begin(op,'owner',2,{...authority,vmid:1144}),null);
    assert.equal(await begin(op,'owner',2,authority,{...intent,command:'arbitrary'}),null);
    assert.equal(await value("select public.claim_hivra_agent_operation('owner',$1,$2,'restart','running',null) as result",[id,next]),true);
    assert.equal(await begin(),null,'ordinary lifecycle wins admission');
    await value("select public.release_hivra_agent_operation('owner',$1,$2,null,false) as result",[id,next]);
    await db.exec(`create function public.fixture_reject_attachment_outbox() returns trigger language plpgsql as $$
      begin raise exception 'fixture outbox failure' using errcode='55000'; end; $$;
      create trigger fixture_reject_attachment_outbox before insert on public.hivra_agent_attachment_outbox
      for each row execute function public.fixture_reject_attachment_outbox();`);
    await assert.rejects(()=>begin(),{code:'55000'});
    assert.equal(await value('select count(*) as result from public.hivra_agent_attachments'),0);
    assert.equal(await value('select operation_id is null as result from public.hivra_agents where id=$1',[id]),true,
      'journal/outbox failure must roll back the shared lifecycle reservation');
    await db.exec('drop trigger fixture_reject_attachment_outbox on public.hivra_agent_attachment_outbox; drop function public.fixture_reject_attachment_outbox()');
    assert.deepEqual(await begin(),{operationId:op,phase:'claimed',resumed:false});
    const claimedSnapshot = await readExecution(op);
    assert.equal(claimedSnapshot.phase,'claimed');
    assert.equal(claimedSnapshot.installation,null);
    assert.equal(claimedSnapshot.observation,null);
    assert.equal(claimedSnapshot.dispatchId,null);
    assert.equal(claimedSnapshot.staged,null);
    assert.equal(claimedSnapshot.generation,'2');
    assert.deepEqual(claimedSnapshot.guestAuthority,authority);
    assert.equal(await readExecution(op,'other'),null);
    snapshots.push(claimedSnapshot);
    assert.equal(await value('select count(*) as result from public.hivra_canonical_source_events where processed_at is null'),0);
    assert.equal(await value('select operation_state as result from public.hivra_canonical_computers where id=$1',[mapping.computer_id]),'unknown',
      'newer lease kinds must remain visibly occupied instead of failing projection or looking idle');
    assert.equal(await value('select operation_id::text as result from public.hivra_canonical_computers where id=$1',[mapping.computer_id]),op);
    assert.deepEqual(await begin(),{operationId:op,phase:'claimed',resumed:true});
    assert.equal(await begin(next),null,'a new command cannot silently reuse another command');
    assert.equal(await begin(op,'owner',2,authority,{...intent,agentName:'Different'}),null);
    assert.equal(await value("select public.claim_hivra_agent_operation('owner',$1,$2,'restart','running',null) as result",[id,next]),false);
    for (const [kind,desired,payload] of [['start','running',null],['stop','stopped',null],
      ['resize','running',{cpu:4,ram:8}],['snapshot','running',{snapshotId:next,providerSnapshotId:'hivra_'+next.replaceAll('-','')}],
      ['restore','stopped',{snapshotId:next,providerSnapshotId:'hivra_'+next.replaceAll('-','')}]]) {
      assert.equal(await value("select public.claim_hivra_agent_operation('owner',$1,$2,$3,$4,$5::jsonb) as result",
        [id,next,kind,desired,payload===null?null:JSON.stringify(payload)]),false,`${kind} cannot take the attachment slot`);
    }
    assert.equal(await value('select count(*) as result from public.hivra_canonical_agent_identities'),0,'claim is not an installed agent');
    assert.equal(await value('select count(*) as result from public.hivra_agent_attachment_outbox'),1);
    for (const set of ["operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null",
      "operation_kind='restart'", "operation_started_at=operation_started_at-interval '1 hour'", "operation_payload='{}'", "status='stopped'", "vmid=1144", "user_id='other'", "managed_provisioner_channel='default'"]) {
      await assert.rejects(()=>db.query(`update public.hivra_agents set ${set} where id=$1`,[id]));
    }
    await assert.rejects(()=>value("select public.release_hivra_agent_operation('owner',$1,$2,'timeout',true) as result",[id,op]));
    await assert.rejects(()=>value(`select public.claim_hivra_agent_operation_recovery('owner',id,operation_id,
      operation_started_at,operation_started_at+interval '1 hour') as result from public.hivra_agents where id=$1`,[id]),{code:'55000'});
    await assert.rejects(()=>db.query('delete from public.hivra_agents where id=$1',[id]));
    assert.equal(await value("select public.request_hivra_agent_delete('owner',$1,$2) as result",[id,next]),'pending');
    assert.equal(await value('select public.dispatch_hivra_agent_attachment($1,$2,$3,2,$4::jsonb,$5) as result',
      ['owner',op,next,JSON.stringify(authority),intent.installerSha256]),false,'pending deletion prevents dispatch');
    await assert.rejects(()=>db.query("update public.hivra_agents set desired_state='running' where id=$1",[id]));
    assert.equal(await value("select public.cancel_undispatched_hivra_agent_attachment('other',$1) as result",[op]),false);
    assert.equal(await value("select public.cancel_undispatched_hivra_agent_attachment('owner',$1) as result",[op]),true);
    assert.deepEqual(await begin(),{operationId:op,phase:'cancelled',resumed:true});
    assert.equal(await value("select desired_state='deleted' and operation_id is null as result from public.hivra_agents where id=$1",[id]),true);
    assert.equal(await value("select public.request_hivra_agent_delete('owner',$1,$2) as result",[id,next]),'claimed');
    // A fresh computer: do not resurrect the cancelled/deleting fixture.
    id='77777777-7777-4777-8777-777777777777';
    await db.query(`insert into public.hivra_agents(id,user_id,type,name,status,desired_state,computer_profile,
      computer_substrate,proxmox_host,vmid,ip,infrastructure_binding_token_hash,infrastructure_binding_token_enforced,
      managed_provisioner_channel) values($1,'owner','linux-desktop','Second Ubuntu','running','running','ubuntu-desktop',
      'proxmox-kvm','local',1144,'10.241.0.44',repeat('d',64),true,'canary')`,[id]);
    mapping = await value('select to_jsonb(m) as result from public.hivra_canonical_source_mappings m where source_id=$1',[id]);
    authority = await value('select public.hivra_desktop_prepare_authority(a) as result from public.hivra_agents a where id=$1',[id]);
    await value("select public.transfer_hivra_canonical_relationship_authority('owner',$1,$2,1,$3) as result",
      [mapping.computer_id,mapping.last_source_event_id,'88888888-8888-4888-8888-888888888888']);
    assert.equal((await begin(next)).phase,'claimed');
    const attempt='66666666-6666-4666-8666-666666666666';
    const dispatch = (owner='owner',generation=2,expected=authority,digest=intent.installerSha256,command=next) => value(
      'select public.dispatch_hivra_agent_attachment($1,$2,$3,$4,$5::jsonb,$6) as result',
      [owner,command,attempt,generation,JSON.stringify(expected),digest]);
    assert.equal(await dispatch('other'),false);
    assert.equal(await dispatch('owner',1),false);
    assert.equal(await dispatch('owner',2,{...authority,vmid:1155}),false);
    assert.equal(await dispatch('owner',2,authority,'c'.repeat(64)),false);
    assert.equal(await dispatch('owner',2,authority,intent.installerSha256,op),false,'cancelled command cannot dispatch');
    await assert.rejects(()=>dispatch(),{code:'55000'},'dispatch cannot invent an installation ID');
    const installation='99999999-9999-4999-8999-999999999999', binding='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const reserve=(owner='owner',generation=2,install=installation,primary=binding,architecture='x86_64') => value(
      'select public.reserve_hivra_attachment_installation($1,$2,$3,$4,$5,$6) as result',[owner,next,generation,install,primary,architecture]);
    const boot='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const worker='2a0aee3e5e3fc0d4403d41a93dbece648648c8a84ab4349a71d7fe87243121ab';
    const observe=(owner='owner',generation=2,expected=authority,observedBoot=boot,digest=worker,command=next) => value(
      'select public.observe_hivra_attachment_guest($1,$2,$3,$4::jsonb,$5,$6) as result',
      [owner,command,generation,JSON.stringify(expected),observedBoot,digest]);
    assert.equal(await observe(),false,'installation reservation must precede guest observation');
    assert.equal(await reserve('other'),false);
    assert.equal(await reserve('owner',1),false);
    assert.equal(await reserve('owner',2,installation,binding,'windows'),false);
    await db.exec('begin');
    await db.query(`insert into public.hivra_canonical_runtime_installations(id,user_id,computer_id,runtime_id,status,source_event_id)
      values($1,'owner',$2,'codex','removed',$3)`,[installation,mapping.computer_id,mapping.last_source_event_id]);
    assert.equal(await reserve(),false,'even a removed runtime keeps its historical ID');
    await db.exec('rollback');
    assert.equal(await reserve(),true);
    assert.equal(await reserve(),true,'exact reservation replay is harmless');
    assert.equal(await reserve('owner',2,op),false,'installation ID cannot be replaced');
    assert.equal(await reserve('owner',2,installation,op),false,'binding ID cannot be replaced');
    assert.equal(await reserve('owner',2,installation,binding,'aarch64'),false,'architecture cannot be replaced');
    assert.equal(await value('select count(*) as result from public.hivra_agent_attachment_installations'),1);
    assert.equal(await value('select count(*) as result from public.hivra_canonical_runtime_installations'),0,'reserved IDs are not installed runtime records');
    await assert.rejects(()=>db.query(`insert into public.hivra_agent_attachment_installations
      (operation_id,installation_id,binding_id,architecture,installer_sha256) values($1,$2,$3,'x86_64',$4)`,
      [op,installation,op,intent.installerSha256]),{code:'23505'},'installation reservation cannot be reused by another command');
    await assert.rejects(()=>db.query(`insert into public.hivra_agent_attachment_installations
      (operation_id,installation_id,binding_id,architecture,installer_sha256) values($1,$2,$3,'x86_64',$4)`,
      [op,op,binding,intent.installerSha256]),{code:'23505'},'binding reservation cannot be reused by another command');
    await assert.rejects(()=>dispatch(),{code:'55000'},'reserved installation without boot observation cannot dispatch');
    assert.equal(await observe('other'),false);
    assert.equal(await observe('owner',1),false);
    assert.equal(await observe('owner',2,{...authority,vmid:1155}),false);
    assert.equal(await observe('owner',2,authority,boot,'0'.repeat(64)),false);
    assert.equal(await observe('owner',2,authority,null),false);
    assert.equal(await observe('owner',2,authority,boot,worker,op),false,'cancelled operation cannot gain boot observation');
    assert.equal(await observe(),true);
    const savedObservation=await value('select to_jsonb(r) as result from public.hivra_agent_attachment_guest_observations r where operation_id=$1',[next]);
    assert.equal(await observe(),true);
    assert.deepEqual(await value('select to_jsonb(r) as result from public.hivra_agent_attachment_guest_observations r where operation_id=$1',[next]),savedObservation,'replay never refreshes observation time');
    assert.equal(await observe('owner',2,authority,op),false,'boot identity cannot be replaced');
    for (const offset of ["-interval '6 minutes'", "+interval '6 minutes'"]) {
      await db.exec('begin');
      await db.query(`update public.hivra_agent_attachment_guest_observations set observed_at=clock_timestamp()${offset} where operation_id=$1`,[next]);
      await assert.rejects(()=>dispatch(),{code:'55000'},'stale or future observation cannot dispatch');
      await db.exec('rollback');
    }
    await db.exec(`create function public.fixture_reject_attachment_dispatch() returns trigger language plpgsql as $$
      begin raise exception 'fixture dispatch event failure' using errcode='55000'; end; $$;
      create trigger fixture_reject_attachment_dispatch before insert on public.hivra_agent_attachment_dispatches
      for each row execute function public.fixture_reject_attachment_dispatch();`);
    await assert.rejects(()=>dispatch(),{code:'55000'});
    assert.equal(await value('select phase as result from public.hivra_agent_attachments where id=$1',[next]),'claimed');
    assert.equal(await value('select dispatch_id is null and dispatched_at is null as result from public.hivra_agent_attachments where id=$1',[next]),true);
    await db.exec('drop trigger fixture_reject_attachment_dispatch on public.hivra_agent_attachment_dispatches; drop function public.fixture_reject_attachment_dispatch()');
    assert.equal(await dispatch(),true);
    assert.equal(await dispatch(),false,'lost acknowledgement does not grant another dispatch');
    assert.equal(await observe(),true,'post-dispatch observation replay is read-only, not another execution grant');
    await db.exec('begin');
    await db.query('delete from public.hivra_agent_attachment_guest_observations where operation_id=$1',[next]);
    assert.equal(await observe(),false,'an older dispatched operation cannot acquire an invented boot observation');
    assert.equal(await value('select count(*) as result from public.hivra_agent_attachment_guest_observations where operation_id=$1',[next]),0);
    await db.exec('rollback');
    assert.equal(await reserve(),true,'post-dispatch replay returns the same reservation without a new grant');
    assert.deepEqual(await begin(next),{operationId:next,phase:'dispatched',resumed:true});
    const dispatchedSnapshot = await readExecution(next);
    assert.equal(dispatchedSnapshot.phase,'dispatched');
    assert.equal(dispatchedSnapshot.dispatchId,attempt);
    assert.equal(dispatchedSnapshot.installation.installationId,installation);
    assert.equal(dispatchedSnapshot.observation.bootId,boot);
    assert.equal(dispatchedSnapshot.staged,null);
    assert.equal(await readExecution(op),null,'cancelled attachment is not executable');
    snapshots.push(dispatchedSnapshot);
    assert.equal(await value('select count(*) as result from public.hivra_agent_attachment_dispatches'),1);
    assert.equal(await value("select public.cancel_undispatched_hivra_agent_attachment('owner',$1) as result",[next]),false);
    await assert.rejects(()=>value("select public.release_hivra_agent_operation('owner',$1,$2,'timeout',true) as result",[id,next]),{code:'55000'});
    await assert.rejects(()=>value(`select public.claim_hivra_agent_operation_recovery('owner',id,operation_id,
      operation_started_at,operation_started_at+interval '1 hour') as result from public.hivra_agents where id=$1`,[id]),{code:'55000'});
    const staged={version:1,phase:'staged',bootId:boot,identity:{operationId:next,dispatchId:attempt,
      installationId:installation,bindingId:binding,computerId:mapping.computer_id,sourceId:id,architecture:'x86_64'},
      receipt:{version:1,state:'staged',operationId:next,installationId:installation,runtimeId:'codex',runtimeVersion:'0.149.1',
        architecture:'x86_64',archiveSha256:'e24fb784c7d71140d67afb620f56e9137496cf7f6c9e19217fa3666dcf306278',
        binarySha256:'73dc5888888f411c1f0fa7b81d866e721dcc86b527ce8e3b2cf4708661e823ba',uid:1001,gid:1001,
        account:'hva_'+installation.replaceAll('-','').slice(0,24),home:'/var/lib/hivra/agent-homes/'+installation,
        executable:'/opt/hivra/agent-installations/'+installation+'/codex'}};
    const record=(result=staged,owner='owner',generation=2,expected=authority,observedBoot=boot,command=next)=>value(
      'select public.record_hivra_attachment_staging_result($1,$2,$3,$4::jsonb,$5,$6::jsonb) as result',
      [owner,command,generation,JSON.stringify(expected),observedBoot,JSON.stringify(result)]);
    assert.equal(await record(staged,'other'),false);
    assert.equal(await record(staged,'owner',1),false);
    assert.equal(await record(staged,'owner',2,{...authority,vmid:1155}),false);
    assert.equal(await record(staged,'owner',2,authority,op),false,'a new boot cannot complete an old dispatch');
    assert.equal(await record(staged,'owner',2,authority,boot,op),false,'cancelled command cannot record staging');
    for (const key of Object.keys(staged.identity)) {
      assert.equal(await record({...staged,identity:{...staged.identity,[key]:key==='architecture'?'aarch64':op}}),false,
        `result must match reserved ${key}`);
    }
    for (const result of [null,[],{}, {...staged,phase:'ready'},{...staged,extra:true},{...staged,receipt:null},
      {...staged,receipt:[]},{...staged,receipt:1},{...staged,receipt:'invalid'},
      {...staged,identity:{...staged.identity,dispatchId:op}},{...staged,bootId:op},
      ...[{uid:true},{gid:null},{uid:0},{gid:4294967295},{uid:1.5},{uid:1e100},{binarySha256:'0'.repeat(64)},
        {state:'ready'},{home:'/root'},{extra:true},{operationId:op}].map(change=>({...staged,receipt:{...staged.receipt,...change}}))]) {
      assert.equal(await record(result),false,'invalid or mismatched staging evidence is refused');
    }
    assert.equal(await value('select count(*) as result from public.hivra_agent_attachment_staging_results'),0);
    const activationId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const policy='66f89162530b682aa66d8a59250f385530726a162def8902ffb7bc953eee9428';
    // Actual generated unit digest for this installation; TS cross-contract test
    // independently renders the committed builder against the SQL result.
    const unitDigest='5ffcd12dda7c2969c6a79405db301f888043f3fd8b6bb03e359459e047899f8c';
    const activate=(overrides={})=> {
      const p={owner:'owner',operation:next,activationId,generation:2,authority,boot,staged,policy,unit:unitDigest,...overrides};
      return value('select public.dispatch_hivra_attachment_activation($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9) as result',
        [p.owner,p.operation,p.activationId,p.generation,JSON.stringify(p.authority),p.boot,JSON.stringify(p.staged),p.policy,p.unit]);
    };
    const readActivation=(owner='owner',operation=next)=>value(
      'select public.read_hivra_attachment_activation($1,$2) as result',[owner,operation]);
    assert.equal(await activate(),false,'no service dispatch before exact staging is recorded');
    assert.equal(await readActivation(),null);
    // Isolate successful activation from the pending-deletion staging cases.
    await db.exec('begin');
    assert.equal(await record(),true);
    for(const change of [{owner:'other'},{operation:op},{generation:1},{authority:{...authority,vmid:1155}},
      {boot:op},{staged:{...staged,receipt:{...staged.receipt,uid:1002}}},{staged:null},{policy:'0'.repeat(64)},
      {unit:null},{unit:'B'.repeat(64)},{unit:'b'.repeat(64)+'\n'},{unit:'short'}]) {
      assert.equal(await activate(change),false,'reject unbound activation request');
    }
    await db.exec('savepoint stale_projection');
    await db.query("update public.hivra_canonical_computers set observed_state='stopped' where id=$1",[mapping.computer_id]);
    assert.equal(await activate(),false,'stale canonical state blocks activation');
    await db.exec('rollback to savepoint stale_projection');
    await db.exec('savepoint competing_runtime');
    await db.query(`insert into public.hivra_canonical_runtime_installations(id,user_id,computer_id,runtime_id,status,source_event_id)
      values($1,'owner',$2,'codex','installing',$3)`,[installation,mapping.computer_id,mapping.last_source_event_id]);
    assert.equal(await activate(),false,'a competing canonical runtime blocks activation');
    await db.exec('rollback to savepoint competing_runtime');
    await db.exec(`create function public.fixture_reject_activation_outbox() returns trigger language plpgsql as $$
      begin raise exception 'fixture activation event failure' using errcode='55000'; end; $$;
      create trigger fixture_reject_activation_outbox before insert on public.hivra_agent_attachment_activation_outbox
      for each row execute function public.fixture_reject_activation_outbox(); savepoint activation_event;`);
    await assert.rejects(()=>activate(),{code:'55000'});
    await db.exec('rollback to savepoint activation_event');
    assert.equal(await readActivation(),null,'event failure rolls back activation grant');
    await db.exec('drop trigger fixture_reject_activation_outbox on public.hivra_agent_attachment_activation_outbox; drop function public.fixture_reject_activation_outbox()');
    assert.equal(await activate(),true);
    const activation=await readActivation();
    assert.equal(activation.activationId,activationId);
    assert.equal(activation.serviceDefinitionSha256,unitDigest);
    assert.equal(activation.servicePolicySha256,policy);
    assert.deepEqual(activation.staged,staged);
    assert.equal(activation.generation,'2');
    activationEvidence={execution:await readExecution(next),activation};
    assert.equal(await activate(),false,'lost acknowledgement never grants a second start');
    assert.equal(await activate({activationId:op}),false,'new activation ID cannot replace existing grant');
    assert.deepEqual(await readActivation(),activation,'replays preserve durable evidence');
    assert.equal(await readActivation('other'),null);
    await db.exec('set role service_role');
    assert.deepEqual(await readActivation(),activation,'service-role owner-scoped read returns the actual saved grant');
    assert.equal(await readActivation('other'),null);
    await db.exec('reset role');
    assert.equal(await value('select count(*) as result from public.hivra_agent_attachment_activation_outbox'),1);
    const observationId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const activationObservation={version:1,state:'process_running',journalPhase:'service_started',operationId:next,
      activationId,installationId:installation,bootId:boot,serviceDefinitionSha256:unitDigest,mainPid:4321};
    const recordObservation=(changes={})=> {
      const p={owner:'owner',operation:next,generation:2,authority,request:activation,observationId,result:activationObservation,...changes};
      return value('select public.record_hivra_attachment_activation_observation($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb) as result',
        [p.owner,p.operation,p.generation,JSON.stringify(p.authority),JSON.stringify(p.request),p.observationId,JSON.stringify(p.result)]);
    };
    for (const changes of [{owner:'other'},{operation:op},{generation:1},{authority:{...authority,vmid:1155}},
      {request:{...activation,activationId:op}},...[
        null,[],{}, {...activationObservation,ready:true}, {...activationObservation,state:null},
        {...activationObservation,activationId:op},{...activationObservation,bootId:op},
        {...activationObservation,installationId:op},{...activationObservation,serviceDefinitionSha256:'0'.repeat(64)},
        {...activationObservation,journalPhase:'preparing'}, {...activationObservation,mainPid:0},
        {...activationObservation,mainPid:'4321'},{...activationObservation,mainPid:1e100},
        {...activationObservation,mainPid:2147483648},{...activationObservation,state:'service_inactive'},
      ].map(result=>({result}))]) assert.equal(await recordObservation(changes),false,'invalid observations do not become evidence');
    await db.exec(`create function public.fixture_reject_observation_outbox() returns trigger language plpgsql as $$
      begin raise exception 'fixture observation event failure' using errcode='55000'; end; $$;
      create trigger fixture_reject_observation_outbox before insert on public.hivra_agent_attachment_activation_observation_outbox
      for each row execute function public.fixture_reject_observation_outbox(); savepoint observation_event;`);
    await assert.rejects(()=>recordObservation(),{code:'55000'});
    await db.exec('rollback to savepoint observation_event');
    assert.equal(await value('select count(*) as result from public.hivra_agent_attachment_activation_observations'),0);
    await db.exec('drop trigger fixture_reject_observation_outbox on public.hivra_agent_attachment_activation_observation_outbox; drop function public.fixture_reject_observation_outbox()');
    assert.equal(await recordObservation(),true);
    const observationRow=await value('select to_jsonb(o) as result from public.hivra_agent_attachment_activation_observations o where observation_id=$1',[observationId]);
    activationEvidence.observation=observationRow.result;
    activationEvidence.observationId=observationId;
    assert.equal(await recordObservation(),true,'exact observation replay does not mutate');
    assert.deepEqual(await value('select to_jsonb(o) as result from public.hivra_agent_attachment_activation_observations o where observation_id=$1',[observationId]),observationRow);
    const inactive={...activationObservation,state:'service_inactive'}; delete inactive.mainPid;
    assert.equal(await recordObservation({result:inactive}),false,'conflicting observation ID is never overwritten');
    await db.exec('savepoint observation_pending_delete');
    assert.equal(await value("select public.request_hivra_agent_delete('owner',$1,$2) as result",[id,op]),'pending');
    assert.equal(await recordObservation({observationId:op,result:inactive}),true,'pending delete may record inactivity, not release');
    assert.equal(await value('select operation_id::text as result from public.hivra_agents where id=$1',[id]),next);
    assert.equal(await activate(),false);
    await db.exec('rollback to savepoint observation_pending_delete');
    assert.equal(await value('select count(*) as result from public.hivra_agent_attachment_activation_observation_outbox'),1);
    await db.exec('savepoint native_observation');
    const nativeId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const nativeObservation={...activationObservation,state:'native_protocol_available'};
    assert.equal(await recordObservation({observationId:nativeId,result:nativeObservation}),true,'native protocol evidence is recorded separately from generic process status');
    const nativeRow=await value('select to_jsonb(o) as result from public.hivra_agent_attachment_activation_observations o where observation_id=$1',[nativeId]);
    assert.deepEqual(nativeRow.result,nativeObservation);
    activationEvidence.nativeObservation=nativeRow.result;
    activationEvidence.nativeObservationId=nativeId;
    assert.equal(await recordObservation({observationId:nativeId,result:nativeObservation}),true);
    assert.deepEqual(await value('select to_jsonb(o) as result from public.hivra_agent_attachment_activation_observations o where observation_id=$1',[nativeId]),nativeRow);
    assert.equal(await recordObservation({observationId:nativeId}),false,'native evidence is never overwritten by generic process evidence');
    assert.equal(await recordObservation({result:nativeObservation}),false,'generic evidence is never promoted in place');
    const invalidNativeId='ffffffff-ffff-4fff-8fff-ffffffffffff';
    for (const change of [{state:'ready'},{ready:true},{mainPid:null},{mainPid:true},{mainPid:1},{mainPid:'4321'},
      {journalPhase:'preparing'},{activationId:op},{bootId:op},{installationId:op}])
      assert.equal(await recordObservation({observationId:invalidNativeId,result:{...nativeObservation,...change}}),false);
    for (const changes of [{owner:'other'},{generation:1},{authority:{...authority,vmid:1155}}])
      assert.equal(await recordObservation({...changes,observationId:invalidNativeId,result:nativeObservation}),false);
    assert.equal(await value('select count(*) as result from public.hivra_agent_attachment_activation_observations where observation_id=$1',[invalidNativeId]),0);
    assert.equal(await value('select count(*) as result from public.hivra_agent_attachment_activation_observation_outbox where observation_id=$1',[invalidNativeId]),0);
    await db.exec(`create function public.fixture_reject_native_event() returns trigger language plpgsql as $$
      begin raise exception 'fixture native event failure' using errcode='55000'; end; $$;
      create trigger fixture_reject_native_event before insert on public.hivra_agent_attachment_activation_observation_outbox
      for each row execute function public.fixture_reject_native_event(); savepoint native_event;`);
    await assert.rejects(()=>recordObservation({observationId:op,result:nativeObservation}),{code:'55000'});
    await db.exec('rollback to savepoint native_event');
    assert.equal(await value('select count(*) as result from public.hivra_agent_attachment_activation_observations where observation_id=$1',[op]),0);
    await db.exec('drop trigger fixture_reject_native_event on public.hivra_agent_attachment_activation_observation_outbox; drop function public.fixture_reject_native_event()');
    assert.equal(await value("select public.request_hivra_agent_delete('owner',$1,$2) as result",[id,op]),'pending');
    assert.equal(await recordObservation({observationId:op,result:nativeObservation}),true,'pending deletion may record native evidence but cannot release');
    assert.equal(await value('select operation_id::text as result from public.hivra_agents where id=$1',[id]),next);
    await db.exec('rollback to savepoint native_observation');
    assert.equal(await value('select count(*) as result from public.hivra_canonical_runtime_installations'),0);
    await assert.rejects(()=>value("select public.release_hivra_agent_operation('owner',$1,$2,null,false) as result",[id,next]),{code:'55000'});
    await db.exec('rollback');
    assert.equal(await readActivation(),null);
    assert.equal(await value("select public.request_hivra_agent_delete('owner',$1,$2) as result",[id,op]),'pending');
    assert.equal(await value("select operation_id::text as result from public.hivra_agents where id=$1",[id]),next);
    assert.equal(await record(),true,'pending deletion may record evidence but cannot activate or unlock');
    assert.equal(await activate(),false,'pending deletion blocks service activation despite exact staged bytes');
    const stagedSnapshot = await readExecution(next);
    assert.deepEqual(stagedSnapshot.staged,staged);
    assert.equal(stagedSnapshot.desiredState,'deleted');
    snapshots.push(stagedSnapshot);
    const savedResult=await value('select to_jsonb(r) as result from public.hivra_agent_attachment_staging_results r where operation_id=$1',[next]);
    assert.equal(await record(),true,'exact result replay succeeds without mutation');
    assert.deepEqual(await value('select to_jsonb(r) as result from public.hivra_agent_attachment_staging_results r where operation_id=$1',[next]),savedResult);
    assert.equal(await record({...staged,receipt:{...staged.receipt,uid:1002}}),false,'even otherwise valid conflicting results cannot replace evidence');
    assert.equal(await value('select count(*) as result from public.hivra_canonical_runtime_installations'),0);
    assert.equal(await value('select count(*) as result from public.hivra_canonical_agent_identities'),0);
    assert.equal(await value('select count(*) as result from public.hivra_canonical_primary_bindings'),0);
    assert.equal(await value('select phase as result from public.hivra_agent_attachments where id=$1',[next]),'dispatched');
    assert.equal(await value('select operation_id::text as result from public.hivra_agents where id=$1',[id]),next);
    await assert.rejects(()=>value("select public.release_hivra_agent_operation('owner',$1,$2,null,false) as result",[id,next]),{code:'55000'});
    for (const role of ['anon','authenticated','service_role']) {
      await db.exec(`set role ${role}`);
      if (role === 'service_role') {
        assert.deepEqual(await readExecution(next),stagedSnapshot);
        assert.equal(await readExecution(next,'other'),null);
      } else await assert.rejects(()=>readExecution(next));
      await assert.rejects(()=>begin());
      await assert.rejects(()=>dispatch());
      await assert.rejects(()=>reserve());
      await assert.rejects(()=>observe());
      await assert.rejects(()=>record());
      await assert.rejects(()=>activate());
      await assert.rejects(()=>recordObservation());
      await assert.rejects(()=>db.query('delete from public.hivra_agent_attachment_activation_observations'));
      await assert.rejects(()=>db.query('delete from public.hivra_agent_attachment_activation_observation_outbox'));
      if (role==='service_role') assert.equal(await readActivation(),null);
      else await assert.rejects(()=>readActivation());
      await assert.rejects(()=>db.query('delete from public.hivra_agent_attachment_activation_dispatches'));
      await assert.rejects(()=>db.query('delete from public.hivra_agent_attachment_activation_outbox'));
      await assert.rejects(()=>db.query('delete from public.hivra_agent_attachment_staging_results'));
      await assert.rejects(()=>db.query('delete from public.hivra_agent_attachment_guest_observations'));
      await assert.rejects(()=>db.query('delete from public.hivra_agent_attachment_installations'));
      await assert.rejects(()=>db.query('delete from public.hivra_agent_attachment_dispatches'));
      await assert.rejects(()=>db.query('update public.hivra_agent_attachments set phase=\'cancelled\''));
      await assert.rejects(()=>value("select public.cancel_undispatched_hivra_agent_attachment('owner',$1) as result",[op]));
      await db.exec('reset role');
    }
    console.log(process.argv.includes('--activation-json') ? JSON.stringify(activationEvidence)
      : process.argv.includes('--json') ? JSON.stringify(snapshots)
      : 'PASS attachment admission shares legacy lease, exact replay, pending delete, cancellation, one-time dispatch and private command ACLs');
  } finally { await db.close(); }
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
