// Exercise the real migration chain in memory with the same default table
// grants as Supabase. No application credentials or host access.
const assert = require("node:assert/strict");
const { openMigratedDatabase } = require("./lib/pglite-all-migrations.cjs");

const operator = "operator-fixture";
const customer = "customer-fixture";
const otherCustomer = "other-customer-fixture";
const foreignOperator = "foreign-operator-fixture";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const connection = id(1);
const target = id(2);
const foreignConnection = id(3);
const foreignTarget = id(4);
const request = id(5);
const adapterSha = "a".repeat(64);
const runtimeSha = "b".repeat(64);
const capabilities = {
  kind: "gvisor",
  launchReady: true,
  hostIdentityDigest: "c".repeat(64),
  adapter: { version: "2026.10.20.1", sha256: adapterSha },
  runtime: { path: "/usr/local/bin/runsc", sha256: runtimeSha },
  runtimeCompatibility: { contractVersion: 1, supportedWorkloadKinds: ["linux-terminal"] },
  resourcePolicy: { reservationEqualsMaximum: true, aggregateAdmission: "serialized-host-headroom-v1" },
  access: { terminal: "owner-gated-command-v1", publicPorts: false },
  desktop: false,
  windows: false,
};

async function main() {
  const db = await openMigratedDatabase();
  try {
    const one = async (sql, params) => (await db.query(sql, params)).rows[0];
    for (const [owner, host, placement] of [[operator, connection, target], [foreignOperator, foreignConnection, foreignTarget]]) {
      await db.query(`insert into public.infrastructure_connections
        (id,user_id,provider,name,status,ssh_host,ssh_host_fingerprint_sha256,revision)
        values ($1,$2,'host','Fixture','ready','192.0.2.10',repeat('d',64),7)`, [host, owner]);
      await db.query(`insert into public.deployment_targets
        (id,user_id,connection_id,external_id,display_name,status,evidence_connection_revision,
         isolation_class,supported_isolation_drivers,capabilities,last_preflight_at)
        values ($1,$2,$3,'gvisor-' || repeat('a',24),'Fixture','ready',7,
          'application-kernel',array['gvisor-runsc'],$4::jsonb,clock_timestamp())`,
      [placement, owner, host, JSON.stringify(capabilities)]);
    }

    const reserve = async (overrides = {}) => {
      const input = { customer, request, name: "Fixture", cpu: 0.5, ram: 2, limit: 1,
        operator, connection, target, revision: 7, adapterSha, runtimeSha, cpuBudget: 16, ramBudgetMb: 16384, maxCpu: 8, maxRamMb: 8192, ...overrides };
      return (await one(`select public.reserve_hivra_managed_gvisor($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) as result`,
        [input.customer, input.request, input.name, input.cpu, input.ram, input.limit, input.operator, input.connection,
          input.target, input.revision, input.adapterSha, input.runtimeSha, input.cpuBudget, input.ramBudgetMb, input.maxCpu, input.maxRamMb])).result;
    };
    const cancel = async (owner, computer) =>
      (await one("select public.cancel_undispatched_hivra_managed_gvisor($1,$2) as result", [owner, computer])).result;
    const count = async (owner) => (await one("select public.hivra_owner_agent_slot_count($1) as n", [owner])).n;
    const counts = () => one(`select
      (select count(*)::int from public.hivra_agents) as agents,
      (select count(*)::int from public.hivra_managed_gvisor_bindings) as bindings`);

    await db.exec("set role authenticated");
    await assert.rejects(reserve(), { code: "42501" });
    await assert.rejects(cancel(customer, id(10)), { code: "42501" });
    await assert.rejects(db.query("select * from public.hivra_managed_gvisor_bindings"), { code: "42501" });
    await db.exec("set role service_role");
    assert.equal((await reserve({ customer: operator })).status, "invalid_request");
    for (const input of [
      { target: foreignTarget }, { operator: foreignOperator }, { connection: foreignConnection },
      { revision: 8 }, { adapterSha: "e".repeat(64) }, { runtimeSha: "e".repeat(64) },
    ]) {
      assert.equal((await reserve(input)).status, "authority_changed");
    }
    assert.deepEqual(await counts(), { agents: 0, bindings: 0 });

    assert.equal((await reserve({ cpu: 2, maxCpu: 1 })).status, "plan_compute_limit");
    assert.equal((await reserve({ ram: 4, ramBudgetMb: 2048 })).status, "plan_compute_limit");
    assert.deepEqual(await counts(), { agents: 0, bindings: 0 });
    const reserved = await reserve();
    assert.equal(reserved.status, "reserved");
    const { computerId, operationId } = reserved;
    const stored = await one(`select a.user_id,a.deployment_mode,a.computer_substrate,a.status,a.operation_kind,
      a.operation_id,a.cpu::text,a.ram,a.infrastructure_connection_id,a.deployment_target_id,
      b.operator_id,b.connection_id,b.target_id,b.connection_revision::int
      from public.hivra_agents a join public.hivra_managed_gvisor_bindings b
        on (b.computer_id,b.customer_id)=(a.id,a.user_id) where a.id=$1`, [computerId]);
    assert.deepEqual(stored, {
      user_id: customer, deployment_mode: "hivra-managed", computer_substrate: "gvisor", status: "provisioning",
      operation_kind: "provision", operation_id: operationId, cpu: "0.5", ram: 2,
      infrastructure_connection_id: null, deployment_target_id: null,
      operator_id: operator, connection_id: connection, target_id: target, connection_revision: 7,
    });
    assert.equal(await count(customer), 1);
    assert.equal(await count(operator), 0);
    assert.deepEqual(await reserve({ limit: 0 }), { ...reserved, status: "replay" });
    for (const input of [{ name: "Changed" }, { cpu: 1 }, { ram: 3 }, { revision: 8 },
      { operator: foreignOperator, connection: foreignConnection, target: foreignTarget }]) {
      assert.equal((await reserve(input)).status, "conflict");
    }
    assert.equal((await reserve({ request: id(6) })).status, "plan_agent_limit");
    assert.equal((await reserve({ request: id(6), limit: 2, cpuBudget: 0.5 })).status, "plan_compute_limit");
    assert.equal((await reserve({ request: id(6), limit: 2, ramBudgetMb: 2048 })).status, "plan_compute_limit");
    const other = await reserve({ customer: otherCustomer });
    assert.equal(other.status, "reserved");
    assert.notEqual(other.computerId, computerId);
    assert.equal(await count(otherCustomer), 1);
    await assert.rejects(db.query("update public.hivra_managed_gvisor_bindings set operator_id=$1 where computer_id=$2",
      [foreignOperator, computerId]), { code: "42501" });

    // Even a generic service-role cleanup path may not release an
    // unconfirmed reservation. Neither an arbitrary receipt nor a hard delete
    // can clear it. The owner-scoped cancellation RPC is the only transition.
    await assert.rejects(db.query(`update public.hivra_agents set status='deleted',desired_state='deleted',
      operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null
      where id=$1`, [computerId]), { code: "55000" });
    await assert.rejects(db.query("delete from public.hivra_agents where id=$1", [computerId]), { code: "55000" });
    assert.equal((await cancel(otherCustomer, computerId)).status, "not_found");
    assert.equal((await cancel(operator, computerId)).status, "not_found");
    assert.equal(await count(customer), 1);
    assert.deepEqual(await counts(), { agents: 2, bindings: 2 });

    await db.exec("reset role");
    await assert.rejects(db.query("update public.hivra_managed_gvisor_bindings set connection_revision=8 where computer_id=$1",
      [computerId]), { code: "55000" });
    await assert.rejects(db.query(`update public.hivra_managed_gvisor_bindings
      set cancelled_at=clock_timestamp(),active_target_id=null where computer_id=$1`, [computerId]), { code: "23514" });
    await db.exec("alter table public.hivra_agents add constraint fixture_insert_failure check (name <> 'Force rollback')");
    await db.exec("set role service_role");
    await assert.rejects(reserve({ customer: "rollback-fixture", name: "Force rollback" }),
      { code: "23514", constraint: "fixture_insert_failure" });
    assert.deepEqual(await counts(), { agents: 2, bindings: 2 }, "failed agent insert rolls back the previously inserted binding");
    await db.exec("reset role");
    await db.query("update public.deployment_targets set last_preflight_at=clock_timestamp()-interval '16 minutes' where id=$1", [target]);
    assert.equal((await reserve({ customer: "unreserved-fixture" })).status, "authority_changed");
    await db.query("update public.deployment_targets set last_preflight_at=clock_timestamp() where id=$1", [target]);
    await db.query("update public.infrastructure_connections set revision=8 where id=$1", [connection]);
    assert.equal((await reserve({ customer: "unreserved-fixture" })).status, "authority_changed");

    await db.exec("alter table public.hivra_agents add constraint fixture_cancel_failure check (status <> 'deleted')");
    await db.exec("set role service_role");
    await assert.rejects(cancel(customer, computerId), { code: "23514", constraint: "fixture_cancel_failure" });
    assert.equal(await count(customer), 1, "uncommitted cancellation retains customer accounting");
    assert.deepEqual(await one(`select cancelled_at,active_target_id from public.hivra_managed_gvisor_bindings
      where computer_id=$1`, [computerId]), { cancelled_at: null, active_target_id: target });
    await db.exec("reset role");
    await db.exec("alter table public.hivra_agents drop constraint fixture_cancel_failure");

    // Cancellation is a local proof of never dispatching, even after evidence
    // goes stale. Atomically clear the accounting slot and live target FK while
    // retaining the original customer/request/operation/authority tombstone.
    await db.exec("set role service_role");
    const cancelled = await cancel(customer, computerId);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.agent.status, "deleted");
    assert.equal(cancelled.agent.operation_id, null);
    assert.equal(await count(customer), 0);
    assert.deepEqual(await cancel(customer, computerId), cancelled);
    assert.deepEqual(await reserve(), { status: "cancelled", computerId, operationId: null });
    assert.equal(await count(otherCustomer), 1);
    const tombstone = await one(`select operator_id,target_id,active_target_id,provision_operation_id,
      cancelled_at is not null as cancelled from public.hivra_managed_gvisor_bindings where computer_id=$1`, [computerId]);
    assert.deepEqual(tombstone, { operator_id: operator, target_id: target, active_target_id: null,
      provision_operation_id: operationId, cancelled: true });
    assert.deepEqual(await counts(), { agents: 2, bindings: 2 });
    await assert.rejects(db.query("delete from public.deployment_targets where id=$1", [target]),
      { code: "23001" });
    assert.equal((await cancel(otherCustomer, other.computerId)).status, "cancelled");
    assert.equal(await count(otherCustomer), 0);
    await db.exec("reset role");
    await db.query("delete from public.deployment_targets where id=$1", [target]);
    assert.deepEqual(await one("select target_id,active_target_id from public.hivra_managed_gvisor_bindings where computer_id=$1",
      [computerId]), { target_id: target, active_target_id: null });
    await db.exec("set role service_role");

    const selfManaged = async (owner, req) => one(`insert into public.hivra_agents
      (user_id,type,computer_profile,name,status,desired_state,deployment_mode,computer_substrate,proxmox_host,
       cpu,ram,cpu_max,ram_max,gvisor_sandbox_id,gvisor_adapter_version,gvisor_adapter_sha256,gvisor_runtime_sha256,
       infrastructure_connection_id,deployment_target_id,infrastructure_connection_revision,infrastructure_binding_token_hash,
       infrastructure_binding_token_enforced,gvisor_launch_request_id,operation_id,operation_kind,operation_started_at)
      values ($1,'linux-terminal','linux-terminal','Self-managed fixture','provisioning','running','self-managed',
       'gvisor','__hivra_self_managed_no_ambient_authority__',1,2,1,2,gen_random_uuid(),'2026.10.20.1',$2,$3,
       $4,$5,7,repeat('f',64),true,$6,gen_random_uuid(),'provision',clock_timestamp()) returning id`,
    [owner, adapterSha, runtimeSha, foreignConnection, foreignTarget, req]);
    await assert.rejects(selfManaged("foreign-customer", id(8)), { code: "55006" });
    const self = await selfManaged(foreignOperator, id(8));
    await db.query(`update public.hivra_agents set status='running',operation_id=null,operation_kind=null,
      operation_started_at=null where id=$1`, [self.id]);
    assert.equal((await one("select status from public.hivra_agents where id=$1", [self.id])).status, "running");
    assert.equal(await count(foreignOperator), 0, "self-managed gVisor still uses the customer's own capacity");
    assert.equal((await reserve({ customer: foreignOperator, request: id(8) })).status, "conflict");
    const dispatchOwner = "dispatch-fixture";
    const dispatchInput = { customer: dispatchOwner, operator: foreignOperator,
      connection: foreignConnection, target: foreignTarget, request: id(9) };
    const dispatch = await reserve(dispatchInput);
    assert.equal(dispatch.status, "reserved");
    const claim = async (owner = dispatchOwner, op = dispatch.operationId, computer = dispatch.computerId) =>
      (await one("select public.claim_hivra_managed_gvisor_dispatch($1,$2,$3) as result", [owner, computer, op])).result;
    const release = async (owner, op, token, receipt) => (await one(
      "select public.release_hivra_managed_gvisor_absent($1,$2,$3,$4,$5::jsonb) as result",
      [owner, dispatch.computerId, op, token, JSON.stringify(receipt)])).result;
    await db.exec("set role authenticated");
    await assert.rejects(claim(), { code: "42501" });
    await assert.rejects(release(dispatchOwner, dispatch.operationId, id(99), {}), { code: "42501" });
    await db.exec("set role service_role");
    assert.equal((await claim(customer)).status, "not_found");
    assert.equal((await claim(dispatchOwner, id(99))).status, "conflict");
    assert.equal((await claim(otherCustomer, other.operationId, other.computerId)).status, "conflict",
      "cancellation excludes later claims");
    await db.exec("reset role");
    await db.query("update public.deployment_targets set last_preflight_at=clock_timestamp()-interval '16 minutes' where id=$1",
      [foreignTarget]);
    assert.equal((await claim()).status, "authority_changed");
    await db.query(`update public.deployment_targets set last_preflight_at=clock_timestamp(),
      capabilities=jsonb_set(capabilities,'{runtime,sha256}',to_jsonb(repeat('e',64))) where id=$1`, [foreignTarget]);
    assert.equal((await claim()).status, "authority_changed");
    await db.query("update public.deployment_targets set capabilities=$2::jsonb where id=$1",
      [foreignTarget, JSON.stringify(capabilities)]);
    await db.exec("set role service_role");
    const claimed = await claim();
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.operatorId, foreignOperator);
    assert.equal(claimed.customerId, dispatchOwner);
    assert.equal(claimed.connectionId, foreignConnection);
    assert.equal(claimed.targetId, foreignTarget);
    assert.equal(claimed.revision, 7);
    assert.deepEqual(await claim(), { status: "held" }, "lost claim response cannot be recovered as another dispatch");
    assert.equal((await reserve(dispatchInput)).status, "replay");
    assert.equal((await cancel(dispatchOwner, dispatch.computerId)).status, "unconfirmed");
    const proof = { version: 1, state: "absent", computerId: dispatch.computerId, sandboxId: claimed.sandboxId };
    const beginCleanup = async () => (await one(
      "select public.begin_hivra_managed_gvisor_cleanup($1,$2,$3,$4) as result",
      [dispatchOwner, dispatch.computerId, dispatch.operationId, claimed.claimId])).result;
    assert.equal(await release(dispatchOwner, dispatch.operationId, claimed.claimId, proof), false);
    assert.equal(await beginCleanup(), true);
    assert.equal(await beginCleanup(), false);
    assert.equal(await release(customer, dispatch.operationId, claimed.claimId, proof), false);
    assert.equal(await release(dispatchOwner, id(99), claimed.claimId, proof), false);
    assert.equal(await release(dispatchOwner, dispatch.operationId, id(99), proof), false);
    assert.equal(await release(dispatchOwner, dispatch.operationId, claimed.claimId, { ...proof, sandboxId: id(99) }), false);
    assert.equal(await release(dispatchOwner, dispatch.operationId, claimed.claimId, { ...proof, state: "stopped" }), false);
    assert.equal(await count(dispatchOwner), 1);
    assert.deepEqual(await one(`select active_target_id,absence_receipt,dispatch_claim_id
      from public.hivra_managed_gvisor_bindings where computer_id=$1`, [dispatch.computerId]),
    { active_target_id: foreignTarget, absence_receipt: null, dispatch_claim_id: claimed.claimId });
    await db.exec("reset role");
    await db.exec("alter table public.hivra_agents add constraint fixture_release_failure check (user_id <> 'dispatch-fixture' or status <> 'deleted')");
    await db.exec("set role service_role");
    await assert.rejects(release(dispatchOwner, dispatch.operationId, claimed.claimId, proof),
      { code: "23514", constraint: "fixture_release_failure" });
    assert.equal(await count(dispatchOwner), 1);
    await db.exec("reset role");
    await db.exec("alter table public.hivra_agents drop constraint fixture_release_failure");
    await db.exec("set role service_role");
    assert.equal(await release(dispatchOwner, dispatch.operationId, claimed.claimId, proof), true);
    assert.equal(await release(dispatchOwner, dispatch.operationId, claimed.claimId, proof), true);
    assert.equal(await count(dispatchOwner), 0);
    assert.deepEqual(await one(`select target_id,active_target_id,absence_receipt
      from public.hivra_managed_gvisor_bindings where computer_id=$1`, [dispatch.computerId]),
    { target_id: foreignTarget, active_target_id: null, absence_receipt: proof });
    const readyOwner = "ready-fixture";
    const readyInput = { ...dispatchInput, customer: readyOwner };
    const ready = await reserve(readyInput);
    const readyClaim = await claim(readyOwner, ready.operationId, ready.computerId);
    const observe = async (owner, requireRunning = false) => (await one(
      "select public.read_hivra_managed_gvisor_observation($1,$2,$3) as result",
      [owner, ready.computerId, requireRunning])).result;
    assert.equal(await observe(customer), null);
    assert.equal(await observe(customer, true), null);
    assert.equal(await observe(readyOwner, true), null);
    assert.equal((await observe(readyOwner)).operationId, ready.operationId);
    const receipt = { version: 1, state: "running", computerId: ready.computerId, sandboxId: readyClaim.sandboxId,
      cpu: 0.5, memoryMb: 2048, adapterVersion: "2026.10.20.1", isolationClass: "application-kernel",
      isolationDriver: "gvisor-runsc", outerHostBoundary: "operator-owned-host", runtime: "runsc",
      reservationEqualsMaximum: true, publicPorts: [],
      image: "python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285",
      workspace: `hivra-gvisor-workspace-${readyClaim.sandboxId}`, network: `hivra-gvisor-net-${readyClaim.sandboxId}` };
    const complete = async (owner, op, token, observed) => (await one(
      "select public.complete_hivra_managed_gvisor_ready($1,$2,$3,$4,$5::jsonb) as result",
      [owner, ready.computerId, op, token, JSON.stringify(observed)])).result;
    assert.equal(await complete(customer, ready.operationId, readyClaim.claimId, receipt), false);
    assert.equal(await complete(readyOwner, id(99), readyClaim.claimId, receipt), false);
    assert.equal(await complete(readyOwner, ready.operationId, id(99), receipt), false);
    assert.equal(await complete(readyOwner, ready.operationId, readyClaim.claimId, { ...receipt, memoryMb: 1024 }), false);
    assert.equal(await complete(readyOwner, ready.operationId, readyClaim.claimId, { ...receipt, workspace: "foreign" }), false);
    await db.exec("reset role");
    await db.exec("alter table public.hivra_agents add constraint fixture_ready_failure check (user_id <> 'ready-fixture' or status <> 'running')");
    await db.exec("set role service_role");
    await assert.rejects(complete(readyOwner, ready.operationId, readyClaim.claimId, receipt),
      { code: "23514", constraint: "fixture_ready_failure" });
    assert.equal((await one("select running_receipt from public.hivra_managed_gvisor_bindings where computer_id=$1",
      [ready.computerId])).running_receipt, null);
    await db.exec("reset role");
    await db.exec("alter table public.hivra_agents drop constraint fixture_ready_failure");
    await db.exec("set role service_role");
    assert.equal(await complete(readyOwner, ready.operationId, readyClaim.claimId, receipt), true);
    assert.equal(await complete(readyOwner, ready.operationId, readyClaim.claimId, receipt), true);
    assert.equal((await reserve(readyInput)).status, "ready");
    assert.equal((await observe(readyOwner, true)).operatorId, foreignOperator);
    assert.equal(await count(readyOwner), 1);
    assert.equal((await cancel(readyOwner, ready.computerId)).status, "unconfirmed");
    assert.equal((await one("select public.begin_hivra_managed_gvisor_cleanup($1,$2,$3,$4) as result",
      [readyOwner, ready.computerId, ready.operationId, readyClaim.claimId])).result, false);
    const lifecycle = async (owner, action) => (await one(
      "select public.claim_hivra_managed_gvisor_lifecycle($1,$2,$3) as result",
      [owner, ready.computerId, action])).result;
    const finish = async (owner, operation, action, observed) => (await one(
      "select public.complete_hivra_managed_gvisor_lifecycle($1,$2,$3,$4,$5::jsonb) as result",
      [owner, ready.computerId, operation, action, JSON.stringify(observed)])).result;
    await db.exec("set role authenticated");
    await assert.rejects(lifecycle(readyOwner, "stop"), { code: "42501" });
    await assert.rejects(finish(readyOwner, ready.operationId, "stop", receipt), { code: "42501" });
    await db.exec("set role service_role");
    assert.deepEqual(await lifecycle(customer, "stop"), { status: "not_found" });

    await db.exec("reset role");
    await db.query("update public.deployment_targets set evidence_connection_revision=8 where id=$1", [foreignTarget]);
    assert.deepEqual(await lifecycle(readyOwner, "stop"), { status: "authority_changed" });
    await db.query("update public.deployment_targets set evidence_connection_revision=7 where id=$1", [foreignTarget]);
    await db.exec("set role service_role");

    const sleep = await lifecycle(readyOwner, "stop");
    assert.equal(sleep.status, "claimed");
    assert.equal(sleep.operatorId, foreignOperator);
    const stoppedReceipt = { ...receipt, state: "stopped" };
    assert.equal(await finish(customer, sleep.operationId, "stop", stoppedReceipt), null);
    assert.equal(await finish(readyOwner, sleep.operationId, "stop", receipt), null);
    assert.equal(await finish(readyOwner, sleep.operationId, "stop", { ...stoppedReceipt, workspace: "foreign" }), null);
    assert.equal((await finish(readyOwner, sleep.operationId, "stop", stoppedReceipt)).status, "stopped");
    assert.equal((await finish(readyOwner, sleep.operationId, "stop", stoppedReceipt)).status, "stopped");
    assert.equal((await lifecycle(readyOwner, "stop")).status, "settled");
    assert.equal(await observe(readyOwner, true), null, "a stopped sandbox cannot open a terminal");
    assert.equal(await count(readyOwner), 1);

    const [wakeA, wakeB] = await Promise.all([lifecycle(readyOwner, "start"), lifecycle(readyOwner, "start")]);
    assert.deepEqual([wakeA.status, wakeB.status].sort(), ["claimed", "held"]);
    const wake = wakeA.status === "claimed" ? wakeA : wakeB;
    assert.equal(await observe(readyOwner, true), null, "a provisioned sandbox with a held power operation cannot open a terminal");
    assert.equal(await finish(readyOwner, sleep.operationId, "stop", stoppedReceipt), null);
    assert.equal((await lifecycle(readyOwner, "delete")).status, "held");
    assert.equal(await finish(readyOwner, wake.operationId, "start", { ...receipt, sandboxId: id(100) }), null);
    assert.equal((await finish(readyOwner, wake.operationId, "start", receipt)).status, "running");
    assert.equal((await lifecycle(readyOwner, "start")).status, "settled");

    const events = async () => (await db.query(`select event,detail->>'operationId' as operation
      from public.hivra_agent_events where agent_id=$1 and user_id=$2 order by created_at`,
    [ready.computerId, readyOwner])).rows;
    assert.deepEqual(await events(), [
      { event: "stopped", operation: sleep.operationId }, { event: "started", operation: wake.operationId },
    ]);

    const deletion = await lifecycle(readyOwner, "delete");
    assert.equal(deletion.status, "claimed");
    const recoverDelete = await lifecycle(readyOwner, "delete");
    assert.equal(recoverDelete.status, "observe");
    assert.equal(recoverDelete.operationId, deletion.operationId);
    assert.equal(await finish(readyOwner, deletion.operationId, "delete", receipt), null);
    assert.equal(await count(readyOwner), 1);
    assert.equal((await one("select active_target_id from public.hivra_managed_gvisor_bindings where computer_id=$1",
      [ready.computerId])).active_target_id, foreignTarget);
    const gone = { version: 1, state: "absent", computerId: ready.computerId, sandboxId: readyClaim.sandboxId };
    await db.exec("reset role");
    await db.exec("alter table public.hivra_agent_events add constraint fixture_audit_failure check (user_id <> 'ready-fixture' or event <> 'deleted')");
    await db.exec("set role service_role");
    await assert.rejects(finish(readyOwner, deletion.operationId, "delete", gone),
      { code: "23514", constraint: "fixture_audit_failure" });
    assert.equal(await count(readyOwner), 1, "an audit write failure rolls back slot and binding release");
    assert.equal((await lifecycle(readyOwner, "delete")).status, "observe");
    await db.exec("reset role");
    await db.exec("alter table public.hivra_agent_events drop constraint fixture_audit_failure");
    await db.exec("set role service_role");
    assert.equal((await finish(readyOwner, deletion.operationId, "delete", gone)).status, "deleted");
    assert.equal((await finish(readyOwner, deletion.operationId, "delete", gone)).status, "deleted");
    assert.equal((await lifecycle(readyOwner, "delete")).status, "settled");
    assert.equal(await count(readyOwner), 0);
    // Existing activity retention removes this computer's earlier events on delete.
    assert.deepEqual(await events(), [{ event: "deleted", operation: deletion.operationId }]);
    const housing = await one(`select c.user_id,c.observed_state,c.tombstoned_at is not null as tombstoned
      from public.hivra_canonical_source_mappings m join public.hivra_canonical_computers c on c.id=m.computer_id
      where m.source_kind='hivra' and m.source_id=$1`, [ready.computerId]);
    assert.deepEqual(housing, { user_id: readyOwner, observed_state: "missing", tombstoned: true });

    assert.deepEqual(await one(`select target_id,active_target_id,absence_receipt
      from public.hivra_managed_gvisor_bindings where computer_id=$1`, [ready.computerId]),
    { target_id: foreignTarget, active_target_id: null, absence_receipt: gone });
    const budgetInput = { ...readyInput, customer: "budget-fixture", cpuBudget: 0.5, ramBudgetMb: 2048, limit: 2 };
    const budgetResults = await Promise.all([reserve({ ...budgetInput, request: id(101) }),
      reserve({ ...budgetInput, request: id(102) })]);
    assert.deepEqual(budgetResults.map(value => value.status).sort(), ["plan_compute_limit", "reserved"]);
    assert.equal(await count(budgetInput.customer), 1);
    console.log("Managed gVisor migration proof passed: atomic reservation and rollback, exact authority, replay, slot and compute accounting, dispatch/cancellation exclusion, durable ready, one-shot lifecycle, atomic audit, owner terminal authority, and exact absence release.");
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
