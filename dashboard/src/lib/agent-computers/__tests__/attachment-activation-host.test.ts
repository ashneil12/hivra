jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/hivra/agent-execution-context", () => ({ resolveHivraAgentExecutionContext: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScript: jest.fn() }));

import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { resolveHivraAgentExecutionContext } from "@/lib/hivra/agent-execution-context";
import { runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import type { AttachmentActivationRecord } from "../attachment-activation-store";
import { parseAttachmentExecutionSnapshot, type AttachmentExecutionSnapshot } from "../attachment-execution-snapshot";
import { ACTIVATION_ACTION_TIMEOUTS, buildAttachmentActivationHostScript, executeAttachmentActivationAction } from "../attachment-activation-host";
import { parseAttachmentActivationResult } from "../attachment-activation-result";

let execution: AttachmentExecutionSnapshot;
let activation: AttachmentActivationRecord;
let started: Record<string, unknown>;
let observed: Record<string, unknown>;
let context: Awaited<ReturnType<typeof resolveHivraAgentExecutionContext>>;
beforeAll(() => {
  const raw = JSON.parse(execFileSync(process.execPath, [path.resolve("scripts/test-hivra-attachment-lease.cjs"), "--activation-json"],
    { encoding: "utf8", timeout: 15000 }));
  execution = parseAttachmentExecutionSnapshot(raw.execution, "owner", raw.execution.operationId)!;
  expect(execution).not.toBeNull();
  activation = raw.activation;
  started = { version: 1, request: activation, phase: "service_started", unitIdentity: [2049, 12345], mainPid: 4321 };
  observed = { version: 1, state: "process_running", journalPhase: "service_started", operationId: activation.operationId,
    activationId: activation.activationId, installationId: activation.staged.identity.installationId,
    bootId: activation.staged.bootId, serviceDefinitionSha256: activation.serviceDefinitionSha256, mainPid: 4321 };
  context = { kind: "managed", host: "fixture", provisionerChannel: "canary", infrastructureBindingTagEnforced: true,
    infrastructureBindingTag: "hivra-bind-" + execution.guestAuthority.infrastructure_binding_token_hash.slice(0, 32), env: { TEST_HOST: "owned" },
    paths: { provisionerDirectory: "/fixture/provisioner", logDirectory: "/fixture/logs", provisionLogPrefix: "hivra-prov-",
      startLogPrefix: "hivra-start-", storage: "fixture-storage", vmSshKeyPath: null } };
});
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(resolveHivraAgentExecutionContext).mockResolvedValue(context);
});

it.each(["start", "observe", "native"] as const)("builds and executes one bounded VMID-bound %s action", async action => {
  const script = buildAttachmentActivationHostScript(action, activation, execution);
  expect(spawnSync("bash", ["-n"], { input: script, encoding: "utf8", timeout: 5000 }).status).toBe(0);
  expect(script).toContain('fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)');
  expect(script).toContain(`VMID=${execution.guestAuthority.vmid}`);
  expect(script).toContain('qm guest exec "$VMID" --timeout 0 --pass-stdin 1 -- "$@"');
  expect(script).toContain('run_vmid_bound_guest_exec_stdin /usr/bin/python3 -I -B -S');
  expect(script.indexOf('grep -Fxq "$EXPECTED_BINDING_TAG"')).toBeLessThan(script.lastIndexOf('run_vmid_bound_guest_exec_stdin /usr/bin/python3'));
  expect(script).not.toContain('ssh ');
  expect(Buffer.byteLength(script)).toBeLessThan(250000);
  const result = action === "start" ? started : action === "native" ? { ...observed, state: "native_protocol_available" } : observed;
  jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({ ok: true, stdout: JSON.stringify(result), stderr: "" });
  expect(await executeAttachmentActivationAction("owner", action, activation, execution)).toEqual({ ok: true, action, result });
  expect(runProxmoxHostScript).toHaveBeenCalledTimes(1);
  expect(runProxmoxHostScript).toHaveBeenCalledWith(script, context.env,
    { timeoutMs: ACTIVATION_ACTION_TIMEOUTS[action].hostMs, maxOutputBytes: 32768 });
});

it("native action refuses generic process output and wrong-owner authority", async () => {
  expect(await executeAttachmentActivationAction("other", "native", activation, execution)).toEqual({ ok: false, code: "invalid_target" });
  expect(resolveHivraAgentExecutionContext).not.toHaveBeenCalled();
  jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({ ok: true, stdout: JSON.stringify(observed), stderr: "" });
  expect(await executeAttachmentActivationAction("owner", "native", activation, execution)).toEqual({ ok: false, code: "invalid_result" });
});

