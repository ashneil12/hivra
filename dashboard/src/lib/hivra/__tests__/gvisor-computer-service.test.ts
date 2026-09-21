const mockFrom = jest.fn();
const mockRunWithStdin = jest.fn();
const mockRunScript = jest.fn();
const mockLoadConnection = jest.fn();
const mockBeginPreparation = jest.fn();
const mockCompletePreflight = jest.fn();

jest.mock("server-only", () => ({}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) } }));
jest.mock("@/lib/infrastructure/connection-store", () => ({
  loadInfrastructureConnectionSecret: (...args: unknown[]) => mockLoadConnection(...args),
  beginInfrastructureConnectionPreparation: (...args: unknown[]) => mockBeginPreparation(...args),
  completeInfrastructureConnectionPreflight: (...args: unknown[]) => mockCompletePreflight(...args),
}));
jest.mock("@/lib/infrastructure/connection-runtime", () => ({
  resolveValidatedSshDestination: jest.fn(async () => ({ address: "192.0.2.1" })),
  buildUserProxmoxEnvironment: jest.fn(() => ({})),
}));
jest.mock("@/lib/infrastructure/host-capacity-policy", () => ({
  resolveProxmoxHostCapacityPolicy: jest.fn(() => ({ hostMemoryReserveMb: 2048 })),
}));
jest.mock("@/lib/services/proxmox-instance-service", () => ({
  runProxmoxHostScript: (...args: unknown[]) => mockRunScript(...args),
  runProxmoxHostScriptWithStdin: (...args: unknown[]) => mockRunWithStdin(...args),
}));

import { findGvisorComputerByLaunchRequest, mutateGvisorComputer, prepareGvisorHost } from "../gvisor-computer-service";

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
  return { ok: true, stdout: `HIVRA_GVISOR_V1 ${JSON.stringify({ version: 1, adapterVersion: "2026.09.15.1",
    computerId, sandboxId, state, isolationDriver: "gvisor-runsc", isolationClass: "application-kernel",
    outerHostBoundary: "operator-owned-host", runtime: "runsc", cpu, memoryMb,
    image: "python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285",
    workspace: `hivra-gvisor-workspace-${sandboxId}`, network: `hivra-gvisor-net-${sandboxId}`,
    publicPorts: [], reservationEqualsMaximum: true })}\n`, stderr: "" };
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
  capabilities: { kind: "gvisor", launchReady: true, adapter: { version: "2026.09.15.1", sha256: adapterSha },
    runtime: { path: "/usr/local/bin/runsc", sha256: runtimeSha },
    runtimeCompatibility: { contractVersion: 1, supportedWorkloadKinds: ["linux-terminal"] },
    resourcePolicy: { reservationEqualsMaximum: true, aggregateAdmission: "serialized-host-headroom-v1" },
    access: { terminal: "owner-gated-command-v1", publicPorts: false }, desktop: false, windows: false },
};

beforeEach(() => {
  agent = { id: computerId, user_id: userId, type: "linux-terminal", computer_profile: "linux-terminal",
    name: "Sandbox", status: "running", desired_state: "running",
    operation_id: null, operation_kind: null, operation_payload: null, computer_substrate: "gvisor",
    gvisor_sandbox_id: sandboxId, gvisor_adapter_sha256: adapterSha, gvisor_runtime_sha256: runtimeSha,
    gvisor_observation: null, infrastructure_connection_id: connectionId, deployment_target_id: targetId,
    infrastructure_connection_revision: 7, cpu: 2, ram: 2 };
  agent.gvisor_launch_request_id = launchRequestId;
  mockFrom.mockImplementation((table: string) => new Query(table));
  mockLoadConnection.mockResolvedValue({ id: connectionId, revision: 7, provider: "host", status: "ready",
    pendingBindingRebindFromRevision: null, name: "Host", setupMode: "advanced", configuration: {},
    endpoint: { sshHost: "host.example", sshPort: 22, sshUser: "root", sshHostFingerprintSha256: "c".repeat(64) },
    credentials: { sshPrivateKey: "test" } });
  mockRunWithStdin.mockReset();
  mockRunScript.mockReset();
  mockBeginPreparation.mockReset().mockResolvedValue(true);
  mockCompletePreflight.mockReset().mockResolvedValue(true);
});

it("recovers an uppercase lost-response UUID through its canonical database identity", async () => {
  await expect(findGvisorComputerByLaunchRequest(userId, launchRequestId.toUpperCase()))
    .resolves.toMatchObject({ id: computerId, gvisor_launch_request_id: launchRequestId });
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
  });
  expect(mockCompletePreflight).toHaveBeenCalledWith(
    userId,
    connectionId,
    7,
    expect.any(String),
    expect.objectContaining({ connectionStatus: "error", lastErrorCode: "PROVISIONER_UNAVAILABLE" }),
  );
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
