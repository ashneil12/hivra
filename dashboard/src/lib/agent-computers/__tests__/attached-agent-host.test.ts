/** @jest-environment node */
// The attached agent's guest steps after staging (design 5.5; threats T3,
// T25): one pinned runner with the pinned lifecycle program and helpers, over
// the VMID-bound guest exec inside the host allocation lock, for the owner's
// own running computer only; exactly one result line, parsed per action.
jest.mock("server-only", () => ({}));
jest.mock("@/lib/hivra/agent-execution-context", () => ({ resolveHivraAgentExecutionContext: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));

import { spawnSync } from "node:child_process";
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
  "builds the fixed %s transport inside the allocation lock, bound to the VMID and binding tag", (action) => {
    const script = buildAttachedAgentHostScript(action, target, packet);
    expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8", timeout: 5000 }).status).toBe(0);
    expect(script).toContain("fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)");
    expect(script).toContain("VMID=1234");
    expect(script).toContain(`qm() { command timeout --kill-after=5 ${ATTACHED_AGENT_TIMEOUTS[action].guestSeconds} qm "$@"; }`);
    expect(script.indexOf('grep -Fxq "$EXPECTED_BINDING_TAG"')).toBeLessThan(script.lastIndexOf("run_vmid_bound_guest_exec_stdin /usr/bin/python3"));
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
    d.runHostScript.mockResolvedValue({ ok: true, stdout: `HIVRA_ATTACHED_AGENT_V1 ${JSON.stringify(removed)}` });
    expect(await executeAttachedAgentStep(OWNER, agent as never, "state", target, packet, d)).toEqual({ ok: false, code: "invalid_result" });
  });
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
