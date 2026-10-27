/** @jest-environment node */
import { runHivraAgentRuntimeUpdate } from "../agent-runtime-update";
import { AGENT_APP_VERSIONS, AGENT_CLI_VERSIONS } from "@/lib/infrastructure/portable-provisioner-contract";

// The shared in-place update as the automatic-update sweep runs it. The
// owner's path through the lifecycle route keeps its own full suite
// (action/__tests__/route.test.ts, unchanged); this covers what the sweep adds
// and what both record for the Updates section.

const mockResolveTarget = jest.fn();
const mockRunHostScript = jest.fn();
const mockClaim = jest.fn();
const mockComplete = jest.fn();
const mockRecordFailure = jest.fn();
const mockRelease = jest.fn();
const mockLogEvent = jest.fn();
const mockRecordOwner = jest.fn();
const mockRecordAuto = jest.fn();
const mockReadRecord = jest.fn();

jest.mock("../agent-lifecycle-host", () => ({
  ...jest.requireActual("../agent-lifecycle-host"),
  resolveHivraLifecycleTarget: (...args: unknown[]) => mockResolveTarget(...args),
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: (...args: unknown[]) => mockRunHostScript(...args),
}));
jest.mock("../agent-operation-store", () => ({
  claimHivraAgentOperation: (...args: unknown[]) => mockClaim(...args),
  completeHivraAgentOperation: (...args: unknown[]) => mockComplete(...args),
  recordHivraAgentOperationFailure: (...args: unknown[]) => mockRecordFailure(...args),
  releaseHivraAgentOperation: (...args: unknown[]) => mockRelease(...args),
}));
jest.mock("../agent-events", () => ({ logHivraAgentEvent: (...args: unknown[]) => mockLogEvent(...args) }));
jest.mock("../agent-cli-store", () => ({
  ...jest.requireActual("../agent-cli-store"),
  readAgentSoftwareRecord: (...args: unknown[]) => mockReadRecord(...args),
  recordOwnerAgentSoftwareRequest: (...args: unknown[]) => mockRecordOwner(...args),
  recordAutomaticAgentSoftwareResult: (...args: unknown[]) => mockRecordAuto(...args),
}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const TESTED = AGENT_CLI_VERSIONS.codex;
const RECEIPT = "HIVRA_GUEST_RUNTIME_UPDATED vmid=1090";
const agent = {
  id: "11111111-1111-4111-8111-111111111111", user_id: "owner", type: "codex", status: "running",
  vmid: 1090, ip: "10.250.21.90", computer_substrate: "proxmox-kvm", deployment_mode: "hivra-managed",
};
const target = {
  executionContext: {
    kind: "managed", host: "fixturenode21", env: {}, provisionerChannel: "default",
    paths: { provisionerDirectory: "/root/hivra-provisioner", vmSshKeyPath: "/etc/hivra/keys/vm-orchestrator", logDirectory: "/root" },
    infrastructureBindingTag: "hivra-binding-fixture", infrastructureBindingTagEnforced: true,
  },
  bindingTag: "hivra-binding-fixture", env: {}, vmid: 1090, octet: 90, subnetPrefix: "10.250.21",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveTarget.mockResolvedValue({ ok: true, target });
  mockClaim.mockResolvedValue(true);
  mockComplete.mockResolvedValue(true);
  mockRecordFailure.mockResolvedValue(true);
  mockRelease.mockResolvedValue(true);
  mockReadRecord.mockResolvedValue(null);
});

it("runs the same in-place update for the sweep and says so only in its event", async () => {
  mockRunHostScript.mockResolvedValue({ ok: true, stdout: `HIVRA_AGENT_CLI name=codex version=0.140.0 target=${TESTED} state=scheduled\n${RECEIPT}\n`, stderr: "" });
  const outcome = await runHivraAgentRuntimeUpdate({ userId: "owner", agent, trigger: "auto", source: "cron/update-hivra-agent-clis" });

  expect(outcome).toEqual({ ok: true, agentCli: { name: "codex", version: "0.140.0", target: TESTED, state: "scheduled" }, agentApp: null });
  expect(mockResolveTarget).toHaveBeenCalledWith({ userId: "owner", agent, action: "update_runtime", source: "cron/update-hivra-agent-clis" });
  // The same lease as the owner's update, and the same bound, in-place helper.
  expect(mockClaim).toHaveBeenCalledWith(expect.objectContaining({ operationKind: "restart", desiredState: "running", operationPayload: null }));
  const [script, , options] = mockRunHostScript.mock.calls[0];
  expect(script).toContain("flock -w 60 8");
  expect(script).toContain("EXPECTED_BINDING_TAG='hivra-binding-fixture'");
  expect(script).toContain("bash '/root/hivra-provisioner/hivra-update-guest-runtime.sh' 1090 '10.250.21.90'");
  expect(script).not.toMatch(/qm (shutdown|stop|start|reboot|reset)\b/);
  expect(options).toEqual({ timeoutMs: 240_000 });
  expect(mockComplete).toHaveBeenCalledWith(expect.objectContaining({ status: "running", expectedDesiredState: "running" }));
  expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
    event: "runtime_updated",
    detail: { inPlace: true, agentCli: { name: "codex", version: "0.140.0", target: TESTED, state: "scheduled" }, trigger: "auto" },
  }));
  // The sweep's claim gets its result; nothing is recorded as the owner's.
  expect(mockRecordAuto).toHaveBeenCalledWith({ id: agent.id, user_id: "owner", type: "codex" }, TESTED, "scheduled", expect.objectContaining({ state: "scheduled" }));
  expect(mockRecordOwner).not.toHaveBeenCalled();
});

