// Isolated PostgreSQL lease/CAS regression; no live credentials or VM access.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
      create function public.update_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end; $$;
      create function public.requesting_user_id() returns text language sql as $$ select 'owner'::text; $$;
      create function public.digest(text,text) returns bytea language sql as $$ select sha256(convert_to($1,'UTF8')); $$;
      create table public.managed_venice_proxy_keys(id uuid primary key,user_id text,status text);`);
    const dir = path.resolve(__dirname, "../supabase/migrations");
    const migration = name => fs.readFileSync(path.join(dir,name),"utf8");
    await db.exec(migration("20260605120000_hivra_agents.sql"));
    await db.exec("alter table public.hivra_agents add column llm_config jsonb, add column llm_api_key_encrypted text");
    for (const file of fs.readdirSync(dir).filter(name => /^202608(?:2[56789]|3[01])/.test(name)
      || ["20260901020000_hivra_remote_desktop_sessions.sql", "20260903010000_hivra_computer_profiles.sql"].includes(name)).sort()) {
      await db.exec(migration(file));
    }
    // Model the independently owned channel contract without importing its
    // changing implementation into this focused lifecycle migration test.
    await db.exec("alter table public.hivra_agents add column managed_provisioner_channel text not null default 'default'");
    await db.exec(migration("20260905150000_hivra_desktop_prepare_lifecycle.sql"));
    const id="11111111-1111-4111-8111-111111111111", other="22222222-2222-4222-8222-222222222222";
    const op="33333333-3333-4333-8333-333333333333", op2="44444444-4444-4444-8444-444444444444";
    const boot="55555555-5555-4555-8555-555555555555";
    const value=async (sql,args=[]) => (await db.query(sql,args)).rows[0]?.result;
    for (const [agent,owner,vmid] of [[id,"owner",1123],[other,"other",1144]]) {
      await db.query(`insert into public.hivra_agents(id,user_id,type,name,status,desired_state,computer_profile,
        computer_substrate,proxmox_host,vmid,ip,api_token,infrastructure_binding_token_hash,infrastructure_binding_token_enforced,
        managed_provisioner_channel) values($1,$2,'linux-desktop','Ubuntu','running','running','ubuntu-desktop',
        'proxmox-kvm','local',$3,'10.241.0.23','test-private-key',repeat('a',64),true,'canary')`,[agent,owner,vmid]);
    }
    const authority=await value("select public.hivra_desktop_prepare_authority(a) as result from public.hivra_agents a where id=$1",[id]);
    const original=await value("select to_jsonb(a) as result from public.hivra_agents a where id=$1",[id]);
    const unrelated=await value("select to_jsonb(a) as result from public.hivra_agents a where id=$1",[other]);
    const begin=(owner="owner", expected=authority, operation=op) => value(
      "select public.begin_hivra_desktop_prepare($1,$2,$3,$4::jsonb) as result",[owner,id,operation,JSON.stringify(expected)]);
    const dispatch=(operation=op) => value("select public.dispatch_hivra_desktop_prepare('owner',$1) as result",[operation]);
    const cancel=(operation=op) => value("select public.cancel_undispatched_hivra_desktop_prepare('owner',$1) as result",[operation]);
    const receipt={version:1,operationId:op,computerId:id,vmid:1123,guestIp:"10.241.0.23",bindingTag:"hivra-bind-"+"a".repeat(32),bootId:boot,exitCode:0};
    const complete=(proof=receipt) => value("select public.complete_hivra_desktop_prepare('owner',$1,$2::jsonb) as result",[proof.operationId,JSON.stringify(proof)]);
    assert.equal(await begin("other"),null);
    for(const change of [{user_id:"other"},{vmid:1144},{ip:"10.241.0.44"},{proxmox_host:"elsewhere"},
      {infrastructure_binding_token_enforced:false},{infrastructure_binding_token_hash:"b".repeat(64)},
      {infrastructure_connection_revision:2},{deployment_target_id:other},{managed_provisioner_channel:"default"}]) {
      assert.equal(await begin("owner",{...authority,...change}),null);
    }
    await db.query("update public.hivra_agents set desired_state='stopped' where id=$1",[id]);
    assert.equal(await begin(),null);
    await db.query("update public.hivra_agents set desired_state='running',status='stopped' where id=$1",[id]);
    assert.equal(await begin(),null);
    await db.query("update public.hivra_agents set status='running' where id=$1",[id]);
    assert.deepEqual(await begin(),{operationId:op,phase:"claimed",resumed:false});
    // A concurrent claimant receives the exact existing journal, never a new
    // dispatch grant; its cancel wins or loses atomically against dispatch.
    assert.deepEqual(await begin("owner",authority,op2),{operationId:op,phase:"claimed",resumed:true});
    assert.equal(await value("select public.claim_hivra_agent_operation('owner',$1,$2,'restart','running',null) as result",[id,op2]),false);
    for (const set of ["operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null",
      "operation_payload='{}'", "vmid=1144", "ip='10.241.0.44'", "user_id='other'", "managed_provisioner_channel='default'",
      "infrastructure_binding_token_enforced=false", "status='stopped'"]) {
      await assert.rejects(() => db.query(`update public.hivra_agents set ${set} where id=$1`,[id]));
    }
    assert.equal(await cancel(),true);
    assert.equal(await dispatch(),false);
    assert.equal(await complete(),false);
    assert.deepEqual(await begin("owner",authority,op2),{operationId:op2,phase:"claimed",resumed:false});
    receipt.operationId=op2;
    assert.equal(await dispatch(op2),true);
    assert.equal(await dispatch(op2),false);
    assert.equal(await cancel(op2),false);
    for(const invalid of [{...receipt,exitCode:null},{...receipt,exitCode:-15},{...receipt,exitCode:256},
      {...receipt,vmid:1144},{...receipt,guestIp:"10.241.0.44"},{...receipt,bindingTag:"wrong"},
      {...receipt,bootId:"not-a-boot-id"},{...receipt,extra:true},{...receipt,version:null}]) {
      assert.equal(await complete(invalid),false);
    }
    await assert.rejects(() => value("select public.release_hivra_agent_operation('owner',$1,$2,'timeout',true) as result",[id,op2]));
    assert.equal(await value("select public.request_hivra_agent_delete('owner',$1,$2) as result",[id,op]),"pending");
    await assert.rejects(() => db.query("update public.hivra_agents set desired_state='running' where id=$1",[id]));
    // Neither service writes nor browser callers may fabricate terminal rows.
    await db.exec("set role service_role");
    await assert.rejects(() => db.query("update public.hivra_desktop_preparations set phase='complete',completed_at=now() where id=$1",[op2]));
    await assert.rejects(() => db.query("delete from public.hivra_desktop_preparations where id=$1",[op2]));
    assert.equal(await complete({...receipt,exitCode:7}),true);
    await db.exec("reset role");
    assert.equal(await value("select status='running' and desired_state='deleted' and operation_id is null as result from public.hivra_agents where id=$1",[id]),true);
    assert.equal(await value("select public.request_hivra_agent_delete('owner',$1,$2) as result",[id,op]),"claimed");
    assert.equal(await complete({...receipt,exitCode:7}),true);
    assert.equal(await value("select operation_kind as result from public.hivra_agents where id=$1",[id]),"delete");
    const after=await value("select to_jsonb(a) as result from public.hivra_agents a where id=$1",[id]);
    for(const key of Object.keys(original).filter(key=>!['desired_state','operation_id','operation_kind','operation_started_at','operation_payload','error','updated_at'].includes(key))) {
      assert.deepEqual(after[key],original[key],`preserved ${key}`);
    }
    assert.deepEqual(await value("select to_jsonb(a) as result from public.hivra_agents a where id=$1",[other]),unrelated);
    // Fresh self-host authority is rechecked at claim and after staging, not
    // inferred from an unchanged agent row or an old connection snapshot.
    const connection="66666666-6666-4666-8666-666666666666", target="77777777-7777-4777-8777-777777777777";
    const self="88888888-8888-4888-8888-888888888888", selfOp="99999999-9999-4999-8999-999999999999";
    await db.query(`insert into public.infrastructure_connections(id,user_id,name,status,ssh_host,ssh_host_fingerprint_sha256)
      values($1,'owner','fixture','ready','192.0.2.10',repeat('c',64))`,[connection]);
    await db.query(`insert into public.deployment_targets(id,user_id,connection_id,external_id,display_name,status,
      evidence_connection_revision,capabilities,isolation_class) values($1,'owner',$2,'fixture','fixture','ready',1,'{"launchReady":true}','hardware-vm')`,[target,connection]);
    await db.query(`insert into public.hivra_agents(id,user_id,type,name,status,desired_state,computer_profile,computer_substrate,
      deployment_mode,proxmox_host,infrastructure_connection_id,deployment_target_id,infrastructure_connection_revision,
      infrastructure_binding_token_hash,infrastructure_binding_token_enforced,vmid,ip) values($1,'owner','linux-desktop','self-host',
      'running','running','ubuntu-desktop','proxmox-kvm','self-managed','__hivra_self_managed_no_ambient_authority__',
      $2,$3,1,repeat('e',64),true,1155,'10.241.0.55')`,[self,connection,target]);
    const selfAuthority=await value("select public.hivra_desktop_prepare_authority(a) as result from public.hivra_agents a where id=$1",[self]);
    const selfBegin=()=>value("select public.begin_hivra_desktop_prepare('owner',$1,$2,$3::jsonb) as result",[self,selfOp,JSON.stringify(selfAuthority)]);
    await db.query("update public.infrastructure_connections set status='error' where id=$1",[connection]);
    assert.equal(await selfBegin(),null);
    await db.query("update public.infrastructure_connections set status='ready' where id=$1",[connection]);
    assert.equal((await selfBegin()).phase,"claimed");
    await db.query("update public.deployment_targets set status='unavailable' where id=$1",[target]);
    assert.equal(await dispatch(selfOp),false);
    assert.equal(await cancel(selfOp),true);
    for(const role of ["anon","authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(() => begin());
      await assert.rejects(() => complete());
      await assert.rejects(() => db.query("select * from public.hivra_desktop_preparations"));
      await db.exec("reset role");
    }
    console.log("PASS: desktop prepare exact owner/identity/channel CAS, shared lease and Delete intent, at-most-once dispatch, nonterminal retention, strict terminal evidence/ACLs, replay and unrelated data preservation");
  } finally { await db.close(); }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
