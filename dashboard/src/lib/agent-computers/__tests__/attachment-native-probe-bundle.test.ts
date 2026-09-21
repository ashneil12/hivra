jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildAttachmentNativeProbeBundle, parseAttachmentNativeProbeResult } from "../attachment-native-probe-bundle";
import { parseAttachmentExecutionSnapshot, type AttachmentExecutionSnapshot } from "../attachment-execution-snapshot";
import type { AttachmentActivationRecord } from "../attachment-activation-store";

let execution: AttachmentExecutionSnapshot;
let activation: AttachmentActivationRecord;
let observation: Record<string, unknown>;
beforeAll(() => {
  const raw = JSON.parse(execFileSync(process.execPath, [path.resolve("scripts/test-hivra-attachment-lease.cjs"), "--activation-json"],
    { encoding: "utf8", timeout: 15000 }));
  execution = parseAttachmentExecutionSnapshot(raw.execution, "owner", raw.execution.operationId)!;
  activation = raw.activation;
  observation = { ...raw.observation, state: "native_protocol_available" };
});

it("packages pinned native probe with the actual SQL activation and matching Python dependencies", () => {
  const bundle = buildAttachmentNativeProbeBundle(activation, execution);
  expect(bundle.program).toBe(readFileSync(path.resolve("provisioner/probe-attached-codex-native.py"), "utf8"));
  expect(Buffer.byteLength(bundle.stdin)).toBeLessThanOrEqual(262144);
  expect(JSON.parse(bundle.stdin).packet.packet.packet.request).toEqual(activation);
  const check = `import json,sys
ns={'__name__':'fixture'}
exec(compile(sys.argv[1],'<probe>','exec'),ns)
p=json.load(sys.stdin)
for name in ('observer','protocol'): ns['load'](name,p[name])
print('NATIVE_PACKET_PINS_OK')
`;
  expect(execFileSync("python3", ["-I", "-B", "-S", "-c", check, bundle.program],
    { input: bundle.stdin, encoding: "utf8", timeout: 5000 }).trim()).toBe("NATIVE_PACKET_PINS_OK");
});

it("rejects mismatched authority and modified or oversized probe assets", () => {
  const reader = jest.fn(() => Buffer.from("changed"));
  expect(() => buildAttachmentNativeProbeBundle({ ...activation, generation: "999" }, execution, reader)).toThrow();
  expect(reader).not.toHaveBeenCalled();
  expect(() => buildAttachmentNativeProbeBundle(activation, execution, reader)).toThrow(/reviewed/);
  expect(() => buildAttachmentNativeProbeBundle(activation, execution, () => Buffer.alloc(65537))).toThrow(/asset/);
});

it("accepts only identity-bound native protocol observations, never ready or generic process status", () => {
  expect(parseAttachmentNativeProbeResult(JSON.stringify(observation), activation, execution)).toEqual(observation);
  for (const change of [{ state: "ready" }, { state: "process_running" }, { version: true }, { mainPid: undefined },
    { mainPid: 1 }, { mainPid: "4321" }, { journalPhase: "preparing" }, { ready: true },
    { activationId: execution.computerId }, { operationId: execution.computerId }, { installationId: execution.computerId },
    { bootId: execution.computerId }, { serviceDefinitionSha256: "0".repeat(64) }]) {
    expect(parseAttachmentNativeProbeResult(JSON.stringify({ ...observation, ...change }), activation, execution)).toBeNull();
  }
  for (const raw of ["null", "[]", "{}", "é".repeat(16385), JSON.stringify(observation) + "{}"])
    expect(parseAttachmentNativeProbeResult(raw, activation, execution)).toBeNull();
});

it("permits diagnostic observation of pending deletion without changing authority", () => {
  const pending = { ...execution, desiredState: "deleted" as const };
  expect(buildAttachmentNativeProbeBundle(activation, pending)).toBeDefined();
  expect(parseAttachmentNativeProbeResult(JSON.stringify(observation), activation, pending)).toEqual(observation);
});
