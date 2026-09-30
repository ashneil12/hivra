/** @jest-environment node */
// The host side of every attach step (design 5.5, T3, T25): the exact VM is
// checked and the guest program started under the host allocation lock, and
// the lock is released before the wait. Launch, start, restart, snapshots and
// bundle sync wait at most 60 s for that lock, so an attach step (up to 540 s)
// must never hold it while the guest works.
//
// scripts/test-attachment-host-step.py runs these exact scripts as root in an
// owned container against a fake qm and proves the lock is free while the
// guest program runs, and that a real attached agent bundle (over the host's
// 128 KiB argument limit) reaches the guest intact over both SSH transports.
// With HIVRA_HOST_STEP_FIXTURE_DIR set, this file writes them there for it.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { HIVRA_SUDO_LOADER } from "@/lib/services/proxmox-sudo-transport";
import { buildAttachedAgentBundle } from "../attached-agent-host";
import { buildAttachmentHostObservationScript, buildAttachmentHostStepScript, HOST_ARGUMENT_MAX_BYTES,
  parseAttachmentTargetRefusal, parseGuestStepRefusal } from "../attachment-host-observation";

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
// Reads its whole stdin and says what arrived.
const DIGEST_PROGRAM = `import hashlib,sys
data=sys.stdin.buffer.read()
print('HIVRA_FIXTURE_STDIN '+str(len(data))+' '+hashlib.sha256(data).hexdigest())
`;
const stepAfterChecks = (script: string) => {
  const body = script.slice(script.indexOf("VMID=1234"));
  return body.slice(body.indexOf("dispatch_vmid_bound_guest_exec_stdin /usr/bin/python3"));
};

it("holds the host lock only for the VM check and the start, and waits for the answer without it", () => {
  const script = buildAttachmentHostStepScript(target, PROGRAM, 540);
  expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8", timeout: 5000 }).status).toBe(0);
  const after = stepAfterChecks(script);
  expect(after.indexOf("flock -u 9")).toBeGreaterThan(0);
  expect(after.indexOf("exec 9>&-")).toBeGreaterThan(after.indexOf("flock -u 9"));
  expect(after.indexOf('await_vmid_bound_guest_exec "$HIVRA_GUEST_PID" 540')).toBeGreaterThan(after.indexOf("exec 9>&-"));
  // No synchronous, unbounded guest exec is left on the step's path.
  expect(after).not.toMatch(/run_vmid_bound_guest_exec(_stdin)? /);
  expect(script).not.toContain("timeout --kill-after=5 540");
  expect(script).toContain("os.dup2(lock,9)");
  expect(() => buildAttachmentHostStepScript(target, PROGRAM, 0)).toThrow();
  expect(() => buildAttachmentHostStepScript(target, PROGRAM, 901)).toThrow();
  expect(() => buildAttachmentHostStepScript({ ...target, guestIp: "10.241.0.1;true" }, PROGRAM, 5)).toThrow();
});

// Live on Canary every activation and observation failed before the VM was
// checked: the ~150 KB bundle was inside the step body, one argument to
// python3, and Linux refuses any one argument of 128 KiB (Argument list too
// long). The program's stdin now comes from the script's own stdin.
it("keeps the guest program's stdin out of the script, and refuses a step body over the host argument limit", () => {
  const { stdin } = buildAttachedAgentBundle({ version: 1, operationId: target.operationId, action: "activate" });
  expect(Buffer.byteLength(stdin)).toBeGreaterThan(HOST_ARGUMENT_MAX_BYTES);
  const script = buildAttachmentHostStepScript(target, PROGRAM, 540);
  expect(Buffer.byteLength(script)).toBeLessThan(32 * 1024);
  // The stdin is moved aside first, so no check before the start can read it.
  expect(script.indexOf("exec 8<&0 </dev/null")).toBeLessThan(script.indexOf("VMID=1234"));
  expect(stepAfterChecks(script)).toMatch(/^dispatch_vmid_bound_guest_exec_stdin \/usr\/bin\/python3 -I -B -c '[^]*' <&8\)"\nexec 8<&-\n/);
  expect(() => buildAttachmentHostStepScript(target, "#".repeat(HOST_ARGUMENT_MAX_BYTES), 5)).toThrow("host argument limit");
});

