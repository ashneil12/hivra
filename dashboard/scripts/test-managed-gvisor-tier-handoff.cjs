const assert = require("node:assert/strict");
const { openMigratedDatabase } = require("./lib/pglite-all-migrations.cjs");

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const customer = "tier-customer-fixture";
const operator = "tier-operator-fixture";
const foreign = "tier-foreign-fixture";
const [srcConnection, srcTarget, dstConnection, dstTarget, generation, dstSandbox] = [1, 2, 3, 4, 5, 6].map(id);
const [adapterSha, runtimeSha, srcHost, dstHost, checkpointDigest] = ["a", "b", "c", "d", "e"].map((c) => c.repeat(64));
const expiry = "2099-01-01T00:00:00Z";
const capabilities = {
  kind: "gvisor",
  launchReady: true,
  adapter: { version: "2026.10.20.1", sha256: adapterSha },
  runtime: { path: "/usr/local/bin/runsc", sha256: runtimeSha },
  runtimeCompatibility: { contractVersion: 1, supportedWorkloadKinds: ["linux-terminal"] },
  resourcePolicy: { reservationEqualsMaximum: true, aggregateAdmission: "serialized-host-headroom-v1" },
  access: { terminal: "owner-gated-command-v1", publicPorts: false },
  desktop: false,
  windows: false,
};

