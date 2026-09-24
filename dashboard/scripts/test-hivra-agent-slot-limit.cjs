// The plan's agent limit, enforced by the database (design 5.1, threat T35).
// Applies every real migration to an in-memory PostgreSQL, then checks:
// - hivra_owner_agent_slot_count() counts exactly what loadCurrentComputeUsage()
//   counted (Hivra-managed rows and legacy rows that hold compute), plus
//   attachments on Hivra-managed computers that are claimed, dispatched or
//   attached, and nothing for cancelled, failed, detached or My server ones;
// - insert_hivra_managed_agent() and the v3 launch-model reservation refuse at
//   the limit and write nothing, keep defaults, and answer a replay without
//   counting it twice;
// - every slot writer takes the owner's slot lock before it counts;
// - migration B refuses a Hivra-managed row written without the lock, closes
//   the unlocked reservations to the application and leaves other writers alone;
// - the new functions are closed to public, anon and authenticated.
const assert = require("node:assert/strict");
const { openMigratedDatabase, readMigration } = require("./lib/pglite-all-migrations.cjs");

const MIGRATION_A = "20260924210000_hivra_agent_slot_limit.sql";
const MIGRATION_B = "20260924211000_hivra_agent_slot_writer_guard.sql";
const OWNER = "owner";

