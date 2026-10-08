// The attach lifecycle in the database (design 5.1, 5.5 to 5.7; threats T1 to
// T3, T20, T25, T30 and T35). Applies every real migration to an in-memory
// PostgreSQL, applies the two attach migrations a second time, then checks:
// - intent v2: the exact review record, the pinned installer and grant policy,
//   owner-only admission, replay and conflict, one live agent per computer;
// - the plan limit at claim and again at dispatch, which cancels the claim with
//   plan_agent_limit when the owner went over in between;
// - complete only with the readiness observation, publishing the canonical
//   identity, installation and binding and releasing the computer's lease;
// - fail only with an observed cleanup receipt; cancel with its reason;
// - a computer that is not running and ready: the gate says so, and a claim
//   nothing ran for yet is refused as failed with its reason, never held;
// - the contract a revision at a time, delivered only on a matching read-back;
// - change access and Remove as their own operations on the lease, each
//   finished only by its observed receipt;
// - a restore refused while an agent is attached, a computer delete detaching
//   the binding with a computer_deleted receipt, and a pending delete honoured;
// - a step sent to a computer that stopped, or is being deleted, releases the
//   computer's lease without being marked done: Stop and Delete go ahead, the
//   step comes back only once the computer runs again, and deleting the
//   computer ends it (T3);
// - a refusal the computer named ends the install failed with its code after
//   the observed cleanup; a claim is refused for an old gateway or a failed
//   download; a computer that came back changed is taken back to be cleaned
//   up, never continued (T3);
// - the worker's queue, least recently tried first;
// - the operation kinds earlier files allow stay allowed (private_access);
// - EXECUTE exactly for service_role on the functions the routes and worker
//   call, never for public, anon or authenticated, and nothing for the v1
//   admission (read from pg_proc ACLs).
const assert = require("node:assert/strict");
const { openMigratedDatabase, readMigration } = require("./lib/pglite-all-migrations.cjs");

const LIFECYCLE = "20260925100200_hivra_agent_attachment_lifecycle.sql";
const GRANTS = "20260925100300_hivra_agent_attachment_grants.sql";
const READINESS = "20260925100400_hivra_agent_attach_readiness.sql";
const INTERRUPT = "20260925100500_hivra_agent_attach_interrupt.sql";
const REFUSALS = "20260925100600_hivra_agent_attach_refusals.sql";
// Re-pins the lifecycle program after its Remove fix; the only later definition of the activation dispatch.
const PROGRAM_REPIN = "20260925160000_hivra_attached_agent_program_remove_fix.sql";
const OWNER = "owner";
const INSTALLER = "77d72e2e8346cc19ef74264e8458bbca8802772d1c668c3fdffa653c4273d375";
const WORKER = "2a0aee3e5e3fc0d4403d41a93dbece648648c8a84ab4349a71d7fe87243121ab";
// Placeholder ids the public-tree hygiene allows.
const pid = (group, n) => `00000000-0000-4${group}00-8000-${String(n).padStart(12, "0")}`;
const pinned = (sql, parameter) => {
  const match = sql.match(new RegExp(`${parameter} is distinct from '([0-9a-f]{64})'`));
  if (!match) throw new Error(`no pinned ${parameter} in the lifecycle migration`);
  return match[1];
};

