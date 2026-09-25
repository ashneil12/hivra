/** @jest-environment node */
// The attached agent's guest steps after staging (design 5.5; threats T3,
// T25): one pinned runner with the pinned lifecycle program and helpers, over
// the VMID-bound guest exec inside the host allocation lock, for the owner's
// own running computer only; exactly one result line, parsed per action.
jest.mock("server-only", () => ({}));
jest.mock("@/lib/hivra/agent-execution-context", () => ({ resolveHivraAgentExecutionContext: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { ATTACHED_AGENT_PROGRAM_SHA256, ATTACHED_AGENT_RUNNER_SHA256, ATTACHED_AGENT_TIMEOUTS, buildAttachedAgentBundle,
  buildAttachedAgentHostScript, executeAttachedAgentStep, parseAttachedAgentResult } from "../attached-agent-host";

const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const source = (file: string) => readFileSync(path.join(process.cwd(), "provisioner", file));
const OWNER = "owner-1";
const target = { operationId: "00000000-0000-4100-8000-000000000001", computerId: "00000000-0000-4100-8000-000000000003",
  sourceId: "00000000-0000-4100-8000-000000000002", vmid: 1234, guestIp: "10.241.0.44", bindingTag: "hivra-bind-" + "a".repeat(32),
  architecture: "x86_64" as const };
const agent = { id: target.sourceId, user_id: OWNER, status: "running", computer_profile: "ubuntu-desktop", computer_substrate: "proxmox-kvm",
  infrastructure_binding_token_enforced: true, vmid: 1234, ip: "10.241.0.44" };
const packet = { version: 1, operationId: target.operationId, installationId: "00000000-0000-4100-8000-000000000004" };
const removed = { version: 1, operationId: target.operationId, installationId: packet.installationId, state: "removed", workspaceTouched: false };

it("pins the runner and the lifecycle program to the files in the tree", () => {
  expect(sha256(source("run-attached-agent-bundle.py"))).toBe(ATTACHED_AGENT_RUNNER_SHA256);
  expect(sha256(source("attached-agent.py"))).toBe(ATTACHED_AGENT_PROGRAM_SHA256);
  expect(() => buildAttachedAgentBundle({ ...packet, action: "remove" }, (file) => file === "attached-agent.py"
    ? Buffer.concat([source(file), Buffer.from("\n")]) : source(file))).toThrow("do not match the reviewed revision");
  expect(() => buildAttachedAgentBundle({ ...packet, action: "native" })).toThrow("Invalid attached agent action");
});

it.each(Object.keys(ATTACHED_AGENT_TIMEOUTS) as Array<keyof typeof ATTACHED_AGENT_TIMEOUTS>)(
  "starts the %s step under the allocation lock, bound to the VMID and binding tag, and waits without the lock", (action) => {
    const script = buildAttachedAgentHostScript(action, target, packet);
    expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8", timeout: 5000 }).status).toBe(0);
    expect(script).toContain("fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)");
    expect(script).toContain("VMID=1234");
    // Every other user of the host lock waits at most 60 s: an activation
    // (up to 540 s) must never hold it while the guest works (fleet safety).
    const dispatch = script.lastIndexOf("dispatch_vmid_bound_guest_exec_stdin /usr/bin/python3");
    const release = script.lastIndexOf("flock -u 9");
    const wait = script.lastIndexOf(`await_vmid_bound_guest_exec "$HIVRA_GUEST_PID" ${ATTACHED_AGENT_TIMEOUTS[action].guestSeconds}`);
    expect(script.indexOf('grep -Fxq "$EXPECTED_BINDING_TAG"')).toBeLessThan(dispatch);
    expect(dispatch).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(dispatch);
    expect(wait).toBeGreaterThan(release);
    expect(script.match(/qm\(\) \{ command timeout/g)).toHaveLength(1);
    expect(script).toContain(`"action":"${action}"`);
    expect(script).not.toContain("ssh ");
  });

describe("executing a step", () => {
  const context = { infrastructureBindingTagEnforced: true, infrastructureBindingTag: target.bindingTag, env: { PROXMOX_SSH_HOST: "192.0.2.1" } };
  const deps = () => ({ resolveContext: jest.fn().mockResolvedValue(context), runHostScript: jest.fn() });

  it.each([
    ["someone else's computer", { user_id: "other" }],
    ["a stopped computer", { status: "stopped" }],
    ["another profile", { computer_profile: "omarchy" }],
    ["a computer without its binding enforced", { infrastructure_binding_token_enforced: false }],
    ["a different VMID", { vmid: 99 }],
    ["a different guest address", { ip: "10.241.0.45" }],
  ])("refuses %s before reaching the host", async (_label, change) => {
    const d = deps();
    expect(await executeAttachedAgentStep(OWNER, { ...agent, ...change } as never, "remove", target, packet, d))
      .toEqual({ ok: false, code: "invalid_target" });
    expect(d.resolveContext).not.toHaveBeenCalled();
    expect(d.runHostScript).not.toHaveBeenCalled();
  });

  it("refuses a host whose binding tag differs", async () => {
    const d = deps();
    d.resolveContext.mockResolvedValue({ ...context, infrastructureBindingTag: "hivra-bind-" + "b".repeat(32) });
    expect(await executeAttachedAgentStep(OWNER, agent as never, "remove", target, packet, d)).toEqual({ ok: false, code: "authority_unavailable" });
    expect(d.runHostScript).not.toHaveBeenCalled();
  });

  it("reads exactly one result line with the action's own schema", async () => {
    const d = deps();
    d.runHostScript.mockResolvedValue({ ok: true, stdout: `noise\nHIVRA_ATTACHED_AGENT_V1 ${JSON.stringify(removed)}\n` });
    expect(await executeAttachedAgentStep(OWNER, agent as never, "remove", target, packet, d)).toEqual({ ok: true, result: removed });
    expect(d.runHostScript).toHaveBeenCalledWith(expect.any(String), context.env, { timeoutMs: ATTACHED_AGENT_TIMEOUTS.remove.hostMs, maxOutputBytes: 65536 });
    d.runHostScript.mockResolvedValue({ ok: false, stdout: "" });
    expect(await executeAttachedAgentStep(OWNER, agent as never, "remove", target, packet, d)).toEqual({ ok: false, code: "transport_failed" });
    // The host refused the VM before anything ran in it, and said why.
    d.runHostScript.mockResolvedValue({ ok: false, stdout: "HIVRA_ATTACHMENT_TARGET_REFUSED computer_not_running\n" });
    expect(await executeAttachedAgentStep(OWNER, agent as never, "remove", target, packet, d))
      .toEqual({ ok: false, code: "target_refused", reason: "computer_not_running" });
    d.runHostScript.mockResolvedValue({ ok: false, stdout: "HIVRA_ATTACHMENT_TARGET_REFUSED something_else\n" });
    expect(await executeAttachedAgentStep(OWNER, agent as never, "remove", target, packet, d)).toEqual({ ok: false, code: "transport_failed" });
    d.runHostScript.mockResolvedValue({ ok: true, stdout: `HIVRA_ATTACHED_AGENT_V1 ${JSON.stringify(removed)}` });
    expect(await executeAttachedAgentStep(OWNER, agent as never, "state", target, packet, d)).toEqual({ ok: false, code: "invalid_result" });
  });

  // Live on Canary an activation and then every observation were held as
  // transport_failed with nothing to say why. The host's own words now reach
  // the logs, bounded and with token-shaped values masked.
  it("logs what the host said when a step fails without a named refusal, masking tokens", async () => {
    const d = deps();
    const secret = "a".repeat(40);
    d.runHostScript.mockResolvedValue({ ok: false, stdout: `partial ${secret}\n`, stderr: `qm guest exec: VM 1113 qmp command 'guest-exec-status' failed - got timeout ${"x".repeat(900)}`, error: "exit 255" });
    expect(await executeAttachedAgentStep(OWNER, agent as never, "activate", target, packet, d)).toEqual({ ok: false, code: "transport_failed" });
    const { log } = jest.requireMock("@/lib/logger") as { log: { warn: jest.Mock } };
    const [message, fields] = log.warn.mock.calls.at(-1)!;
    expect(message).toBe("attach host step failed without a named refusal");
    expect(fields).toMatchObject({ step: "activate", vmid: target.vmid, error: "exit 255", failureType: "attachment_transport_failed" });
    expect(fields.stderrTail.length).toBeLessThanOrEqual(600);
    expect(fields.stdoutTail).toBe("partial [masked]\n");
    expect(JSON.stringify(fields)).not.toContain(secret);

    log.warn.mockClear();
    d.runHostScript.mockRejectedValue(new Error("ssh: connect to host timed out"));
    expect(await executeAttachedAgentStep(OWNER, agent as never, "state", target, packet, d)).toEqual({ ok: false, code: "transport_failed" });
    expect(log.warn).toHaveBeenCalledWith("attach host step failed without a named refusal", expect.objectContaining({ step: "state", error: "ssh: connect to host timed out" }));
  });

  it("reads the refusal the runner named when the program raised in the VM, and only a name it knows (T3)", async () => {
    const d = deps();
    d.runHostScript.mockResolvedValue({ ok: false, stdout: "HIVRA_GUEST_STEP_REFUSED computer_update_required\n" });
    expect(await executeAttachedAgentStep(OWNER, agent as never, "activate", target, packet, d))
      .toEqual({ ok: false, code: "guest_refused", reason: "computer_update_required" });
    for (const stdout of ["HIVRA_GUEST_STEP_REFUSED /home/bux/Hivra\n", "HIVRA_GUEST_STEP_REFUSED step_refused\nHIVRA_GUEST_STEP_REFUSED step_refused\n",
      "Attached agent step refused (computer_update_required)\n"]) {
      d.runHostScript.mockResolvedValue({ ok: false, stdout });
      expect(await executeAttachedAgentStep(OWNER, agent as never, "activate", target, packet, d)).toEqual({ ok: false, code: "transport_failed" });
    }
    // A refusal line in a successful answer is not a refusal.
    d.runHostScript.mockResolvedValue({ ok: true, stdout: `HIVRA_GUEST_STEP_REFUSED step_refused\nHIVRA_ATTACHED_AGENT_V1 ${JSON.stringify(removed)}\n` });
    expect(await executeAttachedAgentStep(OWNER, agent as never, "remove", target, packet, d)).toEqual({ ok: true, result: removed });
  });
});

// The pinned runner, run for real: what it prints when the program it carries
// raised. The names are the host's contract (ATTACHED_AGENT_REFUSALS).
const RUNNER_PROBE = String.raw`import json,runpy,subprocess,sys
runner=sys.argv[1]
names=runpy.run_path(runner,run_name='hivra_probe')
codes={message:names['refusal_code'](ValueError(message)) for message in json.loads(sys.argv[2])}
proc=subprocess.run([sys.executable,'-I','-B',runner],input=sys.stdin.buffer.read(),capture_output=True,timeout=30)
print(json.dumps({'codes':codes,'status':proc.returncode,'stdout':proc.stdout.decode(),'stderr':proc.stderr.decode()}))
`;

it("prints one named refusal line when the program raised, and never a path or guest bytes (T3)", () => {
  const messages = ["computer_update_required", "workspace_path_not_plain", "detach_mount_found",
    "the computer restarted since this step was requested", "the staged installation does not match",
    "the service definition does not match what Hivra recorded", "the gateway group has members", "/home/bux/Hivra is a link"];
  // A real bundle: every asset verified, then the program refuses to run off the bound guest root.
  const { stdin } = buildAttachedAgentBundle({ ...packet, action: "activate" });
  const run = JSON.parse(execFileSync("python3", ["-I", "-B", "-c", RUNNER_PROBE, path.join(process.cwd(), "provisioner", "run-attached-agent-bundle.py"),
    JSON.stringify(messages)], { input: stdin, encoding: "utf8", timeout: 60_000 }));
  expect(run.codes).toEqual({ computer_update_required: "computer_update_required", workspace_path_not_plain: "workspace_path_not_plain",
    detach_mount_found: "detach_mount_found", "the computer restarted since this step was requested": "computer_restarted",
    "the staged installation does not match": "staged_installation_mismatch",
    "the service definition does not match what Hivra recorded": "service_definition_mismatch",
    "the gateway group has members": "gateway_group_has_members", "/home/bux/Hivra is a link": "step_refused" });
  expect(run.status).not.toBe(0);
  expect(run.stdout).toBe("HIVRA_GUEST_STEP_REFUSED step_refused\n");
  expect(run.stderr).toContain("Attached agent step refused (step_refused)");
});

it("never accepts a Remove that says it touched ~/Hivra, or extra fields", () => {
  const line = (value: unknown) => `HIVRA_ATTACHED_AGENT_V1 ${JSON.stringify(value)}`;
  expect(parseAttachedAgentResult("remove", line(removed))).toEqual(removed);
  expect(parseAttachedAgentResult("remove", line({ ...removed, workspaceTouched: true }))).toBeNull();
  expect(parseAttachedAgentResult("remove", line({ ...removed, deleted: ["/home/bux/Hivra"] }))).toBeNull();
  const state = { version: 1, operationId: target.operationId, installationId: packet.installationId, accountPresent: true, unitsPresent: true,
    workspace: false, viewMounted: false, agentActive: true, chatReady: true };
  expect(parseAttachedAgentResult("state", line(state))).toEqual(state);
  expect(parseAttachedAgentResult("state", line({ ...state, chatReady: "yes" }))).toBeNull();
  expect(parseAttachedAgentResult("access", line({ version: 1, operationId: target.operationId, installationId: packet.installationId,
    state: "refused", reason: "view_not_as_granted" }))).toMatchObject({ state: "refused", reason: "view_not_as_granted" });
});
