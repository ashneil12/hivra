// Real PostgreSQL migration/fence checks in an isolated in-memory database.
// No controller credentials, guest services, or provider mutations.
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
    for (const file of fs.readdirSync(dir).filter(name => /^202608(?:2[56789]|3[01])/.test(name)
      || ["20260901020000_hivra_remote_desktop_sessions.sql", "20260903010000_hivra_computer_profiles.sql", "20260905100000_hivra_folder_recovery.sql"].includes(name)).sort()) {
      await db.exec(migration(file));
    }
    const source = "11111111-1111-4111-8111-111111111111";
    const dest = "22222222-2222-4222-8222-222222222222";
    const unrelated = "33333333-3333-4333-8333-333333333333";
    const operation = "44444444-4444-4444-8444-444444444444";
    const session = "55555555-5555-4555-8555-555555555555";
    const generation = "66666666-6666-4666-8666-666666666666";
    const value = async (sql, args=[]) => (await db.query(sql,args)).rows[0]?.result;
    for (const [id,vmid,hash,token,owner] of [[source,1001,"a","source-key","owner"],[dest,1002,"b","fresh-key","owner"],[unrelated,1003,"c","other-key","other"]]) {
      await db.query(`insert into public.hivra_agents(id,user_id,type,name,status,desired_state,computer_profile,
        computer_substrate,proxmox_host,vmid,ip,api_token,infrastructure_binding_token_hash,infrastructure_binding_token_enforced)
        values($1,$2,'linux-desktop','Ubuntu','running','running','ubuntu-desktop','proxmox-kvm','local',$3::integer,'10.0.0.'||($3::integer)::text,$4,repeat($5,64),true)`,[id,owner,vmid,token,hash]);
    }
    const beforeSource = await value("select to_jsonb(a) as result from public.hivra_agents a where id=$1",[source]);
    const beforeOther = await value("select to_jsonb(a) as result from public.hivra_agents a where id=$1",[unrelated]);
    const begin = (owner="owner",src=source,destination=dest,hash="a".repeat(64),consent=true) => value(
      "select public.begin_hivra_folder_recovery($1,$2,$3,$4,$5,$6,$7) as result",
      [owner,src,destination,hash,"d".repeat(64),operation,consent]);
    await assert.rejects(() => begin("owner",source,dest,"a".repeat(64),false));
    await assert.rejects(() => begin("other"));
    await assert.rejects(() => begin("owner",source,source));
    await assert.rejects(() => begin("owner",source,unrelated));
    await assert.rejects(() => begin("owner",source,dest,"f".repeat(64)));
    // No arbitrary age test: independently fresh, empty eligible fixtures are valid.
    await db.query("update public.hivra_agents set created_at=now()-interval '2 days' where id=$1",[dest]);
    assert.equal(await begin(),operation);
    assert.equal(await begin(),operation);
    assert.equal(await value("select operation_kind as result from public.hivra_agents where id=$1",[dest]),"restore");
    // All generic terminal/reset/delete paths remain fenced while outcome unknown.
    for (const set of ["operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null",
      "desired_state='deleted'", "status='running'", "ip='10.241.0.88'", "api_token='substitute'", "vmid=9876"]) {
      await assert.rejects(() => db.query(`update public.hivra_agents set ${set} where id=$1`,[dest]));
    }
    await db.exec("set role service_role");
    await assert.rejects(() => db.query("update public.hivra_folder_recoveries set status='complete',completed_at=now(),file_count=0,byte_count=0 where id=$1",[operation]));
    await assert.rejects(() => db.query("delete from public.hivra_folder_recoveries where id=$1",[operation]));
    await db.exec("reset role");
    // A source controller is actively using the original. Recovery must revoke
    // its session, preserve its capability, and allow a new controller after
    // the normal guest input-release receipt (never bypass that safety fence).
    await db.query(`insert into public.hivra_remote_desktop_capabilities(computer_kind,computer_id,user_id,generation,
      observed_revision,compositor,installed_transports,private_network_reachable,supports_input_takeover,
      broker_origin,attestation,observed_at,expires_at)
      values('hivra-agent',$1,'owner',$2,repeat('a',40),'x11',array['selkies-websocket'],false,true,
        'https://source.example','{}',now(),now()+interval '10 minutes')`,[source,generation]);
    const beforeCapability = await value("select to_jsonb(c) as result from public.hivra_remote_desktop_capabilities c where computer_id=$1",[source]);
    await db.query(`insert into public.hivra_remote_desktop_sessions(id,user_id,computer_kind,computer_id,capability_generation,
      transport,input_role,input_state,audience,handoff,exchange_code_hash,pkce_challenge,issued_at,expires_at)
      values($1,'owner','hivra-agent',$2::uuid,$3,'selkies-websocket','controller','active',
        'hivra-computer:hivra-agent:'||($2::uuid)::text||':desktop','cookie',repeat('a',64),repeat('a',43),now(),now()+interval '4 minutes')`,[session,source,generation]);
    const complete = (hash="d".repeat(64)) => value("select public.complete_hivra_folder_recovery('owner',$1,$2,1,12) as result",[operation,hash]);
    assert.equal(await complete("e".repeat(64)),false);
    assert.equal(await value("select revoked_at is null as result from public.hivra_remote_desktop_sessions where id=$1",[session]),true);
    await db.exec("set role service_role");
    assert.equal(await complete(),true);
    assert.equal(await complete(),true);
    await db.exec("reset role");
    assert.equal(await value("select revoked_at is not null as result from public.hivra_remote_desktop_sessions where id=$1",[session]),true);
    assert.equal(await value("select input_state as result from public.hivra_remote_desktop_sessions where id=$1",[session]),"release-pending");
    assert.deepEqual(await value("select to_jsonb(c) as result from public.hivra_remote_desktop_capabilities c where computer_id=$1",[source]),beforeCapability);
    const freshSession = "77777777-7777-4777-8777-777777777777";
    const issueFresh = () => value(`select public.issue_hivra_remote_desktop_session('owner',$1,'hivra-agent',$2,
      'selkies-websocket','controller','cookie',repeat('f',64),repeat('b',43),now(),now()+interval '4 minutes',null) as result`,[freshSession,source]);
    assert.equal((await issueFresh()).status,"controller_conflict");
    const releaseReceipt = { protocol:"hivra-remote-desktop-input-v1",action:"agent-input-resumed",sessionId:session,
      computerKind:"hivra-agent",computerId:source,capabilityGeneration:generation,transport:"selkies-websocket",
      agentInputSuspended:false,controllerCount:0,observedAt:new Date().toISOString() };
    assert.equal(await value("select public.confirm_hivra_remote_desktop_release('owner',$1,$2::jsonb) as result",[session,JSON.stringify(releaseReceipt)]),true);
    assert.equal((await issueFresh()).status,"issued");
    assert.equal(await complete(),true);
    assert.equal(await value("select revoked_at is null as result from public.hivra_remote_desktop_sessions where id=$1",[freshSession]),true);
    assert.equal(await value("select status='running' and operation_id is null as result from public.hivra_agents where id=$1",[dest]),true);
    assert.deepEqual(await value("select to_jsonb(a) as result from public.hivra_agents a where id=$1",[source]),beforeSource);
    assert.deepEqual(await value("select to_jsonb(a) as result from public.hivra_agents a where id=$1",[unrelated]),beforeOther);
    await db.exec("set role authenticated");
    await assert.rejects(() => begin());
    await assert.rejects(() => complete());
    await assert.rejects(() => db.query("select * from public.hivra_folder_recoveries"));
    console.log("PASS: folder recovery owner/identity/consent, lifecycle fence, durable receipt privileges, exact completion, old controller revocation + guest release + fresh source controller, unrelated resource preservation");
  } finally { await db.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode=1; });