async function main() {
  const db = await openMigratedDatabase({
    setup: "alter default privileges in schema public grant execute on functions to anon, authenticated, service_role",
  });
  try {
    const rpc = async (name, ...args) => {
      const params = args.map((_, i) => `$${i + 1}`).join(",");
      return (await db.query(`select public.${name}(${params}) as result`, args)).rows[0].result;
    };
    for (const [connection, target, host, rev] of [[srcConnection, srcTarget, srcHost, 7], [dstConnection, dstTarget, dstHost, 9]]) {
      await db.query(`insert into public.infrastructure_connections
        (id,user_id,provider,name,status,ssh_host,ssh_host_fingerprint_sha256,revision)
        values ($1,$2,'host',$4,'ready','192.0.2.10',repeat('f',64),$3)`, [connection, operator, rev, `Fixture ${rev}`]);
      await db.query(`insert into public.deployment_targets
        (id,user_id,connection_id,external_id,display_name,status,evidence_connection_revision,
          isolation_class,supported_isolation_drivers,capabilities,last_preflight_at)
        values ($1,$2,$3,'gvisor-' || repeat('a',24),'Fixture','ready',$4,
          'application-kernel',array['gvisor-runsc'],$5::jsonb,clock_timestamp())`,
      [target, operator, connection, rev, { ...capabilities, hostIdentityDigest: host }]);
    }
    const reserve = (request) => rpc("reserve_hivra_managed_gvisor", customer, request, "Fixture", 0.5, 2, 2,
      operator, srcConnection, srcTarget, 7, adapterSha, runtimeSha, 16, 16384, 8, 8192);
    const ready = async ({ computerId, operationId }) => {
      const claim = await rpc("claim_hivra_managed_gvisor_dispatch", customer, computerId, operationId);
      const receipt = {
        version: 1, state: "running", computerId, sandboxId: claim.sandboxId,
        cpu: 0.5, memoryMb: 2048, adapterVersion: "2026.10.20.1", isolationClass: "application-kernel",
        isolationDriver: "gvisor-runsc", outerHostBoundary: "operator-owned-host", runtime: "runsc",
        reservationEqualsMaximum: true, publicPorts: [],
        image: "python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285",
        workspace: `hivra-gvisor-workspace-${claim.sandboxId}`, network: `hivra-gvisor-net-${claim.sandboxId}`,
      };
      assert.equal(await rpc("complete_hivra_managed_gvisor_ready", customer, computerId, operationId, claim.claimId, receipt), true);
      return { claim, receipt };
    };
    await db.exec("set role service_role");
    const original = await reserve(id(7));
    assert.equal(original.status, "reserved");
    const computer = original.computerId;
    const begin = (overrides = {}) => {
      const p = { customer, computer, operator, srcConnection, srcTarget, srcRevision: 7,
        dstConnection, dstTarget, dstRevision: 9, generation, dstSandbox, expiry, ...overrides };
      const args = [p.customer, p.computer, p.operator, p.srcConnection, p.srcTarget, p.srcRevision,
        p.dstConnection, p.dstTarget, p.dstRevision, p.generation, p.dstSandbox, p.expiry];
      if ("idleHours" in p) args.push(p.idleHours);
      return rpc("begin_hivra_gvisor_tier_handoff", ...args);
    };
    const read = (owner = customer) => rpc("read_hivra_gvisor_tier_handoff", owner, computer);
    const checkpoint = (receipt, token = generation, owner = customer) =>
      rpc("commit_hivra_gvisor_tier_checkpoint", owner, computer, token, receipt);
    const running = (receipt, token = generation, owner = customer) =>
      rpc("commit_hivra_gvisor_tier_running", owner, computer, token, receipt);
    const claimRetire = (token = generation, owner = customer, hostOperator = operator) =>
      rpc("claim_hivra_gvisor_tier_retire", owner, computer, token, hostOperator);
    const commitRetire = (source, destination, token = generation, owner = customer, hostOperator = operator) =>
      rpc("commit_hivra_gvisor_tier_retire", owner, computer, token, hostOperator, source, destination);
    const lifecycle = (action, machine = computer) => rpc("claim_hivra_managed_gvisor_lifecycle", customer, machine, action);
    const observe = (machine = computer) => rpc("read_hivra_managed_gvisor_observation", customer, machine, true);
    const command = (machine = computer) => rpc("claim_hivra_managed_gvisor_pilot_command", customer, machine, expiry);
    const settleCommand = (machine, lease) => rpc("complete_hivra_managed_gvisor_pilot_command", customer, machine, lease);
    const idleStop = () => rpc("claim_hivra_managed_gvisor_pilot_idle_stop", customer, operator, srcConnection, srcTarget, 7, expiry);
    const history = async () => (await db.query(`select to_jsonb(a) as agent,to_jsonb(b) as binding
      from public.hivra_agents a join public.hivra_managed_gvisor_bindings b on b.computer_id=a.id where a.id=$1`,
    [computer])).rows[0];

    await db.exec("set role authenticated");
    for (const call of [begin, read, () => checkpoint({}), () => running({}), claimRetire, () => commitRetire({}, {})]) {
      await assert.rejects(call(), { code: "42501" });
    }
    await db.exec("set role anon");
    await assert.rejects(read(), { code: "42501" });
    await db.exec("set role service_role");
    await assert.rejects(db.query("select * from public.hivra_managed_gvisor_tier_handoffs"), { code: "42501" });
    await assert.rejects(rpc("claim_hivra_managed_gvisor_lifecycle_unenrolled", customer, computer, "stop"), { code: "42501" });
    await assert.rejects(rpc("read_hivra_managed_gvisor_observation_unenrolled", customer, computer, true), { code: "42501" });
    assert.equal(await begin(), null, "provisioning cannot enroll");

    const { claim, receipt } = await ready(original);
    assert.equal((await observe()).sandboxId, claim.sandboxId);
    assert.equal(await begin({ idleHours: 1 }), null, "unknown activity cannot qualify as idle");
    const lease = await command();
    assert.ok(lease);
    assert.equal(await begin(), null, "an active command defeats manual enrollment");
    assert.equal(await settleCommand(computer, lease), true);
    assert.equal(await begin({ idleHours: 1 }), null, "recent activity cannot qualify as idle");
    const stop = await lifecycle("stop");
    assert.equal(stop.status, "claimed");
    assert.equal(await begin(), null, "a claimed stop wins against enrollment");
    assert.equal((await rpc("complete_hivra_managed_gvisor_lifecycle", customer, computer, stop.operationId, "stop",
      { ...receipt, state: "stopped" })).status, "stopped");
    assert.equal(await begin(), null, "stopped cannot enroll");
    const start = await lifecycle("start");
    assert.equal(start.status, "claimed");
    assert.equal((await rpc("complete_hivra_managed_gvisor_lifecycle", customer, computer, start.operationId, "start", receipt)).status, "running");
    const before = await history();

    for (const wrong of [
      { customer: foreign }, { operator: foreign }, { customer: operator }, { srcRevision: 6 }, { srcTarget: dstTarget },
      { dstConnection: srcConnection }, { dstRevision: 8 }, { dstSandbox: claim.sandboxId }, { generation: null },
      { expiry: "2000-01-01T00:00:00Z" }, { expiry: "infinity" }, { idleHours: -1 },
    ]) assert.equal(await begin(wrong), null, JSON.stringify(wrong));

    const destinationEvidence = async (clockExpression, overrides = {}) => {
      await db.exec("reset role");
      await db.query(`update public.deployment_targets set capabilities=$2::jsonb,last_preflight_at=${clockExpression} where id=$1`,
        [dstTarget, { ...capabilities, hostIdentityDigest: dstHost, ...overrides }]);
      await db.exec("set role service_role");
    };
    await destinationEvidence("clock_timestamp()-interval '16 minutes'");
    assert.equal(await begin(), null, "stale evidence");
    await destinationEvidence("clock_timestamp()+interval '1 day'");
    assert.equal(await begin(), null, "future evidence");
    await destinationEvidence("clock_timestamp()", { hostIdentityDigest: srcHost });
    assert.equal(await begin(), null, "the destination cannot alias the source host");
    await destinationEvidence("clock_timestamp()", { runtime: { ...capabilities.runtime, sha256: checkpointDigest } });
    assert.equal(await begin(), null, "runtime digests must match");
    await destinationEvidence("clock_timestamp()", { adapter: { ...capabilities.adapter, sha256: checkpointDigest } });
    assert.equal(await begin(), null, "adapter digests must match");
    await destinationEvidence("clock_timestamp()");

    const sibling = await reserve(id(8));
    await ready(sibling);
    const siblingLease = await command(sibling.computerId);
    assert.ok(siblingLease);
    assert.equal(await settleCommand(sibling.computerId, siblingLease), true);
    await db.exec("reset role");
    await db.query(`update public.hivra_managed_gvisor_command_activity
      set last_activity_at=clock_timestamp()-case when computer_id=$1 then interval '3 hours' else interval '2 hours' end
      where computer_id in ($1,$2)`, [computer, sibling.computerId]);
    await db.exec("set role service_role");
    assert.equal(await begin({ idleHours: 1 }), null, "recent Start beats aged command activity");

    await db.exec("reset role");
    await db.query(`update public.hivra_agent_events set created_at=clock_timestamp()-interval '2 hours'
      where agent_id=$1 and event='started'`, [computer]);
    await db.exec("set role service_role");
    const enrolled = await begin({ idleHours: 1 });
    assert.equal(enrolled.phase, "checkpointing");
    assert.deepEqual(enrolled, {
      computer_id: computer, customer_id: customer, operator_id: operator, generation, phase: "checkpointing",
      source_connection_id: srcConnection, source_target_id: srcTarget, source_revision: 7, source_sandbox_id: claim.sandboxId,
      source_host_identity_digest: srcHost, destination_connection_id: dstConnection, destination_target_id: dstTarget,
      destination_revision: 9, destination_sandbox_id: dstSandbox, destination_host_identity_digest: dstHost,
      adapter_sha256: adapterSha, runtime_sha256: runtimeSha, checkpoint_receipt: null, health_receipt: null,
      expires_at: "2099-01-01T00:00:00+00:00", created_at: enrolled.created_at, updated_at: enrolled.created_at,
    });
    assert.deepEqual(await begin({ expiry: "2099-01-02T00:00:00Z" }), enrolled, "retry cannot extend pinned expiry");
    assert.deepEqual(await read(), enrolled);
    assert.equal(await read(foreign), null);
    assert.equal(await begin({ generation: id(10) }), null);
    assert.equal(await begin({ dstSandbox: id(10) }), null);
    assert.equal(await begin({ computer: sibling.computerId, generation: id(11) }), null, "one destination sandbox is pinned per handoff");
    assert.equal(await begin({ computer: sibling.computerId, dstSandbox: id(11) }), null, "one handoff per generation");

    for (const action of ["start", "stop", "delete"]) assert.deepEqual(await lifecycle(action), { status: "conflict" });
    assert.equal(await observe(), null);
    assert.equal(await command(), null);
    assert.equal((await idleStop()).computerId, sibling.computerId, "idle scan skips the older enrolled sandbox");
    assert.equal(await idleStop(), null);
    await assert.rejects(db.query("update public.hivra_agents set name='changed' where id=$1", [computer]), { code: "55000" });
    await assert.rejects(db.query("delete from public.hivra_agents where id=$1", [computer]), { code: "55000" });
    await db.exec("reset role");
    await assert.rejects(db.query("update public.hivra_managed_gvisor_bindings set target_id=$2 where computer_id=$1",
      [computer, dstTarget]), { code: "55000" });
    await db.exec("set role service_role");

    const archive = { sha256: checkpointDigest, ciphertext_bytes: 123, entries: 0, bytes: 0 };
    const base = { version: 1, computerId: computer, generation, checkpointDigest };
    const saved = { ...base, state: "checkpointed", archive, connectionId: srcConnection, targetId: srcTarget, revision: 7,
      sandboxId: claim.sandboxId, hostIdentityDigest: srcHost };
    const healthy = { ...base, state: "running", connectionId: dstConnection, targetId: dstTarget, revision: 9,
      sandboxId: dstSandbox, hostIdentityDigest: dstHost };
    const sourceAbsent = { version: 1, computerId: computer, generation, state: "absent",
      connectionId: srcConnection, targetId: srcTarget, revision: 7, sandboxId: claim.sandboxId, hostIdentityDigest: srcHost };
    const destinationAbsent = { version: 1, computerId: computer, generation, state: "absent",
      connectionId: dstConnection, targetId: dstTarget, revision: 9, sandboxId: dstSandbox, hostIdentityDigest: dstHost };
    const assertRetireOnly = async () => {
      assert.equal(await claimRetire(id(12)), null);
      assert.equal(await claimRetire(generation, foreign), null);
      assert.equal(await claimRetire(generation, customer, foreign), null);
      assert.equal(await commitRetire(sourceAbsent, destinationAbsent), false, "receipts cannot bypass the retirement claim");
      const retiring = await claimRetire();
      assert.equal(retiring.phase, "retiring");
      assert.deepEqual(await claimRetire(), retiring, "uncertain retirement keeps the same claim");
      assert.deepEqual(await read(), retiring);
      assert.equal(await begin(), null);
      assert.equal(await checkpoint(saved), null);
      assert.equal(await running(healthy), null);
      assert.equal(await observe(), null);
      assert.equal(await command(), null);
      assert.deepEqual(await lifecycle("delete"), { status: "conflict" });
    };
    await db.exec("begin");
    await assertRetireOnly();
    assert.equal(await commitRetire(sourceAbsent, destinationAbsent), true, "can retire during checkpointing");
    await db.exec("rollback");
    assert.equal(await running(healthy), null, "cannot skip checkpoint");
    assert.equal(await checkpoint(null), null);
    assert.equal(await checkpoint({}), null);
    assert.equal(await checkpoint(saved, id(12)), null);
    assert.equal(await checkpoint(saved, generation, foreign), null);
    for (const wrong of [
      { ...saved, state: "running" }, { ...saved, generation: id(12) }, { ...saved, hostIdentityDigest: dstHost },
      { ...saved, targetId: dstTarget }, { ...saved, blob: "x".repeat(5000) },
      ...[null, { ...archive, ciphertext_bytes: 0 }, { ...archive, bytes: 1.5 }, { ...archive, entries: -1 },
        { ...archive, entries: 9007199254740992 }, { ...archive, bytes: "12" }, { ...archive, sha256: dstHost },
      ].map((bad) => ({ ...saved, archive: bad })),
    ]) assert.equal(await checkpoint(wrong), null);
    const sleeping = await checkpoint(saved);
    assert.equal(sleeping.phase, "sleeping");
    assert.deepEqual(sleeping.checkpoint_receipt, saved);
    assert.deepEqual(await checkpoint(saved), sleeping);
    assert.equal(await checkpoint({ ...saved, archive: { ...archive, entries: 1 } }), null, "a receipt cannot be replaced");
    await db.exec("begin");
    await assertRetireOnly();
    assert.equal(await commitRetire(sourceAbsent, destinationAbsent), true, "can retire during sleeping");
    await db.exec("rollback");
    assert.equal(await running(null), null);
    assert.equal(await running(healthy, id(12)), null);
    assert.equal(await running(healthy, generation, foreign), null);
    for (const wrong of [
      { connectionId: srcConnection }, { targetId: srcTarget }, { revision: 7 }, { sandboxId: claim.sandboxId },
      { hostIdentityDigest: srcHost }, { checkpointDigest: srcHost }, { state: "stopped" }, { ignored: true },
    ]) assert.equal(await running({ ...healthy, ...wrong }), null);
    const awake = await running(healthy);
    assert.equal(awake.phase, "running");
    assert.deepEqual(awake.health_receipt, healthy);
    assert.deepEqual(await running(healthy), awake);
    assert.equal(await checkpoint(saved), null, "checkpoint cannot regress a running handoff");
    assert.deepEqual(await begin(), awake);
    assert.equal(await begin({ generation: id(12) }), null, "no second move after enrollment");
    assert.equal(await command(), null);
    assert.deepEqual(await lifecycle("delete"), { status: "conflict" });
    assert.deepEqual(await history(), before, "handoff must not change provisioning history, placement, or quota");
    assert.equal(await rpc("hivra_owner_agent_slot_count", customer), 2);

    await assertRetireOnly();
    assert.equal(await commitRetire(null, destinationAbsent), false);
    assert.equal(await commitRetire(sourceAbsent, null), false);
    assert.equal(await commitRetire(destinationAbsent, sourceAbsent), false);
    assert.equal(await commitRetire({ ...sourceAbsent, hostIdentityDigest: dstHost }, destinationAbsent), false);
    assert.equal(await commitRetire(sourceAbsent, { ...destinationAbsent, sandboxId: claim.sandboxId }), false);
    assert.equal(await commitRetire(sourceAbsent, { ...destinationAbsent, extra: "x".repeat(5000) }), false);
    assert.equal(await commitRetire(sourceAbsent, destinationAbsent, id(12)), false);
    assert.equal(await commitRetire(sourceAbsent, destinationAbsent, generation, foreign), false);
    assert.equal(await commitRetire(sourceAbsent, destinationAbsent, generation, customer, foreign), false);
    assert.equal(await rpc("hivra_owner_agent_slot_count", customer), 2, "held cleanup retains admission");
    assert.deepEqual(await history(), before);
    await db.exec("reset role");
    await assert.rejects(db.query("delete from public.deployment_targets where id=$1", [dstTarget]), { code: "23001" });
    await db.exec("alter table public.hivra_agent_events add constraint fixture_force_rollback check (event<>'deleted')");
    await db.exec("set role service_role");
    await assert.rejects(commitRetire(sourceAbsent, destinationAbsent), { code: "23514", constraint: "fixture_force_rollback" });
    assert.equal((await read()).phase, "retiring");
    assert.deepEqual(await history(), before, "failed delete audit rolls back the tombstone and both placements");
    await db.exec("reset role");
    await db.exec("alter table public.hivra_agent_events drop constraint fixture_force_rollback");
    await db.query("update public.deployment_targets set evidence_connection_revision=8 where id=$1", [srcTarget]);
    await db.exec("set role service_role");
    assert.equal(await commitRetire(sourceAbsent, destinationAbsent), true, "settles verified absence without reopening stale placement");
    assert.equal(await commitRetire(sourceAbsent, destinationAbsent), true, "settlement replay is idempotent");
    assert.equal(await read(), null);
    assert.equal(await claimRetire(), null);
    assert.equal(await begin(), null);
    assert.equal(await observe(), null);
    assert.equal(await command(), null);
    assert.equal(await rpc("hivra_owner_agent_slot_count", customer), 1);
    const tombstone = await history();
    assert.deepEqual(tombstone.agent, { ...before.agent, status: "deleted", desired_state: "deleted" });
    const absent = { version: 1, state: "absent", computerId: computer, sandboxId: claim.sandboxId };
    assert.deepEqual(tombstone.binding, {
      ...before.binding, active_target_id: null, lifecycle_operation_id: generation, lifecycle_action: "delete",
      lifecycle_receipt: absent, absence_receipt: absent,
    });
    const events = await db.query("select detail from public.hivra_agent_events where agent_id=$1 and event='deleted'", [computer]);
    assert.deepEqual(events.rows, [{ detail: { operationId: generation, substrate: "gvisor" } }]);
    await db.exec("reset role");
    await db.query("delete from public.deployment_targets where id=$1", [dstTarget]);
    console.log("Managed gVisor tier handoff migration assertions passed.");
  } finally {
    await db.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
