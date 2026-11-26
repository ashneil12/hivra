const mockFrom = jest.fn();
const mockRpc = jest.fn();
const mockResolveEntitlement = jest.fn();
const mockRunWithStdin = jest.fn();
const mockRunScript = jest.fn();
const mockLoadConnection = jest.fn();
const mockBeginPreparation = jest.fn();
const mockCompletePreflight = jest.fn();
const mockLoadSnapshot = jest.fn();

jest.mock("server-only", () => ({}));
jest.mock("@/lib/billing/instance-entitlement", () => ({
  resolveEffectiveSubscription: (...args: unknown[]) => mockResolveEntitlement(...args),
}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: {
  from: (...args: unknown[]) => mockFrom(...args),
  rpc: (...args: unknown[]) => mockRpc(...args),
} }));
jest.mock("@/lib/infrastructure/connection-store", () => ({
  loadInfrastructureConnectionSecret: (...args: unknown[]) => mockLoadConnection(...args),
  beginInfrastructureConnectionPreparation: (...args: unknown[]) => mockBeginPreparation(...args),
  completeInfrastructureConnectionPreflight: (...args: unknown[]) => mockCompletePreflight(...args),
}));
jest.mock("@/lib/infrastructure/connection-runtime", () => ({
  resolveValidatedSshDestination: jest.fn(async () => ({ address: "192.0.2.1" })),
  buildUserProxmoxEnvironment: jest.fn(() => ({})),
}));
// The authority rules are the real ones; only the snapshot read is stubbed.
jest.mock("@/lib/infrastructure/host-authority", () => ({
  ...jest.requireActual("@/lib/infrastructure/host-authority"),
  loadCurrentHostDiscoverySnapshot: (...args: unknown[]) => mockLoadSnapshot(...args),
}));
jest.mock("@/lib/infrastructure/host-capacity-policy", () => ({
  resolveProxmoxHostCapacityPolicy: jest.fn(() => ({ hostMemoryReserveMb: 2048 })),
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: (...args: unknown[]) => mockRunScript(...args),
  runProxmoxHostScriptWithStdin: (...args: unknown[]) => mockRunWithStdin(...args),
}));

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { HIVRA_GVISOR_PREPARE_STAGES } from "../gvisor-computer-contract";
import {
  executeGvisorComputerCommand, findGvisorComputerByLaunchRequest, launchGvisorComputer,
  mutateGvisorComputer, observeGvisorComputer, prepareGvisorHost, reserveAndDispatchManagedGvisor,
} from "../gvisor-computer-service";

const userId = "user_test";
const computerId = "11111111-1111-4111-8111-111111111111";
const sandboxId = "22222222-2222-4222-8222-222222222222";
const connectionId = "33333333-3333-4333-8333-333333333333";
const targetId = "44444444-4444-4444-8444-444444444444";
const adapterSha = "a".repeat(64);
const runtimeSha = "b".repeat(64);
const launchRequestId = "55555555-5555-4555-8555-555555555555";

let agent: Record<string, unknown>;

function result(state: "running" | "stopped", cpu = 2, memoryMb = 2048) {
  return { ok: true, stdout: `HIVRA_GVISOR_V1 ${JSON.stringify({ version: 1, adapterVersion: "2026.10.20.1",
    computerId, sandboxId, state, isolationDriver: "gvisor-runsc", isolationClass: "application-kernel",
    outerHostBoundary: "operator-owned-host", runtime: "runsc", cpu, memoryMb,
    image: "python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285",
    workspace: `hivra-gvisor-workspace-${sandboxId}`, network: `hivra-gvisor-net-${sandboxId}`,
    publicPorts: [], reservationEqualsMaximum: true })}\n`, stderr: "" };
}

function acknowledgeManaged<T extends { stdout: string }>(script: string, receipt: T) {
  const marker = script.match(/HIVRA_GVISOR_LIFECYCLE_ACK [0-9a-f-]+/)?.[0];
  expect(marker).toBeDefined();
  return { ...receipt, stdout: `${receipt.stdout}${marker}\n` };
}

class Query {
  private patch: Record<string, unknown> | null = null;
  private filters = new Map<string, unknown>();
  constructor(private table: string) {}
  select() { return this; }
  update(patch: Record<string, unknown>) { this.patch = patch; return this; }
  eq(column: string, value: unknown) { this.filters.set(column, value); return this; }
  is(column: string, value: unknown) { this.filters.set(column, value); return this; }
  private finish() {
    if (this.table === "deployment_targets") return { data: target, error: null };
    if (!this.patch) return { data: { ...agent }, error: null };
    const matches = [...this.filters].every(([key, value]) => agent[key] === value);
    if (!matches) return { data: null, error: null };
    Object.assign(agent, this.patch);
    return { data: { ...agent }, error: null };
  }
  maybeSingle() { return Promise.resolve(this.finish()); }
  single() { return Promise.resolve(this.finish()); }
  then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
    return Promise.resolve(this.finish()).then(resolve, reject);
  }
}

const target = {
  id: targetId, connection_id: connectionId, evidence_connection_revision: 7, status: "ready",
  supported_isolation_drivers: ["gvisor-runsc"], isolation_class: "application-kernel",
  last_preflight_at: "2026-09-15T12:00:00.000Z",
  capabilities: { kind: "gvisor", launchReady: true, adapter: { version: "2026.10.20.1", sha256: adapterSha },
    runtime: { path: "/usr/local/bin/runsc", sha256: runtimeSha },
    runtimeCompatibility: { contractVersion: 1, supportedWorkloadKinds: ["linux-terminal"] },
    resourcePolicy: { reservationEqualsMaximum: true, aggregateAdmission: "serialized-host-headroom-v1" },
    access: { terminal: "owner-gated-command-v1", publicPorts: false }, desktop: false, windows: false },
};

