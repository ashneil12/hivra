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

async function rpc(name, args, role = "service_role") {
  const response = await fetch(endpoint + name, {
    method: "POST",
    headers: { Authorization: bearer(role), "Content-Type": "application/json", Prefer: "tx=rollback" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json();
  if (role === "anon") {
    assert.ok([401, 403, 404].includes(response.status), `${name}: anon HTTP ${response.status}`);
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
console.log(`PASS PostgREST ${epoch}: old, bridge, canonical and anonymous contracts`);
