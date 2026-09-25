jest.mock("server-only", () => ({}));
jest.mock("@/lib/hivra/agent-execution-context", () => ({ resolveHivraAgentExecutionContext: jest.fn() }));
jest.mock("@/lib/services/proxmox-instance-service", () => ({ runProxmoxHostScriptWithStdin: jest.fn() }));

import { resolveHivraAgentExecutionContext } from "@/lib/hivra/agent-execution-context";
import { runProxmoxHostScriptWithStdin as runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import type { RemoteDesktopAgentRow } from "@/lib/remote-computers/guest-installation";
import { executeAttachmentGuestAction } from "../attachment-host-executor";
import { ATTACHMENT_ACTION_TIMEOUTS } from "../attachment-host-action";
import captured from "./fixtures/attachment-network-staging-result.json";

const expected = { identity: { ...captured.identity, architecture: "x86_64" as const }, bootId: captured.bootId };
const agent: RemoteDesktopAgentRow = { id: expected.identity.sourceId, user_id: "owner", operation_id: expected.identity.operationId,
  operation_kind: "agent_attach", status: "running", desired_state: "running", computer_profile: "ubuntu-desktop",
  computer_substrate: "proxmox-kvm", infrastructure_binding_token_enforced: true, vmid: 1234, ip: "10.241.0.44", chat_url: null };
const context: Awaited<ReturnType<typeof resolveHivraAgentExecutionContext>> = {
  kind: "managed", host: "fixture", provisionerChannel: "canary", infrastructureBindingTagEnforced: true,
  infrastructureBindingTag: "hivra-bind-" + "a".repeat(32), env: { TEST_HOST: "owned" },
  paths: { provisionerDirectory: "/fixture/provisioner", logDirectory: "/fixture/logs", provisionLogPrefix: "hivra-prov-",
    startLogPrefix: "hivra-start-", storage: "fixture-storage", vmSshKeyPath: null },
};
const artifact = { version: 1, state: "available", architecture: "x86_64", bootId: expected.bootId,
  archiveSha256: captured.receipt.archiveSha256, size: 99479490,
  path: `/var/lib/hivra/attachment-artifacts/${captured.receipt.archiveSha256}.tar.gz` };

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(resolveHivraAgentExecutionContext).mockResolvedValue(context);
  jest.mocked(runProxmoxHostScript).mockResolvedValue({ ok: true, stdout: JSON.stringify(captured), stderr: "" });
});

it.each(["fetch", "stage", "observe"] as const)("executes one bounded %s action on the resolved owned host", async action => {
  if (action === "fetch") jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({ ok: true, stdout: JSON.stringify(artifact), stderr: "" });
  expect(await executeAttachmentGuestAction("owner", agent, action, expected)).toEqual(action === "fetch"
    ? { ok: true, action, artifact } : { ok: true, action, staged: captured });
  expect(runProxmoxHostScript).toHaveBeenCalledTimes(1);
  // The bundle travels as the script's own stdin stream, not inside the script.
  expect(runProxmoxHostScript).toHaveBeenCalledWith(expect.stringContaining("VMID=1234"), expect.stringContaining(`"action":"${action}"`),
    context.env, { timeoutMs: ATTACHMENT_ACTION_TIMEOUTS[action].hostMs, maxOutputBytes: 32768 });
});

it("snapshots nested expectations and target before awaiting context resolution", async () => {
  let resolve!: (value: typeof context) => void;
  jest.mocked(resolveHivraAgentExecutionContext).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const mutableAgent = { ...agent };
  const mutableExpected = { ...expected, identity: { ...expected.identity } };
  const pending = executeAttachmentGuestAction("owner", mutableAgent, "stage", mutableExpected);
  mutableAgent.vmid = 9999;
  mutableAgent.operation_id = expected.bootId;
  mutableExpected.identity.dispatchId = expected.bootId;
  mutableExpected.identity.sourceId = expected.bootId;
  mutableExpected.bootId = expected.identity.sourceId;
  resolve(context);
  expect(await pending).toEqual({ ok: true, action: "stage", staged: captured });
  expect(runProxmoxHostScript).toHaveBeenCalledWith(expect.stringContaining("VMID=1234"),
    expect.stringContaining(`"bootId":"${expected.bootId}"`), context.env, expect.anything());
});

