const assert=require("node:assert/strict");
const {createHash}=require("node:crypto");
const fs=require("node:fs"),path=require("node:path");
const {PGlite}=require("@electric-sql/pglite");

async function main(){
 const db=new PGlite();
 try{
  await db.exec([
   "create role anon;create role authenticated;create role service_role bypassrls;",
   "create table public.infrastructure_connections(id uuid primary key,user_id text,provider text,status text,revision bigint,preflight_run_id uuid,last_checked_at timestamptz,last_error_code text,unique(id,user_id,provider));",
   "create table public.infrastructure_connection_secrets(connection_id uuid references public.infrastructure_connections(id) on delete cascade,user_id text,encrypted_bundle text);",
   "create table public.infrastructure_capacity_inventory(user_id text,connection_id uuid,provider_resource_id text,provider text,name text,provider_status text,server_type jsonb,location jsonb,public_network jsonb,provider_created_at timestamptz,discovered_at timestamptz,created_at timestamptz default now(),unique(connection_id,provider_resource_id));",
   "create table public.deployment_targets(id uuid primary key default gen_random_uuid(),connection_id uuid,status text default 'ready');",
   "create function public.update_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now();return new;end;$$;",
  ].join("\n"));
  const dir=path.resolve(__dirname,"../supabase/migrations");
  const original=fs.readFileSync(path.join(dir,"20260826170000_hetzner_cloud_capacity_orders.sql"),"utf8");
  const extract=name=>{const start=original.indexOf("create or replace function public."+name+"(");assert.ok(start>=0);return original.slice(start,original.indexOf("\n$$;",start)+4);};
  await db.exec(extract("is_valid_hetzner_action_receipts"));
  await db.exec(original.slice(original.indexOf("create table if not exists public.infrastructure_capacity_orders"),original.indexOf("create or replace function public.create_hetzner_cloud_capacity_quote(")));
  for(const name of ["delete_infrastructure_connection","force_forget_hetzner_cloud_connection","reconcile_hetzner_cloud_inventory","upsert_hetzner_cloud_inventory_server"])await db.exec(extract(name));
  for(const file of ["20260827150000_hetzner_creation_resource_receipts.sql","20260827160000_hetzner_scoped_cleanup.sql",
   "20260827190000_hetzner_first_boot_enrollment.sql","20260827200000_hetzner_first_boot_operations.sql","20260827210000_hetzner_first_boot_cleanup.sql"]){
   await db.exec(fs.readFileSync(path.join(dir,file),"utf8"));
  }
  const connection="11111111-1111-4111-8111-111111111111",order="22222222-2222-4222-8222-222222222222";
  const attempt="33333333-3333-4333-8333-333333333333",key="44444444-4444-4444-8444-444444444444",lease="55555555-5555-4555-8555-555555555555";
  const other="66666666-6666-4666-8666-666666666666",quote="a".repeat(64),name="hivra-22222222222242228222",cleanupFingerprint="c".repeat(64);
  const blob=Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020","hex"),Buffer.alloc(32,1)]);
  const publicKey="ssh-ed25519 "+blob.toString("base64"),fingerprint="SHA256:"+createHash("sha256").update(blob).digest("base64").replace(/=+$/,"");
  const creation={version:1,serverId:"42",primaryIpv4:{id:"88",ip:"203.0.113.10"},primaryIpv6:{id:"89",ip:"2001:db8::/64"},action:{id:"500",command:"create_server",status:"success",resources:[{id:"42",type:"server"}]},nextActions:[]};
  const firewall={version:1,scope:{orderId:order,attemptId:attempt,quoteFingerprint:quote,serverId:42},firewallId:91,createdAt:new Date().toISOString(),setRulesActionId:601,applyActionId:602};
  const none={server:false,ipv4:false,ipv6:false,sshKey:false,firewall:false};
  const all={server:true,ipv4:true,ipv6:true,sshKey:true,firewall:true};
  const value=async(sql,args=[]) => (await db.query(sql,args)).rows[0].result;
  const read=()=>value("select to_jsonb(o) as result from public.infrastructure_capacity_orders o where id=$1",[order]);
  const phase=()=>value("select phase as result from public.infrastructure_first_boot_enrollments where order_id=$1",[order]);
  async function reset(boot=true){
   await db.exec("truncate public.deployment_targets,public.infrastructure_first_boot_operations,public.infrastructure_first_boot_enrollments,public.infrastructure_capacity_orders,public.infrastructure_connection_secrets,public.infrastructure_capacity_inventory,public.infrastructure_connections");
   await db.query("insert into public.infrastructure_connections(id,user_id,provider,status,revision) values($1,'owner','hetzner-cloud','ready',7)",[connection]);
   await db.query("insert into public.infrastructure_connection_secrets values($1,'owner','sealed-project-fixture')",[connection]);
   await db.query("insert into public.infrastructure_capacity_orders(id,user_id,connection_id,active_connection_id,connection_revision,status,server_name,provider_labels,quote_snapshot,quote_fingerprint_sha256,quote_expires_at,idempotency_key,encrypted_bootstrap_bundle,bootstrap_key_version,bootstrap_public_key,bootstrap_public_key_fingerprint,ssh_key_post_attempted_at,provider_ssh_key_status,provider_ssh_key_id) values($1,'owner',$2,$2,7,'creating',$3,'{}','{}',$4,now()+interval '5 minutes',$5,'sealed-bootstrap-fixture',2,$6,$7,now(),'accepted','77')",[order,connection,name,quote,key,publicKey,fingerprint]);
   if(boot){
    const issued=new Date().toISOString(),expires=new Date(Date.parse(issued)+900_000).toISOString();
    const staged=await value("select public.stage_hetzner_first_boot('owner',$1,7,$2,$3,$4,$5,'2026.08.27.1',$6,$7,repeat('b',64),repeat('sealed-fixture-',10),'Prepare this computer for agent launch') as result",[connection,order,key,attempt,quote,issued,expires]);
    assert.equal(staged.outcome,"staged");
   }
   await db.query("update public.infrastructure_capacity_orders set status='created_off',server_post_attempted_at=now(),provider_server_status='accepted',provider_resource_id='42',provider_action_id='500',provider_action_command='create_server',provider_action_status='success',provider_next_actions='[]',observed_server_status='off',provider_observed_at=now(),provider_creation_receipt=$1 where id=$2",[creation,order]);
  }
  const claimBoot=()=>value("select public.claim_hetzner_first_boot_operation('owner',$1,7,$2,$3,$4,'42') as result",[connection,order,attempt,quote]);
  const checkpoint=(bootLease,event,evidence=null,observed=null)=>value("select public.checkpoint_hetzner_first_boot_operation('owner',$1,7,$2,$3,$4,'42',$5,$6,$7,$8) as result",[connection,order,attempt,quote,bootLease,event,evidence,observed]);
  const release=bootLease=>value("select public.release_hetzner_first_boot_operation('owner',$1,7,$2,$3,$4,'42',$5) as result",[connection,order,attempt,quote,bootLease]);
  const claim=(token=lease,expectedFirewall=firewall)=>value("select public.claim_hetzner_cleanup_with_firewall('owner',$1,7,$2,$3,$4,$5,$6,$7) as result",[connection,order,key,token,cleanupFingerprint,name,expectedFirewall]);
  const legacyClaim=()=>value("select public.claim_hetzner_cleanup('owner',$1,7,$2,$3,$4,$5,$6) as result",[connection,order,key,lease,cleanupFingerprint,name]);
  const record=(absence,error=null,token=lease)=>value("select public.record_hetzner_cleanup_observation('owner',$1,7,$2,$3,$4,$5) as result",[connection,order,token,absence,error]);
  const disconnect=()=>value("select public.delete_infrastructure_connection('owner',$1) as result",[connection]);
  const blocked=action=>assert.rejects(action,error=>error.code==="55006");
  async function ownedFirewall(){
   await reset();const bootLease=(await claimBoot()).record.lease_id;
   assert.equal(await checkpoint(bootLease,"firewall_dispatch"),true);
   assert.equal(await checkpoint(bootLease,"firewall_receipt",firewall),true);
   return bootLease;
  }
  let bootLease=await ownedFirewall();
  assert.equal((await claim()).outcome,"busy");
  assert.equal((await read()).cleanup_firewall_receipt,null);
  assert.equal(await release(bootLease),true);
  assert.equal((await claim(lease,null)).outcome,"confirmation_changed");
  assert.equal((await legacyClaim()).outcome,"confirmation_changed");
  assert.equal((await read()).status,"created_off");
  assert.equal((await read()).cleanup_resource_fingerprint,null);
  assert.equal((await claim(lease,{...firewall,firewallId:92})).outcome,"confirmation_changed");
  assert.equal((await claim()).outcome,"claimed");
  assert.equal(await phase(),"revoked");
  assert.deepEqual((await read()).cleanup_firewall_receipt,firewall);
  assert.deepEqual((await read()).cleanup_absence,none);
  assert.equal((await claimBoot()).outcome,"rejected");
  assert.equal(await checkpoint(bootLease,"power_dispatch"),false);
  await blocked(()=>disconnect());
  await blocked(()=>db.exec("delete from public.infrastructure_connection_secrets"));
  await blocked(()=>db.query("insert into public.deployment_targets(connection_id) values($1)",[connection]));
  for(const bad of [null,{}, {server:true,ipv4:true,ipv6:true,sshKey:true}, {...all,firewall:"true"},{...all,extra:true}]){
   await assert.rejects(()=>record(bad));
   assert.equal((await read()).status,"cleaning");
   assert.equal((await read()).encrypted_bootstrap_bundle,"sealed-bootstrap-fixture");
  }
  await blocked(()=>db.query("update public.infrastructure_capacity_orders set cleanup_firewall_receipt=$1 where id=$2",[{...firewall,firewallId:92},order]));
  const partial={...all,firewall:false};
  assert.equal((await record(partial)).status,"cleaning");
  assert.equal((await read()).encrypted_bootstrap_bundle,"sealed-bootstrap-fixture");
  assert.equal((await claim(other)).outcome,"claimed");
  assert.equal(await record(all),null); // Stale worker cannot finish.
  const done=await record(all,null,other);
  assert.equal(done.status,"deleted");assert.equal(done.encrypted_bootstrap_bundle,null);
  assert.deepEqual(done.cleanup_firewall_receipt,firewall);
  assert.equal((await claim()).outcome,"complete");
  assert.equal(await disconnect(),"deleted");
  assert.equal(await value("select count(*) as result from public.infrastructure_connection_secrets"),0);
  assert.equal(await value("select count(*) as result from public.infrastructure_first_boot_operations"),1);
  // A lost firewall receipt never permits deletion guessed from a name.
  await reset();bootLease=(await claimBoot()).record.lease_id;
  assert.equal(await checkpoint(bootLease,"firewall_dispatch"),true);await release(bootLease);
  assert.equal((await claim()).outcome,"not_eligible");await blocked(()=>disconnect());
  // Published target rows block unused-capacity deletion, including disabled
  // evidence. Their exact lifecycle/retirement is a separate integration gate.
  bootLease=await ownedFirewall();await release(bootLease);
  await db.query("insert into public.deployment_targets(connection_id,status) values($1,'disabled')",[connection]);
  assert.equal((await claim()).outcome,"target_in_use");
  assert.equal((await read()).status,"created_off");
  // Existing capacity-only cleanup keeps exactly its original four resources.
  await reset(false);assert.equal((await legacyClaim()).outcome,"claimed");
  const four={server:true,ipv4:true,ipv6:true,sshKey:true};
  await assert.rejects(()=>record(all));
  assert.equal((await record(four)).status,"deleted");assert.equal(await disconnect(),"deleted");
  // Explicit local forget after a failed five-resource cleanup retains the
  // complete audit/slot claim but removes access in the same transaction.
  bootLease=await ownedFirewall();await release(bootLease);await claim();await record(none,"provider_unavailable");
  assert.equal(await value("select public.abandon_hetzner_cleanup('owner',$1,$2,$3,$4) as result",[connection,order,key,cleanupFingerprint]),true);
  const abandoned=await read();assert.equal(abandoned.status,"cleanup_abandoned");
  assert.equal(abandoned.encrypted_bootstrap_bundle,null);assert.deepEqual(abandoned.cleanup_firewall_receipt,firewall);
  assert.equal(await value("select count(*) as result from public.infrastructure_connection_secrets"),0);
  assert.equal(await value("select count(*) as result from public.infrastructure_first_boot_operations"),1);
  const permissions=await value("select jsonb_build_object('anon',has_function_privilege('anon','public.claim_hetzner_cleanup_with_firewall(text,uuid,bigint,uuid,uuid,uuid,text,text,jsonb)','execute'),'authenticated',has_function_privilege('authenticated','public.record_hetzner_cleanup_observation(text,uuid,bigint,uuid,uuid,jsonb,text)','execute'),'service',has_function_privilege('service_role','public.is_valid_hetzner_cleanup_absence(jsonb,boolean)','execute')) as result");
  assert.deepEqual(permissions,{anon:false,authenticated:false,service:true});
  console.log("PASS first-boot cleanup SQL: shared ownership, immutable fifth resource, exact absence set, stale workers, target publication exclusion, legacy compatibility and atomic access abandonment");
 }finally{await db.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