beforeEach(() => {
  agent = { id: computerId, user_id: userId, type: "linux-terminal", computer_profile: "linux-terminal",
    name: "Sandbox", status: "running", desired_state: "running", deployment_mode: "self-managed",
    operation_id: null, operation_kind: null, operation_payload: null, computer_substrate: "gvisor",
    gvisor_sandbox_id: sandboxId, gvisor_adapter_version: "2026.10.20.1", gvisor_adapter_sha256: adapterSha, gvisor_runtime_sha256: runtimeSha,
    gvisor_observation: null, infrastructure_connection_id: connectionId, deployment_target_id: targetId,
    infrastructure_connection_revision: 7, cpu: 2, ram: 2 };
  agent.gvisor_launch_request_id = launchRequestId;
  mockFrom.mockImplementation((table: string) => new Query(table));
  mockLoadConnection.mockResolvedValue({ id: connectionId, revision: 7, provider: "host", status: "ready",
    pendingBindingRebindFromRevision: null, name: "Host", setupMode: "advanced", configuration: {},
    endpoint: { sshHost: "host.example", sshPort: 22, sshUser: "root", sshHostFingerprintSha256: "c".repeat(64) },
    credentials: { sshPrivateKey: "test" } });
  mockRpc.mockReset();
  mockRunWithStdin.mockReset();
  mockRunScript.mockReset();
  mockBeginPreparation.mockReset().mockResolvedValue(true);
  mockCompletePreflight.mockReset().mockResolvedValue(true);
  mockLoadSnapshot.mockReset().mockResolvedValue(snapshot("login"));
});

/** A current inspection of connection revision 7 that ran as root. */
function snapshot(privilegeVia: "login" | "sudo", overrides: Record<string, unknown> = {}) {
  return {
    connectionRevision: 7,
    contractVersion: 2,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    host: { environment: { effectivePrivilege: "root", privilegeVia, passwordlessSudo: null } },
    ...overrides,
  };
}

function connectionAs(sshUser: string, sshPrivilege?: "login" | "sudo") {
  return { id: connectionId, revision: 7, provider: "host", status: "ready",
    pendingBindingRebindFromRevision: null, name: "Host", setupMode: "advanced", configuration: {},
    endpoint: { sshHost: "host.example", sshPort: 22, sshUser, sshHostFingerprintSha256: "c".repeat(64),
      ...(sshPrivilege ? { sshPrivilege } : {}) },
    credentials: { sshPrivateKey: "test" } };
}

it("recovers an uppercase lost-response UUID through its canonical database identity", async () => {
  await expect(findGvisorComputerByLaunchRequest(userId, launchRequestId.toUpperCase()))
    .resolves.toMatchObject({ id: computerId, gvisor_launch_request_id: launchRequestId });
});