it("records an owner's update with its report, and leaves the owner's event as it always was", async () => {
  mockRunHostScript.mockResolvedValue({ ok: true, stdout: `HIVRA_AGENT_CLI name=codex version=${TESTED} target=${TESTED} state=current\n${RECEIPT}\n`, stderr: "" });
  const previous = { agent_id: agent.id, user_id: "owner", auto_paused_target: TESTED, auto_paused_reason: "rolled_back" };
  mockReadRecord.mockResolvedValue(previous);
  await runHivraAgentRuntimeUpdate({ userId: "owner", agent, trigger: "owner" });

  expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "runtime_updated", detail: { inPlace: true, agentCli: expect.any(Object) } }));
  expect(mockRecordOwner).toHaveBeenCalledWith(expect.objectContaining({
    agent: { id: agent.id, user_id: "owner", type: "codex" }, target: TESTED, result: "current",
    report: { name: "codex", version: TESTED, target: TESTED, state: "current" }, previous,
  }));
  expect(mockRecordAuto).not.toHaveBeenCalled();
});

it.each([
  ["the host isn't ready", { ok: false, code: "host_not_ready", status: 503, message: "Not ready" }, "host_not_ready"],
  ["another operation holds the computer", null, "busy"],
])("records an owner's request that stopped because %s", async (_case, prepared, result) => {
  if (prepared) mockResolveTarget.mockResolvedValue(prepared);
  else mockClaim.mockResolvedValue(false);
  const outcome = await runHivraAgentRuntimeUpdate({ userId: "owner", agent, trigger: "owner" });
  expect(outcome).toMatchObject({ ok: false, code: result });
  expect(mockRecordOwner).toHaveBeenCalledWith(expect.objectContaining({ result, report: null }));
  expect(mockRunHostScript).not.toHaveBeenCalled();
});

it("keeps the operation for reconciliation when the receipt is missing, and says it couldn't confirm", async () => {
  mockRunHostScript.mockResolvedValue({ ok: false, stdout: "", stderr: "guest runtime update ended without its commit receipt\n", error: "Remote bash exited with code 1" });
  const outcome = await runHivraAgentRuntimeUpdate({ userId: "owner", agent, trigger: "auto" });
  expect(outcome).toEqual({ ok: false, code: "unverified", status: 502, message: expect.stringMatching(/could not be verified/) });
  expect(mockRecordFailure).toHaveBeenCalledWith(expect.objectContaining({ error: "guest runtime update ended without its commit receipt" }));
  expect(mockComplete).not.toHaveBeenCalled();
  expect(mockRecordAuto).toHaveBeenCalledWith(expect.anything(), TESTED, "unverified", null);
});

