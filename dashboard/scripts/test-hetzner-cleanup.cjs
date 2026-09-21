const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table public.infrastructure_connections (
        id uuid primary key, user_id text, provider text, status text, revision bigint,
        preflight_run_id uuid, last_checked_at timestamptz, last_error_code text, unique (id, user_id, provider)
      );
      create table public.infrastructure_connection_secrets (
        connection_id uuid references public.infrastructure_connections(id) on delete cascade,
        user_id text, encrypted_bundle text
      );
      create table public.infrastructure_capacity_inventory (
        user_id text,connection_id uuid,provider_resource_id text,provider text,name text,provider_status text,
        server_type jsonb,location jsonb,public_network jsonb,provider_created_at timestamptz,discovered_at timestamptz,
        created_at timestamptz default now(),unique(connection_id,provider_resource_id)
      );
      create function public.update_updated_at() returns trigger language plpgsql as $$
        begin new.updated_at = now(); return new; end; $$;
    `);
    const dir = path.resolve(__dirname, "../supabase/migrations");
    const old = fs.readFileSync(path.join(dir,"20260826170000_hetzner_cloud_capacity_orders.sql"),"utf8");
    // A literal extractor avoids running unrelated migrations in the fixture.
    const extract = name => {
      const start = old.indexOf("create or replace function public."+name+"(");
      assert.ok(start >= 0); return old.slice(start, old.indexOf("\n$$;",start)+4);
    };
    await db.exec(extract("is_valid_hetzner_action_receipts"));
    await db.exec(old.slice(old.indexOf("create table if not exists public.infrastructure_capacity_orders"),
      old.indexOf("create or replace function public.create_hetzner_cloud_capacity_quote(")));
    for(const name of ["record_hetzner_cloud_capacity_order_progress","record_hetzner_cloud_capacity_order_result",
      "mark_hetzner_cloud_server_post_attempted","record_hetzner_cloud_ssh_key_result",
      "delete_infrastructure_connection","force_forget_hetzner_cloud_connection",
      "reconcile_hetzner_cloud_inventory","upsert_hetzner_cloud_inventory_server"]) await db.exec(extract(name));
    await db.exec(fs.readFileSync(path.join(dir,"20260827150000_hetzner_creation_resource_receipts.sql"),"utf8"));
    await db.exec(fs.readFileSync(path.join(dir,"20260827160000_hetzner_scoped_cleanup.sql"),"utf8"));
    const connection = "11111111-1111-4111-8111-111111111111";
    const order = "22222222-2222-4222-8222-222222222222";
    const key = "33333333-3333-4333-8333-333333333333";
    const lease = "44444444-4444-4444-8444-444444444444";
    const other = "55555555-5555-4555-8555-555555555555";
    const name = "hivra-22222222222242228222";
    const fingerprint = "a".repeat(64);
    const none = {server:false,ipv4:false,ipv6:false,sshKey:false};
    const all = {server:true,ipv4:true,ipv6:true,sshKey:true};
    const receipt = {version:1,serverId:"42",primaryIpv4:{id:"88",ip:"203.0.113.10"},
      primaryIpv6:{id:"89",ip:"2001:db8::/64"},
      action:{id:"500",command:"create_server",status:"success",resources:[{id:"42",type:"server"}]},nextActions:[]};
    async function reset(originalReceipt = receipt) {
      await db.exec("truncate public.infrastructure_capacity_orders, public.infrastructure_connection_secrets, public.infrastructure_capacity_inventory, public.infrastructure_connections");
      await db.query("insert into public.infrastructure_connections(id,user_id,provider,status,revision) values($1,'owner','hetzner-cloud','ready',7)",[connection]);
      await db.query("insert into public.infrastructure_connection_secrets values($1,'owner','sealed-project-fixture')",[connection]);
      await db.query(`insert into public.infrastructure_capacity_orders(
        id,user_id,connection_id,active_connection_id,connection_revision,status,server_name,
        provider_labels,quote_snapshot,quote_fingerprint_sha256,quote_expires_at,idempotency_key,
        encrypted_bootstrap_bundle,bootstrap_key_version,bootstrap_public_key,bootstrap_public_key_fingerprint,
        ssh_key_post_attempted_at,provider_ssh_key_status,provider_ssh_key_id,
        server_post_attempted_at,provider_server_status,provider_resource_id,provider_action_id,
        provider_action_command,provider_action_status,provider_next_actions,observed_server_status,
        provider_observed_at,provider_creation_receipt
      ) values($1,'owner',$2,$2,7,'created_off',$3,'{}','{}',$4,now(),$5,
        'sealed-bootstrap-fixture',2,'public-fixture',$6,now(),'accepted','77',now(),'accepted','42','500',
        'create_server','success','[]','off',now(),$7)`,
      [order,connection,name,fingerprint,key,"SHA256:"+"A".repeat(43),originalReceipt]);
      await db.query("insert into public.infrastructure_capacity_inventory(user_id,connection_id,provider_resource_id) values('owner',$1,'42')",[connection]);
    }
    const read = async () => (await db.query("select * from public.infrastructure_capacity_orders where id=$1",[order])).rows[0];
    async function claim(overrides={}) {
      const a={user:"owner",connection,revision:7,order,key,lease,fingerprint,name,...overrides};
      return (await db.query("select public.claim_hetzner_cleanup($1,$2,$3,$4,$5,$6,$7,$8) as result",
        [a.user,a.connection,a.revision,a.order,a.key,a.lease,a.fingerprint,a.name])).rows[0].result;
    }
    const record = async (absence,error=null,token=lease) => (await db.query(
      "select public.record_hetzner_cleanup_observation('owner',$1,7,$2,$3,$4,$5) as result",
      [connection,order,token,absence,error])).rows[0].result;

    await reset();
    for(const a of [{user:"foreign"},{revision:8},{order:other},{name:"another-server"}]) {
      assert.notEqual((await claim(a)).outcome,"claimed");
      assert.equal((await read()).status,"created_off");
    }
    await reset(null); // A legacy row never had an original receipt.
    assert.equal((await claim()).outcome,"not_eligible");
    await reset();
    assert.equal((await claim()).outcome,"claimed");
    assert.equal((await claim({lease:other})).outcome,"busy");
    assert.equal((await claim({key:other})).outcome,"confirmation_changed");
    assert.equal((await claim({fingerprint:"b".repeat(64)})).outcome,"confirmation_changed");
    assert.equal((await read()).encrypted_bootstrap_bundle,"sealed-bootstrap-fixture");
    for(const sql of [
      "update public.infrastructure_connections set revision=8",
      "delete from public.infrastructure_connections",
      "update public.infrastructure_connection_secrets set encrypted_bundle='changed'",
      "delete from public.infrastructure_connection_secrets",
      "update public.infrastructure_capacity_orders set active_connection_id=null,detached_at=now(),encrypted_bootstrap_bundle=null,bootstrap_key_version=null",
      "update public.infrastructure_capacity_orders set status='created_off'",
      "delete from public.infrastructure_capacity_orders",
    ]) await assert.rejects(()=>db.exec(sql),e=>e.code==="55006");
    await assert.rejects(()=>db.query("select public.delete_infrastructure_connection('owner',$1)",[connection]),e=>e.code==="55006");
    const held = await db.query("select public.verify_hetzner_cleanup_lease('owner',$1,7,$2,$3) as held",[connection,order,lease]);
    assert.equal(held.rows[0].held,true);
    assert.equal(await record(all,null,other),null);
    const partial = {server:true,ipv4:false,ipv6:false,sshKey:false};
    assert.equal((await record(partial,"provider_unavailable")).status,"cleaning");
    assert.equal((await read()).encrypted_bootstrap_bundle,"sealed-bootstrap-fixture");
    assert.equal((await claim({lease:other})).outcome,"claimed");
    assert.equal(await record(all),null); // A stale worker cannot complete a resumed lease.
    await assert.rejects(()=>record(none,null,other),e=>e.code==="22023");
    for(const bad of [null,{}, {...all,token:"must-not-store"},{...all,ipv4:"true"}]) {
      await assert.rejects(()=>record(bad,null,other));
    }
    const done = await record(all,null,other);
    assert.equal(done.status,"deleted");
    assert.equal(done.encrypted_bootstrap_bundle,null);
    assert.equal(done.bootstrap_key_version,null);
    assert.deepEqual(done.provider_creation_receipt,receipt);
    assert.equal(done.provider_ssh_key_id,"77"); // Retain non-secret resource audit identity.
    assert.equal((await db.query("select count(*) as n from public.infrastructure_capacity_inventory")).rows[0].n,0);
    const stale = {provider_resource_id:"42",name,provider_status:"off",server_type:{},location:{},public_network:{},
      provider_created_at:"2026-08-27T15:00:00Z",discovered_at:"2040-01-01T00:00:00Z"};
    const reconciled = await db.query("select public.reconcile_hetzner_cloud_inventory('owner',$1,7,$2,$3) as result",
      [connection,stale.discovered_at,[stale]]);
    assert.deepEqual(reconciled.rows[0].result,[]);
    const upserted = await db.query("select public.upsert_hetzner_cloud_inventory_server('owner',$1,7,$2,$3) as result",
      [connection,"2040-01-01T00:01:00Z",stale]);
    assert.equal(upserted.rows[0].result,null);
    assert.equal((await db.query("select count(*) as n from public.infrastructure_capacity_inventory")).rows[0].n,0);
    assert.equal((await claim()).outcome,"complete"); // Lost terminal acknowledgement replay.
    await assert.rejects(()=>db.exec("update public.infrastructure_capacity_orders set status='created_off'"),e=>e.code==="55006");
    // Retained IDs do not keep a verified-deleted order in the unique capacity index.
    await db.query(`insert into public.infrastructure_capacity_orders(id,user_id,connection_id,active_connection_id,
      connection_revision,server_name,provider_labels,quote_snapshot,quote_fingerprint_sha256,quote_expires_at)
      values($1,'owner',$2,$2,7,'hivra-55555555555545558555','{}','{}',$3,now())`,[other,connection,fingerprint]);
    assert.equal((await db.query("select public.delete_infrastructure_connection('owner',$1) as result",[connection])).rows[0].result,"deleted");
    assert.equal((await read()).active_connection_id,null);
    assert.equal((await read()).status,"deleted");
    // Actual serverless lease expiry permits a new worker, not stale completion.
    await reset(); await claim();
    await db.exec("update public.infrastructure_capacity_orders set cleanup_lease_expires_at=now()-interval '1 second'");
    assert.equal(await record(all),null);
    assert.equal((await claim({lease:other})).outcome,"claimed");
    // A revoked provider token must not prevent local credential revocation.
    const abandon = async (user="owner",token=key) => (await db.query(
      "select public.abandon_hetzner_cleanup($1,$2,$3,$4,$5) as result",
      [user,connection,order,token,fingerprint])).rows[0].result;
    await assert.rejects(()=>abandon(),e=>e.code==="55006"); // Active worker retains authority.
    await record(none,"provider_unavailable",other);
    assert.equal(await abandon("foreign"),false);
    assert.equal(await abandon("owner",other),false);
    assert.equal(await abandon(),true);
    assert.equal(await abandon(),true); // Lost local-revocation acknowledgement.
    const abandoned=await read();
    assert.equal(abandoned.status,"cleanup_abandoned");
    assert.equal(abandoned.active_connection_id,null);
    assert.equal(abandoned.encrypted_bootstrap_bundle,null);
    assert.equal(abandoned.bootstrap_key_version,null);
    assert.deepEqual(abandoned.provider_creation_receipt,receipt);
    assert.equal(abandoned.provider_ssh_key_id,"77");
    assert.equal((await db.query("select count(*) as n from public.infrastructure_connection_secrets")).rows[0].n,0);
    assert.equal((await db.query("select count(*) as n from public.infrastructure_connections")).rows[0].n,0);
    // Reconnect cannot bypass the unresolved owner's retained capacity claim.
    await db.query("insert into public.infrastructure_connections(id,user_id,provider,status,revision) values($1,'owner','hetzner-cloud','ready',7)",[connection]);
    await db.query(`insert into public.infrastructure_capacity_orders(
      id,user_id,connection_id,active_connection_id,connection_revision,server_name,provider_labels,
      quote_snapshot,quote_fingerprint_sha256,quote_expires_at
    ) values($1,'owner',$2,$2,7,'hivra-55555555555545558555','{}','{}',$3,now())`,[other,connection,fingerprint]);
    await assert.rejects(()=>db.query(`update public.infrastructure_capacity_orders set status='creating',
      idempotency_key=$1,encrypted_bootstrap_bundle='sealed-fixture',bootstrap_key_version=2,
      bootstrap_public_key='fixture-public',bootstrap_public_key_fingerprint=$2 where id=$1`,
    [other,"SHA256:"+"A".repeat(43)]),e=>e.code==="23505");
    const permissions = await db.query(`select
      has_function_privilege('anon','public.claim_hetzner_cleanup(text,uuid,bigint,uuid,uuid,uuid,text,text)','execute') as anon,
      has_function_privilege('authenticated','public.record_hetzner_cleanup_observation(text,uuid,bigint,uuid,uuid,jsonb,text)','execute') as authenticated,
      has_function_privilege('service_role','public.record_hetzner_cleanup_observation(text,uuid,bigint,uuid,uuid,jsonb,text)','execute') as service`);
    assert.deepEqual(permissions.rows[0],{anon:false,authenticated:false,service:true});
    // Exercise the actual older creation RPC, not only its unique index.
    // Verified absence releases the account slot; forgetting access does not.
    await db.exec(extract('claim_hetzner_cloud_capacity_order'));
    async function insertQuote(targetConnection) {
      await db.query(`insert into public.infrastructure_capacity_orders(id,user_id,connection_id,active_connection_id,connection_revision,server_name,provider_labels,quote_snapshot,quote_fingerprint_sha256,quote_expires_at) values($1,'owner',$2,$2,7,'hivra-55555555555545558555','{}','{}',$3,now()+interval '1 hour')`,[other,targetConnection,fingerprint]);
    }
    async function createClaim(targetConnection) {
      return (await db.query(`select public.claim_hetzner_cloud_capacity_order('owner',$1,7,$2,$2,'synthetic-sealed-bundle',2::smallint,'ssh-ed25519 AAAA hivra-capacity',$3,now()) as result`,[targetConnection,other,'SHA256:'+'A'.repeat(43)])).rows[0].result;
    }
    await reset(); await claim(); await record(all);
    await insertQuote(connection);
    assert.equal((await createClaim(connection)).outcome,'claimed');
    await reset(); await claim(); await record(none,'provider_unavailable'); await abandon();
    const anotherConnection='66666666-6666-4666-8666-666666666666';
    await db.query("insert into public.infrastructure_connections(id,user_id,provider,status,revision) values($1,'owner','hetzner-cloud','ready',7)",[anotherConnection]);
    await insertQuote(anotherConnection);
    assert.equal((await createClaim(anotherConnection)).outcome,'canary_capacity_limit');
    console.log("PASS: Hetzner cleanup lease, ownership, immutable resources, revocation guards, partial recovery, terminal secret wipe, actual capacity-slot reuse and service-only grants");
  } finally { await db.close(); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
