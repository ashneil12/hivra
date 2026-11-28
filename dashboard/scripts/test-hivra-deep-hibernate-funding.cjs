const assert = require("node:assert/strict");
const { openMigratedDatabase, readMigration } = require("./lib/pglite-all-migrations.cjs");

const migration = "20261128164100_hivra_deep_hibernate_funding.sql";
const uuid = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const [holder, paid, unknown, scheduled, job] = [1, 2, 3, 4, 5].map(uuid);
const baseline = "2026-11-20T00:00:00.000Z";
const cutoff = "2026-11-27T00:00:00.000Z";

async function main() {
  const db = await openMigratedDatabase({ through: migration, skip: [migration] });
  try {
    await db.exec(`insert into public.proxmox_hosts (id,total_cpu,total_ram_mb,thinpool_size_gb) values ('fixture-host',16,65536,256);`);
    for (const owner of ["user_EligibleFixture", "user_ScheduledFixture"]) {
      await db.query("insert into public.token_tier_qualifications(user_id,tier,token_key,currently_eligible,qualifying_quantity,threshold_at_qualification,qualifying_threshold_tier) values ($1,'pro','hermesos',true,1,1,'PRO_STANDARD')", [owner]);
      await db.query(`insert into public.holder_admissions(user_id,state,tier,token_key,admitted_at,reserved_cpu,reserved_ram_mb,assigned_host_id)
        values ($1,'admitted','pro','hermesos',now(),2,4096,'fixture-host')`, [owner]);
    }
    for (const [i, [id, funding, alwaysOn, nextWake, owner]] of [
      [holder, "holder", true, null, "user_EligibleFixture"], [paid, "paid", false, null, "user_PaidFixture"], [unknown, null, false, null, "user_UnknownFixture"],
      [scheduled, "holder", false, "now", "user_ScheduledFixture"],
    ].entries()) {
      await db.query(`insert into public.hivra_agents
        (id,user_id,type,name,status,desired_state,deployment_mode,computer_substrate,seat_funding,
         cpu,ram,proxmox_host,vmid,ip,sleep_state,sleep_tier_changed_at,sleep_memory_dropped_at,always_on,next_wake_at)
        values ($1,$6,'claude-code','Fixture','running','running','hivra-managed','proxmox-kvm',$2,
         1,2,'fixture-host',$7,$8,'hibernated',$3,$3,$4,case when $5::text is null then null else now() end)`,
      [id, funding, baseline, alwaysOn, nextWake, owner, 9310 + i, `192.0.2.${15 + i}`]);
    }
    const candidates = () => db.query("select id from public.hivra_sleep_store_candidates($1,10) order by id", [cutoff])
      .then(r => r.rows.map(x => x.id));
    const setJob = (agent, id) => db.query("update public.hivra_agents set sleep_store_job_id=$2 where id=$1", [agent, id]);
    assert.deepEqual(await candidates(), [holder, paid, unknown], "reproduce paid offload admission in the old candidate function");
    await setJob(paid, job);
    await db.exec("begin");
    await assert.rejects(db.exec(readMigration(migration)), { code: "55000" });
    await db.exec("rollback");
    await setJob(paid, null);
    await db.query("update public.hivra_agents set sleep_stored_at=$2 where id=$1", [paid, baseline]);
    await db.exec(readMigration(migration));

    await db.exec("set role service_role");
    assert.deepEqual(await candidates(), [holder]);
    for (const id of [paid, unknown]) {
      await assert.rejects(setJob(id, job), { code: "55000" });
    }
    await assert.rejects(db.query("select public.hivra_deep_hibernate_allowed('holder')"), { code: "42501" });
    await setJob(holder, job);
    await db.exec("set hivra.seat_funding_writer='on'");
    await assert.rejects(db.query("update public.hivra_agents set seat_funding='paid' where id=$1", [holder]), { code: "55000" });
    await db.exec("reset hivra.seat_funding_writer");
    assert.deepEqual(await candidates(), []);
    await setJob(holder, null);
    await db.query(`update public.hivra_agents set sleep_stored_at=null,sleep_unstore_requested_at=null,
      sleep_state='awake' where id=$1`, [paid]);
    assert.deepEqual((await db.query("select sleep_state,sleep_stored_at from public.hivra_agents where id=$1", [paid])).rows,
      [{ sleep_state: "awake", sleep_stored_at: null }], "paid seats already stored can still return");
    await db.exec("reset role");
    const planKeys = ["holder", "paid", "entry", null];
    const answers = await db.query("select v, public.hivra_deep_hibernate_allowed(v) as can_offload from unnest($1::text[]) v", [planKeys]);
    assert.deepEqual(answers.rows.map(r => r.can_offload), [true, false, false, false]);
    console.log("PASS deep hibernate funding: legacy bug reproduced; paid and unknown claims refused; holder and existing returns preserved.");
  } finally {
    await db.close();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
