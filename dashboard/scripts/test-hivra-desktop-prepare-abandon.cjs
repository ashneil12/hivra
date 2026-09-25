// Isolated PostgreSQL regression for releasing an orphaned desktop preparation
// lease (the Canary Ubuntu fixture, 2026-09-16: VM powered off, lease held,
// every power action 409). No live credentials or VM access.
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
    const migration = name => fs.readFileSync(path.join(dir, name), "utf8");
    await db.exec(migration("20260605120000_hivra_agents.sql"));
    await db.exec("alter table public.hivra_agents add column llm_config jsonb, add column llm_api_key_encrypted text");
    for (const file of fs.readdirSync(dir).filter(name => /^202608(?:2[56789]|3[01])/.test(name)
      || ["20260901020000_hivra_remote_desktop_sessions.sql", "20260903010000_hivra_computer_profiles.sql"].includes(name)).sort()) {
      await db.exec(migration(file));
    }
    await db.exec("alter table public.hivra_agents add column managed_provisioner_channel text not null default 'default'");
    for (const file of ["20260905150000_hivra_desktop_prepare_lifecycle.sql", "20260908100000_windows_desktop_prepare_receipt.sql",
      "20260908110000_desktop_prepare_profiles.sql", "20260924231500_hivra_desktop_prepare_abandon.sql"]) {
      await db.exec(migration(file));
    }

    const id = "11111111-1111-4111-8111-111111111111", omarchy = "22222222-2222-4222-8222-222222222222";
    const op = "33333333-3333-4333-8333-333333333333", omarchyOp = "44444444-4444-4444-8444-444444444444";
    const fresh = "55555555-5555-4555-8555-555555555555", next = "66666666-6666-4666-8666-666666666666";
    const value = async (sql, args = []) => (await db.query(sql, args)).rows[0]?.result;
    for (const [agent, profile, vmid, ip] of [[id, "ubuntu-desktop", 1108, "10.250.20.58"], [omarchy, "omarchy", 2099, "10.250.20.99"]]) {
      await db.query(`insert into public.hivra_agents(id,user_id,type,name,status,desired_state,computer_profile,cpu,ram,
        computer_substrate,proxmox_host,vmid,ip,api_token,infrastructure_binding_token_hash,infrastructure_binding_token_enforced,
        managed_provisioner_channel) values($1,'owner','linux-desktop','fixture','running','running',$2,2,4,
        'proxmox-kvm','fixturenode11',$3,$4,'test-private-key',repeat('a',64),true,'canary')`, [agent, profile, vmid, ip]);
    }
    const authority = agent => value("select public.hivra_desktop_prepare_authority(a) as result from public.hivra_agents a where id=$1", [agent]);
    const begin = async (agent, operation) => value("select public.begin_hivra_desktop_prepare('owner',$1,$2,$3::jsonb) as result",
      [agent, operation, JSON.stringify(await authority(agent))]);
    const dispatch = operation => value("select public.dispatch_hivra_desktop_prepare('owner',$1) as result", [operation]);
    const age = operation => db.query("update public.hivra_desktop_preparations set created_at=clock_timestamp()-interval '8 days' where id=$1", [operation]);
    const evidence = { version: 1, operationId: op, computerId: id, vmid: 1108, bindingTag: "hivra-bind-" + "a".repeat(32),
      vmStatus: "stopped", guestInstaller: "powered_off" };
    const abandon = (proof = evidence, owner = "owner") => value(
      "select public.abandon_hivra_desktop_prepare($1,$2,$3::jsonb) as result", [owner, proof.operationId, JSON.stringify(proof)]);
    const powerClaim = operation => value(
      "select public.claim_hivra_agent_operation('owner',$1,$2,'start','running',null) as result", [id, operation]);

    // Reproduce the orphan: dispatched lease, installer never produced a receipt.
    assert.equal((await begin(id, op)).phase, "claimed");
    assert.equal(await dispatch(op), true);
    assert.equal(await powerClaim(next), false, "the held lease blocks every power action");
    await assert.rejects(() => db.query(`update public.hivra_agents set status='stopped',operation_id=null,operation_kind=null,
      operation_started_at=null,operation_payload=null where id=$1`, [id]), /exact terminal evidence/);

    // Not before the lease outlives any bounded install run.
    assert.equal(await abandon(), false);
    await age(op);
    for (const invalid of [
      { ...evidence, vmid: 1144 }, { ...evidence, computerId: omarchy }, { ...evidence, operationId: fresh },
      { ...evidence, bindingTag: "hivra-bind-" + "b".repeat(32) }, { ...evidence, version: 2 }, { ...evidence, extra: true },
      { ...evidence, guestInstaller: "running" }, { ...evidence, vmStatus: "running", guestInstaller: "powered_off" },
      { ...evidence, vmStatus: "missing" }, { ...evidence, vmStatus: null }, Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== "vmStatus")),
    ]) {
      assert.equal(await abandon({ ...invalid, operationId: invalid.operationId ?? op }), false, JSON.stringify(invalid));
    }
    assert.equal(await abandon(evidence, "other"), false);
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(() => abandon());
      await db.exec("reset role");
    }

    await db.exec("set role service_role");
    assert.equal(await abandon(), true);
    assert.equal(await abandon(), true, "exact replay is idempotent");
    assert.equal(await abandon({ ...evidence, guestInstaller: "powered_off", vmStatus: "stopped", bindingTag: evidence.bindingTag.slice(0, -1) + "0" }), false);
    await db.exec("reset role");
    const row = (await db.query("select status,desired_state,cpu,ram,vmid,operation_id,operation_kind,error from public.hivra_agents where id=$1", [id])).rows[0];
    assert.equal(row.status, "stopped");
    assert.equal(row.desired_state, "stopped");
    assert.equal(Number(row.cpu), 2, "entitled size is not overwritten by observed VM drift");
    assert.equal(row.ram, 4);
    assert.equal(row.operation_id, null);
    assert.match(row.error, /powered off/);
    const journal = (await db.query("select phase,terminal_receipt,completed_at from public.hivra_desktop_preparations where id=$1", [op])).rows[0];
    assert.equal(journal.phase, "abandoned");
    assert.deepEqual(journal.terminal_receipt, evidence);
    assert.equal(await value("select public.complete_hivra_desktop_prepare('owner',$1,$2::jsonb) as result", [op, JSON.stringify({
      version: 1, operationId: op, computerId: id, vmid: 1108, guestIp: "10.250.20.58", bindingTag: evidence.bindingTag,
      bootId: "77777777-7777-4777-8777-777777777777", exitCode: 0 })]), false, "a late receipt cannot resurrect the lease");
    assert.equal(await powerClaim(next), true, "power actions are admitted again");

    // Running + quiescent guest reconciles to running.
    await db.query("update public.hivra_agents set status='running',desired_state='running',operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null where id=$1", [id]);
    assert.equal((await begin(id, fresh)).phase, "claimed");
    assert.equal(await dispatch(fresh), true);
    await age(fresh);
    assert.equal(await abandon({ ...evidence, operationId: fresh, vmStatus: "running", guestInstaller: "exited" }), true);
    assert.equal(await value("select status||'/'||desired_state as result from public.hivra_agents where id=$1", [id]), "running/running");

    // Undispatched journals keep the existing cancel; other profiles keep their receipt rule.
    await db.query("update public.hivra_agents set error=null where id=$1", [id]);
    assert.equal((await begin(omarchy, omarchyOp)).phase, "claimed");
    assert.equal(await dispatch(omarchyOp), true);
    await age(omarchyOp);
    assert.equal(await abandon({ ...evidence, operationId: omarchyOp, computerId: omarchy, vmid: 2099 }), false);
    assert.equal(await value("select phase as result from public.hivra_desktop_preparations where id=$1", [omarchyOp]), "dispatched");
    console.log("PASS desktop prepare abandon: stale-only, exact identity/evidence, ubuntu-only, idempotent, row reconciled to observed power state, power actions admitted");
  } finally { await db.close(); }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
