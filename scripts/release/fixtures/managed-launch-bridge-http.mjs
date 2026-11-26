import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";

const [epoch, oldInsert, oldReserve] = process.argv.slice(2);
assert.ok(["legacy", "funding", "placement"].includes(epoch));
const endpoint = "http://127.0.0.1:3000/rpc/";
const secret = process.env.PGRST_JWT_SECRET;
assert.ok(secret && secret.length >= 32);

function bearer(role) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const claims = [encode({ alg: "HS256", typ: "JWT" }), encode({ role, exp: Math.floor(Date.now() / 1000) + 120 })].join(".");
  return `Bearer ${claims}.${createHmac("sha256", secret).update(claims).digest("base64url")}`;
}

async function rpc(name, args, role = "service_role", tx = "rollback", expectedCode) {
  const response = await fetch(endpoint + name, {
    method: "POST",
    headers: { Authorization: bearer(role), "Content-Type": "application/json", Prefer: `tx=${tx}` },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  if (role === "anon") {
    assert.ok([401, 403, 404].includes(response.status), `${name}: anon HTTP ${response.status}`);
    return;
  }
  if (expectedCode) {
    assert.equal(data?.code, expectedCode, `${name}: expected ${expectedCode}`);
    assert.ok(response.status >= 400);
    return;
  }
  assert.equal(response.status, 200, `${name}: HTTP ${response.status} (${data?.code ?? "no error code"})`);
  return data;
}

for (let i = 0; ; i += 1) {
  try {
    assert.equal(await rpc("managed_launch_bridge_epoch", {}), epoch);
    break;
  } catch (error) {
    if (i >= 19) throw error;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

const owner = "synthetic-http-owner";
const agent = {
  id: randomUUID(),
  type: "codex",
  name: "Bridge HTTP probe",
  cpu: 2,
  ram: 4,
  deployment_mode: "hivra-managed",
  computer_substrate: "proxmox-kvm",
  operation_id: randomUUID(),
  infrastructure_binding_token_hash: "a".repeat(64),
  proxmox_host: "bridge-host",
};
const direct = {
  p_row: {
    ...agent, user_id: owner, status: "provisioning", desired_state: "running",
    operation_kind: "provision", operation_started_at: new Date().toISOString(),
    operation_payload: { stage: "pre_allocation_access" }, infrastructure_binding_token_enforced: true,
  },
  p_agent_limit: 20,
};
const receipt = {
  p_user_id: owner,
  p_request_id: randomUUID(),
  p_fingerprints: [{ version: 2, keyTag: "b".repeat(64), digest: "c".repeat(64) }],
  p_model_operation_id: randomUUID(),
  p_agent: agent,
  p_selection: { provider: "venice", mode: "managed", model: "synthetic", walletType: "card" },
  p_encrypted_key: null,
  p_agent_limit: 20,
};
const placement = { p_cpu_overcommit_ratio: 1, p_skip_sleep: false };
const directBridge = "insert_hivra_managed_agent_bridge_v1";
const receiptBridge = "reserve_hivra_launch_model_bridge_v1";

assert.equal((await rpc("insert_hivra_managed_agent", direct)).status, oldInsert);
assert.equal((await rpc("reserve_hivra_launch_model_request_v3", receipt)).status, oldReserve);
const paidDirect = { ...direct, p_row: { ...direct.p_row, seat_funding: "paid" } };
const paidReceipt = { ...receipt, p_agent: { ...agent, seat_funding: "paid" } };
assert.equal((await rpc(directBridge, { ...paidDirect, ...placement, p_epoch: epoch })).status, "inserted");
assert.equal((await rpc(receiptBridge, { ...paidReceipt, ...placement, p_epoch: epoch })).status, "reserved");
const otherEpoch = epoch === "legacy" ? "placement" : "legacy";
assert.equal((await rpc(directBridge, { ...paidDirect, ...placement, p_epoch: otherEpoch })).status, "bridge_phase_changed");
assert.equal((await rpc(receiptBridge, { ...paidReceipt, ...placement, p_epoch: otherEpoch })).status, "bridge_phase_changed");

if (epoch === "placement") {
  assert.equal((await rpc("insert_hivra_managed_agent", { ...paidDirect, ...placement })).status, "inserted");
  assert.equal((await rpc("reserve_hivra_launch_model_request_v3", { ...paidReceipt, ...placement })).status, "reserved");
}

await rpc("managed_launch_bridge_epoch", {}, "anon");
await rpc(directBridge, { ...paidDirect, ...placement, p_epoch: epoch }, "anon");
await rpc(receiptBridge, { ...paidReceipt, ...placement, p_epoch: epoch }, "anon");
const classicCreate = "insert_hermes_instance_bridge_v1";
const classicClaim = "claim_hermes_instance_start_bridge_v1";
const classicFinish = "finish_hermes_instance_start_bridge_v1";
const classic = {
  p_epoch: epoch, ...placement,
  p_row: {
    user_id: owner, name: "Classic HTTP fixture", status: "provisioning", lifecycle_state: "provisioning",
    product_surface: "hermesos", infrastructure_provider: "proxmox",
    cpu_limit: 1, ram_limit: 2048, disk_size_gb: 30, seat_funding: "paid",
    ...(epoch === "placement" ? { proxmox_node: "bridge-host" } : {}),
  },
};
if (epoch === "funding") {
  await rpc(classicCreate, classic, "service_role", "rollback", "P0058");
} else {
  assert.equal((await rpc(classicCreate, classic)).status, "inserted");
}
assert.equal((await rpc(classicCreate, { ...classic, p_epoch: otherEpoch })).status, "bridge_phase_changed");
await rpc(classicCreate, classic, "anon");
const startArgs = {
  p_epoch: epoch, p_instance_id: randomUUID(), p_user_id: owner, p_operation_id: randomUUID(),
  p_host_id: "bridge-host", p_vmid: 13001, ...placement,
};
const finishArgs = {
  p_instance_id: startArgs.p_instance_id, p_user_id: owner, p_operation_id: startArgs.p_operation_id,
  p_outcome: "unknown",
};
assert.equal((await rpc(classicClaim, { ...startArgs, p_epoch: otherEpoch })).status, "bridge_phase_changed");
assert.equal((await rpc(classicClaim, startArgs)).status, "unavailable");
assert.equal((await rpc(classicFinish, finishArgs)).status, "unavailable");
await rpc(classicClaim, startArgs, "anon");
await rpc(classicFinish, finishArgs, "anon");
if (epoch === "placement" && process.env.RUN_CLASSIC_START_RACE === "1") {
  const vm = "00000000-0000-4000-8000-000000000201";
  const start = { ...startArgs, p_instance_id: vm };
  const other = { ...start, p_operation_id: randomUUID() };
  const results = await Promise.all([start, other].map(args => rpc(classicClaim, args, "service_role", "commit")));
  assert.deepEqual(results.map(result => result.status).sort(), ["claimed", "pending"]);
  const winningOp = results[0].status === "claimed" ? start.p_operation_id : other.p_operation_id;
  const finish = { ...finishArgs, p_instance_id: vm, p_operation_id: winningOp };
  assert.equal((await rpc(classicFinish, finish, "service_role", "commit")).status, "pending");
  assert.equal((await rpc(classicClaim, { ...start, p_operation_id: randomUUID() })).status, "pending");
  assert.equal((await rpc(classicFinish, { ...finish, p_outcome: "started" }, "service_role", "commit")).status, "awake");
  assert.equal((await rpc(classicClaim, { ...start, p_operation_id: randomUUID() })).status, "awake");
  console.log("PASS PostgREST Classic Start: concurrent claims dispatch once; unknown stays pending and confirmed start settles");
}
console.log(`PASS PostgREST ${epoch}: old, bridge, canonical and anonymous contracts`);
