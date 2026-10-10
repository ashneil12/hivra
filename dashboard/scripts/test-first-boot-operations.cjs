const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

async function main() {
  const db = new PGlite();
  try {
    await db.exec([
      "create role anon; create role authenticated; create role service_role bypassrls;",
      "create table public.infrastructure_connections (id uuid primary key,user_id text,provider text,status text,revision bigint,preflight_run_id uuid,last_checked_at timestamptz,last_error_code text,unique(id,user_id,provider));",
      "create table public.infrastructure_connection_secrets (connection_id uuid references public.infrastructure_connections(id) on delete cascade,user_id text,encrypted_bundle text);",
      "create table public.infrastructure_capacity_inventory (user_id text,connection_id uuid,provider_resource_id text,provider text,name text,provider_status text,server_type jsonb,location jsonb,public_network jsonb,provider_created_at timestamptz,discovered_at timestamptz,created_at timestamptz default now(),unique(connection_id,provider_resource_id));",
      "create table public.deployment_targets(id uuid primary key default gen_random_uuid(),connection_id uuid,status text default 'ready');",
      "create function public.update_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;",
    ].join("\n"));
    const dir = path.resolve(__dirname,"../supabase/migrations");
    const original = fs.readFileSync(path.join(dir,"20260826170000_hetzner_cloud_capacity_orders.sql"),"utf8");
    const extract = name => {
      const start = original.indexOf("create or replace function public." + name + "(");
      assert.ok(start >= 0);
      return original.slice(start,original.indexOf("\n$$;",start)+4);
    };
    await db.exec(extract("is_valid_hetzner_action_receipts"));
    await db.exec(original.slice(original.indexOf("create table if not exists public.infrastructure_capacity_orders"),
      original.indexOf("create or replace function public.create_hetzner_cloud_capacity_quote(")));
    for (const name of ["delete_infrastructure_connection","force_forget_hetzner_cloud_connection",
      "reconcile_hetzner_cloud_inventory","upsert_hetzner_cloud_inventory_server"]) await db.exec(extract(name));
    for (const file of ["20260827150000_hetzner_creation_resource_receipts.sql","20260827160000_hetzner_scoped_cleanup.sql",
      "20260827190000_hetzner_first_boot_enrollment.sql","20260827200000_hetzner_first_boot_operations.sql",
      "20260827210000_hetzner_first_boot_cleanup.sql","20260827220000_hetzner_first_boot_recipe_admission.sql",
      "20260827230000_hetzner_enrolled_guest_lease.sql",
      // Legacy (2026.08.27.1) rules must hold unchanged after the arm-at-start migration.
      "20260924190000_hetzner_first_boot_arm_at_start.sql"]) {
      await db.exec(fs.readFileSync(path.join(dir,file),"utf8"));
    }
    const connection="11111111-1111-4111-8111-111111111111",order="22222222-2222-4222-8222-222222222222";
    const attempt="33333333-3333-4333-8333-333333333333",capacityKey="44444444-4444-4444-8444-444444444444";
    const other="55555555-5555-4555-8555-555555555555",quote="a".repeat(64),serverName="hivra-22222222222242228222";
    const receipt={version:1,serverId:"42",primaryIpv4:{id:"88",ip:"203.0.113.10"},primaryIpv6:{id:"89",ip:"2001:db8::/64"},
      action:{id:"500",command:"create_server",status:"success",resources:[{id:"42",type:"server"}]},nextActions:[]};
    const firewall={version:1,scope:{orderId:order,attemptId:attempt,quoteFingerprint:quote,serverId:42},
      firewallId:91,createdAt:new Date().toISOString(),setRulesActionId:601,applyActionId:602};
    const power={id:603,command:"start_server",status:"running",resources:[{id:42,type:"server"}]};
    const blob=Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020","hex"),Buffer.alloc(32,1)]);
    const publicKey="ssh-ed25519 "+blob.toString("base64"),fingerprint="SHA256:"+createHash("sha256").update(blob).digest("base64").replace(/=+$/,"");
    const value=async(sql,args=[]) => (await db.query(sql,args)).rows[0].result;
    const read=()=>value("select to_jsonb(o) as result from public.infrastructure_first_boot_operations o where order_id=$1",[order]);
    async function reset({armed=false,expired=false,age="0 seconds"}={}) {
      await db.exec("truncate public.deployment_targets,public.infrastructure_first_boot_operations,public.infrastructure_first_boot_enrollments,public.infrastructure_capacity_orders,public.infrastructure_connection_secrets,public.infrastructure_capacity_inventory,public.infrastructure_connections");
      await db.query("insert into public.infrastructure_connections(id,user_id,provider,status,revision) values($1,'owner','hetzner-cloud','ready',7)",[connection]);
      await db.query("insert into public.infrastructure_connection_secrets values($1,'owner','sealed-project-fixture')",[connection]);
      await db.query("insert into public.infrastructure_capacity_orders(id,user_id,connection_id,active_connection_id,connection_revision,status,server_name,provider_labels,quote_snapshot,quote_fingerprint_sha256,quote_expires_at,idempotency_key,encrypted_bootstrap_bundle,bootstrap_key_version,bootstrap_public_key,bootstrap_public_key_fingerprint,ssh_key_post_attempted_at,provider_ssh_key_status,provider_ssh_key_id) values($1,'owner',$2,$2,7,'creating',$3,'{}','{}',$4,now()+interval '5 minutes',$5,'sealed-bootstrap-fixture',2,$6,$7,now(),'accepted','77')",
        [order,connection,serverName,quote,capacityKey,publicKey,fingerprint]);
      // Direct fixture insertion models a past attempt without weakening any
      // immutable trigger, changing wall clock, or sleeping for fifteen minutes.
      await db.query("with stamp as (select clock_timestamp()-$6::interval as issued) insert into public.infrastructure_first_boot_enrollments(order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,capacity_idempotency_key,recipe_version,phase,issued_at,expires_at,verifier_sha256,encrypted_token) select $1,$2,'owner',$3,7,$4,$5,'2026.08.27.1','staged',issued,issued+interval '15 minutes',repeat('b',64),repeat('sealed-fixture-',10) from stamp",
        [order,attempt,connection,quote,capacityKey,expired?"16 minutes":age]);
      await db.query("update public.infrastructure_capacity_orders set status='created_off',server_post_attempted_at=now(),provider_server_status='accepted',provider_resource_id='42',provider_action_id='500',provider_action_command='create_server',provider_action_status='success',provider_next_actions='[]',observed_server_status='off',provider_observed_at=now(),provider_creation_receipt=$1 where id=$2",[receipt,order]);
      if (armed) assert.equal(await arm(),true);
    }
    const arm=()=>value("select public.arm_hetzner_first_boot('owner',$1,7,$2,$3,$4,'42',$5) as result",[connection,order,attempt,capacityKey,receipt]);
    function claim(overrides={}) {
      const a={user:"owner",connection,revision:7,order,attempt,quote,server:"42",...overrides};
      return value("select public.claim_hetzner_first_boot_operation($1,$2,$3,$4,$5,$6,$7) as result",[a.user,a.connection,a.revision,a.order,a.attempt,a.quote,a.server]);
    }
    function checkpoint(lease,event,evidence=null,observed=null,overrides={}) {
      const a={user:"owner",connection,revision:7,order,attempt,quote,server:"42",lease,event,evidence,observed,...overrides};
      return value("select public.checkpoint_hetzner_first_boot_operation($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as result",
        [a.user,a.connection,a.revision,a.order,a.attempt,a.quote,a.server,a.lease,a.event,a.evidence,a.observed]);
    }
    const release=(lease,server="42",fingerprint=quote)=>value("select public.release_hetzner_first_boot_operation('owner',$1,7,$2,$3,$4,$5,$6) as result",[connection,order,attempt,fingerprint,server,lease]);
    const abandon=(name=serverName,confirmation="Stop setup; provider resources and billing remain",server="42",fingerprint=quote)=>value(
      "select public.abandon_hetzner_first_boot_operation('owner',$1,7,$2,$3,$4,$5,$6,$7) as result",[connection,order,attempt,fingerprint,server,name,confirmation]);
    const cleanup=()=>value("select public.claim_hetzner_cleanup('owner',$1,7,$2,$3,$4,$5,$6) as result",[connection,order,other,capacityKey,"d".repeat(64),serverName]);
    const disconnect=()=>value("select public.delete_infrastructure_connection('owner',$1) as result",[connection]);
    const blocked=fn=>assert.rejects(fn,e=>e.code==="55006");
    await reset();
    for(const change of [{user:"foreign"},{connection:other},{revision:8},{order:other},{attempt:other},{quote:"c".repeat(64)},{server:"43"},{server:null}]) {
      assert.equal((await claim(change)).outcome,"rejected");
    }
    const first=await claim(),lease=first.record.lease_id;
    assert.equal(first.outcome,"claimed");
    assert.ok(Date.parse(first.record.lease_expires_at)-Date.now()<=120_000);
    assert.equal((await claim()).outcome,"busy");
    assert.equal((await read()).lease_expires_at,first.record.lease_expires_at);
    assert.equal((await cleanup()).outcome,"busy"); await blocked(()=>disconnect());
    await blocked(()=>db.exec("update public.infrastructure_connections set revision=8"));
    await blocked(()=>db.exec("delete from public.infrastructure_connection_secrets"));
    await blocked(()=>db.exec("update public.infrastructure_connection_secrets set encrypted_bundle='rotated'"));
    await blocked(()=>db.exec("update public.infrastructure_first_boot_enrollments set phase='revoked',encrypted_token=null"));
    assert.equal(await abandon(),false);
    for (const change of [{user:"foreign"},{connection:other},{revision:8},{order:other},{attempt:other},{lease:other},{quote:"c".repeat(64)},{server:"43"}]) {
      assert.equal(await checkpoint(lease,"firewall_dispatch",null,null,change),false);
    }
    assert.equal(await checkpoint(lease,"power_dispatch"),false);
    assert.equal(await checkpoint(lease,"firewall_receipt",firewall),false);
    assert.equal(await checkpoint(lease,"firewall_dispatch",{}),false);
    await assert.rejects(()=>checkpoint(lease,"arbitrary-command"),error=>error.code==="22023");
    await assert.rejects(()=>checkpoint(lease,null),error=>error.code==="22023");
    assert.equal(await checkpoint(lease,"firewall_dispatch"),true);
    assert.equal(await checkpoint(lease,"firewall_dispatch"),false);
    for(const change of [{scope:{...firewall.scope,quoteFingerprint:"c".repeat(64)}},{scope:{...firewall.scope,serverId:43}},
      {firewallId:"91"},{firewallId:0},{firewallId:9007199254740992},{createdAt:"forever"},{createdAt:null},
      {setRulesActionId:602},{extra:"untrusted"},{scope:{...firewall.scope,extra:"field"}}]) {
      assert.equal(await checkpoint(lease,"firewall_receipt",{...firewall,...change}),false);
    }
    assert.equal(await checkpoint(lease,"firewall_receipt",firewall),true);
    assert.equal(await checkpoint(lease,"firewall_receipt",firewall),true);
    assert.equal(await checkpoint(lease,"firewall_receipt",{...firewall,firewallId:92}),false);
    for (const at of [null,new Date(Date.now()-31_000).toISOString(),new Date(Date.now()+6_000).toISOString()]) {
      assert.equal(await checkpoint(lease,"firewall_verified",firewall,at),false);
    }
    assert.equal(await checkpoint(lease,"firewall_verified",firewall,new Date().toISOString()),true);
    assert.equal(await checkpoint(lease,"power_dispatch"),false); // Not armed yet.
    assert.equal(await arm(),true);
    assert.equal(await checkpoint(lease,"power_dispatch"),true);
    assert.equal(await checkpoint(lease,"power_dispatch"),false);
    assert.equal(await checkpoint(lease,"power_receipt",{...power,command:"poweron"}),false);
    assert.equal(await checkpoint(lease,"power_receipt",{...power,resources:[{id:43,type:"server"}]}),false);
    assert.equal(await checkpoint(lease,"power_receipt",power),true);
    assert.equal(await checkpoint(lease,"power_receipt",{...power,id:604}),false);
    assert.equal(await checkpoint(lease,"power_receipt",{...power,status:"success"}),true);
    assert.equal(await checkpoint(lease,"power_receipt",power),false);
    assert.equal(await checkpoint(lease,"power_receipt",{...power,status:"error"}),false);
    assert.equal(await release(other),false);
    assert.equal(await release(lease,"43"),false);
    assert.equal(await release(lease,"42","c".repeat(64)),false);
    assert.equal(await release(lease),true);
    assert.equal(await checkpoint(lease,"firewall_dispatch"),false);
    assert.equal((await cleanup()).outcome,"confirmation_changed"); await blocked(()=>disconnect()); // Even after lease release.
    const resumed=await claim(),newLease=resumed.record.lease_id;
    assert.notEqual(newLease,lease);
    assert.equal(await release(lease),false);
    assert.equal((await read()).lease_id,newLease);
    assert.equal(await checkpoint(newLease,"firewall_dispatch"),false);
    assert.equal(await checkpoint(newLease,"power_dispatch"),false);
    for(const sql of ["delete from public.infrastructure_first_boot_operations",
      "update public.infrastructure_first_boot_operations set firewall_post_attempted_at=null,firewall_receipt=null,firewall_verified_at=null,power_on_post_attempted_at=null,power_on_action=null",
      "update public.infrastructure_first_boot_operations set provider_server_id='43'",
      "update public.infrastructure_first_boot_operations set lease_expires_at=lease_expires_at+interval '1 minute'"]) await blocked(()=>db.exec(sql));
    assert.equal(await release(newLease),true);
    assert.equal(await abandon("wrong"),false); assert.equal(await abandon(serverName,"billing only"),false);
    assert.equal(await abandon(serverName,undefined,"43"),false);
    assert.equal(await abandon(serverName,undefined,"42","c".repeat(64)),false);
    assert.equal(await abandon(),true); assert.equal(await abandon(),true);
    assert.equal(await value("select count(*) as result from public.infrastructure_connection_secrets"),1);
    assert.equal(await value("select encrypted_bootstrap_bundle as result from public.infrastructure_capacity_orders"),"sealed-bootstrap-fixture");
    assert.equal(await value("select phase as result from public.infrastructure_first_boot_enrollments"),"revoked");
    assert.equal((await claim()).outcome,"rejected");
    assert.equal((await cleanup()).outcome,"confirmation_changed"); // Fifth-resource cleanup requires its exact receipt.
    assert.equal(await disconnect(),"deleted");
    assert.equal(await value("select count(*) as result from public.infrastructure_connection_secrets"),0);
    assert.equal(await value("select phase as result from public.infrastructure_first_boot_enrollments"),"revoked");
    assert.equal(await value("select status as result from public.infrastructure_capacity_orders"),"created_off");
    assert.equal((await read()).firewall_receipt.firewallId,91);
    await blocked(()=>db.exec("update public.infrastructure_first_boot_operations set abandoned_at=null"));
    // No mutation was dispatched: releasing the owner permits normal cleanup.
    await reset(); const idle=(await claim()).record.lease_id;
    assert.equal(await release(idle),true); assert.equal((await cleanup()).outcome,"claimed");
    assert.equal((await claim()).outcome,"rejected");
    // A genuinely expired lease cannot dispatch, but its lost POST marker
    // survives new ownership. No fabricated provider receipt can clear it.
    await reset();
    await db.query("insert into public.infrastructure_first_boot_operations(order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,provider_server_id,lease_id,lease_expires_at,firewall_post_attempted_at) values($1,$2,'owner',$3,7,$4,'42',$5,clock_timestamp()-interval '1 minute',clock_timestamp()-interval '2 minutes')",
      [order,attempt,connection,quote,other]);
    assert.equal(await checkpoint(other,"firewall_dispatch"),false);
    await blocked(()=>disconnect());assert.equal((await cleanup()).outcome,"not_eligible");
    const recovered=(await claim()).record.lease_id;
    assert.notEqual(recovered,other); assert.equal(await checkpoint(recovered,"firewall_dispatch"),false);
    assert.equal(await release(other),false); assert.equal(await release(recovered),true);
    assert.equal(await abandon(),true);
    await reset({expired:true}); assert.equal((await claim()).outcome,"rejected");
    await reset({age:"14 minutes 20 seconds"}); assert.equal((await claim()).outcome,"rejected");
    await reset();
    await db.query("insert into public.infrastructure_first_boot_operations(order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,provider_server_id,lease_id,lease_expires_at) values($1,$2,'owner',$3,7,$4,'42',$5,clock_timestamp()+interval '20 seconds')",
      [order,attempt,connection,quote,other]);
    assert.equal(await checkpoint(other,"firewall_dispatch"),false); // No dispatch near expiry.
    assert.equal((await read()).firewall_post_attempted_at,null);
    const roles=await value("select jsonb_build_object('anon',has_table_privilege('anon','public.infrastructure_first_boot_operations','select'),'auth',has_table_privilege('authenticated','public.infrastructure_first_boot_operations','select'),'service',has_table_privilege('service_role','public.infrastructure_first_boot_operations','select'),'rls',(select relrowsecurity from pg_class where oid='public.infrastructure_first_boot_operations'::regclass),'public_rpc',has_function_privilege('anon','public.claim_hetzner_first_boot_operation(text,uuid,bigint,uuid,uuid,text,text)','execute')) as result");
    assert.deepEqual(roles,{anon:false,auth:false,service:true,rls:true,public_rpc:false});
    const enrolledClaim=(changes={})=>{
      const a={user:"owner",connection,revision:7,order,attempt,quote,server:"42",...changes};
      return value("select public.claim_hetzner_enrolled_guest_operation($1,$2,$3,$4,$5,$6,$7) as result",
        [a.user,a.connection,a.revision,a.order,a.attempt,a.quote,a.server]);
    };
    async function enrolledFixture(){
      await reset({expired:true});
      // Historical completed enrollment fixture. Do not alter a capability's
      // immutable expiry or loosen the real consume/arm admission to create it.
      await db.exec("update public.infrastructure_first_boot_enrollments set phase='awaiting_identity',provider_server_id='42'");
      await db.query("update public.infrastructure_first_boot_enrollments set phase='enrolled',encrypted_token=null,host_public_key=$1,host_fingerprint_sha256=$2,provider_observed_at=issued_at+interval '1 minute',enrolled_at=issued_at+interval '1 minute'",[publicKey,fingerprint]);
      await db.query("insert into public.infrastructure_first_boot_operations(order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,provider_server_id,firewall_post_attempted_at,firewall_receipt,firewall_verified_at,power_on_post_attempted_at,power_on_action) values($1,$2,'owner',$3,7,$4,'42',now()-interval '15 minutes',$5,now()-interval '15 minutes',now()-interval '15 minutes',$6)",[order,attempt,connection,quote,firewall,power]);
    }
    await reset({expired:true});assert.equal((await enrolledClaim()).outcome,"rejected");
    await reset({armed:true});assert.equal((await enrolledClaim()).outcome,"rejected");
    await enrolledFixture();
    const originalPin=await value("select jsonb_build_object('expires',expires_at,'pin',host_public_key,'verifier',verifier_sha256,'encrypted',encrypted_token) as result from public.infrastructure_first_boot_enrollments");
    assert.equal((await claim()).outcome,"rejected"); // Enrollment/boot authority remains expired.
    for(const change of [{user:"foreign"},{connection:other},{revision:8},{order:other},{attempt:other},{quote:"c".repeat(64)},{server:"43"},{server:null}])assert.equal((await enrolledClaim(change)).outcome,"rejected");
    const verifiedClaim=await enrolledClaim(),verifiedLease=verifiedClaim.record.lease_id;
    assert.equal(verifiedClaim.outcome,"claimed");
    assert.ok(Date.parse(verifiedClaim.record.lease_expires_at)-Date.now()>110_000);
    assert.equal((await enrolledClaim()).outcome,"busy");
    assert.equal((await claim()).outcome,"rejected");
    const fullCleanup=()=>value("select public.claim_hetzner_cleanup_with_firewall('owner',$1,7,$2,$3,$4,$5,$6,$7) as result",[connection,order,capacityKey,other,"d".repeat(64),serverName,firewall]);
    assert.equal((await fullCleanup()).outcome,"busy");
    await blocked(()=>disconnect());await blocked(()=>db.exec("update public.infrastructure_connections set revision=8"));
    await blocked(()=>db.exec("delete from public.infrastructure_connection_secrets"));
    await blocked(()=>db.exec("update public.infrastructure_first_boot_enrollments set phase='revoked'"));
    assert.equal(await abandon(),false);
    assert.equal(await checkpoint(verifiedLease,"power_dispatch"),false);
    assert.equal(await checkpoint(verifiedLease,"firewall_dispatch"),false);
    assert.equal(await value("select public.consume_hetzner_first_boot('owner',$1,7,$2,$3,'42',repeat('b',64),$4,$5,clock_timestamp()) as result",[connection,order,attempt,publicKey,fingerprint]),"rejected");
    assert.deepEqual(await value("select jsonb_build_object('expires',expires_at,'pin',host_public_key,'verifier',verifier_sha256,'encrypted',encrypted_token) as result from public.infrastructure_first_boot_enrollments"),originalPin);
    assert.equal(await release(other),false);assert.equal(await release(verifiedLease),true);
    const secondLease=(await enrolledClaim()).record.lease_id;assert.notEqual(secondLease,verifiedLease);
    assert.equal(await release(verifiedLease),false);assert.equal(await release(secondLease),true);
    assert.equal((await fullCleanup()).outcome,"claimed"); // Other serialization order: cleanup wins.
    assert.equal((await enrolledClaim()).outcome,"rejected");
    await enrolledFixture();assert.equal(await abandon(),true);assert.equal((await enrolledClaim()).outcome,"rejected");
    await enrolledFixture();await db.exec("update public.infrastructure_connections set status='error'");assert.equal((await enrolledClaim()).outcome,"rejected");
    const access=await value("select jsonb_build_object('anon',has_function_privilege('anon','public.claim_hetzner_enrolled_guest_operation(text,uuid,bigint,uuid,uuid,text,text)','execute'),'auth',has_function_privilege('authenticated','public.claim_hetzner_enrolled_guest_operation(text,uuid,bigint,uuid,uuid,text,text)','execute'),'service',has_function_privilege('service_role','public.claim_hetzner_enrolled_guest_operation(text,uuid,bigint,uuid,uuid,text,text)','execute'),'definer',(select prosecdef from pg_proc where oid='public.claim_hetzner_enrolled_guest_operation(text,uuid,bigint,uuid,uuid,text,text)'::regprocedure)) as result");
    assert.deepEqual(access,{anon:false,auth:false,service:true,definer:false});
    console.log("PASS first-boot operation SQL: exact scope, bounded leases, one-shot dispatch, receipts, monotonic actions, stale workers, revocation, cleanup exclusion, explicit abandonment, retained audit and service-only/RLS");
    console.log("PASS enrolled guest SQL: persisted pin after token expiry, fresh shared lease, no token revival, cleanup/revocation exclusion in both serialization orders, exact scope and service-only authority");
  } finally { await db.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