it("accepts the guest address with any prefix length and names each refusal", () => {
  for (const script of [buildAttachmentHostStepScript(target, PROGRAM, 5), buildAttachmentHostObservationScript(target)]) {
    expect(script).not.toContain('"ip=$GUEST_IP/24"');
    for (const reason of ["computer_not_running", "binding_mismatch", "address_mismatch"]) {
      expect(script).toContain(`refuse_attachment_target ${reason}`);
    }
  }
  expect(parseAttachmentTargetRefusal("x\nHIVRA_ATTACHMENT_TARGET_REFUSED address_mismatch\n")).toBe("address_mismatch");
  expect(parseAttachmentTargetRefusal("HIVRA_ATTACHMENT_TARGET_REFUSED rm -rf\n")).toBeNull();
  expect(parseAttachmentTargetRefusal("HIVRA_ATTACHMENT_TARGET_REFUSED computer_not_running\nHIVRA_ATTACHMENT_TARGET_REFUSED binding_mismatch")).toBeNull();
  expect(parseAttachmentTargetRefusal(undefined)).toBeNull();
  // A guest program that raised names its refusal on one line (T3).
  const names = ["step_refused", "bundle_invalid"] as const;
  expect(parseGuestStepRefusal("x\nHIVRA_GUEST_STEP_REFUSED step_refused\n", names)).toBe("step_refused");
  expect(parseGuestStepRefusal("HIVRA_GUEST_STEP_REFUSED staging_failed\n", names)).toBeNull();
  expect(parseGuestStepRefusal("HIVRA_GUEST_STEP_REFUSED step_refused\nHIVRA_GUEST_STEP_REFUSED step_refused", names)).toBeNull();
  expect(parseGuestStepRefusal(undefined, names)).toBeNull();
});

const fixtureDir = process.env.HIVRA_HOST_STEP_FIXTURE_DIR;
(fixtureDir ? it : it.skip)("writes the exact host scripts for the root container test", () => {
  const dir = path.resolve(fixtureDir as string);
  mkdirSync(dir, { recursive: true });
  const write = (name: string, script: string) => writeFileSync(path.join(dir, name), script, { mode: 0o600 });
  // A step is its script plus the separate stdin the transport carries.
  const step = (name: string, program: string, stdin: string, seconds: number) => {
    write(`${name}.sh`, buildAttachmentHostStepScript(target, program, seconds));
    write(`${name}.in`, stdin);
  };
  step("step-ok", PROGRAM, JSON.stringify({ sleep: 6, marker: "ok" }), 60);
  step("step-deadline", PROGRAM, JSON.stringify({ sleep: 30, marker: "late" }), 4);
  // The real activation bundle, over the host's argument limit.
  step("step-large", DIGEST_PROGRAM, buildAttachedAgentBundle({ version: 1, operationId: target.operationId, action: "activate" }).stdin, 60);
  write("sudo-loader.sh", HIVRA_SUDO_LOADER);
  for (const architecture of ["x86_64", "aarch64"] as const) {
    write(`observation-${architecture}.sh`, buildAttachmentHostObservationScript({ ...target, architecture }));
  }
  // The real pinned runners with a bundle they refuse: their refusal line must
  // cross the guest exec and the host script unchanged.
  const runner = (file: string) => readFileSync(path.join(process.cwd(), "provisioner", file), "utf8");
  step("step-refused", runner("run-attached-agent-bundle.py"), "{}", 60);
  step("stage-refused", runner("run-attached-codex-bundle.py"), "{}", 60);
  writeFileSync(path.join(dir, "target.json"), JSON.stringify(target));
});
