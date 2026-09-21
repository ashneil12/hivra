// Actual PostgreSQL/WASM and committed schemas. Synthetic credentials only;
// no application environment, external database, guest or network access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createCipheriv, createHash } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');

async function main() {
  const db = new PGlite(); let checks=0;
  const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
  const value=async(sql,args=[]) => (await db.query(sql,args)).rows[0].result;
  const blocked=async fn=>{await assert.rejects(fn,e=>['55000','55006','23503','23505','23514','42501'].includes(e.code));checks++;};
  const blockedByConstraint=async(fn,name)=>{await assert.rejects(fn,e=>e.code==='23514'&&e.constraint===name);checks++;};
  const migration=name=>fs.readFileSync(path.resolve(__dirname,'../supabase/migrations',name),'utf8');
  const read=(table,id,column='agent_id')=>value(`select to_jsonb(t) as result from public.${table} t where ${column}=$1`,[id]);
  const count=table=>value(`select count(*)::int as result from public.${table}`);
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
      create function public.update_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end; $$;
      create function public.requesting_user_id() returns text language sql as $$ select 'owner'::text; $$;
      create function public.digest(text,text) returns bytea language sql as $$ select sha256(convert_to($1,'UTF8')); $$;`);
    const wallet=migration('20260512180000_managed_venice_wallets.sql');
    for(const table of ['managed_venice_wallet_accounts','managed_venice_proxy_keys']) {
      const ddl=wallet.match(new RegExp(`create table if not exists public\\.${table} \\([\\s\\S]*?\\n\\);`));
      assert.ok(ddl); await db.exec(ddl[0]);
    }
    await db.exec(migration('20260605120000_hivra_agents.sql'));
    await db.exec(migration('20260607130000_hivra_agent_half_cpu.sql'));
    await db.exec('alter table public.hivra_agents add column llm_config jsonb, add column llm_api_key_encrypted text');
    const pools=migration('20260605130000_pools_and_agent_type.sql');
    await db.exec(pools.match(/create table if not exists public\.pools \([\s\S]*?\n\);/)[0]);
    await db.exec(pools.match(/alter table public\.hivra_agents[^;]+;/)[0]);
    await db.exec(migration('20260606120000_hivra_agent_bootstrap.sql'));
    await db.exec(migration('20260612190000_hivra_agents_managed_venice.sql'));
    for(const statement of migration('20260613193000_agent_template_skills.sql').matchAll(/alter table public\.hivra_agents[^;]+;/g)) await db.exec(statement[0]);
    const dir=path.resolve(__dirname,'../supabase/migrations');
    for(const file of fs.readdirSync(dir).filter(n=>/^2026082[5678]/.test(n)&&n<'20260828090000').sort()) await db.exec(migration(file));
    const nativeId=randomUUID();
    await db.query("insert into public.hivra_agents(id,user_id,type,name,status,desired_state) values($1,'owner','claude-code','Existing native','running','running')",[nativeId]);
    const native=await read('hivra_agents',nativeId,'id');
    await db.exec(migration('20260828090000_hivra_launch_model_custody.sql'));
    await db.exec(migration('20260830132000_launch_fingerprint_key_separation.sql'));
    await db.exec(migration('20260830190000_standalone_provider_direct_access.sql'));
    await db.exec(migration('20260905140000_managed_provisioner_channels.sql'));
    eq(await read('hivra_agents',nativeId,'id'),{...native,managed_provisioner_channel:'default'}); eq(await count('hivra_launch_model_requests'),0);
    // Isolate the declarative constraint from the current NOT NULL columns and
    // earlier row guards: the binding itself must remain fail-closed if a
    // future schema change ever permits either value to be NULL.
    await db.exec(`alter table public.hivra_agents alter column deployment_mode drop not null;
      alter table public.hivra_agents alter column computer_substrate drop not null;
      set session_replication_role='replica';`);
    try {
      for(const [deploymentMode,computerSubstrate] of [[null,'proxmox-kvm'],['hivra-managed',null],[null,null]]) {
        await blockedByConstraint(()=>db.query(`insert into public.hivra_agents
          (id,user_id,type,name,status,desired_state,managed_provisioner_channel,deployment_mode,computer_substrate)
          values($1,'owner','codex','Invalid Canary binding','pending','running','canary',$2,$3)`,
        [randomUUID(),deploymentMode,computerSubstrate]),'hivra_agents_canary_provisioner_binding_check');
      }
    } finally {
      await db.exec(`set session_replication_role='origin';
        alter table public.hivra_agents alter column deployment_mode set not null;
        alter table public.hivra_agents alter column computer_substrate set not null;`);
    }
    eq(await value("select relrowsecurity as result from pg_class where oid='public.hivra_launch_model_requests'::regclass"),true);
    for(const role of ['anon','authenticated','service_role']) for(const permission of ['INSERT','UPDATE','DELETE','TRUNCATE']) {
      eq(await value("select has_table_privilege($1,'public.hivra_launch_model_requests',$2) as result",[role,permission]),false);
    }
    for(const role of ['anon','authenticated']) eq(await value("select has_table_privilege($1,'public.hivra_launch_model_requests','SELECT') as result",[role]),false);
    eq(await value("select has_table_privilege('service_role','public.hivra_launch_model_requests','SELECT') as result"),true);

    const fixture=(mode='byok',fingerprintVersion=1)=>{
      const cipher=createCipheriv('aes-256-gcm',Buffer.alloc(32,7),Buffer.alloc(12,8));
      const bytes=Buffer.concat([cipher.update('synthetic-launch-key'),cipher.final()]);
      return { requestId:randomUUID(), modelId:randomUUID(), fingerprints:[{version:fingerprintVersion,keyTag:'a'.repeat(64),digest:'b'.repeat(64)}],
        row:{id:randomUUID(),type:'codex',name:'Launch fixture',cpu:2,ram:4,proxmox_host:'pve-fixture',
          deployment_mode:'hivra-managed',computer_substrate:'proxmox-kvm',operation_id:randomUUID(),
          infrastructure_binding_token_hash:'c'.repeat(64),template_skills:['fixture-skill']},
        selection:{provider:'venice',mode,model:'fixture-model',...(mode==='managed'?{walletType:'card'}:{})},
        encryptedKey:mode==='byok'?Buffer.concat([Buffer.alloc(12,8),cipher.getAuthTag(),bytes]).toString('base64'):null };
    };
    const reserve=(f,changes={})=>value('select public.reserve_hivra_launch_model_request($1,$2,$3,$4,$5,$6,$7) as result',
      [changes.user??'owner',f.requestId,changes.fingerprints??f.fingerprints,f.modelId,changes.row??f.row,
        changes.selection??f.selection,Object.hasOwn(changes,'encryptedKey')?changes.encryptedKey:f.encryptedKey]);
    const queued=f=>read('hivra_launch_model_requests',f.row.id);
    const agent=f=>read('hivra_agents',f.row.id,'id');
    const claim=(f,automatic=true,user='owner')=>value('select public.claim_hivra_launch_model_attempt($1,$2,$3,$4) as result',[user,f.row.id,f.requestId,automatic]);
    const cancel=(f,user='owner')=>value('select public.cancel_hivra_launch_model_request($1,$2,$3) as result',[user,f.row.id,f.requestId]);
    let nextVmid=401;
    const ready=async f=>{
      eq(await value("select public.persist_hivra_agent_provision_identity('owner',$1,$2,$3,'10.240.0.4') as result",[f.row.id,f.row.operation_id,nextVmid++]),true);
      await db.query("update public.hivra_agents set api_token=repeat('d',64),cf_hostname='fixture.hivra.test',cf_tunnel_id='fixture-tunnel',chat_url='https://fixture.hivra.test' where id=$1",[f.row.id]);
      eq(await value("select public.complete_hivra_agent_operation('owner',$1,$2,'running','running',null,null) as result",[f.row.id,f.row.operation_id]),true);
    };
    const binding=f=>value('select public.hivra_model_key_binding(a) as result from public.hivra_agents a where id=$1',[f.row.id]);
    const request=f=>({requestDigest:'e'.repeat(64),config:f.selection,payload:{provider:'venice',baseUrl:'https://api.venice.ai/api/v1',model:f.selection.model},
      encryptedKey:f.encryptedKey,managedKey:null,expectedStateDigest:'f'.repeat(64),
      expectedReceipt:{protocol:'hivra-llm-apply-v1',operationId:f.modelId,stateDigest:'a'.repeat(64),payloadDigest:'b'.repeat(64),provider:'venice',model:f.selection.model}});
    const promote=async(f,lease,body=request(f),changes={})=>value('select public.promote_hivra_launch_model_request($1,$2,$3,$4,$5,$6) as result',
      [changes.user??'owner',f.row.id,f.requestId,lease?.attempt_id??null,changes.binding??await binding(f),body]);
    const direct=async(f,body=request(f),id=f.modelId)=>value("select public.admit_hivra_model_key_operation('owner',$1,$2,$3,$4) as result",[f.row.id,id,await binding(f),body]);

    for(const change of [{row:{...fixture().row,type:'claude-code'}},{row:{...fixture().row,llm_api_key_encrypted:'injected'}},
      {row:{...fixture().row,api_token:'injected'}},{row:{...fixture().row,cpu:'2'}},
      {selection:{provider:'venice',mode:'byok',model:42}},{selection:{provider:'venice',mode:'managed',model:'fixture-model',walletType:'other'}},
      {selection:{provider:'venice',mode:'byok',model:'fixture-model',apiKey:'synthetic-launch-key'}},{encryptedKey:'plaintext'},
      {fingerprints:[{version:3,keyTag:'a'.repeat(64),digest:'b'.repeat(64)}]}]) {
      eq((await reserve(fixture(),change)).status,'invalid_request'); eq(await count('hivra_agents'),1);
    }
    const rollback=fixture();
    await db.exec('begin'); eq((await reserve(rollback)).status,'reserved'); await db.exec('rollback');
    eq(await count('hivra_agents'),1); eq(await count('hivra_launch_model_requests'),0);
    const f=fixture('byok',2); await reserve(f); // Ignore the acknowledgement, as a disconnected caller would.
    const original=await queued(f);
    eq(original.fingerprint_version,2);
    eq((await reserve({...f,row:{...f.row,id:randomUUID()},modelId:randomUUID(),encryptedKey:Buffer.alloc(36,2).toString('base64')})).status,'existing');
    eq(await queued(f),original); eq(await count('hivra_agents'),2);
    eq((await reserve(f,{fingerprints:[{...f.fingerprints[0],digest:'c'.repeat(64)}]})).status,'request_conflict');
    eq((await reserve(f,{fingerprints:[{version:2,keyTag:'c'.repeat(64),digest:'d'.repeat(64)},...f.fingerprints]})).status,'existing');
    eq((await agent(f)).llm_config,null); eq((await agent(f)).llm_api_key_encrypted,null);
    eq((await agent(f)).managed_provisioner_channel,'default');
    eq((await agent(f)).template_skills,['fixture-skill']); eq(await count('managed_venice_proxy_keys'),0);
    eq(await claim(f),null); eq(await cancel(f,'foreign'),false); eq(await claim(f,true,'foreign'),null);
    await blocked(()=>db.query("update public.hivra_agents set llm_config='{}' where id=$1",[f.row.id]));
    await blocked(()=>db.query("update public.hivra_agents set type='claude-code' where id=$1",[f.row.id]));
    await blocked(()=>db.query("update public.hivra_agents set allocation_operation_id=$2 where id=$1",[f.row.id,randomUUID()]));
    await blocked(()=>db.query("update public.hivra_agents set managed_provisioner_channel='canary' where id=$1",[f.row.id]));

    const canary=fixture();canary.row.managed_provisioner_channel='canary';
    eq((await reserve(canary)).status,'reserved');
    eq((await agent(canary)).managed_provisioner_channel,'canary');
    for(const managed_provisioner_channel of [null,'staging']) {
      const invalidChannel=fixture();invalidChannel.row.managed_provisioner_channel=managed_provisioner_channel;
      eq((await reserve(invalidChannel)).status,'invalid_request');
    }
    const invalidCanaryBinding=fixture();invalidCanaryBinding.row.managed_provisioner_channel='canary';
    invalidCanaryBinding.row.deployment_mode='self-managed';
    eq((await reserve(invalidCanaryBinding)).status,'invalid_request');
    console.log('PASS launch custody reservation: atomic intent, replay identity, private schema and no early active key');

    await ready(f); const lease=await claim(f); assert.ok(lease?.attempt_id); checks++;
    eq(await claim(f),null); eq(await claim(f,false),null);
    await blocked(()=>direct(f));
    await blocked(()=>promote(f,lease,{...request(f),encryptedKey:Buffer.alloc(36,3).toString('base64')}));
    eq((await queued(f)).phase,'waiting'); eq(await count('hivra_model_key_operations'),0);
    eq(await promote(f,{attempt_id:randomUUID()}),'attempt_ended');
    eq(await promote(f,lease,request(f),{user:'foreign'}),'not_found');
    eq(await promote(f,lease,request(f),{binding:{...await binding(f),hostname:'other.hivra.test'}}),'target_changed');
    await db.exec('begin'); eq(await promote(f,lease),'pending'); await db.exec('rollback');
    eq((await queued(f)).encrypted_key,f.encryptedKey); eq(await count('hivra_model_key_operations'),0);
    eq(await promote(f,lease),'pending');
    eq((await queued(f)).phase,'promoted'); eq((await queued(f)).encrypted_key,null); eq((await queued(f)).attempt_id,null);
    eq(await promote(f,lease),'already_promoted'); eq(await cancel(f),false);
    eq((await agent(f)).llm_config,null); eq(await count('hivra_model_key_operations'),1);
    eq((await read('hivra_model_key_operations',f.row.id)).encrypted_key,f.encryptedKey);
    const delivery=await value("select public.claim_hivra_model_key_delivery('owner',$1,$2) as result",[f.row.id,f.modelId]);
    eq(await value("select public.settle_hivra_model_key_operation('owner',$1,$2,$3,$4) as result",[f.row.id,f.modelId,delivery.lease_id,request(f).expectedReceipt]),true);
    eq((await agent(f)).llm_config.mode,'byok'); eq((await agent(f)).llm_api_key_encrypted,f.encryptedKey);
    console.log('PASS launch custody promotion: original allocation, exclusive settings, atomic journal admission and settlement');

    const cancelled=fixture(); await reserve(cancelled); await ready(cancelled); const cancelledLease=await claim(cancelled);
    eq(await cancel(cancelled),true); eq(await cancel(cancelled),true);
    eq((await queued(cancelled)).encrypted_key,null); eq(await promote(cancelled,cancelledLease),'attempt_ended');
    eq((await reserve(cancelled)).phase,'cancelled'); eq(await claim(cancelled,false),null);
    const deleted=fixture(); await reserve(deleted);
    eq(await value("select public.request_hivra_agent_delete('owner',$1,$2) as result",[deleted.row.id,randomUUID()]),'pending');
    eq(await value("select public.complete_hivra_agent_delete('owner',$1,$2) as result",[deleted.row.id,(await agent(deleted)).operation_id]),true);
    eq((await queued(deleted)).phase,'deleted'); eq((await queued(deleted)).encrypted_key,null);
    eq((await reserve(deleted)).phase,'deleted'); eq(await claim(deleted,false),null);
    for(const chatUrl of [null,'','http://fixture.hivra.test']) {
      const missingAccess=fixture(); await reserve(missingAccess); await ready(missingAccess);
      await db.query('update public.hivra_agents set chat_url=$2 where id=$1',[missingAccess.row.id,chatUrl]);
      eq(await claim(missingAccess),null);
    }
    const managed=fixture('managed'); await reserve(managed); eq(await count('managed_venice_proxy_keys'),0);
    eq((await queued(managed)).selection.walletType,'card'); eq((await queued(managed)).encrypted_key,null);
    eq(await cancel(managed),true);
    // Preserve the scheduler's actual numeric cap, including the original
    // half-core launch. Do not round it while reserving model-selected compute.
    for(const cpu of [0.5,1.5]) {
      const fractional=fixture(); fractional.row.cpu=cpu;
      eq((await reserve(fractional)).status,'reserved'); eq(Number((await agent(fractional)).cpu),cpu);
    }
    for(const cpu of [0,-1,0.25,10000,'0.5']) {
      const invalidCpu=fixture(); invalidCpu.row.cpu=cpu;
      eq((await reserve(invalidCpu)).status,'invalid_request');
    }
    const ownedPool=randomUUID(),foreignPool=randomUUID(),wrongSurface=randomUUID();
    await db.query("insert into public.pools(id,user_id,product_surface) values($1,'owner','hermesos'),($2,'foreign','hermesos'),($3,'owner','workspace_cloud')",[ownedPool,foreignPool,wrongSurface]);
    const validPool=fixture(); validPool.row.pool_id=ownedPool;
    eq((await reserve(validPool)).status,'reserved'); eq((await agent(validPool)).pool_id,ownedPool);
    for(const pool of [foreignPool,wrongSurface,randomUUID()]) {
      const invalidPool=fixture(); invalidPool.row.pool_id=pool;
      eq((await reserve(invalidPool)).status,'invalid_request');
    }
    for(const substrate of ['proxmox-kvm','provider-vm']) {
      const injectedPool=fixture(); injectedPool.row.pool_id=ownedPool;
      injectedPool.row.deployment_mode='self-managed'; injectedPool.row.computer_substrate=substrate;
      eq((await reserve(injectedPool)).status,'invalid_request');
    }
    // Real SQL grants, not just schema inspection. Never disable a guard or
    // use a bypass switch to make a service-role reservation succeed.
    await db.exec('set role service_role');
    const service=fixture(); eq((await reserve(service)).status,'reserved'); await ready(service);
    eq(await promote(service,await claim(service)),'pending');
    await db.exec('reset role');
    for(const role of ['anon','authenticated']) {
      await db.exec('set role '+role);
      await blocked(()=>reserve(fixture())); await blocked(()=>db.query('select * from public.hivra_launch_model_requests'));
      await db.exec('reset role');
    }
    eq(await read('hivra_agents',nativeId,'id'),{...native,managed_provisioner_channel:'default'});
    // Exact historical infrastructure fixtures with all ownership triggers on.
    // Keep existing/native rows: these positives must not truncate prior proof.
    const launchReserve=reserve,launchFixture=fixture;
    {
    const connection = "11111111-1111-4111-8111-111111111111";
    const order = "22222222-2222-4222-8222-222222222222";
    const attempt = "33333333-3333-4333-8333-333333333333";
    const capacityKey = "44444444-4444-4444-8444-444444444444";
    const target = "55555555-5555-4555-8555-555555555555";
    const agent = "66666666-6666-4666-8666-666666666666";
    const op = "77777777-7777-4777-8777-777777777777";
    const quote = "a".repeat(64), serverName = "hivra-22222222222242228222";
    const receipt = { version: 1, serverId: "42", primaryIpv4: { id: "88", ip: "203.0.113.10" },
      primaryIpv6: { id: "89", ip: "2001:db8::/64" },
      action: { id: "500", command: "create_server", status: "success", resources: [{ id: "42", type: "server" }] }, nextActions: [] };
    const firewall = { version: 1, scope: { orderId: order, attemptId: attempt, quoteFingerprint: quote, serverId: 42 },
      firewallId: 91, createdAt: new Date().toISOString(), setRulesActionId: 601, applyActionId: 602 };
    const power = { id: 603, command: "start_server", status: "success", resources: [{ id: 42, type: "server" }] };
    const blob = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), Buffer.alloc(32, 1)]);
    const publicKey = "ssh-ed25519 " + blob.toString("base64");
    const fingerprint = "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
    const caps = { kind: "provider-vm", provider: "hetzner-cloud", capacityOrderId: order,
      enrollmentAttemptId: attempt, allocation: "exclusive-computer", launchReady: true,
      hostIdentityDigest: createHash("sha256").update(blob).digest("hex"),
      provisioner: { configured: true, ready: true, version: "2026.08.28.2", bundleSha256: "b".repeat(64), scopeSha256: "c".repeat(64) } };
    const readAgent = () => value("select to_jsonb(a) as result from public.hivra_agents a where id=$1", [agent]);
    async function seedProvider() {
      await db.query("insert into public.infrastructure_connections(id,user_id,name,provider,operating_mode,setup_mode,status,revision,ssh_host,ssh_port,ssh_user,ssh_host_fingerprint_sha256,config) values($1,'owner','Project','hetzner-cloud','self-managed','simple','ready',7,null,null,null,null,'{}')", [connection]);
      await db.query("insert into public.infrastructure_connection_secrets(connection_id,user_id,encrypted_bundle,key_version) values($1,'owner','sealed-project-fixture',2)", [connection]);
      await db.query("insert into public.infrastructure_capacity_orders(id,user_id,connection_id,active_connection_id,connection_revision,status,server_name,provider_labels,quote_snapshot,quote_fingerprint_sha256,quote_expires_at,idempotency_key,encrypted_bootstrap_bundle,bootstrap_key_version,bootstrap_public_key,bootstrap_public_key_fingerprint,ssh_key_post_attempted_at,provider_ssh_key_status,provider_ssh_key_id) values($1,'owner',$2,$2,7,'creating',$3,'{}','{}',$4,now()+interval '5 minutes',$5,'sealed-bootstrap-fixture',2,$6,$7,now(),'accepted','77')",
        [order, connection, serverName, quote, capacityKey, publicKey, fingerprint]);
      await db.query("insert into public.infrastructure_first_boot_enrollments(order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,capacity_idempotency_key,recipe_version,phase,issued_at,expires_at,verifier_sha256,encrypted_token) values($1,$2,'owner',$3,7,$4,$5,'2026.08.27.1','staged',now()-interval '16 minutes',now()-interval '1 minute',repeat('b',64),repeat('sealed-fixture-',10))",
        [order, attempt, connection, quote, capacityKey]);
      await db.query("update public.infrastructure_capacity_orders set status='created_off',server_post_attempted_at=now(),provider_server_status='accepted',provider_resource_id='42',provider_action_id='500',provider_action_command='create_server',provider_action_status='success',provider_next_actions='[]',observed_server_status='off',provider_observed_at=now(),provider_creation_receipt=$1 where id=$2", [receipt, order]);
      await db.query("update public.infrastructure_first_boot_enrollments set phase='awaiting_identity',provider_server_id='42' where order_id=$1", [order]);
      await db.query("update public.infrastructure_first_boot_enrollments set phase='enrolled',encrypted_token=null,host_public_key=$1,host_fingerprint_sha256=$2,provider_observed_at=issued_at+interval '1 minute',enrolled_at=issued_at+interval '1 minute' where order_id=$3", [publicKey, fingerprint, order]);
      await db.query("insert into public.infrastructure_first_boot_operations(order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,provider_server_id,firewall_post_attempted_at,firewall_receipt,firewall_verified_at,power_on_post_attempted_at,power_on_action) values($1,$2,'owner',$3,7,$4,'42',now()-interval '15 minutes',$5,now()-interval '15 minutes',now()-interval '15 minutes',$6)", [order, attempt, connection, quote, firewall, power]);
      await publishTarget();
    }
    async function publishTarget(changes = {}) {
      const a = { id: target, user: "owner", connection, revision: 7, order, server: "42", caps, ...changes };
      return db.query("insert into public.deployment_targets(id,user_id,connection_id,evidence_connection_revision,external_id,display_name,status,capacity,capabilities,supported_isolation_drivers,isolation_class,provider_capacity_order_id) values($1,$2,$3,$4,$5,'Computer','ready','{}',$6,array['provider-vm'],'provider-vm',$7)",
        [a.id, a.user, a.connection, a.revision, a.server, a.caps, a.order]);
    }

      await seedProvider();
      const provider=launchFixture('byok');
      provider.row={...provider.row,template_skills:null,id:agent,operation_id:op,cpu:2,ram:4,
        deployment_mode:'self-managed',computer_substrate:'provider-vm',
        proxmox_host:'__hivra_self_managed_no_ambient_authority__',pool_id:null,
        infrastructure_connection_id:connection,infrastructure_connection_revision:7,deployment_target_id:target,
        provider_capacity_order_id:order,provider_enrollment_attempt_id:attempt,provider_server_id:'42'};
      await db.exec('set role service_role');
      const result=await launchReserve(provider);
      eq(result.status,'reserved');eq(result.agentId,agent);
      const stored=await readAgent();
      eq(stored.allocation_operation_id,op);eq(stored.operation_id,op);eq(stored.operation_payload,{stage:'pre_allocation_access'});
      eq(stored.computer_substrate,'provider-vm');eq(stored.provider_server_id,'42');
      eq(stored.llm_config,null);eq(stored.llm_api_key_encrypted,null);
      const q=await read('hivra_launch_model_requests',agent);
      eq(q.agent_id,agent);eq(q.provision_operation_id,op);eq(q.phase,'waiting');eq(q.encrypted_key,provider.encryptedKey);
      const duplicate=await launchReserve({...provider,row:{...provider.row,id:randomUUID(),operation_id:randomUUID()},modelId:randomUUID()});
      eq(duplicate.status,'existing');eq(duplicate.agentId,agent);
      await blocked(()=>launchReserve({...provider,requestId:randomUUID(),modelId:randomUUID(),row:{...provider.row,id:randomUUID(),operation_id:randomUUID()}}));
      eq(await value("select public.bind_hivra_provider_direct_access('owner',$1,$2,'203.0.113.11') as result",[agent,op]),false);
      eq(await value("select public.bind_hivra_provider_direct_access('owner',$1,$2,'203.0.113.10') as result",[agent,op]),true);
      const installIdentity={version:1,agentId:agent,operationId:op,bundle:{version:1,state:'bundle_installed',
        provisionerVersion:caps.provisioner.version,bundleSha256:caps.provisioner.bundleSha256,scopeSha256:caps.provisioner.scopeSha256}};
      eq((await value("select public.begin_hivra_provider_install('owner',$1,$2,$3) as result",[agent,op,installIdentity])).outcome,'dispatch');
      eq(await value("select public.record_hivra_provider_install_stopped('owner',$1,$2,$3) as result",
        [agent,op,{version:1,identity:installIdentity,state:'succeeded',stopped:true}]),true);
      eq(await value("select public.complete_hivra_agent_running('owner',$1,$2,'provision','https://203-0-113-10.sslip.io','203.0.113.10',repeat('d',64),clock_timestamp()) as result",[agent,op]),true);
      eq((await binding(provider)).hostname,'203-0-113-10.sslip.io');
      const directAttempt=await claim(provider);
      assert.ok(directAttempt?.attempt_id);checks++;
      eq(await promote(provider,directAttempt),'pending');
      const directDelivery=await value("select public.claim_hivra_model_key_delivery('owner',$1,$2) as result",[agent,provider.modelId]);
      assert.ok(directDelivery?.lease_id);checks++;
      eq(await value("select public.settle_hivra_model_key_operation('owner',$1,$2,$3,$4) as result",
        [agent,provider.modelId,directDelivery.lease_id,request(provider).expectedReceipt]),true);
      eq((await readAgent()).llm_config.mode,'byok');
      eq((await readAgent()).llm_api_key_encrypted,provider.encryptedKey);
      await db.exec('reset role');
      console.log('PASS launch custody provider-vm: original allocation, exact direct HTTPS binding, encrypted-only intent, real SQL promotion/delivery/settlement and exclusive target');

      const connection2=randomUUID(),target2=randomUUID();
      await db.query("insert into public.infrastructure_connections(id,user_id,name,provider,operating_mode,setup_mode,status,revision,ssh_host,ssh_port,ssh_user,ssh_host_fingerprint_sha256,config) values($1,'owner','Home','proxmox','self-managed','advanced','ready',1,'203.0.113.20',22,'root',repeat('f',64),'{}')",[connection2]);
      await db.query("insert into public.deployment_targets(id,user_id,connection_id,evidence_connection_revision,external_id,display_name,status,capacity,capabilities,supported_isolation_drivers,isolation_class) values($1,'owner',$2,1,'pve-home','Home','ready','{}',$3,array['proxmox-kvm'],'hardware-vm')",[target2,connection2,{launchReady:true,provisioner:{configured:true,ready:true,version:'2026.08.28.2'}}]);
      const portable=launchFixture('managed');
      portable.row={...portable.row,deployment_mode:'self-managed',computer_substrate:'proxmox-kvm',pool_id:null,
        proxmox_host:'__hivra_self_managed_no_ambient_authority__',
        infrastructure_connection_id:connection2,infrastructure_connection_revision:1,deployment_target_id:target2};
      await db.exec('set role service_role');
      const portableResult=await launchReserve(portable);
      eq(portableResult.status,'reserved');eq(portableResult.agentId,portable.row.id);
      const portableAgent=await read('hivra_agents',portable.row.id,'id');
      eq(portableAgent.vmid,null);eq(portableAgent.allocation_operation_id,null);
      eq(portableAgent.operation_id,portable.row.operation_id);eq(portableAgent.deployment_target_id,target2);
      eq(portableAgent.infrastructure_connection_id,connection2);eq(portableAgent.llm_config,null);eq(portableAgent.llm_api_key_encrypted,null);
      eq((await read('hivra_launch_model_requests',portable.row.id)).selection,portable.selection);
      await blocked(()=>launchReserve({...portable,requestId:randomUUID(),modelId:randomUUID(),row:{...portable.row,id:randomUUID(),operation_id:randomUUID()}},{user:'foreign'}));
      await blocked(()=>launchReserve({...portable,requestId:randomUUID(),modelId:randomUUID(),row:{...portable.row,id:randomUUID(),operation_id:randomUUID(),infrastructure_connection_revision:2}}));
      eq(await count('managed_venice_proxy_keys'),0);
      await db.exec('reset role');
      console.log('PASS launch custody self-managed Proxmox: actual positive custody reservation, exact owner/revision, no early key, no pre-guessed VM identity');
    }
    eq(await read('hivra_agents',nativeId,'id'),{...native,managed_provisioner_channel:'default'});
    console.log('PASS launch custody cancellation: cancellation wins, terminal wipe, tombstones and preserved native agent');
    console.log(`PASS launch model SQL: ${checks} assertions`);
  } finally { await db.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
