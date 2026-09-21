jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildAttachmentActivationGuestBundle } from "../attachment-activation-guest-bundle";
import type { AttachmentActivationRecord } from "../attachment-activation-store";
import { parseAttachmentExecutionSnapshot, type AttachmentExecutionSnapshot } from "../attachment-execution-snapshot";

let execution: AttachmentExecutionSnapshot;
let activation: AttachmentActivationRecord;
beforeAll(() => {
  const raw = JSON.parse(execFileSync(process.execPath, [path.resolve("scripts/test-hivra-attachment-lease.cjs"), "--activation-json"],
    { encoding: "utf8", timeout: 15000 }));
  execution = parseAttachmentExecutionSnapshot(raw.execution, "owner", raw.execution.operationId)!;
  expect(execution).not.toBeNull();
  activation = raw.activation;
});

it.each(["start", "observe"] as const)("packages the exact reviewed %s program and actual SQL request", action => {
  const result = buildAttachmentActivationGuestBundle(action, activation, execution);
  const outer = JSON.parse(result.stdin);
  const start = action === "start" ? outer : outer.packet;
  expect(start.packet.request).toEqual(activation);
  expect(Object.keys(start.packet.assets).sort()).toEqual(["observer", "worker"]);
  expect(result.program).toBe(readFileSync(path.resolve("provisioner", action === "start"
    ? "start-attached-codex.py" : "observe-attached-codex-activation.py"), "utf8"));
  expect(Buffer.byteLength(result.stdin)).toBeLessThanOrEqual(action === "start" ? 131072 : 196608);
  const program = `import base64,hashlib,json,sys
p=json.load(sys.stdin)
if sys.argv[1]=='observe':
 ns={'__name__':'fixture'}; exec(compile(base64.b64decode(p['starter']),'<starter>','exec'),ns)
 assert hashlib.sha256(base64.b64decode(p['packet']['preflight'])).hexdigest()==ns['PREFLIGHT_SHA256']
 p=p['packet']
ns={'__name__':'fixture'}; exec(compile(base64.b64decode(p['preflight']),'<preflight>','exec'),ns)
request,sources=ns['decode'](json.dumps(p['packet']).encode())
assert ns['service_definition'](request['staged'])['sha256']==request['serviceDefinitionSha256']
print('PACKET_CONTRACT_OK')
`;
  expect(execFileSync("python3", ["-I", "-B", "-S", "-c", program, action],
    { input: result.stdin, encoding: "utf8", timeout: 5000 }).trim()).toBe("PACKET_CONTRACT_OK");
});

it("allows pending-delete observation but rejects start and malformed input before asset reads", () => {
  const pending = { ...execution, desiredState: "deleted" as const };
  expect(buildAttachmentActivationGuestBundle("observe", activation, pending)).toBeDefined();
  const reader = jest.fn();
  for (const [action, record, snapshot] of [
    ["start", activation, pending], ["arbitrary", activation, execution],
    ["observe", { ...activation, generation: "3" }, execution],
    ["observe", activation, { ...execution, staged: null }],
  ] as const) {
    expect(() => buildAttachmentActivationGuestBundle(action as "start", record, snapshot, reader)).toThrow();
  }
  expect(reader).not.toHaveBeenCalled();
});

it("rejects modified and oversized sources rather than packaging them", () => {
  expect(() => buildAttachmentActivationGuestBundle("start", activation, execution, () => Buffer.from("unreviewed")))
    .toThrow(/reviewed revision/);
  expect(() => buildAttachmentActivationGuestBundle("observe", activation, execution, () => Buffer.alloc(65537)))
    .toThrow(/Invalid activation asset/);
});
