// Compose desktop RPCs with the real prior ownership/lifecycle migrations.
// Provider/guest readiness is fixture evidence, never a live acceptance claim.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
module.exports = async function desktopLifecycle({db,reset,publishTarget,reserve,caps,
  agent,op,other,connection,order,attempt,quote,value,readAgent,rejected}) {
  const {buildProviderDesktopWorkerPlan} = require("../src/lib/infrastructure/provider-desktop-worker.ts");
  const {PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES} = require("../src/lib/infrastructure/portable-provisioner-contract.ts");
  const access = {mode:"cloudflare-named",hostname:"desktop.example.test",tunnelId:other};
  const identity = buildProviderDesktopWorkerPlan({agentId:agent,operationId:op,action:"start",
    scope:{binding:{userId:"owner",connectionId:connection,connectionRevision:7,orderId:order,attemptId:attempt,
      quoteFingerprint:quote,recipeVersion:"2026.08.27.1"},providerServerId:"42"},
    assets:PORTABLE_HIVRA_PROVISIONER_BUNDLE_FILES.map(relativePath=>({relativePath,content:fs.readFileSync(path.join(__dirname,"../provisioner",relativePath))})),
    authority:{computerId:agent,controlOrigin:"https://canary.hermesos.cloud",access},
    launch:{version:3,agentKind:"linux-desktop",computerSubstrate:"provider-vm",computerId:agent,
      controlOrigin:"https://canary.hermesos.cloud",publicOrigin:"https://desktop.example.test",wantBrowser:null,
      model:"",modelKey:"",modelBaseUrl:"",tunnelToken:Buffer.from(JSON.stringify({t:other})).toString("base64"),accessHostname:null},
  },{bootId:other,boottimeMs:0}).identity;
  const begin = (i=identity,a=access) => value("select public.begin_hivra_provider_desktop_install('owner',$1,$2,$3,$4) as result",[agent,op,i,a]);
  const fixture = async (dispatch=true) => {
    await reset({publish:false});
    await publishTarget({caps:{...caps,provisioner:{configured:true,ready:true,version:identity.bundle.provisionerVersion,
      bundleSha256:identity.bundle.bundleSha256,scopeSha256:identity.bundle.scopeSha256}}});
    await reserve({type:"linux-desktop",profile:"ubuntu-desktop"});
    await db.query("update public.hivra_agents set cf_hostname=$1,cf_tunnel_id=$2",[access.hostname,access.tunnelId]);
    if(dispatch) assert.equal((await begin()).outcome,"dispatch");
  };
  const receipt = (state="failed",cleanup="pending")=>({version:3,identity,state,stopped:true,
    desktopCleanup:cleanup==="pending"?{state:cleanup}:{state:cleanup,bootId:other}});
  const stopped = r=>value("select public.record_hivra_provider_install_stopped('owner',$1,$2,$3) as result",[agent,op,r]);
  const grant = ()=>value("select public.begin_hivra_provider_desktop_cleanup('owner',$1,$2,$3) as result",[agent,op,identity]);
  const record = (g,r)=>value("select public.record_hivra_provider_desktop_cleanup('owner',$1,$2,$3,$4) as result",[agent,op,g.observationId,r]);
  const release = ()=>value("select public.release_hivra_agent_operation('owner',$1,$2,null,false) as result",[agent,op]);
  const complete = (url="https://desktop.example.test",ip="203.0.113.10")=>value("select public.complete_hivra_provider_desktop_running('owner',$1,$2,$3,$4,clock_timestamp()) as result",[agent,op,url,ip]);
  await fixture(false);
  assert.equal((await value("select public.begin_hivra_provider_install('owner',$1,$2,$3) as result",[agent,op,identity])).outcome,"rejected");
  for(const a of [{...access,hostname:"other.example.test"},{...access,tunnelId:agent},null]) assert.equal((await begin(identity,a)).outcome,"rejected");
  assert.equal((await begin()).outcome,"dispatch"); assert.equal((await begin()).outcome,"observe");
  for(const sql of ["update public.hivra_agents set cf_hostname='other.example.test'", "update public.hivra_agents set computer_profile='omarchy'",
    "update public.hivra_agents set type='codex'", "update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null"]) await rejected(()=>db.exec(sql));
  assert.equal(await stopped(receipt("succeeded")),true);
  assert.equal(await value("select public.complete_hivra_agent_running('owner',$1,$2,'provision',$3,'203.0.113.10',null,clock_timestamp()) as result",
    [agent,op,"https://desktop.example.test"]),false);
  assert.equal(await complete("https://other.example.test"),false);
  assert.equal(await complete(undefined,"203.0.113.11"),false);
  assert.equal(await complete(),true);
  const running=await readAgent(); assert.equal(running.status,"running"); assert.equal(running.operation_id,null);assert.equal(running.api_token,null);
  for(const outcome of ["failed","cancelled","succeeded"]) {
    await fixture(); assert.equal(await stopped(receipt(outcome)),true);
    await rejected(release);
    const g=await grant(); assert.ok(g); assert.equal(await complete(),false);
    await rejected(()=>db.exec("update public.hivra_agents set status='running',operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null"));
    assert.equal(await record(g,receipt(outcome,"verified_stopped")),true);
    assert.equal(await release(),true);
    assert.equal((await readAgent()).operation_id,null);
  }
  await fixture(); assert.equal(await stopped(receipt()),true);
  const old=await grant(),latest=await grant();
  assert.equal(await record(old,receipt("failed","verified_stopped")),false); await rejected(release);
  assert.equal(await record(latest,receipt("failed","verified_stopped")),true);
  await db.exec("update public.hivra_provider_desktop_cleanup set issued_at=issued_at-interval '1 minute',expires_at=expires_at-interval '1 minute',observed_at=observed_at-interval '1 minute'");
  await rejected(release);
  for(const profile of ["omarchy","windows",null]) {
    await fixture(false); await db.query("update public.hivra_agents set computer_profile=$1",[profile]);
    assert.equal((await begin()).outcome,"rejected");
    await rejected(()=>db.query("update public.hivra_agents set provider_install_identity=$1,provider_install_dispatched_at=clock_timestamp()",
      [{version:1,agentId:agent,operationId:op,bundle:identity.bundle}]));
  }
  await fixture(false);
  const direct={mode:"direct-https",hostname:"203-0-113-10.sslip.io",tunnelId:null};
  await db.exec("update public.hivra_agents set cf_hostname=null,cf_tunnel_id=null,ip='203.0.113.10',chat_url='https://203-0-113-10.sslip.io'");
  assert.equal((await begin(identity,{...direct,hostname:"203-0-113-11.sslip.io"})).outcome,"rejected");
  assert.equal((await begin(identity,direct)).outcome,"dispatch");
  await rejected(()=>db.exec("update public.hivra_agents set ip='203.0.113.11',chat_url='https://203-0-113-11.sslip.io'"));
  assert.equal(await stopped(receipt("succeeded")),true);
  assert.equal(await complete("https://203-0-113-10.sslip.io"),true);
  await fixture(false);
  await db.exec("set role service_role");
  try { assert.equal((await begin()).outcome,"dispatch"); assert.equal(await stopped(receipt()),true);
    assert.equal(await record(await grant(),receipt("failed","verified_stopped")),true); assert.equal(await release(),true);
  } finally {await db.exec("reset role");}
  await require("./provider-desktop-store-sql-fixture.cjs")({db,desktopFixture:fixture,desktopIdentity:identity,
    desktopReceipt:(outcome="failed",state="verified_stopped",bootId=other)=>({...receipt(outcome,state),
      desktopCleanup:state==="pending"?{state}:{state,bootId}}),desktopGrant:grant,
    desktopJournal:()=>value("select to_jsonb(j) as result from public.hivra_provider_desktop_cleanup j where agent_id=$1",[agent]),
    recordStopped:stopped,readAgent,release});
  await require("./provider-desktop-capability-sql-fixture.cjs")({ db, fixture, stopped, complete, receipt, agent, op });
  await require("./provider-workspace-sql-fixture.cjs")({ db, fixture, stopped, complete, receipt, agent, op, other, identity, access, value });
  await require("./provider-desktop-power-sql-fixture.cjs")({ db, fixture, stopped, complete, receipt, agent, op, other, value, readAgent });
  await require("./provider-desktop-absence-sql-fixture.cjs")({ db, fixture, stopped, receipt, agent, op, other,
    connection, order, attempt, value, readAgent, rejected });
  await require("./provider-desktop-teardown-sql-fixture.cjs")({ db, fixture, stopped, receipt, grant, agent, op, other,
    connection, order, value, readAgent, rejected, release });
  console.log("PASS desktop lifecycle SQL: exact dispatch, access immutability, original-operation cleanup handoff, cancellation readiness exclusion and profile isolation");
};
