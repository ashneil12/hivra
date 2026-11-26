import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createCanaryQaDispatcher } from "./canary-qa-dispatch.ts";

const stage = process.argv[2];
assert.ok(["off", "a", "closed", "b", "fallback"].includes(stage));
const secret = process.env.PGRST_JWT_SECRET;
assert.ok(secret && secret.length >= 32);
const root = "http://127.0.0.1:3000/";
const scope = { ownerId: "user_CanaryQaFixture", hostId: "qa-fixture-host", vmid: 13011 };
const instance = "00000000-0000-4000-8000-000000000431";
const uncertain = "00000000-0000-4000-8000-000000000432";
const confirmed = "00000000-0000-4000-8000-000000000433";
const other = "00000000-0000-4000-8000-000000000434";
const a = "hivra_canary_qa_a";
const b = "hivra_canary_qa_b";
const fallback = "hivra_canary_qa_fallback";

async function send(role, path, body, method = "POST") {
  const encode = data => Buffer.from(JSON.stringify(data)).toString("base64url");
  const claims = [encode({ alg: "HS256", typ: "JWT" }), encode({ role, exp: Math.floor(Date.now() / 1000) + 120 })].join(".");
  const response = await fetch(root + path, {
    method,
    headers: { Authorization: `Bearer ${claims}.${createHmac("sha256", secret).update(claims).digest("base64url")}`,
      "Content-Type": "application/json", Prefer: "return=representation" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(5000),
  });
  const json = await response.json();
  return response.ok ? { data: json, error: null } : { data: null, error: json };
}

const invocations = [];
function run(role, instanceId = instance) {
  const dispatcher = createCanaryQaDispatcher({
    enabled: true, scope,
    db: { schema() {
      return { rpc(name, args) {
        return name === "claim_canary_qa_dispatch"
          ? send(role, "rpc/claim_canary_qa_classic_start", { ...args, p_instance_id: instanceId })
          : send(role, "rpc/finish_canary_qa_classic_start", args);
      } };
    } },
    async run(operation) {
      invocations.push(operation.operationId);
      return operation.operationId === uncertain ? "unknown" : "performed";
    },
  });
  return operationId => dispatcher({ ...scope, action: "start", operationId });
}

async function assertLifecycle(status, substate) {
  for (let i = 0; ; i += 1) {
    try {
      const { data, error } = await send("service_role", `hermes_instances?id=eq.${instance}&select=status,lifecycle_substate`, undefined, "GET");
      assert.equal(error, null);
      assert.deepEqual(data, [{ status, lifecycle_substate: substate }]);
      return;
    } catch (error) {
      if (i >= 19 || stage !== "off") throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

if (stage === "off") {
  await assertLifecycle("stopped", null);
  assert.equal((await run(a)(uncertain)).status, "denied");
  assert.deepEqual(invocations, []);
}
if (stage === "a") {
  assert.equal((await run(a, other)(other)).status, "denied");
  assert.equal((await run(b)(uncertain)).status, "denied");
  assert.equal((await run(a)(uncertain)).status, "held");
  await assertLifecycle("provisioning", "classic_start");
  assert.equal((await run(a)(uncertain)).status, "denied");
  assert.equal((await send(a, "rpc/finish_canary_qa_dispatch", {
    p_operation_id: uncertain, p_outcome: "refused",
  })).data?.status, "denied");
  assert.deepEqual(invocations, [uncertain]);
}
if (stage === "closed") {
  assert.equal((await run(a)(uncertain)).status, "denied");
  assert.equal((await run(b)(confirmed)).status, "denied");
  await assertLifecycle("provisioning", "classic_start");
  assert.deepEqual(invocations, []);
}
if (stage === "b") {
  await assertLifecycle("stopped", null);
  assert.equal((await run(a)(confirmed)).status, "denied");
  assert.deepEqual(await run(b)(uncertain), { status: "settled", outcome: "refused" });
  assert.deepEqual(await run(b)(confirmed), { status: "settled", outcome: "performed" });
  await assertLifecycle("running", null);
  assert.deepEqual(invocations, [confirmed]);
}
if (stage === "fallback") {
  assert.equal((await run(a)(confirmed)).status, "denied");
  assert.equal((await run(b)(confirmed)).status, "denied");
  assert.deepEqual(await run(fallback)(confirmed), { status: "settled", outcome: "performed" });
  await assertLifecycle("running", null);
  assert.deepEqual(invocations, []);
}
console.log(`PASS integrated Classic Start ${stage}: exact role, lifecycle and dispatch receipts`);
