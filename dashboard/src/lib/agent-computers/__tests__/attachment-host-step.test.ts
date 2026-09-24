/** @jest-environment node */
// The host side of every attach step (design 5.5, T3, T25): the exact VM is
// checked and the guest program started under the host allocation lock, and
// the lock is released before the wait. Launch, start, restart, snapshots and
// bundle sync wait at most 60 s for that lock, so an attach step (up to 540 s)
// must never hold it while the guest works.
//
// scripts/test-attachment-host-step.py runs these exact scripts as root in an
// owned container against a fake qm and proves the lock is free while the
// guest program runs. With HIVRA_HOST_STEP_FIXTURE_DIR set, this file writes
// them there for it.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildAttachmentHostObservationScript, buildAttachmentHostStepScript,
  parseAttachmentTargetRefusal } from "../attachment-host-observation";

const target = {
  operationId: "11111111-1111-4111-8111-111111111111", computerId: "22222222-2222-4222-8222-222222222222",
  sourceId: "33333333-3333-4333-8333-333333333333", vmid: 1234, guestIp: "10.241.0.44",
  bindingTag: "hivra-bind-" + "a".repeat(32), architecture: "x86_64" as const,
};
// A stand-in guest program: reads its packet from stdin, works for a while, answers once.
const PROGRAM = `import json,sys,time
packet=json.loads(sys.stdin.read())
time.sleep(packet['sleep'])
print('HIVRA_FIXTURE_RESULT '+json.dumps({'marker':packet['marker']},separators=(',',':')))
`;
const stepAfterChecks = (script: string) => {
  const body = script.slice(script.indexOf("VMID=1234"));
  return body.slice(body.indexOf("dispatch_vmid_bound_guest_exec_stdin /usr/bin/python3"));
};

it("holds the host lock only for the VM check and the start, and waits for the answer without it", () => {
  const script = buildAttachmentHostStepScript(target, PROGRAM, JSON.stringify({ sleep: 1, marker: "ok" }), 540);
  expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8", timeout: 5000 }).status).toBe(0);
  const after = stepAfterChecks(script);
  expect(after.indexOf("flock -u 9")).toBeGreaterThan(0);
  expect(after.indexOf("exec 9>&-")).toBeGreaterThan(after.indexOf("flock -u 9"));
  expect(after.indexOf('await_vmid_bound_guest_exec "$HIVRA_GUEST_PID" 540')).toBeGreaterThan(after.indexOf("exec 9>&-"));
  // No synchronous, unbounded guest exec is left on the step's path.
  expect(after).not.toMatch(/run_vmid_bound_guest_exec(_stdin)? /);
  expect(script).not.toContain("timeout --kill-after=5 540");
  expect(script).toContain("os.dup2(lock,9)");
  expect(() => buildAttachmentHostStepScript(target, PROGRAM, "{}", 0)).toThrow();
  expect(() => buildAttachmentHostStepScript(target, PROGRAM, "{}", 901)).toThrow();
  expect(() => buildAttachmentHostStepScript({ ...target, guestIp: "10.241.0.1;true" }, PROGRAM, "{}", 5)).toThrow();
});

it("accepts the guest address with any prefix length and names each refusal", () => {
  for (const script of [buildAttachmentHostStepScript(target, PROGRAM, "{}", 5), buildAttachmentHostObservationScript(target)]) {
    expect(script).not.toContain('"ip=$GUEST_IP/24"');
    for (const reason of ["computer_not_running", "binding_mismatch", "address_mismatch"]) {
      expect(script).toContain(`refuse_attachment_target ${reason}`);
    }
  }
  expect(parseAttachmentTargetRefusal("x\nHIVRA_ATTACHMENT_TARGET_REFUSED address_mismatch\n")).toBe("address_mismatch");
  expect(parseAttachmentTargetRefusal("HIVRA_ATTACHMENT_TARGET_REFUSED rm -rf\n")).toBeNull();
  expect(parseAttachmentTargetRefusal("HIVRA_ATTACHMENT_TARGET_REFUSED computer_not_running\nHIVRA_ATTACHMENT_TARGET_REFUSED binding_mismatch")).toBeNull();
  expect(parseAttachmentTargetRefusal(undefined)).toBeNull();
});

const fixtureDir = process.env.HIVRA_HOST_STEP_FIXTURE_DIR;
(fixtureDir ? it : it.skip)("writes the exact host scripts for the root container test", () => {
  const dir = path.resolve(fixtureDir as string);
  mkdirSync(dir, { recursive: true });
  const write = (name: string, script: string) => writeFileSync(path.join(dir, name), script, { mode: 0o600 });
  write("step-ok.sh", buildAttachmentHostStepScript(target, PROGRAM, JSON.stringify({ sleep: 6, marker: "ok" }), 60));
  write("step-deadline.sh", buildAttachmentHostStepScript(target, PROGRAM, JSON.stringify({ sleep: 30, marker: "late" }), 4));
  for (const architecture of ["x86_64", "aarch64"] as const) {
    write(`observation-${architecture}.sh`, buildAttachmentHostObservationScript({ ...target, architecture }));
  }
  writeFileSync(path.join(dir, "target.json"), JSON.stringify(target));
});