it.each([{ user_id: "other" }, { id: expected.identity.computerId }, { operation_id: null }, { operation_kind: "restart" },
  { status: "stopped" }, { desired_state: "deleted" }, { computer_profile: "windows-desktop" },
  { computer_substrate: "docker" }, { infrastructure_binding_token_enforced: false }, { vmid: null }])("refuses stage on invalid authority %j", async change => {
  expect(await executeAttachmentGuestAction("owner", { ...agent, ...change }, "stage", expected)).toEqual({ ok: false, code: "invalid_target" });
  expect(resolveHivraAgentExecutionContext).not.toHaveBeenCalled();
  expect(runProxmoxHostScript).not.toHaveBeenCalled();
});

it("permits only read-only result recovery while deletion is pending", async () => {
  const deleting = { ...agent, desired_state: "deleted" };
  expect(await executeAttachmentGuestAction("owner", deleting, "fetch", expected)).toEqual({ ok: false, code: "invalid_target" });
  expect(await executeAttachmentGuestAction("owner", deleting, "observe", expected)).toEqual({ ok: true, action: "observe", staged: captured });
  expect(runProxmoxHostScript).toHaveBeenCalledTimes(1);
});

it("does not execute with unavailable or unenforced host authority", async () => {
  jest.mocked(resolveHivraAgentExecutionContext).mockRejectedValueOnce(new Error("private detail"));
  expect(await executeAttachmentGuestAction("owner", agent, "stage", expected)).toEqual({ ok: false, code: "authority_unavailable" });
  jest.mocked(resolveHivraAgentExecutionContext).mockResolvedValueOnce({ ...context, infrastructureBindingTagEnforced: false } as typeof context);
  expect(await executeAttachmentGuestAction("owner", agent, "stage", expected)).toEqual({ ok: false, code: "authority_unavailable" });
  expect(runProxmoxHostScript).not.toHaveBeenCalled();
});

it("retains uncertainty without retry or raw-error disclosure", async () => {
  for (const action of ["fetch", "stage", "observe"] as const) {
    jest.mocked(runProxmoxHostScript).mockRejectedValueOnce(new Error("private"));
    expect(await executeAttachmentGuestAction("owner", agent, action, expected)).toEqual({ ok: false, code: "transport_failed" });
    jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({ ok: false, stdout: "private", stderr: "private" });
    expect(await executeAttachmentGuestAction("owner", agent, action, expected)).toEqual({ ok: false, code: "transport_failed" });
    jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({ ok: true, stdout: JSON.stringify({ ...captured, bootId: expected.identity.sourceId }), stderr: "private" });
    expect(await executeAttachmentGuestAction("owner", agent, action, expected)).toEqual({ ok: false, code: "invalid_result" });
  }
  expect(runProxmoxHostScript).toHaveBeenCalledTimes(9);
});

it("reads the one refusal the runner named when a step raised in the VM, and only a name it knows (T3)", async () => {
  jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({ ok: false, stdout: "HIVRA_GUEST_STEP_REFUSED staging_failed\n", stderr: "" });
  expect(await executeAttachmentGuestAction("owner", agent, "stage", expected)).toEqual({ ok: false, code: "guest_refused", reason: "staging_failed" });
  jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({ ok: false, stdout: "HIVRA_GUEST_STEP_REFUSED staging_in_progress\n", stderr: "" });
  expect(await executeAttachmentGuestAction("owner", agent, "observe", expected))
    .toEqual({ ok: false, code: "guest_refused", reason: "staging_in_progress" });
  for (const stdout of ["HIVRA_GUEST_STEP_REFUSED ../etc/passwd\n", "HIVRA_GUEST_STEP_REFUSED staging_failed\nHIVRA_GUEST_STEP_REFUSED staging_failed\n"]) {
    jest.mocked(runProxmoxHostScript).mockResolvedValueOnce({ ok: false, stdout, stderr: "" });
    expect(await executeAttachmentGuestAction("owner", agent, "observe", expected)).toEqual({ ok: false, code: "transport_failed" });
  }
});