async function main() {
  const db = await openMigratedDatabase();
  const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
  const value = async (sql, args = []) => (await one(sql, args))?.result;
  const slots = async () => value("select public.hivra_owner_agent_slot_count($1) as result", [OWNER]);
  const lifecycleSql = readMigration(LIFECYCLE);
  const GRANT_POLICY = pinned(lifecycleSql, "p_intent->>'grantPolicySha256'");
  const SERVICE_POLICY = pinned(lifecycleSql, "p_service_policy_sha256");
  const PROGRAM = pinned(readMigration(PROGRAM_REPIN), "p_program_sha256");
  const PREVIOUS_PROGRAM = pinned(lifecycleSql, "p_program_sha256");
  assert.notEqual(PROGRAM, PREVIOUS_PROGRAM, "the re-pin names a new program");
  try {
    // The attach migrations are idempotent, applied again in order.
    await db.exec(readMigration(LIFECYCLE));
    await db.exec(readMigration(GRANTS));
    await db.exec(readMigration(READINESS));
    await db.exec(readMigration(INTERRUPT));
    await db.exec(readMigration(REFUSALS));
    await db.exec(readMigration(PROGRAM_REPIN));

    let computers = 0;
    const computer = async (mode = "hivra-managed") => {
      computers += 1;
      const id = pid("1", computers);
      await db.query(`insert into public.hivra_agents(id,user_id,type,name,status,desired_state,computer_profile,computer_substrate,
          deployment_mode,proxmox_host,vmid,ip,cpu,ram,infrastructure_binding_token_hash,infrastructure_binding_token_enforced,
          managed_provisioner_channel,provisioned_at,chat_url)
        values($1,$2,'linux-desktop',$3,'running','running','ubuntu-desktop','proxmox-kvm',$4,'local',$5,$6,2,4,repeat('a',64),true,'canary',
          now(),$7)`,
        [id, OWNER, `Desk ${computers}`, mode, 1200 + computers, `10.241.0.${20 + computers}`, `https://desk-${computers}.example.test`]);
      const authority = await value("select public.hivra_desktop_prepare_authority(a) as result from public.hivra_agents a where id=$1", [id]);
      return { id, authority, n: computers };
    };
    const intent = (n, grants = { workspace: true }, extra = {}) => ({
      version: 2, agentIdentityId: pid("2", n), runtimeId: "codex", agentName: "Codex", installerSha256: INSTALLER,
      grants, grantPolicySha256: GRANT_POLICY, reviewSha256: "e".repeat(64), requestId: pid("3", n), ...extra });
    const claim = (c, op, requested, limit = 10, owner = OWNER, expected = c.authority) => value(
      "select public.claim_hivra_agent_attachment($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) as result",
      [owner, c.id, op, pid("4", c.n), JSON.stringify(expected), JSON.stringify(requested), limit]);
    const target = (c, owner = OWNER) => value("select public.read_hivra_agent_attach_target($1,$2) as result", [owner, c.id]);
    const lease = async (c) => one("select operation_id, operation_kind from public.hivra_agents where id=$1", [c.id]);

    // ---- claim (intent v2, owner, replay, one per computer) ---------------
    const desk = await computer();
    const before = await target(desk);
    assert.equal(before.eligible, true);
    assert.equal(before.writeAuthority, "legacy", "no transfer happens until the owner adds an agent");
    assert.equal(await target(desk, "other"), null, "a foreign computer is not readable (T1)");
    const op = pid("5", 1);
    for (const [bad, label] of [
      [intent(1, { workspace: true, chrome: true }), "an unknown grant"],
      [intent(1, { workspace: "yes" }), "a non-boolean grant"],
      [intent(1, undefined, { grantPolicySha256: "0".repeat(64) }), "another grant policy"],
      [intent(1, undefined, { installerSha256: "0".repeat(64) }), "another installer"],
      [intent(1, undefined, { runtimeId: "claude" }), "another runtime"],
      [intent(1, undefined, { agentName: "Line\nbreak" }), "a control character in the name"],
      [intent(1, undefined, { agentName: "x".repeat(61) }), "a name longer than 60"],
      [intent(1, undefined, { reviewSha256: "nope" }), "no review digest"],
      [intent(1, undefined, { version: 1 }), "an intent v1"],
      [{ ...intent(1), command: "anything" }, "an extra key"],
    ]) assert.deepEqual(await claim(desk, op, bad), { status: "invalid_request" }, label);
    assert.deepEqual(await claim(desk, op, intent(1), null), { status: "invalid_request" }, "a missing limit is not unlimited");
    assert.deepEqual(await claim(desk, op, intent(1), 10, "other"), { status: "not_found" }, "the owner comes from auth, never the body (T1)");
    assert.deepEqual(await claim(desk, op, intent(1), 10, OWNER, { ...desk.authority, vmid: 9999 }), { status: "review_changed" },
      "a computer that changed since the review is refused (T25)");
    // The Hivra Cloud desktop itself takes a slot; at that limit Add is refused.
    assert.equal(await slots(), 1);
    assert.deepEqual(await claim(desk, op, intent(1), 1), { status: "plan_agent_limit", activeCount: 1, limit: 1 },
      "the plan limit is enforced inside the claim (T35)");
    assert.equal(await value("select count(*)::int as result from public.hivra_agent_attachments"), 0, "a refusal writes nothing");
    const claimed = await claim(desk, op, intent(1));
    assert.equal(claimed.status, "claimed");
    assert.equal(claimed.resumed, false);
    assert.equal((await target(desk)).writeAuthority, "canonical", "the claim transferred relationship authority once");
    assert.equal((await target(desk)).reason, "agent_present");
    assert.deepEqual(await claim(desk, op, intent(1)), { ...claimed, resumed: true }, "an exact replay is the same claim (T2)");
    assert.deepEqual(await claim(desk, op, intent(1, { workspace: false })), { status: "conflict" },
      "the same request id with another review is refused (T20)");
    assert.deepEqual(await claim(desk, pid("5", 2), intent(2)), { status: "agent_present" }, "one agent per computer");
    assert.equal(await slots(), 2, "a claimed attachment on Hivra Cloud takes a slot");
    assert.deepEqual(await lease(desk), { operation_id: op, operation_kind: "agent_attach" });
    const stored = await one("select agent_limit, grants, review_sha256, intent from public.hivra_agent_attachments where id=$1", [op]);
    assert.deepEqual(stored, { agent_limit: 10, grants: { workspace: true }, review_sha256: "e".repeat(64), intent: intent(1) },
      "the review record is kept with the claim (5.7)");

    // ---- dispatch v2 cancels a claim that went over the plan (T35) --------
    const reserve = (operation, n) => value("select public.reserve_hivra_attachment_installation($1,$2,2,$3,$4,'x86_64') as result",
      [OWNER, operation, pid("6", n), pid("7", n)]);
    const boot = pid("8", 1);
    const observe = (c, operation) => value("select public.observe_hivra_attachment_guest($1,$2,2,$3::jsonb,$4,$5) as result",
      [OWNER, operation, JSON.stringify(c.authority), boot, WORKER]);
    const dispatch = (c, operation, dispatchId) => value(
      "select public.dispatch_hivra_agent_attachment_v2($1,$2,$3,2,$4::jsonb,$5) as result",
      [OWNER, operation, dispatchId, JSON.stringify(c.authority), INSTALLER]);
    const over = await computer();
    const overOp = pid("5", 3);
    assert.equal((await claim(over, overOp, intent(3), 4)).status, "claimed", "two computers and one claim fit a limit of 4");
    assert.equal(await reserve(overOp, 3), true);
    assert.equal(await observe(over, overOp), true);
    await db.query(`insert into public.hermes_instances(id,user_id,name,status,lifecycle_state,cpu_limit,ram_limit)
      values($1,$2,'Legacy','running','active',1,1024)`, [pid("9", 1), OWNER]);
    assert.equal(await dispatch(over, overOp, pid("a", 1)), false, "an owner over the limit at dispatch is not dispatched");
    assert.deepEqual(await one("select phase, end_reason from public.hivra_agent_attachments where id=$1", [overOp]),
      { phase: "cancelled", end_reason: "plan_agent_limit" });
    assert.deepEqual(await lease(over), { operation_id: null, operation_kind: null }, "the cancel released the computer's lease");
    assert.equal(await value("select count(*)::int as result from public.hivra_agent_attachment_dispatches where operation_id=$1", [overOp]), 0);
    await db.query("delete from public.hermes_instances where id=$1", [pid("9", 1)]);
    for (const fn of ["claim_hivra_agent_attachment(text,uuid,uuid,uuid,jsonb,jsonb,integer)",
      "dispatch_hivra_agent_attachment_v2(text,uuid,uuid,bigint,jsonb,text)"]) {
      const def = await value(`select pg_get_functiondef('public.${fn}'::regprocedure) as result`);
      assert.ok(def.indexOf("lock_hivra_owner_agent_slots") > 0 && def.indexOf("lock_hivra_owner_agent_slots") < def.indexOf("hivra_owner_agent_slot_count"),
        `${fn} locks the owner's slots before it counts`);
    }

    // ---- the happy path: dispatch, stage, activate, ready, complete --------
    assert.equal(await reserve(op, 1), true);
    assert.equal(await observe(desk, op), true);
    const dispatchId = pid("a", 2);
    assert.equal(await dispatch(desk, op, dispatchId), true);
    assert.equal(await dispatch(desk, op, dispatchId), false, "a lost acknowledgement never dispatches twice (T2)");
    const snapshot = await value("select public.read_hivra_attachment_execution($1,$2) as result", [OWNER, op]);
    const installation = pid("6", 1), binding = pid("7", 1);
    const staged = { version: 1, phase: "staged", bootId: boot, identity: { operationId: op, dispatchId, installationId: installation,
      bindingId: binding, computerId: snapshot.computerId, sourceId: desk.id, architecture: "x86_64" },
    receipt: { version: 1, state: "staged", operationId: op, installationId: installation, runtimeId: "codex", runtimeVersion: "0.149.1",
      architecture: "x86_64", archiveSha256: "e24fb784c7d71140d67afb620f56e9137496cf7f6c9e19217fa3666dcf306278",
      binarySha256: "73dc5888888f411c1f0fa7b81d866e721dcc86b527ce8e3b2cf4708661e823ba", uid: 996, gid: 988,
      account: "hva_" + installation.replaceAll("-", "").slice(0, 24), home: "/var/lib/hivra/agent-homes/" + installation,
      executable: "/opt/hivra/agent-installations/" + installation + "/codex" } };
    assert.equal(await value("select public.record_hivra_attachment_staging_result($1,$2,2,$3::jsonb,$4,$5::jsonb) as result",
      [OWNER, op, JSON.stringify(desk.authority), boot, JSON.stringify(staged)]), true);
    const token = "f".repeat(64), activationId = pid("b", 1), definition = "d".repeat(64);
    const activate = (changes = {}) => {
      const p = { owner: OWNER, policy: SERVICE_POLICY, program: PROGRAM, token, activation: activationId, ...changes };
      return value(`select public.dispatch_hivra_attachment_activation_v2($1,$2,$3,2,$4::jsonb,$5,$6::jsonb,$7,$8,$9,$10) as result`,
        [p.owner, op, p.activation, JSON.stringify(desk.authority), boot, JSON.stringify(staged), p.policy, p.program, definition, p.token]);
    };
    for (const change of [{ owner: "other" }, { policy: "0".repeat(64) }, { program: "0".repeat(64) }, { program: PREVIOUS_PROGRAM },
      { token: "short" }]) {
      assert.equal(await activate(change), false, "an unbound or unpinned activation is refused");
    }
    assert.equal(await activate(), true);
    assert.equal(await activate(), false, "one activation per attach");
    assert.equal(await value("select public.read_hivra_attachment_instance_token($1,$2) as result", [OWNER, op]), token);
    assert.equal(await value("select public.read_hivra_attachment_instance_token($1,$2) as result", ["other", op]), null);
    const request = await value("select public.read_hivra_attachment_activation($1,$2) as result", [OWNER, op]);
    assert.equal(request.version, 2);
    assert.equal(request.programSha256, PROGRAM);
    assert.deepEqual(request.grants, { workspace: true });
    const observation = (id, state) => value(`select public.record_hivra_attachment_activation_observation($1,$2,2,$3::jsonb,$4::jsonb,$5,$6::jsonb) as result`,
      [OWNER, op, JSON.stringify(desk.authority), JSON.stringify(request), id, JSON.stringify({ version: 1, state, journalPhase: "service_started",
        operationId: op, activationId, installationId: installation, bootId: boot, serviceDefinitionSha256: definition, mainPid: 4242 })]);
    const complete = (observationId, owner = OWNER) => value(
      "select public.complete_hivra_agent_attachment($1,$2,2,$3::jsonb,$4) as result", [owner, op, JSON.stringify(desk.authority), observationId]);
    assert.equal(await observation(pid("c", 1), "process_running"), true);
    assert.equal(await complete(pid("c", 1)), false, "a running process is not Chat ready");
    assert.equal(await complete(pid("c", 9)), false, "an unknown observation completes nothing");
    assert.equal(await observation(pid("c", 2), "native_protocol_available"), true);
    assert.equal(await complete(pid("c", 2), "other"), false, "another owner cannot complete it (T1)");
    // Contract rev 1 is recorded while the attach is dispatched.
    const content = "<!-- HIVRA:COMPUTER:START v1 rev=1 -->\nblock\n<!-- HIVRA:COMPUTER:END -->";
    const contentSha = await value("select encode(sha256(convert_to($1,'UTF8')),'hex') as result", [content]);
    const recordContract = (revision, readback, fileSha = "1".repeat(64), grants = { workspace: true }, text = content, sha = contentSha) => value(
      "select public.record_hivra_attachment_contract($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) as result",
      [OWNER, op, revision, text, sha, fileSha, JSON.stringify(grants), readback === null ? null : JSON.stringify(readback)]);
    assert.equal(await recordContract(1, null, "1".repeat(64), { workspace: true }, content, "0".repeat(64)), false,
      "a content digest that does not match the content is refused");
    assert.equal(await recordContract(1, { sha256: "2".repeat(64), checked: true }), true);
    assert.equal(await value("select delivered_at is null as result from public.hivra_agent_attachment_contracts where attachment_id=$1 and revision=1", [op]),
      true, "a read-back of other bytes is never delivered (T33)");
    assert.equal(await recordContract(1, { sha256: "1".repeat(64), checked: false }), true);
    assert.equal(await value("select delivered_at is null as result from public.hivra_agent_attachment_contracts where attachment_id=$1 and revision=1", [op]),
      true, "a read-back missing inside the unit is never delivered (T33)");
    assert.equal(await recordContract(1, { sha256: "1".repeat(64), checked: true }), true);
    assert.equal(await value("select delivered_at is not null as result from public.hivra_agent_attachment_contracts where attachment_id=$1 and revision=1", [op]),
      true, "a matching root read-back on the host and in the unit is delivered");
    assert.equal(await complete(pid("c", 2)), true);
    assert.equal(await complete(pid("c", 2)), true, "an exact replay of completion is harmless");
    assert.deepEqual(await lease(desk), { operation_id: null, operation_kind: null }, "completion released the lease");
    assert.equal(await value("select phase as result from public.hivra_agent_attachments where id=$1", [op]), "attached");
    assert.deepEqual(await one(`select i.status as identity, r.status as installation, b.status as binding
      from public.hivra_canonical_agent_identities i, public.hivra_canonical_runtime_installations r, public.hivra_canonical_primary_bindings b
      where i.id=$1 and r.id=$2 and b.id=$3`, [pid("2", 1), installation, binding]),
    { identity: "active", installation: "ready", binding: "active" }, "the canonical identity, installation and binding are published");
    assert.equal(await slots(), 3, "an attached agent on Hivra Cloud keeps its slot (two computers and one agent)");
    const listed = await value("select public.read_hivra_agent_attachments($1,$2) as result", [OWNER, desk.id]);
    assert.equal(listed[0].phase, "attached");
    assert.ok(listed[0].receipts.accepted && listed[0].receipts.staged && listed[0].receipts.started && listed[0].receipts.chatReady,
      "every progress line has its receipt");
    assert.equal(listed[0].contract.revision, 1);
    assert.deepEqual(await value("select public.read_hivra_agent_attachments($1,$2) as result", ["other", desk.id]), []);
    const agents = await value("select public.read_hivra_owner_attached_agents($1) as result", [OWNER]);
    assert.deepEqual(agents.map((row) => [row.agentName, row.computerName, row.phase]), [["Codex", "Desk 1", "attached"]]);

    // ---- a restore is refused while an agent is attached (T25, T26) --------
    await assert.rejects(() => value(`select public.claim_hivra_agent_operation($1,$2,$3,'restore','stopped',$4::jsonb) as result`,
      [OWNER, desk.id, pid("d", 1), JSON.stringify({ snapshotId: pid("d", 2), providerSnapshotId: "hivra_" + pid("d", 2).replaceAll("-", "") })]),
    { code: "55000" }, "Remove Codex first");

    // ---- change access -------------------------------------------------------
    const begin = (kind, operation, grants, owner = OWNER, expected = desk.authority) => value(
      "select public.begin_hivra_agent_attachment_operation($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) as result",
      [owner, op, operation, kind, JSON.stringify(expected), JSON.stringify(grants), "c".repeat(64)]);
    assert.deepEqual(await begin("access_change", pid("e", 1), { workspace: true }), { status: "unchanged" });
    assert.deepEqual(await begin("access_change", pid("e", 1), { workspace: false }, "other"), { status: "not_found" });
    assert.deepEqual(await begin("detach", pid("e", 1), { workspace: false }), { status: "review_changed" },
      "a Remove names the grants the agent has");
    const access = pid("e", 1);
    assert.equal((await begin("access_change", access, { workspace: false })).status, "claimed");
    assert.deepEqual(await lease(desk), { operation_id: access, operation_kind: "agent_access_change" });
    await assert.rejects(() => db.query("update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null where id=$1",
      [desk.id]), { code: "55000" }, "only the step's own record releases the lease (T3)");
    assert.equal((await begin("detach", pid("e", 2), { workspace: true })).status, "computer_busy", "one step at a time");
    const dispatchOp = (operation) => value("select public.dispatch_hivra_agent_attachment_operation($1,$2) as result", [OWNER, operation]);
    const completeOp = (operation, receipt) => value("select public.complete_hivra_agent_attachment_operation($1,$2,$3::jsonb) as result",
      [OWNER, operation, JSON.stringify(receipt)]);
    const failOp = (operation, code, receipt) => value("select public.fail_hivra_agent_attachment_operation($1,$2,$3,$4::jsonb) as result",
      [OWNER, operation, code, JSON.stringify(receipt)]);
    const ready = { version: 1, operationId: access, installationId: installation, state: "ready", grants: { workspace: false }, viewMounted: false };
    assert.equal(await completeOp(access, ready), false, "a step that was never dispatched cannot complete");
    assert.equal(await dispatchOp(access), true);
    assert.equal(await dispatchOp(access), false);
    assert.equal(await completeOp(access, { ...ready, viewMounted: true }), false, "a view that does not match the new grant is not done");
    assert.equal(await completeOp(access, { ...ready, installationId: pid("6", 9) }), false);
    assert.equal(await completeOp(access, ready), true);
    assert.equal(await completeOp(access, ready), true, "an exact replay is harmless");
    assert.deepEqual(await value("select grants as result from public.hivra_agent_attachments where id=$1", [op]), { workspace: false });
    assert.deepEqual(await lease(desk), { operation_id: null, operation_kind: null });
    // A change that could not finish and was put back.
    const back = pid("e", 3);
    assert.equal((await begin("access_change", back, { workspace: true })).status, "claimed");
    assert.equal(await dispatchOp(back), true);
    assert.equal(await failOp(back, "chat_not_ready", { version: 1, operationId: back, state: "restored", viewMounted: true }), false,
      "a put-back must be observed in the current grant");
    assert.equal(await failOp(back, "chat_not_ready", { version: 1, operationId: back, state: "restored", viewMounted: false }), true);
    assert.deepEqual(await value("select grants as result from public.hivra_agent_attachments where id=$1", [op]), { workspace: false });
    // A Remove the computer refused ends failed with its reason, frees the
    // computer and leaves the agent attached, to be removed again (T3).
    const refusedRemove = pid("e", 9);
    assert.equal((await begin("detach", refusedRemove, { workspace: false })).status, "claimed");
    assert.equal(await dispatchOp(refusedRemove), true);
    assert.equal(await failOp(refusedRemove, "detach_mount_found", { version: 1, operationId: refusedRemove, installationId: installation,
      state: "refused", reason: "detach_mount_found" }), true);
    assert.deepEqual(await one("select phase, failure_code from public.hivra_agent_attachment_operations where id=$1", [refusedRemove]),
      { phase: "failed", failure_code: "detach_mount_found" });
    assert.equal(await value("select phase as result from public.hivra_agent_attachments where id=$1", [op]), "attached");
    assert.deepEqual(await lease(desk), { operation_id: null, operation_kind: null });
    // A step on a stopped computer is refused before anything is claimed.
    await db.query("update public.hivra_agents set status='stopped',desired_state='stopped' where id=$1", [desk.id]);
    assert.deepEqual(await begin("detach", pid("e", 4), { workspace: false }), { status: "computer_not_running" });
    await db.query("update public.hivra_agents set status='running',desired_state='running' where id=$1", [desk.id]);

    // ---- Remove ---------------------------------------------------------------
    const detach = pid("e", 5);
    assert.equal((await begin("detach", detach, { workspace: false })).status, "claimed");
    assert.equal(await dispatchOp(detach), true);
    const removed = { version: 1, operationId: detach, installationId: installation, state: "removed", workspaceTouched: false,
      viewUnmounted: true, networkRemoved: true, unitsRemoved: true, homeRemoved: true, accountRemoved: true, stagingCleared: true, leftoverFiles: 0 };
    for (const missing of ["viewUnmounted", "networkRemoved", "unitsRemoved", "homeRemoved", "accountRemoved", "stagingCleared"]) {
      assert.equal(await completeOp(detach, { ...removed, [missing]: false }), false, `a Remove without ${missing} is not done (T23)`);
    }
    assert.equal(await completeOp(detach, { ...removed, leftoverFiles: 1 }), false, "leftover files hold the Remove for review");
    assert.equal(await completeOp(detach, { ...removed, workspaceTouched: true }), false);
    assert.equal(await completeOp(detach, removed), true);
    assert.deepEqual(await one("select phase, end_reason from public.hivra_agent_attachments where id=$1", [op]),
      { phase: "detached", end_reason: "removed" });
    assert.deepEqual(await one(`select b.status as binding, r.status as installation, i.status as identity
      from public.hivra_canonical_primary_bindings b, public.hivra_canonical_runtime_installations r, public.hivra_canonical_agent_identities i
      where b.id=$1 and r.id=$2 and i.id=$3`, [binding, installation, pid("2", 1)]),
    { binding: "detached", installation: "removed", identity: "active" }, "the identity is kept, unbound");
    assert.equal(await slots(), 2, "Remove frees the slot");
    assert.equal((await target(desk)).eligible, true, "a new agent can be added after Remove");
    assert.equal(await value("select public.read_hivra_attachment_instance_token($1,$2) as result", [OWNER, op]), null,
      "a removed agent's token is never read again");

    // ---- fail with a cleanup receipt, and cancel with a reason ------------
    const fdesk = await computer();
    const fop = pid("5", 4);
    assert.equal((await claim(fdesk, fop, intent(4))).status, "claimed");
    assert.equal(await reserve(fop, 4), true);
    assert.equal(await observe(fdesk, fop), true);
    assert.equal(await dispatch(fdesk, fop, pid("a", 4)), true);
    const fail = (cleanup, code = "install_failed") => value("select public.fail_hivra_agent_attachment($1,$2,2,$3::jsonb,$4::jsonb,$5) as result",
      [OWNER, fop, JSON.stringify(fdesk.authority), JSON.stringify(cleanup), code]);
    const cleanup = { version: 1, state: "removed", operationId: pid("f", 1), installationId: pid("6", 4), workspaceTouched: false };
    assert.equal(await fail({ ...cleanup, state: "unresolved" }), false, "an uncertain cleanup keeps the attach held (5.5)");
    assert.equal(await fail({ ...cleanup, installationId: pid("6", 9) }), false);
    assert.equal(await fail(cleanup, "computer_update_required"), true);
    assert.deepEqual(await one("select phase, end_reason, failure_code from public.hivra_agent_attachments where id=$1", [fop]),
      { phase: "failed", end_reason: "install_failed", failure_code: "computer_update_required" },
    "a refusal the computer named is kept with the failure");
    assert.equal((await value("select public.read_hivra_agent_attachments($1,$2) as result", [OWNER, fdesk.id]))[0].failureCode,
      "computer_update_required", "the computer page reads why it failed");
    assert.equal(await fail(cleanup, "other_code"), true, "a replay after the failure is harmless and rewrites nothing");
    assert.equal(await value("select failure_code as result from public.hivra_agent_attachments where id=$1", [fop]), "computer_update_required");
    await assert.rejects(db.query("update public.hivra_agent_attachments set failure_code='Not A Code' where id=$1", [fop]),
      /hivra_agent_attachments_failure_code_check/);
    assert.deepEqual(await lease(fdesk), { operation_id: null, operation_kind: null });
    const cop = pid("5", 5);
    assert.equal((await claim(fdesk, cop, intent(5))).status, "claimed");
    assert.equal(await value("select public.cancel_hivra_agent_attachment($1,$2,'whatever') as result", [OWNER, cop]), false);
    assert.equal(await value("select public.cancel_hivra_agent_attachment($1,$2,'cancelled') as result", ["other", cop]), false);
    // A pending delete is honoured: the claim is cancelled with that reason.
    assert.equal(await value("select public.request_hivra_agent_delete($1,$2,$3) as result", [OWNER, fdesk.id, pid("d", 3)]), "pending");
    assert.equal(await dispatch(fdesk, cop, pid("a", 5)), false, "a pending delete blocks dispatch (T3)");
    assert.equal(await value("select public.cancel_hivra_agent_attachment($1,$2,'pending_delete') as result", [OWNER, cop]), true);
    assert.deepEqual(await one("select phase, end_reason from public.hivra_agent_attachments where id=$1", [cop]),
      { phase: "cancelled", end_reason: "pending_delete" });

    // ---- running and ready, or refused as failed with its reason ------------
    const rdesk = await computer();
    await db.query("update public.hivra_agents set provisioned_at=null where id=$1", [rdesk.id]);
    assert.equal((await target(rdesk)).reason, "computer_not_ready", "a computer Hivra has not seen ready is not offered");
    await db.query("update public.hivra_agents set provisioned_at=now(),chat_url=' ' where id=$1", [rdesk.id]);
    assert.equal((await target(rdesk)).reason, "computer_not_ready", "no gateway for the agent's chat is not ready either");
    await db.query("update public.hivra_agents set chat_url='https://desk-ready.example.test' where id=$1", [rdesk.id]);
    rdesk.authority = await value("select public.hivra_desktop_prepare_authority(a) as result from public.hivra_agents a where id=$1", [rdesk.id]);
    assert.equal((await target(rdesk)).eligible, true);
    const rop = pid("5", 7);
    assert.equal((await claim(rdesk, rop, intent(7))).status, "claimed");
    const refuse = (operation, reason, owner = OWNER) => value("select public.refuse_hivra_agent_attachment($1,$2,$3) as result",
      [owner, operation, reason]);
    assert.equal((await value("select public.read_hivra_agent_attachment_state($1,$2) as result", [OWNER, rop])).createdAt !== undefined, true,
      "the worker reads when the claim was made");
    assert.equal(await refuse(rop, "install_failed"), false, "only a precondition is a refusal");
    assert.equal(await refuse(rop, "computer_not_ready", "other"), false, "the owner comes from the claim");
    assert.equal(await refuse(rop, "computer_not_ready"), true);
    assert.deepEqual(await one("select phase, end_reason, dispatch_id from public.hivra_agent_attachments where id=$1", [rop]),
      { phase: "failed", end_reason: "computer_not_ready", dispatch_id: null }, "a refusal ends failed with its reason, never held");
    assert.deepEqual(await lease(rdesk), { operation_id: null, operation_kind: null }, "the refusal released the computer's lease");
    assert.equal(await refuse(rop, "computer_not_ready"), true, "a replay of the same refusal is the same answer");
    assert.equal(await refuse(rop, "computer_not_running"), false, "a refusal is never rewritten");
    assert.equal((await target(rdesk)).eligible, true, "a refused claim leaves the computer free to try again");
    for (const [n, reason] of [[11, "computer_update_required"], [12, "download_failed"]]) {
      const claimOp = pid("5", n);
      assert.equal((await claim(rdesk, claimOp, intent(n))).status, "claimed");
      assert.equal(await refuse(claimOp, reason), true, `a claim nothing ran for ends failed with ${reason}`);
      assert.deepEqual(await one("select phase, end_reason, dispatch_id from public.hivra_agent_attachments where id=$1", [claimOp]),
        { phase: "failed", end_reason: reason, dispatch_id: null });
      assert.deepEqual(await lease(rdesk), { operation_id: null, operation_kind: null });
    }
    const rop2 = pid("5", 8);
    assert.equal((await claim(rdesk, rop2, intent(8))).status, "claimed");
    assert.equal(await reserve(rop2, 8), true);
    assert.equal(await observe(rdesk, rop2), true);
    assert.equal(await dispatch(rdesk, rop2, pid("a", 8)), true);
    assert.equal(await refuse(rop2, "computer_not_running"), false, "a dispatched install is never refused: it needs an observed cleanup");
    assert.equal(await value("select public.fail_hivra_agent_attachment($1,$2,2,$3::jsonb,$4::jsonb,'install_failed') as result",
      [OWNER, rop2, JSON.stringify(rdesk.authority), JSON.stringify({ ...cleanup, installationId: pid("6", 8) })]), true);
    await assert.rejects(db.query(`update public.hivra_agent_attachments set phase='failed',completed_at=now(),end_reason='install_failed',
        dispatch_id=null,dispatched_at=null where id=$1`, [rop]), /hivra_agent_attachments_check/,
    "a failure without a dispatch is only a precondition refusal");

    // ---- the operation kinds earlier files allow stay allowed ---------------
    await db.query("update public.hivra_agents set operation_id=$2,operation_kind='private_access',operation_started_at=now() where id=$1",
      [rdesk.id, pid("d", 7)]);
    await db.query("update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null where id=$1", [rdesk.id]);

    // ---- a step sent to a computer that stopped: the computer is freed (T3) --
    const interrupt = (kind, id, reason, owner = OWNER) => value(
      "select public.interrupt_hivra_agent_attachment_step($1,$2,$3,$4) as result", [owner, kind, id, reason]);
    const resume = (kind, id, owner = OWNER) => value(
      "select public.resume_hivra_agent_attachment_step($1,$2,$3) as result", [owner, kind, id]);
    const stepRow = (id) => one("select phase, end_reason, lease_released, interrupt_reason from public.hivra_agent_attachments where id=$1", [id]);
    const sdesk = await computer();
    const sop = pid("5", 9);
    assert.equal((await claim(sdesk, sop, intent(9))).status, "claimed");
    assert.equal(await interrupt("attach", sop, "computer_not_running"), false, "a claim nothing was sent for is refused or cancelled instead");
    assert.equal(await reserve(sop, 9), true);
    assert.equal(await observe(sdesk, sop), true);
    assert.equal(await dispatch(sdesk, sop, pid("a", 9)), true);
    assert.equal(await interrupt("attach", sop, "pending_delete"), false, "no delete is pending");
    assert.equal(await interrupt("attach", sop, "computer_not_running", "other"), false, "the owner comes from the step");
    assert.equal(await interrupt("attach", sop, "other_reason"), false);
    assert.equal(await interrupt("attach", sop, "computer_not_running"), true);
    assert.equal(await interrupt("attach", sop, "computer_not_running"), true, "a replay of the same interruption is the same answer");
    assert.equal(await interrupt("attach", sop, "pending_delete"), false, "an interruption is never rewritten");
    assert.deepEqual(await lease(sdesk), { operation_id: null, operation_kind: null }, "the computer is free again");
    assert.deepEqual(await stepRow(sop), { phase: "dispatched", end_reason: null, lease_released: true, interrupt_reason: "computer_not_running" },
      "the step stays open: nothing is marked done or failed without evidence");
    assert.equal((await target(sdesk)).reason, "agent_present", "no second agent while the first may still be on the computer");
    // The owner can stop the computer now; the step does not come back meanwhile.
    const stopOp = pid("d", 8);
    assert.equal(await value("select public.claim_hivra_agent_operation($1,$2,$3,'stop','stopped',null) as result", [OWNER, sdesk.id, stopOp]), true,
      "Stop is no longer refused");
    assert.equal(await resume("attach", sop), false, "the lease is not taken back while another step holds the computer");
    assert.equal(await value("select public.complete_hivra_agent_operation($1,$2,$3,'stopped','stopped',null,null) as result",
      [OWNER, sdesk.id, stopOp]), true);
    assert.equal(await resume("attach", sop), false, "nor while the computer is stopped");
    await db.query("update public.hivra_agents set status='running',desired_state='running' where id=$1", [sdesk.id]);
    assert.equal(await resume("attach", sop, "other"), false);
    assert.equal(await resume("attach", sop), true, "running again: the step takes the lease back to clean up");
    assert.equal(await resume("attach", sop), true, "a replay after the lease came back is the same answer");
    assert.deepEqual(await lease(sdesk), { operation_id: sop, operation_kind: "agent_attach" });
    await assert.rejects(() => db.query("update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null where id=$1",
      [sdesk.id]), { code: "55000" }, "once taken back, only the step's own record releases the lease");
    await assert.rejects(() => db.query("update public.hivra_agent_attachments set phase='attached',completed_at=now() where id=$1", [sop]),
      /hivra_agent_attachments_interrupt_check/, "an install the computer stopped under is never finished");
    assert.equal(await value("select public.fail_hivra_agent_attachment($1,$2,2,$3::jsonb,$4::jsonb,'computer_stopped') as result",
      [OWNER, sop, JSON.stringify(sdesk.authority), JSON.stringify({ ...cleanup, installationId: pid("6", 9) })]), true,
    "it ends only with an observed cleanup");
    assert.deepEqual(await stepRow(sop), { phase: "failed", end_reason: "install_failed", lease_released: false, interrupt_reason: "computer_not_running" });
    assert.deepEqual(await lease(sdesk), { operation_id: null, operation_kind: null });

    // ---- a computer that came back changed is taken back to be cleaned up ----
    const cdesk = await computer();
    const chop = pid("5", 13);
    assert.equal((await claim(cdesk, chop, intent(13))).status, "claimed");
    assert.equal(await reserve(chop, 13), true);
    assert.equal(await observe(cdesk, chop), true);
    assert.equal(await dispatch(cdesk, chop, pid("a", 13)), true);
    assert.equal(await interrupt("attach", chop, "computer_not_running"), true);
    // Stopped, then started again on a new address (a restore or a move changes it too).
    await db.query("update public.hivra_agents set ip='10.241.9.9' where id=$1", [cdesk.id]);
    assert.notDeepEqual(await value("select public.hivra_desktop_prepare_authority(a) as result from public.hivra_agents a where id=$1", [cdesk.id]),
      cdesk.authority, "the computer's authority changed while the step waited");
    assert.equal(await resume("attach", chop), true, "running and free again: the step takes it back, even changed");
    assert.deepEqual(await lease(cdesk), { operation_id: chop, operation_kind: "agent_attach" });
    assert.deepEqual(await stepRow(chop), { phase: "dispatched", end_reason: null, lease_released: false, interrupt_reason: "computer_changed" },
      "marked computer_changed: it is removed, never continued");
    await assert.rejects(() => db.query("update public.hivra_agent_attachments set phase='attached',completed_at=now() where id=$1", [chop]),
      /hivra_agent_attachments_interrupt_check/, "an install on a computer that changed is never finished");
    assert.equal(await value("select public.fail_hivra_agent_attachment($1,$2,2,$3::jsonb,$4::jsonb,'computer_changed') as result",
      [OWNER, chop, JSON.stringify(cdesk.authority), JSON.stringify({ ...cleanup, installationId: pid("6", 13) })]), true);
    assert.deepEqual(await one("select phase, end_reason, failure_code from public.hivra_agent_attachments where id=$1", [chop]),
      { phase: "failed", end_reason: "install_failed", failure_code: "computer_changed" });
    assert.deepEqual(await lease(cdesk), { operation_id: null, operation_kind: null }, "the computer is free and has no plan slot held");
    assert.equal((await target(cdesk)).reason, null, "and Codex can be added again");

    // ---- a delete that is pending wins over a step in flight (T3) ------------
    const xdesk = await computer();
    const xop = pid("5", 10);
    assert.equal((await claim(xdesk, xop, intent(10))).status, "claimed");
    assert.equal(await reserve(xop, 10), true);
    assert.equal(await observe(xdesk, xop), true);
    assert.equal(await dispatch(xdesk, xop, pid("a", 10)), true);
    assert.equal(await value("select public.request_hivra_agent_delete($1,$2,$3) as result", [OWNER, xdesk.id, pid("d", 9)]), "pending",
      "a delete never steals the lease of a step in flight");
    assert.equal(await interrupt("attach", xop, "pending_delete"), true, "the worker releases the computer to the delete");
    assert.equal(await resume("attach", xop), false, "a computer being deleted is never taken back");
    assert.equal(await value("select public.request_hivra_agent_delete($1,$2,$3) as result", [OWNER, xdesk.id, pid("d", 9)]), "claimed",
      "the owner's delete goes ahead");
    await db.query(`update public.hivra_agents set status='deleted',operation_id=null,operation_kind=null,operation_started_at=null,
      operation_payload=null where id=$1`, [xdesk.id]);
    assert.deepEqual(await stepRow(xop), { phase: "failed", end_reason: "computer_deleted", lease_released: false, interrupt_reason: "pending_delete" },
      "the step ends with the computer");
    assert.deepEqual(await value("select public.list_open_hivra_agent_attachment_work(20) as result"), [], "nothing of it is picked up again");

    // ---- deleting the computer detaches its binding (T30) -----------------
    const ddesk = await computer();
    const dop = pid("5", 6);
    assert.equal((await claim(ddesk, dop, intent(6))).status, "claimed");
    assert.equal(await reserve(dop, 6), true);
    assert.equal(await observe(ddesk, dop), true);
    assert.equal(await dispatch(ddesk, dop, pid("a", 6)), true);
    const dsnapshot = await value("select public.read_hivra_attachment_execution($1,$2) as result", [OWNER, dop]);
    const dstaged = { ...staged, identity: { ...staged.identity, operationId: dop, dispatchId: pid("a", 6), installationId: pid("6", 6),
      bindingId: pid("7", 6), computerId: dsnapshot.computerId, sourceId: ddesk.id },
    receipt: { ...staged.receipt, operationId: dop, installationId: pid("6", 6), account: "hva_" + pid("6", 6).replaceAll("-", "").slice(0, 24),
      home: "/var/lib/hivra/agent-homes/" + pid("6", 6), executable: "/opt/hivra/agent-installations/" + pid("6", 6) + "/codex" } };
    assert.equal(await value("select public.record_hivra_attachment_staging_result($1,$2,2,$3::jsonb,$4,$5::jsonb) as result",
      [OWNER, dop, JSON.stringify(ddesk.authority), boot, JSON.stringify(dstaged)]), true);
    assert.equal(await value(`select public.dispatch_hivra_attachment_activation_v2($1,$2,$3,2,$4::jsonb,$5,$6::jsonb,$7,$8,$9,$10) as result`,
      [OWNER, dop, pid("b", 6), JSON.stringify(ddesk.authority), boot, JSON.stringify(dstaged), SERVICE_POLICY, PROGRAM, definition, token]), true);
    const drequest = await value("select public.read_hivra_attachment_activation($1,$2) as result", [OWNER, dop]);
    assert.equal(await value(`select public.record_hivra_attachment_activation_observation($1,$2,2,$3::jsonb,$4::jsonb,$5,$6::jsonb) as result`,
      [OWNER, dop, JSON.stringify(ddesk.authority), JSON.stringify(drequest), pid("c", 6), JSON.stringify({ version: 1, state: "native_protocol_available",
        journalPhase: "service_started", operationId: dop, activationId: pid("b", 6), installationId: pid("6", 6), bootId: boot,
        serviceDefinitionSha256: definition, mainPid: 4343 })]), true);
    const dstate = await value("select public.read_hivra_agent_attachment_state($1,$2) as result", [OWNER, dop]);
    assert.ok(dstate.dispatchedAt && dstate.activationDispatchedAt && Date.parse(dstate.activationDispatchedAt) >= Date.parse(dstate.dispatchedAt),
      "the worker reads when the stage and the activation were sent, from the database clock");
    assert.equal(await value("select public.complete_hivra_agent_attachment($1,$2,2,$3::jsonb,$4) as result",
      [OWNER, dop, JSON.stringify(ddesk.authority), pid("c", 6)]), true);
    // A Remove the computer stopped under frees the computer, comes back when
    // it runs again, and ends with the computer when it is deleted.
    const dremove = pid("e", 6);
    const dbegin = (kind, operation, grants) => value("select public.begin_hivra_agent_attachment_operation($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7) as result",
      [OWNER, dop, operation, kind, JSON.stringify(ddesk.authority), JSON.stringify(grants), "c".repeat(64)]);
    assert.equal((await dbegin("detach", dremove, { workspace: true })).status, "claimed");
    assert.equal(await interrupt("detach", dremove, "computer_not_running"), false, "a Remove that was never sent is cancelled instead");
    assert.equal(await value("select public.dispatch_hivra_agent_attachment_operation($1,$2) as result", [OWNER, dremove]), true);
    assert.equal(await interrupt("access_change", dremove, "computer_not_running"), false, "the kind is part of the step");
    assert.equal(await interrupt("detach", dremove, "computer_not_running"), true);
    assert.deepEqual(await lease(ddesk), { operation_id: null, operation_kind: null });
    assert.equal((await dbegin("access_change", pid("e", 7), { workspace: false })).status, "computer_busy", "the Remove is still open");
    await db.query("update public.hivra_agents set chat_url='https://desk-moved.example.test' where id=$1", [ddesk.id]);
    assert.equal(await resume("detach", dremove), true, "running and free: the Remove takes the computer back to finish, even changed");
    assert.deepEqual(await lease(ddesk), { operation_id: dremove, operation_kind: "agent_detach" });
    assert.equal(await value("select interrupt_reason as result from public.hivra_agent_attachment_operations where id=$1", [dremove]),
      "computer_changed", "the Remove is marked computer_changed and ends by what the computer shows");
    assert.equal(await interrupt("detach", dremove, "computer_not_running"), true, "and lets it go again when it stopped again");
    await db.query("update public.hivra_agents set status='deleted',desired_state='deleted' where id=$1", [ddesk.id]);
    assert.deepEqual(await one("select phase, end_reason from public.hivra_agent_attachments where id=$1", [dop]),
      { phase: "detached", end_reason: "computer_deleted" });
    assert.deepEqual(await one("select phase, failure_code, lease_released from public.hivra_agent_attachment_operations where id=$1", [dremove]),
      { phase: "failed", failure_code: "computer_deleted", lease_released: false }, "the interrupted Remove ends with the computer");
    assert.equal(await value("select status as result from public.hivra_canonical_primary_bindings where id=$1", [pid("7", 6)]), "detached");

    // ---- the worker's queue --------------------------------------------------
    const work = await value("select public.list_open_hivra_agent_attachment_work(20) as result");
    assert.deepEqual(work, [], "nothing finished is ever picked up again");
    // The limit is for the whole list, least recently tried first across both
    // kinds, so steps that stay held never starve a newer one. Open rows are
    // copied from finished ones with foreign keys and triggers off.
    await db.exec("begin; set local session_replication_role = replica;");
    for (const [n, minutes] of [[1, 5], [2, 3], [3, 1]]) {
      await db.query(`insert into public.hivra_agent_attachments select (jsonb_populate_record(p, jsonb_build_object('id',$1::text,
        'source_id',$5::text,'computer_id',$2::text,'agent_identity_id',$2::text,'phase','claimed','completed_at',null,'dispatch_id',null,'dispatched_at',null,'ended_at',null,'end_reason',null,
        'created_at',(now()-make_interval(mins=>$3))::text))).* from public.hivra_agent_attachments p where p.id=$4`,
      [pid("f", n), pid("f", 10 + n), minutes * 2, op, desk.id]);
      await db.query(`insert into public.hivra_agent_attachment_operations select (jsonb_populate_record(o, jsonb_build_object('id',$1::text,
        'attachment_id',$2::text,'phase','claimed','dispatched_at',null,'completed_at',null,'receipt',null,'failure_code',null,
        'created_at',(now()-make_interval(mins=>$3))::text))).* from public.hivra_agent_attachment_operations o where o.id=$4`,
      [pid("f", 20 + n), pid("f", n), minutes * 2 - 1, access]);
    }
    const listed2 = async () => (await value("select public.list_open_hivra_agent_attachment_work(2) as result")).map((item) => [item.kind, item.id]);
    assert.deepEqual(await listed2(), [["attach", pid("f", 1)], ["access_change", pid("f", 21)]],
      "two items in all, the oldest two, not two of each kind");
    assert.deepEqual(await listed2(), [["attach", pid("f", 2)], ["access_change", pid("f", 22)]],
      "the next pass serves the ones not tried yet, not the same held two again");
    assert.deepEqual(await listed2(), [["attach", pid("f", 3)], ["access_change", pid("f", 23)]]);
    // Both were stamped by the same pass; which of the two stamps is earlier is
    // not specified, so the pass is compared as a set.
    assert.deepEqual((await listed2()).sort(), [["access_change", pid("f", 21)], ["attach", pid("f", 1)]], "then the least recently tried");
    assert.equal((await value("select public.list_open_hivra_agent_attachment_work(20) as result")).length, 6);
    // An interrupted step waits off the list until its computer is running and
    // free, then is tried at most every ten minutes.
    await db.query(`update public.hivra_agent_attachments set phase='dispatched',dispatch_id=$2,dispatched_at=now(),lease_released=true,
      interrupted_at=now(),interrupt_reason='computer_not_running',last_attempt_at=now()-interval '11 minutes' where id=$1`, [pid("f", 1), pid("a", 30)]);
    await db.query("update public.hivra_agents set status='stopped' where id=$1", [desk.id]);
    const ids = async (limit) => (await value("select public.list_open_hivra_agent_attachment_work($1) as result", [limit])).map((item) => item.id);
    assert.equal((await ids(20)).includes(pid("f", 1)), false, "not while its computer is stopped");
    await db.query("update public.hivra_agents set status='running' where id=$1", [desk.id]);
    assert.equal((await ids(20)).includes(pid("f", 1)), true, "listed once its computer runs");
    assert.equal((await ids(20)).includes(pid("f", 1)), false, "and not again within ten minutes");
    await db.exec("rollback;");
    assert.deepEqual(await value("select public.list_open_hivra_agent_attachment_work(20) as result"), []);

    // ---- grants: EXECUTE for service_role only, v1 closed ------------------
    const granted = ["read_hivra_agent_attach_target(text,uuid)", "claim_hivra_agent_attachment(text,uuid,uuid,uuid,jsonb,jsonb,integer)",
      "dispatch_hivra_agent_attachment_v2(text,uuid,uuid,bigint,jsonb,text)", "cancel_hivra_agent_attachment(text,uuid,text)",
      "dispatch_hivra_attachment_activation_v2(text,uuid,uuid,bigint,jsonb,uuid,jsonb,text,text,text,text)",
      "read_hivra_attachment_instance_token(text,uuid)", "complete_hivra_agent_attachment(text,uuid,bigint,jsonb,uuid)",
      "fail_hivra_agent_attachment(text,uuid,bigint,jsonb,jsonb,text)", "record_hivra_attachment_contract(text,uuid,integer,text,text,text,jsonb,jsonb)",
      "begin_hivra_agent_attachment_operation(text,uuid,uuid,text,jsonb,jsonb,text)", "dispatch_hivra_agent_attachment_operation(text,uuid)",
      "cancel_hivra_agent_attachment_operation(text,uuid)", "complete_hivra_agent_attachment_operation(text,uuid,jsonb)",
      "fail_hivra_agent_attachment_operation(text,uuid,text,jsonb)", "read_hivra_agent_attachments(text,uuid)",
      "read_hivra_owner_attached_agents(text)", "list_open_hivra_agent_attachment_work(integer)",
      "read_hivra_agent_attachment_state(text,uuid)", "read_hivra_agent_attachment_operation(text,uuid)",
      "refuse_hivra_agent_attachment(text,uuid,text)",
      "interrupt_hivra_agent_attachment_step(text,text,uuid,text)", "resume_hivra_agent_attachment_step(text,text,uuid)",
      "reserve_hivra_attachment_installation(text,uuid,bigint,uuid,uuid,text)", "observe_hivra_attachment_guest(text,uuid,bigint,jsonb,uuid,text)",
      "record_hivra_attachment_staging_result(text,uuid,bigint,jsonb,uuid,jsonb)",
      "record_hivra_attachment_activation_observation(text,uuid,bigint,jsonb,jsonb,uuid,jsonb)"];
    const closed = ["begin_hivra_agent_attachment(text,uuid,uuid,bigint,jsonb,jsonb)", "dispatch_hivra_agent_attachment(text,uuid,uuid,bigint,jsonb,text)",
      "cancel_undispatched_hivra_agent_attachment(text,uuid)", "dispatch_hivra_attachment_activation(text,uuid,uuid,bigint,jsonb,uuid,jsonb,text,text)",
      "transfer_hivra_canonical_relationship_authority(text,uuid,bigint,bigint,uuid)", "guard_hivra_agent_attachment_operation_lease()",
      "guard_hivra_restore_while_attached()", "detach_hivra_agents_on_computer_delete()"];
    const can = (role, fn) => value(`select has_function_privilege($1,'public.${fn}','EXECUTE') as result`, [role]);
    for (const fn of granted) {
      assert.equal(await can("service_role", fn), true, `service_role executes ${fn}`);
      for (const role of ["anon", "authenticated"]) assert.equal(await can(role, fn), false, `${role} cannot execute ${fn}`);
      const acl = await value("select proacl::text as result from pg_proc where oid=$1::regprocedure", [`public.${fn}`]);
      assert.ok(acl && !/(^|[{,])=/.test(acl), `PUBLIC has no EXECUTE on ${fn}`);
      const def = await value(`select pg_get_functiondef('public.${fn}'::regprocedure) as result`);
      assert.match(def, /SECURITY DEFINER/, `${fn} runs as its owner`);
      assert.match(def, /SET search_path TO 'pg_catalog', 'pg_temp'/, `${fn} pins its search_path`);
    }
    for (const fn of closed) {
      for (const role of ["service_role", "anon", "authenticated"]) assert.equal(await can(role, fn), false, `${role} cannot execute ${fn}`);
    }
    for (const table of ["hivra_agent_attachments", "hivra_agent_attachment_secrets", "hivra_agent_attachment_contracts",
      "hivra_agent_attachment_operations"]) {
      assert.equal(await value("select relrowsecurity as result from pg_class where oid=$1::regclass", [`public.${table}`]), true, `${table} has RLS on`);
      for (const role of ["anon", "authenticated"]) {
        assert.equal(await value(`select has_table_privilege($1,'public.${table}','SELECT') as result`, [role]), false, `${role} cannot read ${table}`);
      }
      for (const privilege of ["INSERT", "UPDATE", "DELETE"]) {
        assert.equal(await value(`select has_table_privilege('service_role','public.${table}',$1) as result`, [privilege]), false,
          `service_role cannot ${privilege} ${table} directly`);
      }
    }
    assert.equal(await value("select has_table_privilege('service_role','public.hivra_agent_attachment_secrets','SELECT') as result"), false,
      "the instance token is read only through its owner-bound function");
    console.log("PASS hivra attachment lifecycle");
  } finally {
    await db.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
