import { spawnSync } from "node:child_process";
import { buildAttachmentHostObservationScript, parseAttachmentHostObservation } from "../attachment-host-observation";

const target = {
  operationId: "11111111-1111-4111-8111-111111111111", computerId: "22222222-2222-4222-8222-222222222222",
  sourceId: "33333333-3333-4333-8333-333333333333", vmid: 1234, guestIp: "10.241.0.44",
  bindingTag: "hivra-bind-" + "a".repeat(32), architecture: "x86_64" as const,
};
const observed = { version: 1, target, bootId: "44444444-4444-4444-8444-444444444444" };

it("builds syntactically valid bounded VMID transport with checks inside the lifecycle lock", () => {
  const script = buildAttachmentHostObservationScript(target);
  expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8", timeout: 5000 }).status).toBe(0);
  expect(script).toContain('qm() { command timeout --kill-after=5 20 qm "$@"; }');
  expect(script.indexOf('fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)')).toBeLessThan(script.indexOf('qm status'));
  expect(script).toContain('deadline=time.monotonic()+10');
  expect(script).toContain('os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK');
  expect(script).not.toContain('install -d');
  expect(script).not.toContain('O_TRUNC');
  expect(script.indexOf('grep -Fxq "$EXPECTED_BINDING_TAG"')).toBeLessThan(script.lastIndexOf('run_vmid_bound_guest_exec /usr/bin/python3'));
  expect(script).toContain('qm guest exec "$VMID" --timeout 0 -- "$@"');
  expect(script).not.toContain('ssh ');
  expect(script).not.toContain('stage-attached-codex');
});

it.each([
  { operationId: "../unsafe" }, { vmid: 1 }, { vmid: 1234.5 }, { vmid: Number.MAX_SAFE_INTEGER },
  { guestIp: "10.241.0.44;exit 0" }, { bindingTag: "-e unsafe" }, { bindingTag: "hivra-bind-abc\n" },
  { bindingTag: target.bindingTag + "\n" }, { operationId: target.operationId + "\n" },
  { architecture: "windows" }, { extra: "unsupported" },
])("refuses invalid host targets before generating commands %j", change => {
  expect(() => buildAttachmentHostObservationScript({ ...target, ...change } as typeof target)).toThrow();
});

it("matches the complete expected target and rejects foreign and malformed observations", () => {
  expect(parseAttachmentHostObservation(JSON.stringify(observed), target)).toEqual(observed);
  for (const key of ["operationId", "computerId", "sourceId"] as const) {
    expect(parseAttachmentHostObservation(JSON.stringify(observed), { ...target, [key]: observed.bootId })).toBeNull();
  }
  for (const change of [{ vmid: 1235 }, { guestIp: "10.241.0.45" }, { bindingTag: "hivra-bind-" + "b".repeat(32) }, { architecture: "aarch64" as const }]) {
    expect(parseAttachmentHostObservation(JSON.stringify(observed), { ...target, ...change })).toBeNull();
  }
  for (const output of ["null", "[]", "{}", "é".repeat(2049), JSON.stringify(observed) + JSON.stringify(observed),
    JSON.stringify({ ...observed, bootId: "invalid" }), JSON.stringify({ ...observed, extra: true })]) {
    expect(parseAttachmentHostObservation(output, target)).toBeNull();
  }
});
