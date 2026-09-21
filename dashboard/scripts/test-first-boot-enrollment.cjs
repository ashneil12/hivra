const assert = require("node:assert/strict");
const { createHash, generateKeyPairSync } = require("node:crypto");
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
    const dir = path.resolve(__dirname, "../supabase/migrations");
    const original = fs.readFileSync(path.join(dir, "20260826170000_hetzner_cloud_capacity_orders.sql"), "utf8");
    const extract = name => {
      const start = original.indexOf("create or replace function public." + name + "(");
      assert.ok(start >= 0);
      return original.slice(start, original.indexOf("\n$$;", start) + 4);
    };
    await db.exec(extract("is_valid_hetzner_action_receipts"));
    await db.exec(original.slice(original.indexOf("create table if not exists public.infrastructure_capacity_orders"),
      original.indexOf("create or replace function public.create_hetzner_cloud_capacity_quote(")));
    for (const name of ["delete_infrastructure_connection","force_forget_hetzner_cloud_connection",
      "reconcile_hetzner_cloud_inventory","upsert_hetzner_cloud_inventory_server"]) await db.exec(extract(name));
    for (const file of ["20260827150000_hetzner_creation_resource_receipts.sql",
      "20260827160000_hetzner_scoped_cleanup.sql","20260827190000_hetzner_first_boot_enrollment.sql",
      "20260827200000_hetzner_first_boot_operations.sql","20260827210000_hetzner_first_boot_cleanup.sql",
      "20260827220000_hetzner_first_boot_recipe_admission.sql"]) {
      await db.exec(fs.readFileSync(path.join(dir,file),"utf8"));
    }
    const connection = "11111111-1111-4111-8111-111111111111";
    const order = "22222222-2222-4222-8222-222222222222";
    const attempt = "33333333-3333-4333-8333-333333333333";
    const capacityKey = "44444444-4444-4444-8444-444444444444";
    const other = "55555555-5555-4555-8555-555555555555";
    const quote = "a".repeat(64), verifier = "b".repeat(64);
    const sealed = "sealed-test-only-" + "x".repeat(128);
    const receipt = { version:1,serverId:"42",primaryIpv4:{id:"88",ip:"203.0.113.10"},
      primaryIpv6:{id:"89",ip:"2001:db8::/64"},
      action:{id:"500",command:"create_server",status:"success",resources:[{id:"42",type:"server"}]},nextActions:[] };
    const host = () => {
      const jwk = generateKeyPairSync("ed25519").publicKey.export({format:"jwk"});
      const blob = Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020","hex"),Buffer.from(jwk.x,"base64url")]);
      return { key:"ssh-ed25519 " + blob.toString("base64"),
        fingerprint:"SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/,"") };
    };
    const hostOne = host(),hostTwo = host();
    let issued,expires;
    const read = async () => (await db.query("select * from public.infrastructure_first_boot_enrollments where order_id=$1",[order])).rows[0];
    async function reset() {
      await db.exec("truncate public.deployment_targets,public.infrastructure_first_boot_operations,public.infrastructure_first_boot_enrollments,public.infrastructure_capacity_orders,public.infrastructure_connection_secrets,public.infrastructure_capacity_inventory,public.infrastructure_connections");
      await db.query("insert into public.infrastructure_connections(id,user_id,provider,status,revision) values($1,'owner','hetzner-cloud','ready',7)",[connection]);
      await db.query("insert into public.infrastructure_connection_secrets values($1,'owner','sealed-project-fixture')",[connection]);
      await db.query([
        "insert into public.infrastructure_capacity_orders(",
        "id,user_id,connection_id,active_connection_id,connection_revision,status,server_name,",
        "provider_labels,quote_snapshot,quote_fingerprint_sha256,quote_expires_at,idempotency_key,",
        "encrypted_bootstrap_bundle,bootstrap_key_version,bootstrap_public_key,bootstrap_public_key_fingerprint,",
        "ssh_key_post_attempted_at,provider_ssh_key_status,provider_ssh_key_id)",
        "values($1,'owner',$2,$2,7,'creating','hivra-22222222222242228222','{}','{}',$3,now()+interval '5 minutes',$4,",
        "'sealed-bootstrap-fixture',2,$5,$6,now(),'accepted','77')",
      ].join("\n"),[order,connection,quote,capacityKey,hostOne.key,hostOne.fingerprint]);
      issued = new Date().toISOString(); expires = new Date(Date.parse(issued)+900_000).toISOString();
    }
    async function stage(overrides={}) {
      const a={user:"owner",connection,revision:7,order,capacityKey,attempt,quote,recipe:"2026.08.27.1",
        issued,expires,verifier,sealed,confirmation:"Prepare this computer for agent launch",...overrides};
      return (await db.query("select public.stage_hetzner_first_boot($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) as result",
        [a.user,a.connection,a.revision,a.order,a.capacityKey,a.attempt,a.quote,a.recipe,a.issued,a.expires,a.verifier,a.sealed,a.confirmation])).rows[0].result;
    }
    async function created() {
      await db.query([
        "update public.infrastructure_capacity_orders set status='created_off',",
        "server_post_attempted_at=now(),provider_server_status='accepted',provider_resource_id='42',",
        "provider_action_id='500',provider_action_command='create_server',provider_action_status='success',",
        "provider_next_actions='[]',observed_server_status='off',provider_observed_at=now(),provider_creation_receipt=$1 where id=$2",
      ].join("\n"),[receipt,order]);
    }
    async function arm(overrides={}) {
      const a={user:"owner",connection,revision:7,order,attempt,capacityKey,server:"42",receipt,...overrides};
      return (await db.query("select public.arm_hetzner_first_boot($1,$2,$3,$4,$5,$6,$7,$8) as result",
        [a.user,a.connection,a.revision,a.order,a.attempt,a.capacityKey,a.server,a.receipt])).rows[0].result;
    }
    async function consume(overrides={}) {
      const a={user:"owner",connection,revision:7,order,attempt,server:"42",verifier,
        key:hostOne.key,fingerprint:hostOne.fingerprint,observed:new Date().toISOString(),...overrides};
      return (await db.query("select public.consume_hetzner_first_boot($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as result",
        [a.user,a.connection,a.revision,a.order,a.attempt,a.server,a.verifier,a.key,a.fingerprint,a.observed])).rows[0].result;
    }
    async function readyForEnrollment() {
      await reset(); assert.equal((await stage()).outcome,"staged");
      await created(); assert.equal(await arm(),true);
    }
    const expectation = {attemptId:attempt,verifierSha256:verifier,recipeVersion:"2026.08.27.1"};
    async function mark(enrollment=null, overrides={}) {
      const a={user:"owner",connection,revision:7,order,key:capacityKey,ssh:"77",at:new Date().toISOString(),...overrides};
      return (await db.query("select public.mark_hetzner_server_post_for_recipe($1,$2,$3,$4,$5,$6,$7,$8) as result",
        [a.user,a.connection,a.revision,a.order,a.key,a.ssh,a.at,enrollment===null?null:JSON.stringify(enrollment)])).rows[0].result;
    }
    const legacyMark = async () => (await db.query(
      "select public.mark_hetzner_cloud_server_post_attempted('owner',$1,7,$2,$3,'77',clock_timestamp()) as result",
      [connection,order,capacityKey])).rows[0].result;
    const marked = async () => (await db.query("select server_post_attempted_at as marker from public.infrastructure_capacity_orders where id=$1",[order])).rows[0].marker;
    // Both serial orders of a competing stage/legacy-POST interleaving are
    // checked. This is actual SQL, not a claim of concurrent scheduling proof.
    await reset(); assert.equal(await legacyMark(),true);
    assert.equal((await stage()).outcome,"rejected"); assert.equal(await legacyMark(),false);
    await reset(); assert.equal((await stage()).outcome,"staged");
    assert.equal(await legacyMark(),false); assert.equal(await marked(),null);
    for(const malformed of [null,{},[],"invalid",{...expectation,extra:true},
      {...expectation,attemptId:other},{...expectation,verifierSha256:"c".repeat(64)},
      {...expectation,recipeVersion:"later"}]) {
      assert.equal(await mark(malformed),false); assert.equal(await marked(),null);
    }
    for(const override of [{user:"foreign"},{connection:other},{revision:8},{order:other},{key:other},{ssh:"78"},
      {at:null},{at:new Date(Date.now()-31_000).toISOString()},{at:new Date(Date.now()+6_000).toISOString()}]) {
      assert.equal(await mark(expectation,override),false); assert.equal(await marked(),null);
    }
    assert.equal(await mark(expectation),true); assert.ok(await marked());
    assert.equal(await mark(expectation),false); assert.equal(await legacyMark(),false);
    await reset(); assert.equal(await mark(expectation),false); assert.equal(await marked(),null);
    for(const change of ["status='ambiguous'","quote_expires_at=now()-interval '1 minute'",
      "provider_ssh_key_status='pending',provider_ssh_key_id=null"]) {
      await reset(); await stage();
      await db.exec("update public.infrastructure_capacity_orders set "+change);
      assert.equal(await mark(expectation),false); assert.equal(await marked(),null);
    }
    await reset(); await stage();
    await db.exec("update public.infrastructure_first_boot_enrollments set phase='revoked',encrypted_token=null");
    assert.equal(await mark(expectation),false); assert.equal(await legacyMark(),false);
    assert.equal(await marked(),null);
    await reset();
    for(const overrides of [{confirmation:null},{confirmation:"Create server and start billing"},{attempt:null},
      {recipe:"later"},{issued:null},{expires:new Date(Date.parse(issued)+901_000).toISOString()},
      {verifier:null},{sealed:"short"}]) {
      await assert.rejects(()=>stage(overrides),e=>e.code==="22023");
      assert.equal(await read(),undefined);
    }
    for(const overrides of [{user:"foreign"},{connection:other},{revision:8},{order:other},{capacityKey:other},{quote:"c".repeat(64)}]) {
      assert.equal((await stage(overrides)).outcome,"rejected");
      assert.equal(await read(),undefined);
    }
    assert.equal((await stage()).outcome,"staged");
    assert.equal((await stage({sealed:"other-sealed-envelope-".repeat(5)})).record.encrypted_token,sealed);
    assert.equal((await stage({attempt:other})).outcome,"rejected");
    assert.equal((await stage({verifier:"c".repeat(64)})).outcome,"rejected");
    assert.equal(await arm(),false);
    await created();
    assert.equal((await stage()).outcome,"rejected");
    for(const overrides of [{receipt:null},{receipt:{...receipt,serverId:"43"}},{server:"43"},{user:"foreign"},{attempt:other}]) {
      assert.equal(await arm(overrides),false);
    }
    assert.equal(await arm(),true);
    assert.equal(await arm(),true);
    assert.equal((await read()).phase,"awaiting_identity");
    assert.equal((await read()).encrypted_token,sealed);
    for(const overrides of [{user:"foreign"},{connection:other},{revision:8},{order:other},{attempt:other},
      {server:"43"},{verifier:"c".repeat(64)},{key:hostOne.key+"\n"},{fingerprint:hostTwo.fingerprint},
      {key:null},{fingerprint:null},{observed:null},{observed:new Date(Date.now()-31_000).toISOString()},
      {observed:new Date(Date.now()+6_000).toISOString()}]) {
      assert.equal(await consume(overrides),"rejected");
      assert.equal((await read()).phase,"awaiting_identity");
    }
    assert.equal(await consume(),"enrolled");
    const pinned = await read();
    assert.equal(pinned.encrypted_token,null);
    assert.equal(pinned.host_public_key,hostOne.key);
    assert.equal(await consume(),"acknowledgement_replay");
    assert.equal(await consume({key:hostTwo.key,fingerprint:hostTwo.fingerprint}),"identity_changed");
    assert.equal((await read()).host_public_key,hostOne.key);
    for(const sql of [
      "update public.infrastructure_first_boot_enrollments set phase='awaiting_identity'",
      "update public.infrastructure_first_boot_enrollments set verifier_sha256=repeat('c',64)",
      "update public.infrastructure_first_boot_enrollments set expires_at=expires_at+interval '1 minute'",
      "update public.infrastructure_first_boot_enrollments set provider_server_id='43'",
      "delete from public.infrastructure_first_boot_enrollments",
    ]) await assert.rejects(()=>db.exec(sql),e=>e.code==="55006");
    await assert.rejects(()=>db.query("update public.infrastructure_first_boot_enrollments set host_public_key=$1,host_fingerprint_sha256=$2",
      [hostTwo.key,hostTwo.fingerprint]),e=>e.code==="55006");
    for(const sql of [
      "update public.infrastructure_connections set revision=8",
      "update public.infrastructure_connection_secrets set encrypted_bundle='rotated'",
      "delete from public.infrastructure_connection_secrets",
      "update public.infrastructure_capacity_orders set status='ambiguous'",
    ]) {
      await readyForEnrollment();
      await db.exec(sql);
      assert.equal((await read()).phase,"revoked");
      assert.equal((await read()).encrypted_token,null);
      assert.equal(await consume(),"rejected");
    }
    await readyForEnrollment();
    await db.exec("begin; update public.infrastructure_connection_secrets set encrypted_bundle='rotated'");
    assert.equal((await read()).phase,"revoked");
    await db.exec("rollback");
    assert.equal((await read()).phase,"awaiting_identity");
    assert.equal((await read()).encrypted_token,sealed);
    assert.equal(await consume(),"enrolled");
    // Exercise the real existing cleanup/disconnect RPCs with the new guards.
    await readyForEnrollment();
    assert.equal((await db.query("select public.claim_hetzner_cleanup('owner',$1,7,$2,$3,$4,$5,'hivra-22222222222242228222') as result",
      [connection,order,other,capacityKey,"d".repeat(64)])).rows[0].result.outcome,"claimed");
    assert.equal((await read()).phase,"revoked");
    assert.equal(await consume(),"rejected");
    await db.query("select public.record_hetzner_cleanup_observation('owner',$1,7,$2,$3,$4,null)",
      [connection,order,capacityKey,{server:true,ipv4:true,ipv6:true,sshKey:true}]);
    assert.equal((await db.query("select public.delete_infrastructure_connection('owner',$1) as result",[connection])).rows[0].result,"deleted");
    assert.equal((await read()).phase,"revoked");
    // An early provider rejection may happen before any SSH key or server
    // exists. Keep revoked audit evidence without preventing token removal.
    async function rejectedBeforeKey() {
      await reset();
      await db.exec("update public.infrastructure_capacity_orders set provider_ssh_key_id=null,provider_ssh_key_status=null,ssh_key_post_attempted_at=null");
      assert.equal((await stage()).outcome,"staged");
      await db.exec("update public.infrastructure_capacity_orders set status='provider_rejected',last_error_code='token_read_only',ssh_key_post_attempted_at=now(),provider_ssh_key_status='rejected',encrypted_bootstrap_bundle=null,bootstrap_key_version=null");
      assert.equal((await read()).phase,"revoked");
      assert.equal((await read()).encrypted_token,null);
    }
    await rejectedBeforeKey();
    assert.equal((await db.query("select public.delete_infrastructure_connection('owner',$1) as result",[connection])).rows[0].result,"deleted");
    assert.equal((await read()).phase,"revoked");
    assert.equal((await db.query("select active_connection_id from public.infrastructure_capacity_orders where id=$1",[order])).rows[0].active_connection_id,null);
    assert.equal((await db.query("select count(*) as n from public.infrastructure_connection_secrets")).rows[0].n,0);
    await rejectedBeforeKey();
    await db.query([
      "insert into public.infrastructure_capacity_orders(",
      "id,user_id,connection_id,active_connection_id,connection_revision,status,server_name,",
      "provider_labels,quote_snapshot,quote_fingerprint_sha256,quote_expires_at,idempotency_key,",
      "encrypted_bootstrap_bundle,bootstrap_key_version,bootstrap_public_key,bootstrap_public_key_fingerprint,",
      "ssh_key_post_attempted_at,provider_ssh_key_status)",
      "values($1,'owner',$2,$2,7,'ambiguous','hivra-55555555555545558555','{}','{}',$3,now(),$1,",
      "'ambiguous-bootstrap-fixture',2,$4,$5,now()-interval '2 minutes','ambiguous')",
    ].join("\n"),[other,connection,quote,hostOne.key,hostOne.fingerprint]);
    assert.equal((await db.query("select public.force_forget_hetzner_cloud_connection('owner',$1) as result",[connection])).rows[0].result,"forgotten");
    assert.equal((await read()).phase,"revoked");
    assert.equal((await db.query("select count(*) as n from public.infrastructure_connection_secrets")).rows[0].n,0);
    assert.equal((await db.query("select count(*) as n from public.infrastructure_capacity_orders where active_connection_id is not null")).rows[0].n,0);
    // The SQL replay contract itself refuses an expired staged record.
    await reset();
    await db.query([
      "insert into public.infrastructure_first_boot_enrollments(",
      "order_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,attempt_id,",
      "capacity_idempotency_key,recipe_version,phase,issued_at,expires_at,verifier_sha256,encrypted_token)",
      "values($1,'owner',$2,7,$3,$4,$5,'2026.08.27.1','staged',",
      "now()-interval '16 minutes',now()-interval '1 minute',$6,$7)",
    ].join("\n"),[order,connection,quote,attempt,capacityKey,verifier,sealed]);
    const expired = await read();
    assert.equal((await stage({issued:expired.issued_at,expires:expired.expires_at})).outcome,"rejected");
    assert.equal(await mark(expectation),false); assert.equal(await legacyMark(),false);
    assert.equal(await marked(),null);
    // Model a stored attempt after its true window elapsed without weakening
    // the immutable-row trigger or waiting fifteen minutes.
    await reset(); await created();
    await db.query([
      "insert into public.infrastructure_first_boot_enrollments(",
      "order_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,attempt_id,",
      "capacity_idempotency_key,recipe_version,phase,issued_at,expires_at,verifier_sha256,encrypted_token,provider_server_id)",
      "values($1,'owner',$2,7,$3,$4,$5,'2026.08.27.1','awaiting_identity',",
      "now()-interval '16 minutes',now()-interval '1 minute',$6,$7,'42')",
    ].join("\n"),[order,connection,quote,attempt,capacityKey,verifier,sealed]);
    assert.equal(await arm(),false);
    assert.equal(await consume(),"rejected");
    assert.equal((await read()).host_public_key,null);
    const privileges = (await db.query([
      "select has_table_privilege('anon','public.infrastructure_first_boot_enrollments','select') as anon_table,",
      "has_table_privilege('authenticated','public.infrastructure_first_boot_enrollments','select') as auth_table,",
      "has_function_privilege('anon','public.consume_hetzner_first_boot(text,uuid,bigint,uuid,uuid,text,text,text,text,timestamptz)','execute') as anon_rpc,",
      "has_function_privilege('authenticated','public.stage_hetzner_first_boot(text,uuid,bigint,uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,text)','execute') as auth_rpc,",
      "has_function_privilege('service_role','public.consume_hetzner_first_boot(text,uuid,bigint,uuid,uuid,text,text,text,text,timestamptz)','execute') as service_rpc,",
      "(select relrowsecurity from pg_class where oid='public.infrastructure_first_boot_enrollments'::regclass) as rls",
    ].join("\n"))).rows[0];
    assert.deepEqual(privileges,{anon_table:false,auth_table:false,anon_rpc:false,auth_rpc:false,service_rpc:true,rls:true});
    const recipePrivileges=(await db.query("select has_function_privilege('anon','public.mark_hetzner_server_post_for_recipe(text,uuid,bigint,uuid,uuid,text,timestamptz,jsonb)','execute') as anon_rpc,has_function_privilege('authenticated','public.mark_hetzner_cloud_server_post_attempted(text,uuid,bigint,uuid,uuid,text,timestamptz)','execute') as auth_rpc,has_function_privilege('service_role','public.mark_hetzner_server_post_for_recipe(text,uuid,bigint,uuid,uuid,text,timestamptz,jsonb)','execute') as service_rpc")).rows[0];
    assert.deepEqual(recipePrivileges,{anon_rpc:false,auth_rpc:false,service_rpc:true});
    console.log("PASS first-boot actual SQL: consent, binding, original receipt, one-key consumption/replay, expiry, immutable evidence, transactional revocation, existing cleanup/disconnect compatibility, service-only/RLS");
  } finally {
    await db.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