it("refuses a stopped computer before any lease", async () => {
  const outcome = await runHivraAgentRuntimeUpdate({ userId: "owner", agent: { ...agent, status: "stopped" }, trigger: "auto" });
  expect(outcome).toMatchObject({ ok: false, code: "not_running", status: 409 });
  expect(mockClaim).not.toHaveBeenCalled();
  // The sweep's claim is closed with a result, so the Updates section doesn't wait on it.
  expect(mockRecordAuto).toHaveBeenCalledWith(expect.anything(), TESTED, "refused", null);
});

it.each([
  // An owner may update DeepSeek (its own owned update restarts it); the sweep never does.
  ["DeepSeek", { type: "deepseek-harness" }],
  ["a prepared computer", { type: "linux-desktop", computer_profile: "omarchy" }],
  ["My cloud", { computer_substrate: "provider-vm" }],
  ["a Linux Sandbox", { computer_substrate: "gvisor" }],
])("never updates %s", async (_case, extra) => {
  const outcome = await runHivraAgentRuntimeUpdate({ userId: "owner", agent: { ...agent, ...extra }, trigger: "auto" });
  expect(outcome).toMatchObject({ ok: false, code: "unsupported" });
  expect(mockResolveTarget).not.toHaveBeenCalled();
  expect(mockRunHostScript).not.toHaveBeenCalled();
});

it("records an owner's update of an app agent against its tested app version", async () => {
  const target = AGENT_APP_VERSIONS["agent-zero"].version;
  const line = `HIVRA_AGENT_APP name=agent-zero version=sha256:${"d".repeat(64)} target=${target} state=scheduled`;
  mockRunHostScript.mockResolvedValue({ ok: true, stdout: `${line}\n${RECEIPT}\n`, stderr: "" });
  const outcome = await runHivraAgentRuntimeUpdate({ userId: "owner", agent: { ...agent, type: "agent-zero" }, trigger: "owner" });
  expect(outcome).toEqual({ ok: true, agentCli: null, agentApp: { name: "agent-zero", version: `sha256:${"d".repeat(64)}`, target, state: "scheduled" } });
  expect(mockRecordOwner).toHaveBeenCalledWith(expect.objectContaining({
    target, result: "scheduled",
    subject: expect.objectContaining({ app: "agent-zero", software: "agent-zero" }),
  }));
  expect(mockRecordAuto).not.toHaveBeenCalled();
});

it("updates DeepSeek when its owner asks, through the same helper", async () => {
  mockRunHostScript.mockResolvedValue({ ok: true, stdout: `${RECEIPT}\n`, stderr: "" });
  expect(await runHivraAgentRuntimeUpdate({ userId: "owner", agent: { ...agent, type: "deepseek-harness" }, trigger: "owner" }))
    .toEqual({ ok: true, agentCli: null, agentApp: null });
  expect(mockResolveTarget).toHaveBeenCalled();
  expect(mockRecordOwner).not.toHaveBeenCalled();
});

it("records an app update whose app step can't be confirmed as unverified", async () => {
  mockRunHostScript.mockResolvedValue({ ok: true, stdout: `${RECEIPT}\n`, stderr: "" });
  expect(await runHivraAgentRuntimeUpdate({ userId: "owner", agent: { ...agent, type: "aeon" }, trigger: "owner" })).toEqual({ ok: true, agentCli: null, agentApp: null });
  expect(mockRecordOwner).toHaveBeenCalledWith(expect.objectContaining({ target: AGENT_APP_VERSIONS.aeon.version, result: "unverified", report: null }));
});
