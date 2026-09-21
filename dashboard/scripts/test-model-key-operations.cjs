// Real PostgreSQL/WASM, the production guest receipt primitive, and synthetic
// keys only. No environment loading, network, cloud resources or live DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createCipheriv, createHash } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { createLlmApplicationStore, PROTOCOL } = require('../provisioner/hivra-chat/llm-application.js');

async function main() {
  const db = new PGlite();
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hivra-model-key-sql-'));
  let checks = 0;
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
      create function public.update_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end; $$;
      create function public.requesting_user_id() returns text language sql as $$ select 'owner'::text; $$;
      create function public.digest(text,text) returns bytea language sql as $$ select sha256(convert_to($1,'UTF8')); $$;`);
    const dir = path.resolve(__dirname, '../supabase/migrations');
    const migration = name => fs.readFileSync(path.join(dir,name), 'utf8');
    const wallet = migration('20260512180000_managed_venice_wallets.sql');
    for (const table of ['managed_venice_wallet_accounts','managed_venice_proxy_keys']) {
      // Use the actual schema, including constraints and FK; not a mock key table.
      const ddl = wallet.match(new RegExp(`create table if not exists public\\.${table} \\([\\s\\S]*?\\n\\);`));
      assert.ok(ddl); await db.exec(ddl[0]);
    }
    await db.exec(migration('20260605120000_hivra_agents.sql'));
    await db.exec('alter table public.hivra_agents add column llm_config jsonb, add column llm_api_key_encrypted text');
    for (const file of fs.readdirSync(dir).filter(name=>/^2026082[5678]/.test(name)).sort()) await db.exec(migration(file));
    await db.exec(migration('20260830190000_standalone_provider_direct_access.sql'));
    const agentId=randomUUID(), accountId=randomUUID(), oldKeyId=randomUUID(), token='a'.repeat(64);
    const eq = (actual,expected) => { assert.deepEqual(actual,expected); checks++; };
    const value = async (sql,args=[]) => (await db.query(sql,args)).rows[0].result;
    const read = () => value('select to_jsonb(a) as result from public.hivra_agents a where id=$1',[agentId]);
    const binding = () => value('select public.hivra_model_key_binding(a) as result from public.hivra_agents a where id=$1',[agentId]);
    const journal = id => value('select to_jsonb(j) as result from public.hivra_model_key_operations j where operation_id=$1',[id]);
    const countKeys = () => value('select count(*)::int as result from public.managed_venice_proxy_keys');
    const keyStatus = id => value('select status as result from public.managed_venice_proxy_keys where id=$1',[id]);
    const blocked = async action => { await assert.rejects(action,e=>['42501','55000','55006','23503','23505','23514','P0001'].includes(e.code)); checks++; };
    let currentStore;
    async function reset({managed=false,config,changes={}}={}) {
      await db.exec('truncate public.hivra_agents,public.managed_venice_wallet_accounts,public.managed_venice_proxy_keys,public.infrastructure_connections cascade');
      await db.query("insert into public.managed_venice_wallet_accounts(id,user_id) values($1,'owner')",[accountId]);
      await db.query("insert into public.managed_venice_proxy_keys(id,account_id,user_id,key_hash,key_prefix) values($1,$2,'owner','old-fixture-hash','hven_live_fixture')",[oldKeyId,accountId]);
      const row = { type:'codex',status:'running',desired:'running',hostname:'computer.hivra.test',vmid:401,...changes };
      await db.query(`insert into public.hivra_agents(id,user_id,type,name,status,desired_state,vmid,api_token,cf_hostname,cf_tunnel_id,chat_url,llm_config,llm_api_key_encrypted)
        values($1,'owner',$2,'Fixture',$3,$4,$5,$6,$7,'fixture-tunnel',$8,$9,$10)`,
      [agentId,row.type,row.status,row.desired,row.vmid,token,row.hostname,Object.hasOwn(row,'chatUrl')?row.chatUrl:'https://'+row.hostname,
        config ?? (managed?{provider:'venice',mode:'managed',model:'old-model',proxyKeyId:oldKeyId}:null),managed?'old-sealed-fixture':null]);
      currentStore=createLlmApplicationStore({directory:path.join(fs.mkdtempSync(path.join(root,'guest-')),'.hivra'),apiToken:token,runtime:'codex'});
    }
    function request({mode='byok',operationId=randomUUID(),state=currentStore.inspect(),model='fixture-model'}={}) {
      const plaintext='hven_live_fixture_' + randomUUID().replaceAll('-','');
      const payload=mode===null?null:{provider:'venice',baseUrl:mode==='managed'?'https://dashboard.hivra.test/api/managed-venice/v1':'https://api.venice.ai/api/v1',apiKey:plaintext,model};
      const input={protocol:PROTOCOL,operationId,expectedStateDigest:state.stateDigest,payload};
      // Independently obtain expected bytes from the actual guest on a separate
      // fixture for an empty predecessor; later writes use the canonical MAC.
      const expectedDir=path.join(fs.mkdtempSync(path.join(root,'expected-')),'.hivra');
      const originalPayload=currentStore.readProvider();
      // The receipt MAC is computed directly with the documented canonical
      // record for non-empty predecessor states; the real guest below must
      // produce exactly this receipt before SQL settlement can succeed.
      const {createHmac}=require('node:crypto');
      const mac=(domain,s)=>createHmac('sha256',token).update(PROTOCOL+'\0'+domain+'\0'+s).digest('hex');
      const payloadDigest=mac('payload',JSON.stringify({operationId,previousStateDigest:state.stateDigest,payload}));
      const record={...(payload||{provider:null}),_hivraApplication:{protocol:PROTOCOL,operationId,previousStateDigest:state.stateDigest,payloadDigest}};
      const receipt={protocol:PROTOCOL,operationId,stateDigest:mac('state','record:'+JSON.stringify(record)+'\n'),payloadDigest,provider:payload?.provider??null,model:payload?.model??null};
      if (!originalPayload && state.operationId===null) {
        const isolated=createLlmApplicationStore({directory:expectedDir,apiToken:token,runtime:'codex'});
        eq(isolated.apply(input),receipt);
      }
      const cipher=createCipheriv('aes-256-gcm',Buffer.alloc(32,7),Buffer.alloc(12,8));
      const encrypted=Buffer.concat([cipher.update(plaintext),cipher.final()]);
      const encryptedKey=mode===null?null:Buffer.concat([Buffer.alloc(12,8),cipher.getAuthTag(),encrypted]).toString('base64');
      const managedKey=mode==='managed'?{id:randomUUID(),accountId,hash:createHash('sha256').update(plaintext).digest('hex'),prefix:'hven_live_fixture'}:null;
      const config=mode===null?null:{provider:'venice',mode,model,...(managedKey?{proxyKeyId:managedKey.id,keyPrefix:managedKey.prefix,walletType:'card'}:{})};
      return {operationId,input,receipt,body:{requestDigest:createHash('sha256').update(operationId).digest('hex'),config,
        payload:payload?{provider:payload.provider,baseUrl:payload.baseUrl,model}:null,encryptedKey,managedKey,
        expectedStateDigest:state.stateDigest,expectedReceipt:receipt}};
    }
    const admit = async (r,changes={}) => value('select public.admit_hivra_model_key_operation($1,$2,$3,$4,$5) as result',
      [changes.user??'owner',changes.agent??agentId,r.operationId,changes.binding??await binding(),Object.hasOwn(changes,'body')?changes.body:r.body]);
    const claim = (r,user='owner') => value('select public.claim_hivra_model_key_delivery($1,$2,$3) as result',[user,agentId,r.operationId]);
    const settle = (r,lease,receipt=r.receipt,user='owner') => value('select public.settle_hivra_model_key_operation($1,$2,$3,$4,$5) as result',
      [user,agentId,r.operationId,lease,receipt]);
    const deletion = () => value("select public.request_hivra_agent_delete('owner',$1,$2) as result",[agentId,randomUUID()]);
    const finish = async () => value("select public.complete_hivra_agent_delete('owner',$1,$2) as result",[agentId,(await read()).operation_id]);

    await reset();
    const before=await read();
    const invalid=request({mode:'managed'});
    for(const body of [null,{}, {...invalid.body,extra:'plaintext'}, {...invalid.body,encryptedKey:'plain'},
      {...invalid.body,expectedReceipt:{...invalid.receipt,stateDigest:null}}, {...invalid.body,expectedStateDigest:null},
      {...invalid.body,config:{...invalid.body.config,model:null}}, {...invalid.body,payload:{...invalid.body.payload,apiKey:'secret'}},
      {...invalid.body,managedKey:{...invalid.body.managedKey,accountId:'invalid'}},
      {...invalid.body,config:{...invalid.body.config,walletType:'unknown'}}]) {
      eq(await admit(invalid,{body}), 'invalid_request'); eq(await read(),before); eq(await countKeys(),1);
    }
    eq(await admit(invalid,{user:'foreign'}),'not_found');
    eq(await admit(invalid,{binding:{...await binding(),hostname:'other.hivra.test'}}),'target_changed');
    eq(await admit(invalid,{body:{...invalid.body,managedKey:{...invalid.body.managedKey,accountId:randomUUID()}}}),'invalid_wallet');
    for(const changes of [{type:'hermes'},{status:'stopped',desired:'stopped'},{status:'provisioning'},{desired:'deleted'},{vmid:null},
      {chatUrl:null},{chatUrl:''},{chatUrl:'http://computer.hivra.test'}]) {
      await reset({changes}); eq(await admit(request()),'not_ready');
    }
    await reset({config:{provider:'future'}}); eq(await admit(request()),'legacy_config_invalid');
    console.log('PASS model key admission: strict envelope, original owner/target/runtime/readiness, no failed-admission custody');

    await reset({managed:true});
    const original=await read(), first=request({mode:'managed'});
    eq(await admit(first),'pending'); eq(await keyStatus(first.body.managedKey.id),'paused'); eq(await read(),original);
    const dupe=request({mode:'managed',operationId:first.operationId});
    dupe.body.requestDigest=first.body.requestDigest;
    eq(await admit(dupe),'pending'); eq(await countKeys(),2);
    eq((await journal(first.operationId)).encrypted_key,first.body.encryptedKey);
    eq(await admit({...first,body:{...first.body,requestDigest:'b'.repeat(64)}}),'operation_conflict');
    eq(await admit(request()),'pending_conflict');
    await blocked(()=>db.exec('update public.hivra_agents set llm_config=null,llm_api_key_encrypted=null'));
    await blocked(()=>db.exec("update public.hivra_agents set cf_hostname='other.hivra.test'"));
    await blocked(()=>db.query("update public.managed_venice_proxy_keys set status='active' where id=$1",[first.body.managedKey.id]));
    await blocked(()=>db.query("update public.managed_venice_proxy_keys set status='revoked' where id=$1",[first.body.managedKey.id]));
    await blocked(()=>db.query('delete from public.managed_venice_proxy_keys where id=$1',[first.body.managedKey.id]));
    await blocked(()=>db.query("update public.managed_venice_proxy_keys set status='revoked' where id=$1",[oldKeyId]));
    await blocked(()=>db.query('delete from public.managed_venice_proxy_keys where id=$1',[oldKeyId]));
    eq(await keyStatus(oldKeyId),'active');
    // Billing safety and top-up recovery still operate on the predecessor,
    // while the new key cannot be activated by the bulk recovery query.
    await db.query("update public.managed_venice_proxy_keys set status='paused',paused_reason='managed_venice_overage_uncovered' where id=$1",[oldKeyId]);
    const recovered=await db.query("update public.managed_venice_proxy_keys set status='active',paused_reason=null where user_id='owner' and status='paused' and paused_reason='managed_venice_overage_uncovered' returning id");
    eq(recovered.rows,[{id:oldKeyId}]); eq(await keyStatus(first.body.managedKey.id),'paused');
    eq(await settle(first,randomUUID()),false);
    eq(await claim(first,'foreign'),null);
    const lease=await claim(first); assert.ok(lease.lease_id); checks++;
    eq(await claim(first),null);
    await blocked(()=>db.query("select public.claim_hivra_agent_operation('owner',$1,$2,'restart','running',null)",[agentId,randomUUID()]));
    eq(await settle(first,lease.lease_id,{...first.receipt,model:'wrong'}),false);
    eq(await settle(first,randomUUID()),false);
    eq(await settle(first,lease.lease_id,first.receipt,'foreign'),false);
    eq(currentStore.apply(first.input),first.receipt);
    // The guest applied; now inject a DB failure during old-key revocation.
    // This does not disable a guard. The complete settlement must roll back.
    await db.exec(`create function public.fixture_fail_revoke() returns trigger language plpgsql as $$ begin
      if old.status='active' and new.status='revoked' then raise exception 'fixture revocation failure'; end if; return new; end; $$;
      create trigger fixture_fail_revoke before update on public.managed_venice_proxy_keys for each row execute function public.fixture_fail_revoke();`);
    await blocked(()=>settle(first,lease.lease_id));
    eq(await read(),original); eq(await keyStatus(oldKeyId),'active'); eq(await keyStatus(first.body.managedKey.id),'paused');
    eq((await journal(first.operationId)).phase,'pending');
    await db.exec('drop trigger fixture_fail_revoke on public.managed_venice_proxy_keys; drop function public.fixture_fail_revoke()');
    eq(await settle(first,lease.lease_id,currentStore.inspect()),true);
    eq(await keyStatus(oldKeyId),'revoked'); eq(await keyStatus(first.body.managedKey.id),'active');
    // The very first legacy predecessor also needs a terminal fence. A late
    // chat settlement must not pause it and let top-up recovery resurrect it.
    await blocked(()=>db.query("update public.managed_venice_proxy_keys set status='paused',paused_reason='managed_venice_overage_uncovered' where id=$1",[oldKeyId]));
    await blocked(()=>db.query("update public.managed_venice_proxy_keys set status='active' where id=$1",[oldKeyId]));
    eq(await keyStatus(oldKeyId),'revoked');
    eq((await read()).llm_config.walletType,'card'); eq((await read()).llm_api_key_encrypted,first.body.encryptedKey);
    eq((await journal(first.operationId)).encrypted_key,null);
    eq(await settle(first,lease.lease_id),true);
    await blocked(()=>db.query("update public.managed_venice_proxy_keys set status='revoked',revoked_at=clock_timestamp() where id=$1",[first.body.managedKey.id]));
    eq(await keyStatus(first.body.managedKey.id),'active');
    await blocked(()=>db.exec('update public.hivra_agents set llm_config=null,llm_api_key_encrypted=null'));
    await blocked(()=>db.exec('update public.hivra_agents set llm_api_key_encrypted=null'));
    console.log('PASS model key settlement: paused candidate, duplicate custody, exact guest receipt, atomic rollback and predecessor revocation');

    const clear=request({mode:null}); eq(await admit(clear),'pending');
    const clearLease=await claim(clear); eq(currentStore.apply(clear.input),clear.receipt);
    eq(await settle(clear,clearLease.lease_id,currentStore.inspect()),true);
    eq((await read()).llm_config,null); eq((await read()).llm_api_key_encrypted,null);
    eq(await keyStatus(first.body.managedKey.id),'revoked');
    await blocked(()=>db.query("update public.managed_venice_proxy_keys set status='active' where id=$1",[first.body.managedKey.id]));
    eq(await admit(first),'applied'); eq(await claim(first),null); eq(await settle(first,lease.lease_id),false);
    const byok=request(); eq(await admit(byok),'pending'); const byokLease=await claim(byok);
    eq(currentStore.apply(byok.input),byok.receipt); eq(await settle(byok,byokLease.lease_id),true);
    eq((await read()).llm_config.mode,'byok'); eq(await countKeys(),2);
    await blocked(()=>db.exec('update public.hivra_agents set llm_config=null,llm_api_key_encrypted=null'));
    await db.exec('set role service_role');
    await blocked(()=>db.exec('update public.hivra_agents set llm_api_key_encrypted=null'));
    await db.exec('reset role');
    console.log('PASS model key history: clear and BYOK, no historical replay, no legacy overwrite after adoption');

    // Expiry is the real DB clock, not test rewriting timestamps or triggers.
    const waiting=request({mode:'managed'}); eq(await admit(waiting),'pending'); const expired=await claim(waiting);
    const waitMs=Number(await value('select greatest(0,extract(epoch from ($1::timestamptz-clock_timestamp()))*1000) as result',[expired.lease_expires_at]));
    assert.ok(waitMs<=20000 && waitMs>0); checks++;
    await new Promise(resolve=>setTimeout(resolve,Math.ceil(waitMs)+30));
    eq(await settle(waiting,expired.lease_id),false);
    const powerId=randomUUID();
    eq(await value("select public.claim_hivra_agent_operation('owner',$1,$2,'restart','running',null) as result",[agentId,powerId]),true);
    eq(await claim(waiting),null);
    eq(await value("select public.release_hivra_agent_operation('owner',$1,$2,null,false) as result",[agentId,powerId]),true);
    const resumed=await claim(waiting); assert.notEqual(resumed.lease_id,expired.lease_id); checks++;
    eq(resumed.encrypted_key,waiting.body.encryptedKey); eq(await settle(waiting,expired.lease_id),false);
    eq(await deletion(),'claimed'); eq(await claim(waiting),null); eq(await settle(waiting,resumed.lease_id),false);
    await blocked(()=>finish());
    eq((await journal(waiting.operationId)).encrypted_key,waiting.body.encryptedKey);
    const deleteWait=Number(await value('select greatest(0,extract(epoch from ($1::timestamptz-clock_timestamp()))*1000) as result',[resumed.lease_expires_at]));
    await new Promise(resolve=>setTimeout(resolve,Math.ceil(deleteWait)+30));
    eq(await finish(),true);
    eq((await journal(waiting.operationId)).phase,'deleted'); eq((await journal(waiting.operationId)).encrypted_key,null);
    eq(await keyStatus(waiting.body.managedKey.id),'revoked'); eq((await read()).llm_api_key_encrypted,null);
    console.log('PASS model key lifecycle: bounded real-clock expiry, restart recovery, new lease, delete preemption, terminal erasure');

    await db.exec('set role service_role');
    await blocked(()=>db.exec('delete from public.hivra_model_key_operations'));
    await blocked(()=>db.exec("update public.hivra_model_key_operations set phase='applied'"));
    await blocked(()=>db.exec('truncate public.hivra_model_key_operations'));
    eq(await value('select count(*)::int as result from public.hivra_model_key_operations'),4);
    await db.exec('reset role');
    for(const role of ['anon','authenticated']) {
      await db.exec('set role '+role);
      await blocked(()=>db.exec('select * from public.hivra_model_key_operations'));
      await blocked(()=>claim(first));
      await blocked(()=>settle(first,lease.lease_id));
      await blocked(()=>admit(first,{binding:{}}));
      await db.exec('reset role');
    }
    // Use the real service role, not the migration owner, for a full RPC path.
    await reset({managed:true});
    const serviceRequest=request({mode:'managed'}), serviceBinding=await binding();
    await db.exec('set role service_role');
    eq(await admit(serviceRequest,{binding:serviceBinding}),'pending');
    const serviceLease=await claim(serviceRequest);
    eq(currentStore.apply(serviceRequest.input),serviceRequest.receipt);
    eq(await settle(serviceRequest,serviceLease.lease_id),true);
    eq(await deletion(),'claimed');
    await db.query("update public.managed_venice_proxy_keys set status='revoked' where id=$1",[serviceRequest.body.managedKey.id]);
    eq(await finish(),true);
    eq((await journal(serviceRequest.operationId)).phase,'deleted');
    await db.exec('reset role');
    // Pending-but-never-dispatched delete retains revocation evidence and can
    // complete immediately through the existing lifecycle finalizer.
    await reset({managed:true}); const abandoned=request({mode:'managed'});
    eq(await admit(abandoned),'pending'); eq(await deletion(),'claimed');
    await blocked(()=>db.query("update public.managed_venice_proxy_keys set user_id='foreign' where id=$1",[oldKeyId]));
    await db.query("update public.managed_venice_proxy_keys set status='revoked' where id=$1",[oldKeyId]);
    eq(await finish(),true); eq(await keyStatus(abandoned.body.managedKey.id),'revoked');
    // Credential-only recovery is an existing supported operation, not a new
    // computer. Exercise the original repair/preflight RPCs with both pending
    // and settled model settings; never retarget their allocation or bearer.
    for (const applied of [false,true]) {
      await reset();
      const connection=randomUUID(), target=randomUUID(), preflight=randomUUID();
      await db.query("insert into public.infrastructure_connections(id,user_id,name,provider,status,ssh_host,ssh_host_fingerprint_sha256) values($1,'owner','Proxmox fixture','proxmox','ready','fixture.hivra.test',$2)",[connection,'d'.repeat(64)]);
      await db.query("insert into public.infrastructure_connection_secrets(connection_id,user_id,encrypted_bundle) values($1,'owner','fixture-envelope')",[connection]);
      await db.query("insert into public.deployment_targets(id,user_id,connection_id,external_id,display_name,status,capabilities,supported_isolation_drivers,isolation_class,evidence_connection_revision) values($1,'owner',$2,'pve-fixture','Fixture','ready',$3,array['proxmox-kvm'],'hardware-vm',1)",[target,connection,{launchReady:true}]);
      await db.query("update public.hivra_agents set deployment_mode='self-managed',proxmox_host='__hivra_self_managed_no_ambient_authority__',infrastructure_connection_id=$1,deployment_target_id=$2,infrastructure_connection_revision=1,infrastructure_binding_token_enforced=true,allocation_operation_id=$3 where id=$4",[connection,target,randomUUID(),agentId]);
      const portable=request(), originalBinding=await binding(); eq(await admit(portable),'pending');
      if(applied) { const l=await claim(portable); eq(currentStore.apply(portable.input),portable.receipt); eq(await settle(portable,l.lease_id),true); }
      await db.exec('set role service_role');
      await db.query("select * from public.recover_infrastructure_connection_credentials('owner',$1,1,'repaired-fixture-envelope',1::smallint)",[connection]);
      eq(await value("select public.begin_infrastructure_connection_preflight('owner',$1,2,$2,clock_timestamp()) as result",[connection,preflight]),true);
      eq(await value("select public.complete_infrastructure_connection_preflight('owner',$1,2,$2,'ready',clock_timestamp(),null,$3) as result",[connection,preflight,{externalId:'pve-fixture',status:'ready',capabilities:{launchReady:true},supportedIsolationDrivers:['proxmox-kvm'],isolationClass:'hardware-vm'}]),true);
      eq((await read()).infrastructure_connection_revision,2); eq(await binding(),originalBinding);
      eq((await journal(portable.operationId)).admission_connection_revision,1);
      if(!applied) { const l=await claim(portable); eq(currentStore.apply(portable.input),portable.receipt); eq(await settle(portable,l.lease_id),true); }
      const restart=randomUUID();
      eq(await value("select public.claim_hivra_agent_operation('owner',$1,$2,'restart','running',null) as result",[agentId,restart]),true);
      eq(await value("select public.release_hivra_agent_operation('owner',$1,$2,null,false) as result",[agentId,restart]),true);
      await db.exec('reset role');
      await blocked(()=>db.query("update public.hivra_agents set api_token=$1 where id=$2",['b'.repeat(64),agentId]));
      await blocked(()=>db.query("update public.hivra_agents set vmid=402 where id=$1",[agentId]));
    }
    console.log('PASS model key integration: actual top-up filter and same-computer credential repair for pending and applied keys');
    eq(await value("select count(*)::int as result from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('admit_hivra_model_key_operation','claim_hivra_model_key_delivery','settle_hivra_model_key_operation') and p.prosecdef and p.proconfig @> array['search_path=pg_catalog, pg_temp']"),3);
    console.log(`PASS model key SQL: ${checks} assertions; private grants, actual PostgreSQL and guest receipts, owned fixtures only`);
  } finally { await db.close(); fs.rmSync(root,{recursive:true,force:true}); }
}
main().catch(error=>{ console.error(error); process.exitCode=1; });
