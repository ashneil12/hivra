// Real isolated PostgreSQL, full portable schema; never a live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
      create function public.update_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end; $$;
      create function public.requesting_user_id() returns text language sql as $$ select 'owner'::text; $$;
      create function public.digest(text,text) returns bytea language sql as $$ select sha256(convert_to($1,'UTF8')); $$;
      create table public.managed_venice_proxy_keys(id uuid primary key,user_id text,status text);
    `);
    const dir = path.resolve(__dirname, "../supabase/migrations");
    const migration = name => fs.readFileSync(path.join(dir, name), "utf8");
    await db.exec(migration("20260605120000_hivra_agents.sql"));
    await db.exec("alter table public.hivra_agents add column llm_config jsonb, add column llm_api_key_encrypted text");
    for (const name of fs.readdirSync(dir).filter(name => /^2026082[5678]/.test(name)).sort()) await db.exec(migration(name));
    const connection = "11111111-1111-4111-8111-111111111111", order = "22222222-2222-4222-8222-222222222222";
    const key = "33333333-3333-4333-8333-333333333333", other = "44444444-4444-4444-8444-444444444444";
    const serverName = "hivra-22222222222242228222";
    const value = async (sql, args=[]) => (await db.query(sql, args)).rows[0].result;
    const read = () => value("select to_jsonb(o) as result from public.infrastructure_capacity_orders o where id=$1", [order]);
    const scope = (owner="owner", conn=connection) => value("select public.hetzner_external_cleanup_scope($1,$2,$3) as result", [owner,conn,order]);
    const stageEnrollment = () => db.query(`insert into public.infrastructure_first_boot_enrollments(
      order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,capacity_idempotency_key,
      recipe_version,phase,issued_at,expires_at,verifier_sha256,encrypted_token)
      values($1,$2,'owner',$3,7,repeat('a',64),$4,'2026.08.27.1','staged',now()-interval '1 hour',now()-interval '45 minutes',repeat('b',64),repeat('fixture',10))`,[order,other,connection,key]);
    async function reset() {
      await db.exec("truncate public.infrastructure_connections cascade");
      // Capacity history is deliberately independent of disconnected credentials.
      await db.exec("truncate public.infrastructure_capacity_orders cascade");
      await db.query("insert into public.infrastructure_connections(id,user_id,name,provider,operating_mode,setup_mode,status,revision,config,ssh_port,ssh_user) values($1,'owner','Fixture','hetzner-cloud','self-managed','simple','ready',7,'{}',null,null)", [connection]);
      await db.query("insert into public.infrastructure_connection_secrets(connection_id,user_id,encrypted_bundle,key_version) values($1,'owner','sealed-fixture',2)", [connection]);
      await db.query(`insert into public.infrastructure_capacity_orders(id,user_id,connection_id,active_connection_id,connection_revision,status,
        server_name,provider_labels,quote_snapshot,quote_fingerprint_sha256,quote_expires_at,idempotency_key,encrypted_bootstrap_bundle,
        bootstrap_key_version,bootstrap_public_key,bootstrap_public_key_fingerprint,ssh_key_post_attempted_at,provider_ssh_key_status,
        provider_ssh_key_id,server_post_attempted_at,provider_server_status,provider_resource_id,observed_server_status)
        values($1,'owner',$2,$2,7,'ambiguous',$3,'{}','{}',repeat('a',64),now()-interval '1 hour',$4,'sealed-bootstrap',2,
          'public-fixture','SHA256:'||repeat('A',43),now()-interval '1 hour','accepted','77',now()-interval '1 hour','accepted','42','off')`,
      [order,connection,serverName,key]);
    }
    async function resolve(overrides={}) {
      const s = await scope();
      const a = { owner:"owner",conn:connection,revision:7,id:order,key,name:serverName,digest:s?.stateSha256,
        evidence:{version:1,serverId:"42",sshKeyId:"77",observedAt:new Date().toISOString(),serverAbsent:true,sshKeyAbsent:true,projectServers:0,projectPrimaryIps:0}, ...overrides };
      return value("select public.resolve_hetzner_external_cleanup($1,$2,$3,$4,$5,$6,$7,$8) as result",
        [a.owner,a.conn,a.revision,a.id,a.key,a.name,a.digest,a.evidence]);
    }
    await reset();
    assert.equal(await scope("foreign"),null);
    assert.equal(await scope("owner",other),null);
    for (const bad of [{owner:"foreign"},{conn:other},{revision:8},{id:other},{name:"another-server"},{digest:"b".repeat(64)}]) {
      assert.notEqual((await resolve(bad)).outcome,"resolved");
      assert.equal((await read()).external_cleanup_resolution_id,null);
    }
    for (const mutate of [
      v=>{v.serverId="43";}, v=>{v.sshKeyAbsent=false;}, v=>{v.projectServers=1;}, v=>{v.projectPrimaryIps=1;},
      v=>{v.serverAbsent="true";}, v=>{v.token="must-not-store";}, v=>{delete v.observedAt;},
    ]) {
      const evidence={version:1,serverId:"42",sshKeyId:"77",observedAt:new Date().toISOString(),serverAbsent:true,sshKeyAbsent:true,projectServers:0,projectPrimaryIps:0};
      mutate(evidence); await assert.rejects(()=>resolve({evidence}));
    }
    for (const offset of [-60_000,60_000]) {
      const evidence={version:1,serverId:"42",sshKeyId:"77",observedAt:new Date(Date.now()+offset).toISOString(),serverAbsent:true,sshKeyAbsent:true,projectServers:0,projectPrimaryIps:0};
      assert.equal((await resolve({evidence})).outcome,"evidence_expired");
    }
    const before=await read(), stale=(await scope()).stateSha256;
    await db.exec("update public.infrastructure_capacity_orders set observed_server_status='unknown'");
    assert.equal((await resolve({digest:stale})).outcome,"state_changed");
    await reset();
    for (const change of ["server_post_attempted_at=now()","provider_server_status='pending',provider_resource_id=null","provider_resource_id=null"] ) {
      await reset(); await db.exec("update public.infrastructure_capacity_orders set "+change);
      assert.equal((await resolve()).outcome,"not_eligible");
    }
    await reset();
    await stageEnrollment();
    await db.query(`insert into public.infrastructure_first_boot_operations(order_id,attempt_id,user_id,connection_id,
      connection_revision,quote_fingerprint_sha256,provider_server_id,lease_id,lease_expires_at)
      values($1,$2,'owner',$3,7,repeat('a',64),'42',gen_random_uuid(),now()+interval '2 minutes')`,[order,other,connection]);
    assert.equal((await resolve()).outcome,"not_eligible");
    await reset();
    await stageEnrollment();
    await db.exec('set role service_role');
    const original=await read(), result=await resolve();
    assert.equal(result.outcome,"resolved");
    const done=await read();
    assert.equal(done.status,"ambiguous"); assert.equal(done.provider_creation_receipt,null);
    assert.equal(done.encrypted_bootstrap_bundle,null); assert.equal(done.bootstrap_key_version,null);
    assert.equal(done.external_cleanup_resolution_id,result.resolutionId);
    assert.deepEqual(await value("select jsonb_build_object('phase',phase,'token',encrypted_token) as result from public.infrastructure_first_boot_enrollments where order_id=$1",[order]),{phase:"revoked",token:null});
    for(const field of Object.keys(original).filter(k=>!["external_cleanup_resolution_id","encrypted_bootstrap_bundle","bootstrap_key_version","updated_at"].includes(k))) assert.deepEqual(done[field],original[field],field);
    assert.equal((await resolve({evidence:null})).resolutionId,result.resolutionId);
    assert.equal((await resolve({key:other,evidence:null})).outcome,"confirmation_changed");
    assert.equal(await value("select count(*) as result from public.infrastructure_external_cleanup_resolutions"),1);
    await db.exec('reset role');
    for(const sql of [
      "delete from public.infrastructure_external_cleanup_resolutions",
      "update public.infrastructure_external_cleanup_resolutions set reason=reason",
      "delete from public.infrastructure_capacity_orders",
      "update public.infrastructure_capacity_orders set external_cleanup_resolution_id=null",
      "update public.infrastructure_capacity_orders set provider_resource_id='43'",
      "update public.infrastructure_capacity_orders set status='creating'",
      "update public.infrastructure_capacity_orders set encrypted_bootstrap_bundle='restored',bootstrap_key_version=2",
      "update public.infrastructure_first_boot_enrollments set phase='staged'",
    ]) await assert.rejects(()=>db.exec(sql),error=>error.code==="55006");
    await db.query(`insert into public.infrastructure_capacity_inventory(user_id,connection_id,provider_resource_id,name,
      provider_status,server_type,location,public_network,provider_created_at,discovered_at)
      values('owner',$1,'42',$2,'off','{}','{}','{}',now(),now())`,[connection,serverName]);
    assert.equal(await value("select count(*) as result from public.infrastructure_capacity_inventory"),0);
    await db.exec('set role service_role');
    const staleServer={provider_resource_id:'42',name:serverName,provider_status:'off',server_type:{},location:{},public_network:{},
      provider_created_at:new Date().toISOString(),discovered_at:new Date().toISOString()};
    await value("select public.reconcile_hetzner_cloud_inventory('owner',$1,7,clock_timestamp(),$2) as result",[connection,[staleServer]]);
    await value("select public.upsert_hetzner_cloud_inventory_server('owner',$1,7,clock_timestamp(),$2) as result",[connection,staleServer]);
    assert.equal(await value("select count(*) as result from public.infrastructure_capacity_inventory"),0);
    await assert.rejects(()=>value("select public.record_hetzner_cloud_capacity_order_result('owner',$1,$2,$3,'created_off','42','500','create_server','success','[]',clock_timestamp(),'off',null) as result",[connection,order,key]),error=>error.code==='55006');
    const bootReplay=await value("select public.stage_hetzner_first_boot('owner',$1,7,$2,$3,$4,repeat('a',64),'2026.08.27.1',now(),now()+interval '15 minutes',repeat('b',64),repeat('fixture',10),'Prepare this computer for agent launch') as result",[connection,order,key,other]);
    assert.equal(bootReplay.outcome,'rejected');
    await db.exec('reset role');
    // New normal capacity remains bounded to one active claim.
    await db.query(`insert into public.infrastructure_capacity_orders(id,user_id,connection_id,active_connection_id,connection_revision,status,
      server_name,provider_labels,quote_snapshot,quote_fingerprint_sha256,quote_expires_at,idempotency_key,encrypted_bootstrap_bundle,
      bootstrap_key_version,bootstrap_public_key,bootstrap_public_key_fingerprint)
      values($1,'owner',$2,$2,7,'creating','hivra-44444444444444448444','{}','{}',repeat('b',64),now(),$1,'fixture',2,'fixture','SHA256:'||repeat('B',43))`,[other,connection]);
    await assert.rejects(()=>db.query(`insert into public.infrastructure_capacity_orders(id,user_id,connection_id,active_connection_id,connection_revision,status,
      server_name,provider_labels,quote_snapshot,quote_fingerprint_sha256,quote_expires_at,idempotency_key,encrypted_bootstrap_bundle,
      bootstrap_key_version,bootstrap_public_key,bootstrap_public_key_fingerprint)
      values(gen_random_uuid(),'owner',$1,$1,7,'creating','hivra-55555555555545558555','{}','{}',repeat('c',64),now(),gen_random_uuid(),'fixture',2,'fixture','SHA256:'||repeat('C',43))`,[connection]),error=>error.code==='23505');
    assert.equal(await value("select public.delete_infrastructure_connection('owner',$1) as result",[connection]),"capacity_busy");
    await reset(); await resolve();
    await db.exec('set role service_role');
    assert.equal(await value("select public.delete_infrastructure_connection('owner',$1) as result",[connection]),"deleted");
    assert.equal((await read()).external_cleanup_resolution_id!==null,true);
    assert.equal(await value("select count(*) as result from public.infrastructure_external_cleanup_resolutions"),1);
    await db.exec('reset role');
    const permissions=await value(`select jsonb_build_object(
      'anon',has_function_privilege('anon','public.resolve_hetzner_external_cleanup(text,uuid,bigint,uuid,uuid,text,text,jsonb)','execute'),
      'authenticated',has_function_privilege('authenticated','public.resolve_hetzner_external_cleanup(text,uuid,bigint,uuid,uuid,text,text,jsonb)','execute'),
      'service',has_function_privilege('service_role','public.resolve_hetzner_external_cleanup(text,uuid,bigint,uuid,uuid,text,text,jsonb)','execute'),
      'ledgerInsert',has_table_privilege('service_role','public.infrastructure_external_cleanup_resolutions','insert'),
      'ledgerDelete',has_table_privilege('service_role','public.infrastructure_external_cleanup_resolutions','delete')) as result`);
    assert.deepEqual(permissions,{anon:false,authenticated:false,service:true,ledgerInsert:false,ledgerDelete:false});
    assert.equal(before.status,"ambiguous");
    console.log("PASS: owner/revision/state/freshness gates, immutable ambiguity/ledger, secret revocation, idempotency, claim bound, disconnect, restricted grants");
  } finally { await db.close(); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