describe("managed gVisor reservation lifecycle", () => {
  beforeEach(() => {
    agent = { ...agent, deployment_mode: "hivra-managed", status: "provisioning",
      operation_id: launchRequestId, operation_kind: "provision",
      infrastructure_connection_id: null, deployment_target_id: null, infrastructure_connection_revision: null };
  });

  afterEach(() => {
    expect(mockLoadConnection).not.toHaveBeenCalled();
    expect(mockRunWithStdin).not.toHaveBeenCalled();
    expect(mockRunScript).not.toHaveBeenCalled();
  });

  it("cancels only through the owner-scoped undispatched reservation RPC", async () => {
    const deleted = { ...agent, status: "deleted", operation_id: null };
    mockRpc.mockResolvedValue({ data: { status: "cancelled", agent: deleted }, error: null });
    await expect(mutateGvisorComputer(userId, computerId, { action: "delete" })).resolves.toEqual(deleted);
    expect(mockRpc).toHaveBeenCalledWith("cancel_undispatched_hivra_managed_gvisor", {
      p_customer: userId, p_computer: computerId,
    });
  });

  it("refuses a foreign customer's computer before any write", async () => {
    await expect(mutateGvisorComputer("foreign-owner", computerId, { action: "delete" }))
      .rejects.toMatchObject({ code: "not_found" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("treats an unconfirmed cancellation as unresolved without a second write", async () => {
    mockRpc.mockResolvedValue({ data: { status: "unconfirmed" }, error: null });
    await expect(mutateGvisorComputer(userId, computerId, { action: "delete" }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(agent).toMatchObject({ status: "provisioning", operation_id: launchRequestId });
  });

  it("blocks remote observe, exec, and lifecycle before dispatch support", async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(observeGvisorComputer(userId, computerId)).rejects.toMatchObject({ code: "not_ready" });
    await expect(executeGvisorComputerCommand(userId, computerId, ["true"])).rejects.toMatchObject({ code: "not_ready" });
    for (const action of ["start", "stop", "resize", "update"] as const) {
      await expect(mutateGvisorComputer(userId, computerId, { action })).rejects.toMatchObject({ code: "not_ready" });
    }
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it("blocks self-managed launch replay even when supplied a matching target ID", async () => {
    agent.deployment_target_id = targetId;
    await expect(launchGvisorComputer({ userId, launchRequestId, targetId, name: "Sandbox", cpu: 2, ramGb: 2 }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe("managed provision dispatch", () => {
  const operatorId = "operator-fixture";
  const claimId = "77777777-7777-4777-8777-777777777777";
  const op = "88888888-8888-4888-8888-888888888888";
  const provision = {
    userId, launchRequestId, name: "Sandbox", cpu: 2, ramGb: 2,
    authority: { agentLimit: 3, authorityUserId: operatorId, connectionId, targetId,
      connectionRevision: 7, adapterSha, runtimeSha, cpuBudget: 4, ramBudgetMb: 8192, maxCpu: 2, maxRamMb: 4096 },
  };
  const claim = { status: "claimed", customerId: userId, computerId, operationId: op, claimId, operatorId,
    connectionId, targetId, revision: 7, sandboxId, adapterSha, runtimeSha, cpu: 2, ram: 2 };
  const pending = { state: "reconciling", computerId };
  const absent = { version: 1, computerId, sandboxId, state: "absent" };
  const absence = (receipt = absent) => ({ ok: true, stdout: `HIVRA_GVISOR_V1 ${JSON.stringify(receipt)}\n`, stderr: "" });

  beforeEach(() => { target.last_preflight_at = new Date().toISOString(); });
  afterEach(() => { target.last_preflight_at = "2026-09-15T12:00:00.000Z"; });

  function reserveThen(data: unknown) {
    mockRpc.mockResolvedValueOnce({ data: { status: "replay", computerId, operationId: op }, error: null })
      .mockResolvedValueOnce({ data, error: null });
  }

  it("dispatches once under the persisted operator and the customer adapter identity", async () => {
    reserveThen(claim);
    mockRunWithStdin.mockImplementationOnce(async script => acknowledgeManaged(script, result("running"))).mockImplementationOnce(async script => acknowledgeManaged(script, result("running")));
    mockRpc.mockResolvedValueOnce({ data: null, error: { message: "completion response lost" } });
    await expect(reserveAndDispatchManagedGvisor(provision)).resolves.toEqual(pending);
    reserveThen({ status: "held" });
    mockRpc.mockResolvedValueOnce({ data: { ...claim, status: "observe" }, error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    await expect(reserveAndDispatchManagedGvisor(provision)).resolves.toEqual({ state: "ready", computerId });
    expect(mockRunWithStdin.mock.calls.map(([, input]) => JSON.parse(input).operation)).toEqual(["create", "status"]);
    expect(mockLoadConnection).toHaveBeenCalledWith(operatorId, connectionId);
    expect(mockRpc).toHaveBeenLastCalledWith("complete_hivra_managed_gvisor_ready", expect.objectContaining({
      p_customer: userId, p_computer: computerId, p_operation: op, p_claim: claimId,
      p_receipt: expect.objectContaining({ state: "running", computerId, sandboxId }),
    }));
    expect(JSON.parse(mockRunWithStdin.mock.calls[0][1])).toMatchObject({
      operation: "create", computerId, sandboxId,
      ownerHash: createHash("sha256").update("hivra-gvisor-owner-v1\0").update(userId).digest("hex"),
    });
  });

  it("reconciles through the owner status boundary without dispatching a mutation", async () => {
    agent = { ...agent, deployment_mode: "hivra-managed", status: "provisioning", operation_kind: "provision", operation_id: op };
    await expect(observeGvisorComputer("foreign-customer", computerId)).rejects.toMatchObject({ code: "not_found" });
    expect(mockRpc).not.toHaveBeenCalled();

    mockRpc.mockResolvedValueOnce({ data: { ...claim, status: "observe" }, error: null })
      .mockResolvedValueOnce({ data: true, error: null });
    mockRunWithStdin.mockImplementationOnce(async script => acknowledgeManaged(script, result("running")));
    await expect(observeGvisorComputer(userId, computerId)).resolves.toMatchObject({ state: "running", computerId, sandboxId });
    expect(mockRpc).toHaveBeenNthCalledWith(1, "read_hivra_managed_gvisor_observation", {
      p_customer: userId, p_computer: computerId,
    });
    expect(mockRpc).toHaveBeenNthCalledWith(2, "complete_hivra_managed_gvisor_ready", expect.objectContaining({
      p_customer: userId, p_operation: op, p_claim: claimId,
    }));
    expect(mockRunWithStdin.mock.calls.map(([, input]) => JSON.parse(input).operation)).toEqual(["status"]);
  });

  it.each([{ status: "held" }, { ...claim, operatorId: "foreign" },
    { ...claim, revision: 8 }, { ...claim, operationId: launchRequestId }])(
    "keeps a missing or mismatched claim from reaching the adapter", async (response) => {
      reserveThen(response);
      await expect(reserveAndDispatchManagedGvisor(provision)).resolves.toEqual(pending);
      expect(mockRunWithStdin).not.toHaveBeenCalled();
      expect(mockLoadConnection).not.toHaveBeenCalled();
    });

  it("retains accounting on a lost create response without probing or retrying transport", async () => {
    reserveThen(claim);
    mockRunWithStdin.mockRejectedValueOnce(new Error("connection lost"));
    await expect(reserveAndDispatchManagedGvisor(provision)).resolves.toEqual(pending);
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRunWithStdin).toHaveBeenCalledTimes(1);
  });

  it("releases a before-create capacity refusal after exact acknowledged absence", async () => {
    reserveThen(claim);
    mockRunWithStdin
      .mockResolvedValueOnce({ ok: false, stdout: "", stderr: "The connected host does not have enough uncommitted capacity" })
      .mockImplementationOnce(async script => acknowledgeManaged(script, absence()));
    mockRpc.mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: true, error: null });

    await expect(reserveAndDispatchManagedGvisor(provision)).resolves.toEqual({ state: "cleaned", computerId });
    expect(mockRunWithStdin.mock.calls.map(([, input]) => JSON.parse(input).operation)).toEqual(["create", "status"]);
    expect(mockRpc).toHaveBeenNthCalledWith(3, "begin_hivra_managed_gvisor_cleanup", {
      p_customer: userId, p_computer: computerId, p_operation: op, p_claim: claimId,
    });
    expect(mockRpc).toHaveBeenNthCalledWith(4, "release_hivra_managed_gvisor_absent", {
      p_customer: userId, p_computer: computerId, p_operation: op, p_claim: claimId, p_receipt: absent,
    });
  });

  it("keeps a before-create capacity refusal reconciling when absence cannot be confirmed", async () => {
    reserveThen(claim);
    mockRunWithStdin
      .mockResolvedValueOnce({ ok: false, stdout: "", stderr: "The connected host does not have enough uncommitted capacity" })
      .mockResolvedValueOnce({ ok: false, stdout: "", stderr: "status transport failed" });

    await expect(reserveAndDispatchManagedGvisor(provision)).resolves.toEqual(pending);
    expect(mockRunWithStdin.mock.calls.map(([, input]) => JSON.parse(input).operation)).toEqual(["create", "status"]);
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a mismatched identity", absence({ ...absent, sandboxId: launchRequestId })],
    ["a present computer", result("running")],
  ])("keeps a before-create capacity refusal reconciling on %s", async (_case, observation) => {
    reserveThen(claim);
    mockRunWithStdin
      .mockResolvedValueOnce({ ok: false, stdout: "", stderr: "The connected host does not have enough uncommitted capacity" })
      .mockImplementationOnce(async script => acknowledgeManaged(script, observation));

    await expect(reserveAndDispatchManagedGvisor(provision)).resolves.toEqual(pending);
    expect(mockRunWithStdin.mock.calls.map(([, input]) => JSON.parse(input).operation)).toEqual(["create", "status"]);
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it("holds the original claim after losing the delete response", async () => {
    reserveThen(claim);
    mockRpc.mockResolvedValueOnce({ data: true, error: null });
    mockRunWithStdin.mockImplementationOnce(async script => acknowledgeManaged(script, result("stopped"))).mockImplementationOnce(async script => acknowledgeManaged(script, result("stopped")))
      .mockRejectedValueOnce(new Error("delete acknowledgement lost"));
    await expect(reserveAndDispatchManagedGvisor(provision)).resolves.toEqual(pending);
    expect(mockRunWithStdin.mock.calls.map(([, input]) => JSON.parse(input).operation)).toEqual(["create", "start", "delete"]);
    expect(mockRpc).toHaveBeenCalledTimes(3);
  });

  it.each([false, true])("requires matched delete absence before releasing (matched=%s)", async (matched) => {
    reserveThen(claim);
    mockRpc.mockResolvedValueOnce({ data: true, error: null });
    mockRunWithStdin.mockImplementationOnce(async script => acknowledgeManaged(script, result("stopped"))).mockImplementationOnce(async script => acknowledgeManaged(script, result("stopped")))
      .mockImplementationOnce(async script => acknowledgeManaged(script, absence(matched ? absent : { ...absent, sandboxId: launchRequestId })));
    mockRpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(reserveAndDispatchManagedGvisor(provision)).resolves.toEqual(matched ? { state: "cleaned", computerId } : pending);
    expect(mockRunWithStdin.mock.calls.map(([, input]) => JSON.parse(input).operation)).toEqual(["create", "start", "delete"]);
    if (matched) expect(mockRpc).toHaveBeenNthCalledWith(4, "release_hivra_managed_gvisor_absent", {
      p_customer: userId, p_computer: computerId, p_operation: op, p_claim: claimId, p_receipt: absent,
    });
    else expect(mockRpc).toHaveBeenCalledTimes(3);
  });
});

describe("ready managed sandbox lifecycle", () => {
  const operatorId = "operator-fixture";
  const operationId = "99999999-9999-4999-8999-999999999999";
  const claim = { status: "claimed", customerId: userId, computerId, operationId, claimId: operationId, operatorId,
    connectionId, targetId, revision: 7, sandboxId, adapterSha, runtimeSha, cpu: 2, ram: 2 };
  const gone = { version: 1, state: "absent", computerId, sandboxId };
  const absence = { ok: true, stdout: `HIVRA_GVISOR_V1 ${JSON.stringify(gone)}\n`, stderr: "" };
  const expectCommand = () => mockRunWithStdin.mock.calls.map(([, input]) => JSON.parse(input).operation);

  beforeEach(() => {
    agent = { ...agent, deployment_mode: "hivra-managed", infrastructure_connection_id: null,
      deployment_target_id: null, infrastructure_connection_revision: null };
    mockResolveEntitlement.mockReset().mockResolvedValue({ plan: "operator", source: "stripe", status: "active" });
  });

  it("rejects a foreign owner before touching the lifecycle ledger or adapter", async () => {
    await expect(mutateGvisorComputer("wrong-owner", computerId, { action: "delete" }))
      .rejects.toMatchObject({ code: "not_found" });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockRunWithStdin).not.toHaveBeenCalled();
  });

  it("opens only the owner's ready, idle terminal on its immutable operator binding", async () => {
    await expect(executeGvisorComputerCommand("foreign", computerId, ["true"])).rejects.toMatchObject({ code: "not_found" });
    agent.operation_id = operationId;
    await expect(executeGvisorComputerCommand(userId, computerId, ["true"])).rejects.toMatchObject({ code: "not_ready" });
    expect(mockRpc).not.toHaveBeenCalled();
    agent.operation_id = null;
    mockRpc.mockResolvedValueOnce({ data: { ...claim, status: "observe" }, error: null });
    mockRunWithStdin.mockImplementationOnce(async script => acknowledgeManaged(script, {
      ok: true, stdout: 'HIVRA_GVISOR_EXEC_V1 {"exitCode":0,"stdout":"ok","stderr":""}\n', stderr: "",
    }));
    await expect(executeGvisorComputerCommand(userId, computerId, ["true"])).resolves.toMatchObject({ exitCode: 0, stdout: "ok" });
    expect(mockRpc).toHaveBeenCalledWith("read_hivra_managed_gvisor_observation", {
      p_customer: userId, p_computer: computerId, p_require_running: true,
    });
    expect(mockLoadConnection).toHaveBeenCalledWith(operatorId, connectionId);
    expect(expectCommand()).toEqual(["exec"]);
  });

  it("requires a confirmed paid entitlement before wake", async () => {
    agent.status = "stopped";
    mockResolveEntitlement.mockResolvedValueOnce(null);
    await expect(mutateGvisorComputer(userId, computerId, { action: "start" }))
      .rejects.toMatchObject({ code: "plan_required" });
    expect(mockResolveEntitlement).toHaveBeenCalledWith(userId, { throwOnQueryError: true });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("settles sleep only with a fresh exact adapter acknowledgement", async () => {
    const stopped = { ...agent, status: "stopped" };
    mockRpc.mockResolvedValueOnce({ data: { ...claim, action: "stop" }, error: null }).mockResolvedValueOnce({ data: stopped, error: null });
    mockRunWithStdin.mockImplementationOnce(async script => acknowledgeManaged(script, result("stopped")));
    await expect(mutateGvisorComputer(userId, computerId, { action: "stop" })).resolves.toEqual(stopped);
    expect(mockRpc).toHaveBeenNthCalledWith(2, "complete_hivra_managed_gvisor_lifecycle", expect.objectContaining({
      p_customer: userId, p_computer: computerId, p_operation: operationId, p_action: "stop",
      p_receipt: expect.objectContaining({ state: "stopped", sandboxId }),
    }));
    expect(mockLoadConnection).toHaveBeenCalledWith(operatorId, connectionId);
    expect(expectCommand()).toEqual(["stop"]);
  });

  it("rejects a stale acknowledgement even when the receipt names the correct sandbox", async () => {
    mockRpc.mockResolvedValueOnce({ data: { ...claim, action: "stop" }, error: null });
    const previous = result("stopped");
    mockRunWithStdin.mockResolvedValueOnce({ ...previous,
      stdout: `${previous.stdout}HIVRA_GVISOR_LIFECYCLE_ACK ${launchRequestId}\n` });
    await expect(mutateGvisorComputer(userId, computerId, { action: "stop" }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it("dispatches a single wake under concurrent owner requests", async () => {
    agent.status = "stopped";
    let entered!: () => void;
    let release!: () => void;
    const enteredAdapter = new Promise<void>(resolve => { entered = resolve; });
    const finishAdapter = new Promise<void>(resolve => { release = resolve; });
    mockRpc.mockResolvedValueOnce({ data: { ...claim, action: "start" }, error: null }).mockResolvedValueOnce({ data: { status: "held" }, error: null })
      .mockResolvedValueOnce({ data: { ...agent, status: "running" }, error: null });
    mockRunWithStdin.mockImplementationOnce(async script => {
      entered();
      await finishAdapter;
      return acknowledgeManaged(script, result("running"));
    });
    const first = mutateGvisorComputer(userId, computerId, { action: "start" });
    await Promise.race([enteredAdapter, first]);
    try {
      await expect(mutateGvisorComputer(userId, computerId, { action: "start" }))
        .rejects.toMatchObject({ code: "conflict" });
    } finally { release(); }
    await expect(first).resolves.toMatchObject({ status: "running" });
    expect(expectCommand()).toEqual(["start"]);
  });

  it("holds a lost delete until read-only recovery verifies fresh exact absence", async () => {
    mockRpc.mockResolvedValueOnce({ data: { ...claim, action: "delete" }, error: null });
    mockRunWithStdin.mockRejectedValueOnce(new Error("delete response lost"));
    await expect(mutateGvisorComputer(userId, computerId, { action: "delete" }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(mockRpc).toHaveBeenCalledTimes(1);

    mockRpc.mockResolvedValueOnce({ data: { ...claim, action: "delete", status: "observe" }, error: null });
    mockRunWithStdin.mockImplementationOnce(async script => acknowledgeManaged(script, result("running")));
    await expect(mutateGvisorComputer(userId, computerId, { action: "delete" }))
      .rejects.toMatchObject({ code: "conflict" });
    expect(mockRpc).toHaveBeenCalledTimes(2);

    mockRpc.mockResolvedValueOnce({ data: { ...claim, action: "delete", status: "observe" }, error: null })
      .mockResolvedValueOnce({ data: { ...agent, status: "deleted" }, error: null });
    mockRunWithStdin.mockImplementationOnce(async script => {
      expect(script).toContain(`hivra-gvisor-${sandboxId}-previous$`);
      return acknowledgeManaged(script, absence);
    });
    await expect(mutateGvisorComputer(userId, computerId, { action: "delete" })).resolves.toMatchObject({ status: "deleted" });
    expect(expectCommand()).toEqual(["delete", "status", "status"]);
    expect(mockRpc).toHaveBeenLastCalledWith("complete_hivra_managed_gvisor_lifecycle", {
      p_customer: userId, p_computer: computerId, p_operation: operationId, p_action: "delete", p_receipt: gone,
    });
  });
});

it("reports a sanitized Docker runtime-registration timeout from preparation", async () => {
  mockRunScript.mockResolvedValue({
    ok: false,
    stdout: "",
    stderr: "internal transport detail\nHIVRA_GVISOR_PREPARE_FAILED_V1 runtime-registration\n",
  });

  await expect(prepareGvisorHost(userId, connectionId)).rejects.toMatchObject({
    code: "remote_failed",
    message: "Docker did not confirm the exact runsc runtime path within 30 seconds of its configuration reload.",
    // The named stage lets the review dialog mark the step setup stopped in.
    stage: "runtime-registration",
  });
  expect(mockCompletePreflight).toHaveBeenCalledWith(
    userId,
    connectionId,
    7,
    expect.any(String),
    expect.objectContaining({ connectionStatus: "error", lastErrorCode: "PROVISIONER_UNAVAILABLE" }),
  );
});

// Review of slice 5: one stage covered both the download and its checksum,
// and Hivra's own adapter from an earlier release was reported as "a different
// gVisor install". Each now stops in a stage of its own.
it.each([
  ["bundle-checksum", "The downloaded gVisor bundle did not match its pinned checksum."],
  ["installed-adapter-check", "The host has a Linux Sandbox adapter Hivra does not recognize. Existing runtime files were not replaced."],
])("reports the %s stage with its own message", async (stage, message) => {
  mockRunScript.mockResolvedValue({ ok: false, stdout: "", stderr: `HIVRA_GVISOR_PREPARE_FAILED_V1 ${stage}\n` });
  await expect(prepareGvisorHost(userId, connectionId)).rejects.toMatchObject({ code: "remote_failed", message, stage });
});

it("runs the checksum and the earlier-release adapter check in their own stages", () => {
  const script = readFileSync(`${process.cwd()}/provisioner/gvisor/prepare-gvisor-host.sh`, "utf8");
  const stageBody = (stage: string) => {
    const start = script.indexOf(`prepare_stage="${stage}"\n`);
    const end = script.indexOf("prepare_stage=", start + 1);
    return script.slice(start, end);
  };
  expect(stageBody("bundle-download")).toContain("curl ");
  expect(stageBody("bundle-download")).not.toContain("sha256sum -c");
  expect(stageBody("bundle-checksum")).toContain(`printf '%s  %s\\n' "$BUNDLE_SHA256" "$tmp_bundle" | sha256sum -c -`);
  expect(stageBody("installed-adapter-check")).toContain('= "$ADAPTER_SHA256" ]');
  expect(stageBody("installed-identity-check")).not.toContain("ADAPTER_SHA256");
});

it("reports no stage when the host names one Hivra doesn't know", async () => {
  mockRunScript.mockResolvedValue({ ok: false, stdout: "", stderr: "HIVRA_GVISOR_PREPARE_FAILED_V1 invented-stage\n" });
  await expect(prepareGvisorHost(userId, connectionId)).rejects.toMatchObject({
    code: "remote_failed",
    message: "The gVisor host preparation could not be confirmed.",
    stage: null,
  });
});

it("keeps the stage list in step with the prepare script", () => {
  const script = readFileSync(`${process.cwd()}/provisioner/gvisor/prepare-gvisor-host.sh`, "utf8");
  const stages = [...script.matchAll(/^prepare_stage="([a-z-]+)"$/gm)].map((match) => match[1]).filter((stage) => stage !== "complete");
  expect(stages).toEqual([...HIVRA_GVISOR_PREPARE_STAGES]);
});

it("releases a rejected resize only after unchanged live status, then accepts a new size", async () => {
  mockRunWithStdin
    .mockResolvedValueOnce({ ok: false, stdout: "", stderr: "The connected host does not have enough uncommitted capacity" })
    .mockResolvedValueOnce(result("running"))
    .mockResolvedValueOnce(result("running", 1, 1024));

  await expect(mutateGvisorComputer(userId, computerId, { action: "resize", cpu: 4, ramGb: 2 }))
    .rejects.toMatchObject({ code: "not_ready", definiteAdmissionRejection: true });
  expect(agent).toMatchObject({ status: "running", desired_state: "running", operation_id: null,
    operation_kind: null, cpu: 2, ram: 2, error: "gvisor_resize_admission_rejected" });

  await expect(mutateGvisorComputer(userId, computerId, { action: "resize", cpu: 1, ramGb: 1 }))
    .resolves.toMatchObject({ status: "running", operation_id: null, cpu: 1, ram: 1 });
});

it("retains the matching lease when rejection status cannot be verified", async () => {
  mockRunWithStdin
    .mockResolvedValueOnce({ ok: false, stdout: "", stderr: "Every existing Docker workload needs explicit CPU and memory limits" })
    .mockResolvedValueOnce({ ok: false, stdout: "", stderr: "transport failed" });

  await expect(mutateGvisorComputer(userId, computerId, { action: "resize", cpu: 4, ramGb: 2 }))
    .rejects.toMatchObject({ code: "not_ready" });
  expect(agent).toMatchObject({ status: "provisioning", desired_state: "running",
    operation_kind: "resize", error: "gvisor_resize_unconfirmed" });
  expect(agent.operation_id).toEqual(expect.any(String));
});

it("restores a stopped computer after start admission is denied", async () => {
  Object.assign(agent, { status: "stopped", desired_state: "stopped" });
  mockRunWithStdin
    .mockResolvedValueOnce({ ok: false, stdout: "", stderr: "The connected host does not have enough uncommitted capacity" })
    .mockResolvedValueOnce(result("stopped"));

  await expect(mutateGvisorComputer(userId, computerId, { action: "start" }))
    .rejects.toMatchObject({ code: "not_ready", definiteAdmissionRejection: true });
  expect(agent).toMatchObject({ status: "stopped", desired_state: "stopped", operation_id: null,
    operation_kind: null, error: "gvisor_start_admission_rejected" });
});

it("does not unlock a lease for target authority rejection", async () => {
  mockLoadConnection.mockResolvedValueOnce({ id: connectionId, revision: 8, provider: "host", status: "error",
    pendingBindingRebindFromRevision: null, name: "Host", setupMode: "advanced", configuration: {},
    endpoint: { sshHost: "host.example", sshPort: 22, sshUser: "root", sshHostFingerprintSha256: "c".repeat(64) },
    credentials: { sshPrivateKey: "test" } });

  await expect(mutateGvisorComputer(userId, computerId, { action: "resize", cpu: 4, ramGb: 2 }))
    .rejects.toMatchObject({ code: "not_ready", definiteAdmissionRejection: false });
  expect(mockRunWithStdin).not.toHaveBeenCalled();
  expect(agent).toMatchObject({ status: "provisioning", operation_kind: "resize", error: "gvisor_resize_unconfirmed" });
  expect(agent.operation_id).toEqual(expect.any(String));
});

describe("host authority (section 9.5)", () => {
  it("runs operations on an existing computer without reading any discovery snapshot (root login and sudo)", async () => {
    mockLoadSnapshot.mockResolvedValue(null); // Expired, or never inspected.
    for (const connection of [connectionAs("root"), connectionAs("hivra", "sudo")]) {
      Object.assign(agent, { status: "running", desired_state: "running", operation_id: null, operation_kind: null });
      mockLoadConnection.mockResolvedValue(connection);
      mockRunWithStdin.mockReset().mockResolvedValueOnce(result("stopped"));
      await expect(mutateGvisorComputer(userId, computerId, { action: "stop" }))
        .resolves.toMatchObject({ status: "stopped", operation_id: null });
      expect(mockRunWithStdin).toHaveBeenCalledTimes(1);
    }
    expect(mockLoadSnapshot).not.toHaveBeenCalled();
  });

  it("refuses a non-root login connection before any SSH", async () => {
    mockLoadConnection.mockResolvedValue(connectionAs("ubuntu"));
    await expect(mutateGvisorComputer(userId, computerId, { action: "stop" }))
      .rejects.toMatchObject({ code: "not_ready" });
    expect(mockRunWithStdin).not.toHaveBeenCalled();
  });

  it("checks the inspection before Prepare installs anything: none, expired or another privilege opens no SSH", async () => {
    for (const current of [null, snapshot("sudo"), snapshot("login", { connectionRevision: 6 }),
      snapshot("login", { host: { environment: { effectivePrivilege: "non-root", privilegeVia: "login", passwordlessSudo: true } } })]) {
      mockLoadSnapshot.mockResolvedValueOnce(current);
      await expect(prepareGvisorHost(userId, connectionId)).rejects.toMatchObject({ code: "not_ready" });
    }
    expect(mockBeginPreparation).not.toHaveBeenCalled();
    expect(mockRunScript).not.toHaveBeenCalled();
  });

  it("prepares a passwordless-sudo connection whose current inspection ran through sudo", async () => {
    mockLoadConnection.mockResolvedValue(connectionAs("hivra", "sudo"));
    mockLoadSnapshot.mockResolvedValue(snapshot("sudo"));
    mockRunScript.mockResolvedValue({ ok: false, stdout: "", stderr: "HIVRA_GVISOR_PREPARE_FAILED_V1 prerequisites\n" });
    await expect(prepareGvisorHost(userId, connectionId)).rejects.toMatchObject({ code: "remote_failed", stage: "prerequisites" });
    expect(mockRunScript).toHaveBeenCalledTimes(1);
    // Prepare installs packages, so under sudo it runs without the remote
    // TERM/KILL limit: apt and dpkg are never killed mid-install (finding 6).
    expect(mockRunScript.mock.calls[0][2]).toMatchObject({ timeoutMs: 360_000, remoteLimit: "none" });
    // A v1 snapshot counts as "login", so it never authorizes a sudo connection.
    mockLoadSnapshot.mockResolvedValue({ ...snapshot("login"), contractVersion: 1,
      host: { environment: { effectivePrivilege: "root" } } });
    await expect(prepareGvisorHost(userId, connectionId)).rejects.toMatchObject({ code: "not_ready" });
    expect(mockRunScript).toHaveBeenCalledTimes(1);
  });

  it("names root or passwordless sudo in the refusal", async () => {
    mockLoadConnection.mockResolvedValue(connectionAs("ubuntu"));
    await expect(prepareGvisorHost(userId, connectionId))
      .rejects.toThrow("Linux Sandbox needs root or passwordless sudo on this server.");
  });
});

describe("Update (recreate on the pinned image, keeping /workspace)", () => {
  const previousSha = "2bb8ce761b72a5fc5054b8dbf9f7c79684da478b74c5f1127a212c489539695d";
  afterEach(() => { target.capabilities.adapter = { version: "2026.10.20.1", sha256: adapterSha }; });

  it("runs the adapter's update under the runtime_update lease and keeps the sandbox's state", async () => {
    // The regression: a Linux Sandbox could not be updated at all.
    mockRunWithStdin.mockResolvedValueOnce(result("running"));
    await expect(mutateGvisorComputer(userId, computerId, { action: "update" }))
      .resolves.toMatchObject({ status: "running", desired_state: "running", operation_id: null, operation_kind: null });
    const request = JSON.parse(mockRunWithStdin.mock.calls[0][1]);
    expect(request).toMatchObject({ operation: "update", computerId, sandboxId, hostMemoryReserveMb: 2048 });
    expect(mockRunWithStdin.mock.calls[0][3]).toMatchObject({ timeoutMs: 360_000 });
  });

  it("keeps a stopped sandbox stopped", async () => {
    Object.assign(agent, { status: "stopped", desired_state: "stopped" });
    mockRunWithStdin.mockResolvedValueOnce(result("stopped"));
    await expect(mutateGvisorComputer(userId, computerId, { action: "update" }))
      .resolves.toMatchObject({ status: "stopped", desired_state: "stopped" });
  });

  it("moves a sandbox from Hivra's earlier adapter to the host's current one, and only on Update", async () => {
    Object.assign(agent, { gvisor_adapter_version: "2026.09.15.1", gvisor_adapter_sha256: previousSha });
    // It keeps working on the upgraded host meanwhile.
    mockRunWithStdin.mockResolvedValueOnce(result("stopped"));
    await expect(mutateGvisorComputer(userId, computerId, { action: "stop" }))
      .resolves.toMatchObject({ status: "stopped", gvisor_adapter_sha256: previousSha });
    mockRunWithStdin.mockResolvedValueOnce(result("stopped"));
    await expect(mutateGvisorComputer(userId, computerId, { action: "update" }))
      .resolves.toMatchObject({ gvisor_adapter_version: "2026.10.20.1", gvisor_adapter_sha256: adapterSha });
  });

  it("refuses a sandbox pinned to an adapter Hivra does not recognize", async () => {
    Object.assign(agent, { gvisor_adapter_version: "2026.09.15.1", gvisor_adapter_sha256: "d".repeat(64) });
    await expect(mutateGvisorComputer(userId, computerId, { action: "update" })).rejects.toMatchObject({ code: "not_ready" });
    expect(mockRunWithStdin).not.toHaveBeenCalled();
  });

  it("recognizes the previous exact digest at the same adapter protocol version", async () => {
    const priorDigest = "3168f185b90abfcf7b17fa603ffa31b9e780b69b0856a5b079595be8b7f63cff";
    Object.assign(agent, { gvisor_adapter_version: "2026.10.20.1", gvisor_adapter_sha256: priorDigest });
    mockRunWithStdin.mockResolvedValueOnce(result("stopped"));
    await expect(mutateGvisorComputer(userId, computerId, { action: "stop" }))
      .resolves.toMatchObject({ status: "stopped", gvisor_adapter_sha256: priorDigest });
    mockRunWithStdin.mockResolvedValueOnce(result("stopped"));
    await expect(mutateGvisorComputer(userId, computerId, { action: "update" }))
      .resolves.toMatchObject({ gvisor_adapter_version: "2026.10.20.1", gvisor_adapter_sha256: adapterSha });
  });

  it("asks for the host to be set up again before an Update on Hivra's earlier adapter, without stopping its sandboxes", async () => {
    target.capabilities.adapter = { version: "2026.09.15.1", sha256: previousSha };
    Object.assign(agent, { gvisor_adapter_version: "2026.09.15.1", gvisor_adapter_sha256: previousSha });
    await expect(mutateGvisorComputer(userId, computerId, { action: "update" }))
      .rejects.toMatchObject({ code: "not_ready", message: expect.stringMatching(/Set up Linux Sandbox on this server again/) });
    expect(mockRunWithStdin).not.toHaveBeenCalled();
    mockRunWithStdin.mockResolvedValueOnce(result("stopped"));
    await expect(mutateGvisorComputer(userId, computerId, { action: "stop" })).resolves.toMatchObject({ status: "stopped" });
  });

  it("keeps the lease and the reason when the update can't be confirmed", async () => {
    mockRunWithStdin.mockResolvedValueOnce({ ok: false, stdout: "", stderr: "boom" });
    await expect(mutateGvisorComputer(userId, computerId, { action: "update" })).rejects.toMatchObject({ code: "remote_failed" });
    expect(agent).toMatchObject({ operation_kind: "runtime_update", error: "gvisor_update_unconfirmed" });
  });
});
