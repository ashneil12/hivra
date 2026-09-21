// Actual PostgreSQL functions and journal constraints in an isolated database.
// Minimal agent rows stand in for dispatch, which this migration does NOT admit.
// No provider, SSH, lifecycle release, application credentials or live database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");

async function main() {
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      alter default privileges in schema public grant all on tables to anon,authenticated,service_role;
      create table public.hivra_agents(id uuid primary key,user_id text,computer_substrate text,type text,
        computer_profile text,operation_id uuid,allocation_operation_id uuid,operation_kind text,status text,
        provider_install_identity jsonb,provider_install_stopped_at timestamptz,provider_install_outcome text);`);
    await db.exec(fs.readFileSync(path.join(__dirname, "../supabase/migrations/20260905210000_provider_desktop_cleanup_contract.sql"), "utf8"));
    const agent = "11111111-1111-4111-8111-111111111111", op = "22222222-2222-4222-8222-222222222222";
    const boot = "33333333-3333-4333-8333-333333333333";
    const identity = {version: 3, agentId: agent, operationId: op, bundle: {version: 1, state: "bundle_installed",
      scopeSha256: "a".repeat(64), provisionerVersion: "2026.09.05.6",
      bundleSha256: "1226dfc97e54f745b84b934e89246adc4453f85b3bdad1e14fc892d9ff5d1da4"},
      desktopCleanup: {profile: "desktop-owned-services-v1", closureSha256: "d3dd454b6f386deadb0d3f45f0eee3cb21999f5229c0a831b5dc62f82a578225"}};
    const receipt = (state = "failed", cleanup = "verified_stopped") => ({version: 3, identity, state, stopped: true,
      desktopCleanup: cleanup === "pending" ? {state: cleanup} : {state: cleanup, bootId: boot}});
    const value = async (sql, args = []) => (await db.query(sql, args)).rows[0].result;
    const valid = i => value("select public.hivra_provider_desktop_identity_valid($1,$2,$3) as result", [i,agent,op]);
    const receiptValid = r => value("select public.hivra_provider_desktop_stopped_receipt_valid($1,$2,$3) as result", [r,agent,op]);
    const grant = (owner = "owner", operation = op, i = identity) => value("select public.begin_hivra_provider_desktop_cleanup($1,$2,$3,$4) as result", [owner,agent,operation,i]);
    const record = (g, r = receipt()) => value("select public.record_hivra_provider_desktop_cleanup('owner',$1,$2,$3,$4) as result", [agent,op,g.observationId,r]);
    const verified = () => value("select public.hivra_provider_desktop_cleanup_verified('owner',$1,$2,$3,'failed') as result", [agent,op,identity]);
    const reset = async () => {
      await db.exec("reset role; truncate public.hivra_agents cascade");
      await db.query(`insert into public.hivra_agents values($1,'owner','provider-vm','linux-desktop','ubuntu-desktop',
        $2,$2,'provision','provisioning',$3,clock_timestamp(),'failed')`, [agent,op,identity]);
    };
    assert.equal(await valid(identity), true);
    for (const i of [null, {}, {...identity, version: 2}, {...identity, agentId: op}, {...identity, operationId: agent},
      {...identity, command: "forbidden"}, {...identity, bundle: {...identity.bundle, provisionerVersion: "2026.09.05.5"}},
      {...identity, bundle: {...identity.bundle, bundleSha256: "f".repeat(64)}},
      {...identity, bundle: {...identity.bundle, scopeSha256: null}},
      {...identity, desktopCleanup: {...identity.desktopCleanup, profile: "deepseek-owned-service-v1"}},
      {...identity, desktopCleanup: {...identity.desktopCleanup, closureSha256: "f".repeat(64)}}]) assert.equal(await valid(i), false);
    for (const state of ["failed", "succeeded", "cancelled"]) {
      assert.equal(await receiptValid(receipt(state)), true);
      assert.equal(await receiptValid(receipt(state,"pending")), true);
      assert.equal(await receiptValid(receipt(state,"not_started")), state === "cancelled");
    }
    for (const r of [null, {}, {...receipt(), version: 2}, {...receipt(), stopped: false}, receipt("running"),
      {...receipt(), identity: {...identity, operationId: agent}}, {...receipt(), extra: true},
      {...receipt(), desktopCleanup: {state: "verified_stopped"}},
      {...receipt(), desktopCleanup: {state: "verified_stopped", bootId: "bad"}},
      {...receipt(), desktopCleanup: {state: "pending", bootId: boot}}]) assert.equal(await receiptValid(r), false);
    for (const [column, changed] of [["type","codex"],["type","deepseek-harness"],["computer_profile","omarchy-desktop"],
      ["computer_profile","windows-desktop"],["computer_profile",null],["computer_substrate","proxmox-kvm"],
      ["status","running"],["operation_kind","delete"],["allocation_operation_id",boot]]) {
      await reset(); await db.query(`update public.hivra_agents set ${column}=$1`, [changed]);
      assert.equal(await grant(), null);
    }
    await reset();
    assert.equal(await grant("foreign"), null); assert.equal(await grant("owner",boot), null);
    assert.equal(await grant("owner",op,{...identity,bundle:{...identity.bundle,scopeSha256:"b".repeat(64)}}), null);
    await db.exec("set role service_role");
    const first = await grant(); assert.equal(first.budgetMs,30000);
    assert.equal(await verified(),false);
    assert.equal(await record(first,receipt("failed","pending")),false);
    assert.equal(await record(first,receipt("cancelled")),false);
    assert.equal(await record(first),true); assert.equal(await verified(),true);
    assert.equal(await record(first),true);
    const second = await grant(); assert.notEqual(second.observationId,first.observationId);
    assert.equal(await verified(),false); assert.equal(await record(first),false);
    assert.equal(await record(second),true);
    for (const sql of ["delete from public.hivra_provider_desktop_cleanup", "update public.hivra_provider_desktop_cleanup set receipt=null"]) {
      await assert.rejects(()=>db.exec(sql), e=>e.code==="42501");
    }
    await db.exec("reset role");
    await db.exec("update public.hivra_provider_desktop_cleanup set issued_at=issued_at-interval '1 minute',expires_at=expires_at-interval '1 minute',observed_at=observed_at-interval '1 minute'");
    assert.equal(await record(second),false); assert.equal(await verified(),false);
    for (const role of ["anon","authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(grant,e=>e.code==="42501");
      await assert.rejects(()=>db.exec("select * from public.hivra_provider_desktop_cleanup"),e=>e.code==="42501");
      await db.exec("reset role");
    }
    await reset();
    await db.exec("update public.hivra_agents set provider_install_stopped_at=null,provider_install_outcome=null");
    assert.equal(await record(await grant()),false);
    // No desktop dispatch or shared identity widening is smuggled into this prerequisite.
    assert.equal(await value("select to_regprocedure('public.begin_hivra_provider_desktop_install(text,uuid,uuid,jsonb,jsonb)') is null as result"),true);
    console.log("PASS desktop cleanup SQL: exact identity, receipt shape, original-operation scope, pending/outcome rejection, grant supersession/expiry, and private journal permissions");
  } finally { await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode=1; });
