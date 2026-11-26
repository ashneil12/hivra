import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createCanaryQaDispatcher } from "./canary-qa-dispatch.ts";

const stage = process.argv[2];
assert.ok(["off", "a", "closed", "b", "fallback"].includes(stage));
const secret = process.env.PGRST_JWT_SECRET;
assert.ok(secret && secret.length >= 32);
const root = "http://127.0.0.1:3000/";
const scope = { ownerId: "user_CanaryQaFixture", hostId: "qa-fixture-host", vmid: 13011 };
const ownerControls = ["user_ControlOne", "user_ControlTwo", "user_ControlThree", "user_ControlFour"];
const a = "hivra_canary_qa_a";
const b = "hivra_canary_qa_b";
const fallback = "hivra_canary_qa_fallback";
const old = "service_role";
const success = "00000000-0000-4000-8000-000000000401";
const ambiguous = "00000000-0000-4000-8000-000000000402";
const next = "00000000-0000-4000-8000-000000000403";
const restored = "00000000-0000-4000-8000-000000000404";
const unbound = "00000000-0000-4000-8000-000000000406";
const bound = "00000000-0000-4000-8000-000000000407";

function authorize(role) {
  const encode = data => Buffer.from(JSON.stringify(data)).toString("base64url");
  const claims = [encode({ alg: "HS256", typ: "JWT" }), encode({ role, exp: Math.floor(Date.now() / 1000) + 120 })].join(".");
  return `Bearer ${claims}.${createHmac("sha256", secret).update(claims).digest("base64url")}`;
}

async function send(role, path, body, method = "POST") {
  const response = await fetch(root + path, {
    method,
    headers: { Authorization: authorize(role), "Content-Type": "application/json", Prefer: "return=representation" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  const json = await response.json();
  return response.ok ? { data: json, error: null } : { data: null, error: json };
}

function client(role) {
  return { schema(schema) {
    assert.equal(schema, "public");
    return { rpc: (name, args) => send(role, `rpc/${name}`, args) };
  } };
}

function classic(userId) {
  return { user_id: userId, name: "Synthetic Classic fixture", status: "provisioning", lifecycle_state: "provisioning" };
}

async function assertWrite(reply, code) {
  const result = await reply;
  assert.equal(result.error?.code ?? null, code ?? null);
}

function scopedClassic(role, userId, host = scope.hostId) {
  return send(role, "rpc/insert_hermes_instance", {
    p_row: { ...classic(userId), id: bound, infrastructure_provider: "proxmox", proxmox_node: host, proxmox_vmid: scope.vmid,
      seat_funding: "paid", cpu_limit: 1, ram_limit: 2048, disk_size_gb: 30 },
    p_cpu_overcommit_ratio: 1, p_skip_sleep: false,
  });
}

function changeClassic(role, id = bound, vmid = scope.vmid) {
  return send(role, "rpc/synthetic_canary_qa_change_classic", { p_id: id, p_vmid: vmid });
}

for (let i = 0; ; i += 1) {
  try {
    assert.equal((await send(old, "", undefined, "GET")).error, null);
    break;
  } catch (error) {
    if (i >= 19) throw error;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

const dispatched = [];
function dispatcher(role, enabled = true) {
  return createCanaryQaDispatcher({ enabled, scope, db: client(role),
    async run(operation) {
      dispatched.push(operation);
      return operation.operationId === ambiguous ? "unknown" : "performed";
    },
  });
}
const start = operationId => ({ ...scope, action: "start", operationId });
const resize = operationId => ({ ...scope, action: "resize", operationId });

for (const owner of ownerControls) await assertWrite(send(old, "hermes_instances", classic(owner)));
if (stage === "off") {
  await assertWrite(send(old, "hermes_instances", { ...classic(scope.ownerId), id: unbound }));
  await assertWrite(scopedClassic(a, scope.ownerId), "P0060");
  assert.equal((await dispatcher(a)(start(success))).status, "denied");
  assert.equal((await dispatcher(a, false)(start(success))).status, "denied");
  assert.equal(dispatched.length, 0);
} else {
  await assertWrite(send(old, "hermes_instances", classic(scope.ownerId)), "P0060");
  await assertWrite(send(old, "rpc/reserve_hivra_launch_operation", {
    p_user_id: scope.ownerId, p_request_id: success, p_operation_id: success,
    p_request_digest: "a".repeat(64), p_intent_digest: "b".repeat(64), p_resource_kind: "agent", p_runtime_id: "codex",
  }), "P0060");
  await assertWrite(send(old, "rpc/insert_hivra_managed_agent", {
    p_row: { user_id: scope.ownerId, name: "Synthetic old managed writer", type: "codex", status: "provisioning",
      deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", seat_funding: "paid", proxmox_host: scope.hostId,
      cpu: 1, ram: 2 },
    p_agent_limit: 3, p_cpu_overcommit_ratio: 1, p_skip_sleep: false,
  }), "P0060");
  if (stage === "a") {
    await assertWrite(scopedClassic(a, ownerControls[0]), "P0060");
    await assertWrite(scopedClassic(a, scope.ownerId, "qa-control-host"), "P0060");
    await assertWrite(scopedClassic(b, scope.ownerId), "P0060");
    await assertWrite(changeClassic(a, unbound), "P0060");
    await assertWrite(scopedClassic(a, scope.ownerId));
    await assertWrite(changeClassic(a, bound, null), "P0060");
    assert.equal((await dispatcher(b)(start(success))).status, "denied");
    assert.deepEqual(await dispatcher(a)(start(success)), { status: "settled", outcome: "performed" });
    assert.equal((await dispatcher(a)(start(success))).status, "settled");
    assert.equal((await dispatcher(a)(resize(ambiguous))).status, "held");
    assert.deepEqual(dispatched, [start(success), resize(ambiguous)]);
  }
  if (stage === "closed") {
    await assertWrite(changeClassic(a), "P0060");
    await assertWrite(changeClassic(b), "P0060");
    assert.equal((await dispatcher(a)(resize(ambiguous))).status, "denied");
    assert.equal((await dispatcher(b)(start(next))).status, "denied");
    assert.equal(dispatched.length, 0);
  }
  if (stage === "b") {
    await assertWrite(changeClassic(a), "P0060");
    await assertWrite(changeClassic(b));
    assert.equal((await dispatcher(a)(start(next))).status, "denied");
    assert.deepEqual(await dispatcher(b)(resize(ambiguous)), { status: "settled", outcome: "refused" });
    assert.deepEqual(await dispatcher(b)(start(next)), { status: "settled", outcome: "performed" });
    assert.deepEqual(dispatched, [start(next)]);
  }
  if (stage === "fallback") {
    await assertWrite(changeClassic(a), "P0060");
    await assertWrite(changeClassic(b), "P0060");
    await assertWrite(changeClassic(fallback));
    assert.equal((await dispatcher(a)(start(restored))).status, "denied");
    assert.equal((await dispatcher(b)(start(restored))).status, "denied");
    assert.deepEqual(await dispatcher(fallback)(start(success)), { status: "settled", outcome: "performed" });
    assert.deepEqual(await dispatcher(fallback)(start(restored)), { status: "settled", outcome: "performed" });
    assert.deepEqual(dispatched, [start(restored)]);
  }
}
console.log(`PASS ${stage}: ordinary QA write and dispatch expectations; four unrelated owners remained writable`);