async function main() {
  const db = await openMigratedDatabase({ through: MIGRATION_A });
  const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
  const count = async (owner = OWNER) => (await one("select public.hivra_owner_agent_slot_count($1) as n", [owner])).n;
  try {
    // Re-running migration A is harmless.
    await db.exec(readMigration(MIGRATION_A));

    // A ready My server connection, for agents on the owner's own infrastructure.
    const CONNECTION = "c0000000-0000-4000-8000-000000000001", TARGET = "c0000000-0000-4000-8000-000000000002";
    await db.query(`insert into public.infrastructure_connections(id,user_id,name,status,ssh_host,ssh_host_fingerprint_sha256)
      values($1,$2,'fixture','ready','192.0.2.10',repeat('c',64))`, [CONNECTION, OWNER]);
    await db.query(`insert into public.deployment_targets(id,user_id,connection_id,external_id,display_name,status,
      evidence_connection_revision,capabilities,isolation_class) values($1,$2,$3,'fixture','fixture','ready',1,'{"launchReady":true}','hardware-vm')`,
      [TARGET, OWNER, CONNECTION]);
    const selfManaged = (mode) => mode === "self-managed"
      ? ["__hivra_self_managed_no_ambient_authority__", CONNECTION, TARGET, 1] : ["local", null, null, null];
    const agent = async (id, fields) => db.query(`insert into public.hivra_agents(id,user_id,type,name,status,desired_state,
        deployment_mode,computer_substrate,proxmox_host,infrastructure_connection_id,deployment_target_id,infrastructure_connection_revision,
        cpu,ram,infrastructure_binding_token_enforced) values($1,$2,$3,$4,$5,$6,$7,'proxmox-kvm',$8,$9,$10,$11,1,2,$7='self-managed')`,
      [id, fields.owner ?? OWNER, fields.type ?? "codex", fields.name ?? "A", fields.status, fields.status === "deleted" ? "deleted" : "running",
        fields.mode ?? "hivra-managed", ...selfManaged(fields.mode ?? "hivra-managed")]);
    await agent("10000000-0000-4000-8000-000000000001", { status: "running" });
    await agent("10000000-0000-4000-8000-000000000002", { status: "stopped" });
    await agent("10000000-0000-4000-8000-000000000003", { status: "provisioning" });
    await agent("10000000-0000-4000-8000-000000000004", { status: "error" });
    await agent("10000000-0000-4000-8000-000000000005", { status: "deleted" });
    await agent("10000000-0000-4000-8000-000000000006", { status: "running", mode: "self-managed" });
    await agent("10000000-0000-4000-8000-000000000007", { status: "running", owner: "other" });
    // A pool-exempt dashboard (Aeon) still takes a slot.
    await agent("10000000-0000-4000-8000-000000000008", { status: "running", type: "aeon" });
    assert.equal(await count(), 4, "running, stopped, provisioning and Aeon count; error, deleted, My server and other owners do not");

    const legacy = (id, status, lifecycle) => db.query(`insert into public.hermes_instances(id,user_id,name,status,lifecycle_state,cpu_limit,ram_limit)
      values($1,$2,'H',$3,$4,1,1024)`, [id, OWNER, status, lifecycle]);
    await legacy("20000000-0000-4000-8000-000000000001", "running", "active");
    await legacy("20000000-0000-4000-8000-000000000002", "stopped", "cold_archived");
    await legacy("20000000-0000-4000-8000-000000000003", "stopped", "pending_deletion");
    await legacy("20000000-0000-4000-8000-000000000004", "deleted", "deleted");
    await legacy("20000000-0000-4000-8000-000000000005", "failed", "active");
    assert.equal(await count(), 5, "a live legacy instance counts; gone, cold-archived, deleted and failed ones do not");

    // Attachments on a Hivra Cloud desktop count; on My server they do not.
    const desktop = async (id, mode) => {
      await db.query(`insert into public.hivra_agents(id,user_id,type,name,status,desired_state,computer_profile,computer_substrate,
          deployment_mode,proxmox_host,infrastructure_connection_id,deployment_target_id,infrastructure_connection_revision,
          vmid,ip,cpu,ram,infrastructure_binding_token_hash,infrastructure_binding_token_enforced)
        values($1,$2,'linux-desktop','Desk','running','running','ubuntu-desktop','proxmox-kvm',$3,$4,$5,$6,$7,$8,$9,2,4,repeat('a',64),true)`,
        [id, OWNER, mode, ...selfManaged(mode), 1200 + Number(id.slice(-1)), `10.0.0.${Number(id.slice(-1)) + 10}`]);
      const mapping = await one("select computer_id, last_source_event_id from public.hivra_canonical_source_mappings where source_id=$1", [id]);
      const command = id.replace(/^3/, "4");
      await one("select public.transfer_hivra_canonical_relationship_authority($1,$2,$3,1,$4) as r",
        [OWNER, mapping.computer_id, mapping.last_source_event_id, command]);
      return { computerId: mapping.computer_id, command };
    };
    const cloud = await desktop("30000000-0000-4000-8000-000000000001", "hivra-managed");
    const server = await desktop("30000000-0000-4000-8000-000000000002", "self-managed");
    assert.equal(await count(), 6, "the Hivra Cloud desktop itself takes a slot; the My server one does not");
    const attach = (id, target, sourceId, phase) => db.query(`insert into public.hivra_agent_attachments(id,user_id,computer_id,source_id,
        authority_generation,authority_command_id,guest_authority,intent,agent_identity_id,phase,completed_at)
      values($1,$2,$3,$4,2,$5,'{}','{}',gen_random_uuid(),$6,case when $6='claimed' then null else clock_timestamp() end)`,
      [id, OWNER, target.computerId, sourceId, target.command, phase]);
    await attach("50000000-0000-4000-8000-000000000001", cloud, "30000000-0000-4000-8000-000000000001", "claimed");
    assert.equal(await count(), 7, "an attachment claimed on a Hivra Cloud computer takes a slot");
    await attach("50000000-0000-4000-8000-000000000002", server, "30000000-0000-4000-8000-000000000002", "claimed");
    assert.equal(await count(), 7, "an attachment on My server does not");
    await db.query("update public.hivra_agent_attachments set phase='cancelled',completed_at=clock_timestamp() where id=$1",
      ["50000000-0000-4000-8000-000000000001"]);
    assert.equal(await count(), 6, "a cancelled attachment frees its slot");

    // insert_hivra_managed_agent: one writer, under the lock, exact at the limit.
    const insert = (row, limit) => one("select public.insert_hivra_managed_agent($1::jsonb,$2) as r", [JSON.stringify(row), limit]);
    const row = { user_id: OWNER, type: "codex", name: "New", status: "provisioning", deployment_mode: "hivra-managed",
      computer_substrate: "proxmox-kvm", proxmox_host: "local", cpu: 1, ram: 2, desired_state: "running" };
    const before = (await one("select count(*)::int as n from public.hivra_agents")).n;
    assert.deepEqual((await insert(row, 6)).r, { status: "plan_agent_limit", activeCount: 6, limit: 6 });
    assert.equal((await one("select count(*)::int as n from public.hivra_agents")).n, before, "a refusal writes nothing");
    const inserted = (await insert(row, 7)).r;
    assert.equal(inserted.status, "inserted");
    assert.match(inserted.row.id, /^[0-9a-f-]{36}$/, "the id default applies");
    assert.equal(inserted.row.user_id, OWNER);
    assert.equal(inserted.row.infrastructure_binding_token_enforced, false, "absent columns keep their defaults");
    assert.equal(await count(), 7);
    assert.deepEqual((await insert(row, 7)).r, { status: "plan_agent_limit", activeCount: 7, limit: 7 });
    for (const [bad, label] of [[{ ...row, api_token: undefined, unknown_column: 1 }, "unknown column"],
      [{ ...row, deployment_mode: "self-managed" }, "not Hivra-managed"], [{ ...row, user_id: "" }, "no owner"], [[], "not an object"]]) {
      assert.deepEqual((await insert(bad, 99)).r, { status: "invalid_request" }, label);
    }
    assert.deepEqual((await insert(row, null)).r, { status: "invalid_request" }, "a missing limit is not unlimited");
    assert.equal((await one("select current_setting('hivra.agent_slot_checked', true) as v")).v !== "on", true,
      "the writer flag does not outlive the insert");

    // The v3 reservation counts under the same lock; a replay is not recounted.
    const requestId = "60000000-0000-4000-8000-000000000001";
    const reservation = (id, request, limit, mode = "hivra-managed") => one(`select public.reserve_hivra_launch_model_request_v3($1,$2,$3::jsonb,$4,$5::jsonb,$6::jsonb,null,$7) as r`, [
      OWNER, request, JSON.stringify([{ version: 1, keyTag: "a".repeat(64), digest: "b".repeat(64) }]), "70000000-0000-4000-8000-00000000000" + id.slice(-1),
      JSON.stringify({ id, type: "codex", name: "M", cpu: 1, ram: 2, deployment_mode: mode, computer_substrate: "proxmox-kvm",
        operation_id: "80000000-0000-4000-8000-00000000000" + id.slice(-1), infrastructure_binding_token_hash: "c".repeat(64),
        ...(mode === "self-managed" ? { proxmox_host: "__hivra_self_managed_no_ambient_authority__", infrastructure_connection_id: CONNECTION,
          deployment_target_id: TARGET, infrastructure_connection_revision: 1 } : { proxmox_host: "local" }) }),
      JSON.stringify({ provider: "venice", mode: "managed", model: "m1", walletType: "card" }), limit]);
    assert.deepEqual((await reservation("90000000-0000-4000-8000-000000000001", requestId, 7)).r,
      { status: "plan_agent_limit", activeCount: 7, limit: 7 });
    assert.equal((await one("select count(*)::int as n from public.hivra_launch_model_requests")).n, 0);
    const reserved = (await reservation("90000000-0000-4000-8000-000000000001", requestId, 8)).r;
    assert.equal(reserved.status, "reserved");
    assert.equal(await count(), 8);
    assert.equal((await reservation("90000000-0000-4000-8000-000000000001", requestId, 1)).r.status, "existing",
      "a replay of an existing request is answered without counting it again");
    // My server reservations do not count and are not refused.
    const serverRequest = "60000000-0000-4000-8000-000000000002";
    assert.notEqual((await reservation("90000000-0000-4000-8000-000000000002", serverRequest, 0, "self-managed")).r.status,
      "plan_agent_limit", "an agent on the owner's own server is not counted toward the plan");

    // Every writer counts under the owner's slot lock.
    for (const fn of ["insert_hivra_managed_agent(jsonb,integer)",
      "reserve_hivra_launch_model_request_v3(text,uuid,jsonb,uuid,jsonb,jsonb,text,integer)"]) {
      const { def } = await one(`select pg_get_functiondef('public.${fn}'::regprocedure) as def`);
      assert.ok(def.indexOf("lock_hivra_owner_agent_slots") > 0 && def.indexOf("lock_hivra_owner_agent_slots") < def.indexOf("hivra_owner_agent_slot_count"),
        `${fn} locks before it counts`);
    }
    assert.match((await one("select pg_get_functiondef('public.lock_hivra_owner_agent_slots(text)'::regprocedure) as def")).def,
      /pg_advisory_xact_lock\(hashtextextended\('hivra-agent-slots-v1:' \|\| p_owner, 0\)\)/);

    // Migration B: the writer trigger and the closed unlocked reservations.
    await db.exec(readMigration(MIGRATION_B));
    await db.exec(readMigration(MIGRATION_B));
    await assert.rejects(() => agent("10000000-0000-4000-8000-000000000009", { status: "running" }), { code: "55000" },
      "a Hivra-managed row written without the slot lock is refused");
    await agent("10000000-0000-4000-8000-00000000000a", { status: "running", mode: "self-managed" });
    assert.equal((await insert(row, 99)).r.status, "inserted", "the locked writer still writes");
    const secondRequest = "60000000-0000-4000-8000-000000000003";
    assert.equal((await reservation("90000000-0000-4000-8000-000000000003", secondRequest, 99)).r.status, "reserved",
      "the v3 reservation still writes through the unlocked v2 inside its own lock");

    const execute = async (role, fn) => (await one("select has_function_privilege($1, $2, 'execute') as ok", [role, fn])).ok;
    for (const fn of ["public.reserve_hivra_launch_model_request(text,uuid,jsonb,uuid,jsonb,jsonb,text)",
      "public.reserve_hivra_launch_model_request_v2(text,uuid,jsonb,uuid,jsonb,jsonb,text)"]) {
      assert.equal(await execute("service_role", fn), false, `${fn} is closed to the application`);
    }
    for (const fn of ["public.hivra_owner_agent_slot_count(text)", "public.insert_hivra_managed_agent(jsonb,integer)",
      "public.reserve_hivra_launch_model_request_v3(text,uuid,jsonb,uuid,jsonb,jsonb,text,integer)"]) {
      assert.equal(await execute("service_role", fn), true, `${fn} is service-only`);
      for (const role of ["anon", "authenticated", "public"]) {
        if (role === "public") {
          const { acl } = await one("select array_to_string(proacl, ',') as acl from pg_proc where oid=$1::regprocedure", [fn]);
          assert.ok(!/(^|,)=X/.test(acl ?? ""), `${fn} is not executable by public`);
        } else assert.equal(await execute(role, fn), false, `${fn} is closed to ${role}`);
      }
    }
    for (const fn of ["public.lock_hivra_owner_agent_slots(text)", "public.guard_hivra_managed_agent_slot_writer()"]) {
      for (const role of ["service_role", "anon", "authenticated"]) assert.equal(await execute(role, fn), false, `${fn} is internal`);
    }
    console.log("PASS hivra agent slot limit");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
