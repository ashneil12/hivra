const assert = require("node:assert/strict");
const { openMigratedDatabase, readMigration } = require("./lib/pglite-all-migrations.cjs");

const migration = "20261128015300_kvm_portable_runtime_selector.sql";
const enrollment = "hivra_kvm_portable_private.pilot_enrollment";
const owner = "user_RuntimeFixture";
const agent = "00000000-0000-4000-8000-000000000011";
const otherAgent = "00000000-0000-4000-8000-000000000012";
const operation = "00000000-0000-4000-8000-000000000013";
const hash = "a".repeat(64);
const bindingTag = `hivra-bind-${hash.slice(0, 32)}`;
const source = { hostId: "fixture-source", vmid: 1110, ip: "192.0.2.42", bindingTag };
const destination = { ...source, hostId: "fixture-destination", vmid: 1111 };
const profile = { machine: "pc-i440fx-9.2", hosts: { [source.hostId]: { bridge: "hivra0" } } };

async function main() {
  const db = await openMigratedDatabase({
    through: migration,
    skip: [migration],
    setup: `create role other_api_role;
      alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;`,
  });
  try {
    const row = async (sql, args = []) => (await db.query(sql, args)).rows[0];
    const rpc = async (name, ...args) =>
      (await row(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) as result`, args)).result;
    const read = (...args) => rpc("read_hivra_kvm_portable_pilot", ...args);
    await db.query(`insert into public.proxmox_hosts (id,total_cpu,total_ram_mb,thinpool_size_gb)
      values ($1,16,65536,256),($2,16,65536,256)`, [source.hostId, destination.hostId]);
    await db.query(`insert into public.hivra_agents
      (id,user_id,type,name,status,desired_state,deployment_mode,computer_substrate,seat_funding,cpu,ram,
        proxmox_host,vmid,ip,cf_hostname,cf_tunnel_id,chat_url,
        sleep_policy,sleep_state,sleep_generation,sleep_tier_changed_at,sleep_memory_dropped_at,
        infrastructure_binding_token_enforced,infrastructure_binding_token_hash)
      values ($1,$2,'claude-code','Fixture','running','running','hivra-managed','proxmox-kvm','paid',4,8,
        $3,$4,$5,'runtime.fixture.invalid','opaque-fixture-tunnel','https://runtime.fixture.invalid',
        'full','hibernated',8,now()-interval '2 minutes',now(),true,$6)`,
    [agent, owner, source.hostId, source.vmid, source.ip, hash]);
    assert.equal((await row("select hivra_kvm_portable_private.enroll_pilot($1,$2,$3,$4,$5) as ok", [
      owner, agent, source, destination, { placementA: source, placementB: destination,
        placementAReservedForBinding: true, placementBReservedForBinding: true },
    ])).ok, true);
    await db.exec(`update ${enrollment} set enrolled_at=now()-interval '5 minutes'`);
    await db.exec(readMigration(migration));

    assert.deepEqual(await row(`select runtime_profile,runtime_expires_at from ${enrollment}`), {
      runtime_profile: null, runtime_expires_at: null,
    });
    assert.equal(await read(null, null), null);
    assert.equal(await read(owner, agent), null);
    await assert.rejects(db.query(`update ${enrollment} set runtime_profile=$1`, [profile]), { code: "23514" });
    await assert.rejects(db.exec(`update ${enrollment} set runtime_expires_at=enrolled_at+interval '1 hour'`), { code: "23514" });
    for (const expiry of ["enrolled_at", "enrolled_at+interval '4 hours 1 microsecond'", "'infinity'"]) {
      await assert.rejects(db.query(`update ${enrollment} set runtime_profile=$1,runtime_expires_at=${expiry}`, [profile]),
        { code: "23514" });
    }
    await assert.rejects(db.exec(`update ${enrollment}
      set runtime_profile='null'::jsonb,runtime_expires_at=enrolled_at+interval '1 hour'`), { code: "23514" });
    await db.query(`update ${enrollment} set runtime_profile=$1,runtime_expires_at=now()-interval '1 second'`, [profile]);
    assert.equal(await read(owner, agent), null);
    const { expiresAt } = await row(`update ${enrollment}
      set runtime_expires_at=enrolled_at+interval '4 hours'
      returning to_jsonb(runtime_expires_at) as "expiresAt"`);
    const expected = { ownerId: owner, agentId: agent, placements: [source, destination], profile, expiresAt };

    for (const role of ["anon", "authenticated", "other_api_role"]) {
      await db.exec(`set role ${role}`);
      await assert.rejects(read(owner, agent), { code: "42501" });
      await db.exec("reset role");
    }
    const table = await row("select $1::regclass::oid as oid", [enrollment]);
    const { allowed } = await row(`select has_table_privilege('service_role',$1::oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege('service_role',$1::oid,'SELECT,INSERT,UPDATE,REFERENCES') as allowed`, [table.oid]);
    assert.equal(allowed, false);
    await db.exec("set role service_role");
    assert.deepEqual(await read(), expected);
    assert.deepEqual(await read(null, null), expected);
    assert.deepEqual(await read(owner), expected);
    assert.deepEqual(await read(owner, agent), expected);
    for (const args of [[owner, otherAgent], ["user_NotEnrolled", agent], ["user_NotEnrolled", null], [null, agent], ["", null]]) {
      assert.equal(await read(...args), null);
    }
    await assert.rejects(db.exec(`select * from ${enrollment}`), { code: "42501" });
    await assert.rejects(db.exec(`update ${enrollment} set runtime_profile=null,runtime_expires_at=null`), { code: "42501" });
    await assert.rejects(db.query("select hivra_kvm_portable_private.enroll_pilot($1,$2,$3,$4,$5)",
      [owner, agent, source, destination, {}]), { code: "42501" });
    await db.exec("reset role");

    for (const [column, invalid, original] of [
      ["ip", "192.0.2.43", source.ip],
      ["infrastructure_binding_token_enforced", false, true],
      ["infrastructure_binding_token_hash", `${hash.slice(0, 32)}${"b".repeat(32)}`, hash],
      ["desired_state", "stopped", "running"],
    ]) {
      await db.query(`update public.hivra_agents set ${column}=$1 where id=$2`, [invalid, agent]);
      assert.equal(await read(owner, agent), null, column);
      await db.query(`update public.hivra_agents set ${column}=$1 where id=$2`, [original, agent]);
      assert.deepEqual(await read(owner, agent), expected);
    }
    await db.query(`update ${enrollment} set placement_b=$1`, [{ ...destination, extra: true }]);
    assert.equal(await read(owner, agent), null);
    await db.query(`update ${enrollment} set placement_b=$1`, [{ ...destination, ip: "192.0.2.73" }]);
    assert.equal(await read(owner, agent), null);
    await db.query(`update ${enrollment} set placement_b=$1`, [destination]);

    const deadline = new Date(Date.now() + 3600_000).toISOString();
    const checkpointSha256 = "b".repeat(64);
    const sourceProof = { source, sourceStopped: true, sourceFenced: true, sourceConnectorOff: true };
    const advance = (action, evidence) => rpc("advance_hivra_kvm_portable_handoff", owner, agent, operation, 9, action, evidence);
    await db.exec("set role service_role");
    assert.equal((await rpc("begin_hivra_kvm_portable_handoff", owner, agent, operation, 8, source, destination, deadline)).phase,
      "checkpointing");
    assert.ok((await rpc("request_hivra_kvm_portable_wake", owner, agent, operation, 9)).wake_requested_at);
    assert.equal((await advance("verify_storage", {
      ...sourceProof, checkpointSha256, storageReadbackVerified: true,
      configuration: { snapshotId: "c".repeat(64), sha256: "d".repeat(64) },
      disk: { key: "scsi0", snapshotId: "e".repeat(64), sha256: "f".repeat(64), bytes: 40 * 1024 ** 3 },
    })).phase, "storage_verified");
    assert.equal((await advance("claim_restore", null)).phase, "restore_claimed");
    assert.equal((await advance("verify_destination", {
      destination, checkpointSha256, coldBootVerified: true, destinationConnectorBlocked: true,
      bootId: "00000000-0000-4000-8000-000000000014", reservationSha256: "1".repeat(64),
    })).phase, "destination_verified");
    assert.deepEqual(await read(owner, agent), expected);
    assert.equal((await advance("commit_placement", { ...sourceProof, destination, checkpointSha256, destinationConnectorBlocked: true })).phase,
      "placement_committed");
    assert.deepEqual(await read(owner, agent), expected);
    await db.exec("reset role");
    await db.exec(`update ${enrollment} set runtime_profile=null,runtime_expires_at=null`);
    assert.equal(await read(), null);

    console.log("KVM portable runtime selector SQL passed");
  } finally {
    await db.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
