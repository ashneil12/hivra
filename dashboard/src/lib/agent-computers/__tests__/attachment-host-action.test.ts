jest.mock("server-only", () => ({}));

import { spawnSync } from "node:child_process";
import { ATTACHMENT_ACTION_TIMEOUTS, buildAttachmentHostActionScript } from "../attachment-host-action";
import { parseAttachmentArtifactResult } from "../attachment-artifact-result";
import { ATTACHED_CODEX_ARCHIVES } from "../attachment-staging-receipt";

const expected = {
  identity: { operationId: "11111111-1111-4111-8111-111111111111", dispatchId: "22222222-2222-4222-8222-222222222222",
    installationId: "33333333-3333-4333-8333-333333333333", bindingId: "44444444-4444-4444-8444-444444444444",
    computerId: "55555555-5555-4555-8555-555555555555", sourceId: "66666666-6666-4666-8666-666666666666", architecture: "x86_64" as const },
  bootId: "77777777-7777-4777-8777-777777777777",
};
const target = { operationId: expected.identity.operationId, computerId: expected.identity.computerId,
  sourceId: expected.identity.sourceId, architecture: expected.identity.architecture,
  vmid: 1234, guestIp: "10.241.0.44", bindingTag: "hivra-bind-" + "a".repeat(32) };

it.each(["fetch", "stage", "observe"] as const)("builds the fixed %s transport inside the allocation lock", action => {
  const script = buildAttachmentHostActionScript(action, target, expected);
  expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8", timeout: 5000 }).status).toBe(0);
  expect(script).toContain('fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)');
  expect(script).toContain('VMID=1234');
  expect(script).toContain('qm() { command timeout --kill-after=5 20 qm "$@"; }');
  expect(script).toContain(`qm() { command timeout --kill-after=5 ${ATTACHMENT_ACTION_TIMEOUTS[action].guestSeconds} qm "$@"; }`);
  expect(script.indexOf('grep -Fxq "$EXPECTED_BINDING_TAG"')).toBeLessThan(script.lastIndexOf('run_vmid_bound_guest_exec_stdin /usr/bin/python3'));
  expect(script).toContain('qm guest exec "$VMID" --timeout 0 --pass-stdin 1 -- "$@"');
  expect(script).toContain(`"action":"${action}"`);
  expect(script).toContain(`"bootId":"${expected.bootId}"`);
  expect(script).not.toContain('ssh ');
  expect(Buffer.byteLength(script)).toBeLessThan(120_000);
});

it("rejects cross-target and malformed requests before producing a script", () => {
  for (const key of ["operationId", "computerId", "sourceId"] as const) {
    expect(() => buildAttachmentHostActionScript("stage", { ...target, [key]: expected.bootId }, expected)).toThrow();
  }
  expect(() => buildAttachmentHostActionScript("stage", { ...target, architecture: "aarch64" }, expected)).toThrow();
  expect(() => buildAttachmentHostActionScript("stage", { ...target, guestIp: "10.241.0.44;exit 0" }, expected)).toThrow();
  expect(() => buildAttachmentHostActionScript("stage", target, { ...expected, bootId: expected.bootId + "\n" })).toThrow();
  expect(() => buildAttachmentHostActionScript("constructor" as "stage", target, expected)).toThrow();
});

it.each(["x86_64", "aarch64"] as const)("validates the exact %s acquisition result, never staging", architecture => {
  const expectation = { ...expected, identity: { ...expected.identity, architecture } };
  const digest = ATTACHED_CODEX_ARCHIVES[architecture];
  const result = { version: 1, state: "available", architecture, bootId: expected.bootId,
    archiveSha256: digest, size: architecture === "x86_64" ? 99479490 : 91899352,
    path: `/var/lib/hivra/attachment-artifacts/${digest}.tar.gz` };
  expect(parseAttachmentArtifactResult(JSON.stringify(result), expectation)).toEqual(result);
  for (const changed of [{ version: true }, { state: "staged" }, { size: result.size + 1 }, { size: String(result.size) },
    { bootId: expected.identity.sourceId }, { archiveSha256: "f".repeat(64) }, { path: "/tmp/archive" }, { extra: true },
    { architecture: architecture === "x86_64" ? "aarch64" : "x86_64" }]) {
    expect(parseAttachmentArtifactResult(JSON.stringify({ ...result, ...changed }), expectation)).toBeNull();
  }
  for (const output of ["null", "[]", "{}", "é".repeat(2049), JSON.stringify(result) + JSON.stringify(result)]) {
    expect(parseAttachmentArtifactResult(output, expectation)).toBeNull();
  }
  expect(parseAttachmentArtifactResult(JSON.stringify(result), { ...expectation, bootId: "bad" })).toBeNull();
});