it("binds every result to the exact activation and rejects malformed or readiness claims", () => {
  for (const change of [{ activationId: execution.computerId }, { operationId: execution.computerId },
    { installationId: execution.computerId }, { bootId: execution.computerId }, { serviceDefinitionSha256: "0".repeat(64) },
    { version: true }, { state: "ready" }, { journalPhase: "preparing" }, { mainPid: "4321" },
    { mainPid: 1 }, { mainPid: undefined }, { ready: true }, { state: "service_inactive" }]) {
    expect(parseAttachmentActivationResult("observe", JSON.stringify({ ...observed, ...change }), activation, execution)).toBeNull();
  }
  for (const change of [{ phase: "start_requested" }, { request: { ...activation, activationId: execution.computerId } },
    { unitIdentity: [1, Number.MAX_SAFE_INTEGER + 1] }, { unitIdentity: [true, 1] }, { mainPid: 0 }, { extra: true }]) {
    expect(parseAttachmentActivationResult("start", JSON.stringify({ ...started, ...change }), activation, execution)).toBeNull();
  }
  for (const text of ["null", "[]", "{}", "é".repeat(16385), JSON.stringify(observed) + JSON.stringify(observed)]) {
    expect(parseAttachmentActivationResult("observe", text, activation, execution)).toBeNull();
  }
  const noPid = { ...observed };
  delete noPid.mainPid;
  expect(parseAttachmentActivationResult("observe", JSON.stringify({ ...noPid, state: "service_inactive" }), activation, execution)).not.toBeNull();
  expect(parseAttachmentActivationResult("observe", JSON.stringify({ ...noPid, state: "activation_unresolved", journalPhase: "start_failed" }), activation, execution)).not.toBeNull();
});

it("refuses wrong-owner or pending-delete starts before resolving a host; deletion may observe", async () => {
  const pending = { ...execution, desiredState: "deleted" as const };
  expect(await executeAttachmentActivationAction("other", "start", activation, execution)).toEqual({ ok: false, code: "invalid_target" });
  expect(await executeAttachmentActivationAction("owner", "start", activation, pending)).toEqual({ ok: false, code: "invalid_target" });
  expect(resolveHivraAgentExecutionContext).not.toHaveBeenCalled();
  jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({ ok: true, stdout: JSON.stringify(observed), stderr: "" });
  expect(await executeAttachmentActivationAction("owner", "observe", activation, pending)).toEqual({ ok: true, action: "observe", result: observed });
});

it("rejects changed host binding and context errors without any command", async () => {
  jest.mocked(resolveHivraAgentExecutionContext).mockResolvedValueOnce({ ...context, infrastructureBindingTag: "hivra-bind-" + "f".repeat(32) });
  expect(await executeAttachmentActivationAction("owner", "start", activation, execution)).toEqual({ ok: false, code: "authority_unavailable" });
  jest.mocked(resolveHivraAgentExecutionContext).mockRejectedValueOnce(new Error("private details"));
  expect(await executeAttachmentActivationAction("owner", "start", activation, execution)).toEqual({ ok: false, code: "authority_unavailable" });
  expect(runProxmoxHostScript).not.toHaveBeenCalled();
});

it("snapshots request and target before awaiting context resolution", async () => {
  let resolve!: (value: typeof context) => void;
  jest.mocked(resolveHivraAgentExecutionContext).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({ ok: true, stdout: JSON.stringify(started), stderr: "" });
  const mutable = structuredClone(execution), request = structuredClone(activation);
  const pending = executeAttachmentActivationAction("owner", "start", request, mutable);
  mutable.guestAuthority.vmid = 9999;
  mutable.generation = "3";
  request.activationId = execution.computerId;
  resolve(context);
  expect(await pending).toEqual({ ok: true, action: "start", result: started });
  expect(runProxmoxHostScript).toHaveBeenCalledWith(expect.stringContaining(`VMID=${execution.guestAuthority.vmid}`), context.env, expect.anything());
});

it("never retries uncertain transport or exposes raw errors", async () => {
  jest.mocked(runProxmoxHostScript).mockRejectedValueOnce(new Error("private details"));
  expect(await executeAttachmentActivationAction("owner", "start", activation, execution)).toEqual({ ok: false, code: "transport_failed" });
  jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({ ok: true, stdout: "private garbage", stderr: "private details" });
  expect(await executeAttachmentActivationAction("owner", "start", activation, execution)).toEqual({ ok: false, code: "invalid_result" });
  expect(runProxmoxHostScript).toHaveBeenCalledTimes(2);
});
