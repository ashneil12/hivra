import "server-only";

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ManagedGvisorAuthority } from "./managed-gvisor-authority";
import { claudeSandboxPilot } from "./claude-sandbox-pilot";
import { managedGvisorDiskAdmissionEnabled, managedGvisorIdlePilotConfig } from "./managed-gvisor-launch-config";
import { isCanonicalGitCanaryDeployment } from "./canonical-git-canary";
import { GvisorTierArchive, GvisorTierHandoff, gvisorTierIdleHours, gvisorTierKey, gvisorTierPilot } from "./gvisor-tier-handoff";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { HOSTED_COMPUTE_REQUIRES_PLAN_MESSAGE, paysForHostedCompute } from "@/lib/billing/hosted-compute";
import { beginInfrastructureConnectionPreparation, completeInfrastructureConnectionPreflight,
  loadInfrastructureConnectionSecret } from "@/lib/infrastructure/connection-store";
import { buildUserProxmoxEnvironment, resolveValidatedSshDestination } from "@/lib/infrastructure/connection-runtime";
import { resolveProxmoxHostCapacityPolicy } from "@/lib/infrastructure/host-capacity-policy";
import {
  hasHostAdministratorAuthority,
  hasRuntimeHostAuthority,
  LINUX_SANDBOX_PRIVILEGE_COPY,
  loadCurrentHostDiscoverySnapshot,
} from "@/lib/infrastructure/host-authority";
import { runProxmoxHostScript, runProxmoxHostScriptWithStdin } from "@/lib/services/proxmox-instance-service";
import {
  GvisorComputerReceiptSchema, GvisorComputerRequestSchema, GvisorExecReceiptSchema,
  HIVRA_GVISOR_ADAPTER_VERSION, HIVRA_GVISOR_BUNDLE_SHA256, HIVRA_GVISOR_BUNDLE_URL, HIVRA_GVISOR_PREVIOUS_ADAPTERS,
  isGvisorPendingBoundObservation, isGvisorPreflightFresh, isHivraGvisorPrepareStage,
  type GvisorComputerReceipt, type GvisorComputerRequest, type HivraGvisorPrepareStage,
} from "./gvisor-computer-contract";

const ADAPTER = "/opt/hivra/gvisor-adapter/hivra-gvisor-adapter";
const RESULT = "HIVRA_GVISOR_V1 ";
const EXEC_RESULT = "HIVRA_GVISOR_EXEC_V1 ";
const TIER_RESULT = "HIVRA_GVISOR_TIER_V1 ";
const ADMISSION_RESULT = "HIVRA_GVISOR_ADMISSION_V1 ";
const PREPARE_FAILURE = "HIVRA_GVISOR_PREPARE_FAILED_V1 ";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DiskAdmissionResult = z.object({
  version: z.literal(1),
  code: z.enum(["disk_capacity", "disk_unverified"]),
  operation: z.enum(["create", "start"]),
  computerId: z.string().uuid(),
  sandboxId: z.string().uuid(),
}).strict();

export class GvisorComputerError extends Error {
  constructor(readonly code: "not_found" | "not_ready" | "conflict" | "remote_failed" | "database_failed" | "plan_required" | "capacity_limit", message: string,
    readonly computerId: string | null = null, readonly definiteAdmissionRejection = false) {
    super(message); this.name = "GvisorComputerError";
  }
}

type GvisorAgent = {
  id: string; user_id: string; name: string; status: string; desired_state: string;
  operation_id: string | null; operation_kind: string | null; operation_payload: Record<string, unknown> | null;
  computer_substrate: string; deployment_mode: string; gvisor_sandbox_id: string;
  gvisor_adapter_version: string; gvisor_adapter_sha256: string; gvisor_runtime_sha256: string;
  gvisor_claude_terminal_image: string | null;
  gvisor_observation: Record<string, unknown> | null;
  infrastructure_connection_id: string; deployment_target_id: string;
  infrastructure_connection_revision: number; cpu: number; ram: number;
};

function db() {
  if (!supabaseAdmin) throw new GvisorComputerError("database_failed", "The computer store is unavailable.");
  return supabaseAdmin;
}

function ownerHash(userId: string): string {
  return createHash("sha256").update("hivra-gvisor-owner-v1\0").update(userId).digest("hex");
}

function cleanupReceipt(agent: GvisorAgent, receipt: GvisorComputerReceipt) {
  return { ...receipt, binding: {
    connectionId: agent.infrastructure_connection_id,
    targetId: agent.deployment_target_id,
    connectionRevision: agent.infrastructure_connection_revision,
    adapterSha256: agent.gvisor_adapter_sha256,
    runtimeSha256: agent.gvisor_runtime_sha256,
  } };
}

/** A failed host preparation, with the named stage it stopped in when the
 * script reported one. */
export class GvisorPreparationError extends GvisorComputerError {
  constructor(message: string, readonly stage: HivraGvisorPrepareStage | null) {
    super("remote_failed", message); this.name = "GvisorPreparationError";
  }
}

function preparationFailureStage(stdout: string, stderr: string): HivraGvisorPrepareStage | null {
  const stage = `${stdout}\n${stderr}`.split("\n")
    .find(line => line.startsWith(PREPARE_FAILURE))
    ?.slice(PREPARE_FAILURE.length).trim();
  return isHivraGvisorPrepareStage(stage) ? stage : null;
}

function preparationFailureMessage(stage: HivraGvisorPrepareStage | null): string {
  const messages: Record<HivraGvisorPrepareStage, string> = {
    "host-eligibility": "The host no longer meets the supported gVisor preparation requirements.",
    prerequisites: "The required Docker and installation tools could not be prepared on this host.",
    "bundle-download": "The pinned gVisor bundle could not be downloaded.",
    "bundle-checksum": "The downloaded gVisor bundle did not match its pinned checksum.",
    "bundle-validation": "The pinned gVisor bundle did not contain the expected safe runtime files.",
    "installed-adapter-check": "The host has a Linux Sandbox adapter Hivra does not recognize. Existing runtime files were not replaced.",
    "installed-identity-check": "The host has a conflicting gVisor runtime identity. Existing runtime files were not replaced.",
    "asset-installation": "The pinned gVisor runtime files could not be installed.",
    "runtime-registration": "Docker did not confirm the exact runsc runtime path within 30 seconds of its configuration reload.",
    "sidecar-validation": "The installed gVisor runtime sidecars did not pass their pinned identity checks.",
    "image-pull": "The pinned Linux application image could not be downloaded.",
    "sandbox-smoke-test": "The prepared gVisor runtime did not pass its isolated sandbox test.",
  };
  return stage ? messages[stage] : "The gVisor host preparation could not be confirmed.";
}

type GvisorBinding = Pick<GvisorAgent, "infrastructure_connection_id" | "infrastructure_connection_revision"
  | "deployment_target_id" | "gvisor_adapter_sha256" | "gvisor_runtime_sha256"> & {
    gvisor_adapter_version?: string;
    gvisor_claude_terminal_image?: string | null;
    hostIdentityDigest?: string;
  };

/** One of Hivra's own earlier adapter releases, by its exact identity. */
function previousAdapter(version: unknown, sha256: unknown): boolean {
  return HIVRA_GVISOR_PREVIOUS_ADAPTERS.some(entry => entry.version === version && entry.sha256 === sha256);
}

async function executionAuthority(userId: string, targetId: string, binding?: GvisorBinding,
  operation?: GvisorComputerRequest["operation"], exactManaged = false) {
  const { data, error } = await db().from("deployment_targets").select("id,connection_id,evidence_connection_revision,status,capabilities,supported_isolation_drivers,isolation_class,last_preflight_at")
    .eq("id", targetId).eq("user_id", userId).maybeSingle();
  if (error) throw new GvisorComputerError("database_failed", "The target could not be checked.");
  const target = data as null | { id: string; connection_id: string; evidence_connection_revision: number; status: string;
    capabilities: Record<string, unknown>; supported_isolation_drivers: string[]; isolation_class: string; last_preflight_at: string | null };
  if (!target) throw new GvisorComputerError("not_found", "The connected host target was not found.");
  if (binding && (binding.deployment_target_id !== target.id || binding.infrastructure_connection_id !== target.connection_id
    || binding.infrastructure_connection_revision !== target.evidence_connection_revision
    || (binding.hostIdentityDigest && target.capabilities?.hostIdentityDigest !== binding.hostIdentityDigest))) {
    throw new GvisorComputerError("not_ready", "This Computer's immutable host binding no longer matches its target evidence.");
  }
  const capabilities = target.capabilities;
  const adapter = capabilities?.adapter as { version?: unknown; sha256?: unknown } | undefined;
  const runtime = capabilities?.runtime as { path?: unknown; sha256?: unknown } | undefined;
  const compatibility = capabilities?.runtimeCompatibility as { contractVersion?: unknown; supportedWorkloadKinds?: unknown } | undefined;
  const resourcePolicy = capabilities?.resourcePolicy as { reservationEqualsMaximum?: unknown; aggregateAdmission?: unknown } | undefined;
  const access = capabilities?.access as { terminal?: unknown; publicPorts?: unknown } | undefined;
  // A host still on an earlier Hivra adapter keeps running its sandboxes;
  // launching one, or updating one, needs this release's adapter on the host.
  const currentAdapter = adapter?.version === HIVRA_GVISOR_ADAPTER_VERSION;
  if (adapter && !currentAdapter && previousAdapter(adapter.version, adapter.sha256)
    && (!binding || operation === "create" || operation === "update")) {
    throw new GvisorComputerError("not_ready", "Set up Linux Sandbox on this server again to use Hivra's current sandbox release. Your sandboxes keep running meanwhile.");
  }
  if (capabilities?.kind !== "gvisor"
    || !(currentAdapter || previousAdapter(adapter?.version, adapter?.sha256))
    || typeof adapter?.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(adapter.sha256)
    || runtime?.path !== "/usr/local/bin/runsc" || typeof runtime.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(runtime.sha256)
    || compatibility?.contractVersion !== 1 || !Array.isArray(compatibility.supportedWorkloadKinds)
    || compatibility.supportedWorkloadKinds.length !== 1 || compatibility.supportedWorkloadKinds[0] !== "linux-terminal"
    || resourcePolicy?.reservationEqualsMaximum !== true || resourcePolicy.aggregateAdmission !== "serialized-host-headroom-v1"
    || access?.terminal !== "owner-gated-command-v1" || access.publicPorts !== false
    || capabilities.desktop !== false || capabilities.windows !== false) {
    throw new GvisorComputerError("not_ready", "Inspect or prepare this Linux host again before launching a sandbox.");
  }
  // A sandbox pinned to an earlier Hivra adapter runs on the host's current
  // one (it manages the same resources); its owner's Update re-pins it.
  const adapterMoved = binding !== undefined && !binding.gvisor_claude_terminal_image && binding.gvisor_adapter_sha256 !== adapter.sha256
    && currentAdapter && previousAdapter(binding.gvisor_adapter_version, binding.gvisor_adapter_sha256);
  if (binding && ((binding.gvisor_adapter_sha256 !== adapter.sha256 && !adapterMoved) || binding.gvisor_runtime_sha256 !== runtime.sha256)) {
    throw new GvisorComputerError("not_ready", "This Computer's pinned gVisor adapter identity no longer matches the ready target.");
  }
  const connection = await loadInfrastructureConnectionSecret(userId, target.connection_id);
  const normalAuthority = connection.revision === target.evidence_connection_revision
    && connection.status === "ready" && target.status === "ready" && target.isolation_class === "application-kernel"
    && target.supported_isolation_drivers.length === 1 && target.supported_isolation_drivers[0] === "gvisor-runsc"
    && capabilities.launchReady === true && (binding || isGvisorPreflightFresh(target.last_preflight_at))
    && (!exactManaged || (connection.id === binding?.infrastructure_connection_id
      && currentAdapter && !adapterMoved && (operation !== "create" || isGvisorPreflightFresh(target.last_preflight_at))));
  const pendingBoundObservation = isGvisorPendingBoundObservation({ operation,
    connectionStatus: connection.status, connectionRevision: connection.revision,
    pendingFromRevision: connection.pendingBindingRebindFromRevision,
    bindingRevision: binding?.infrastructure_connection_revision ?? null,
    targetRevision: target.evidence_connection_revision });
  // Runtime authority reads no discovery snapshot (9.5): an existing computer
  // keeps working however long ago its host was last inspected.
  if (!hasRuntimeHostAuthority(connection) || (!normalAuthority && (exactManaged || !pendingBoundObservation))) {
    throw new GvisorComputerError("not_ready", "The connected host authority changed. Inspect it again.");
  }
  const destination = await resolveValidatedSshDestination(connection.endpoint.sshHost, { userId });
  const env = buildUserProxmoxEnvironment({ id: connection.id, sshHost: connection.endpoint.sshHost,
    sshPort: connection.endpoint.sshPort, sshUser: connection.endpoint.sshUser,
    sshHostFingerprintSha256: connection.endpoint.sshHostFingerprintSha256!, sshPrivateKey: connection.credentials.sshPrivateKey,
    sshPrivilege: connection.endpoint.sshPrivilege, sshHostKeyType: connection.endpoint.sshHostKeyType }, destination);
  return { target, connection, env };
}

function parseReceipt(stdout: string, marker = RESULT): GvisorComputerReceipt | ReturnType<typeof GvisorExecReceiptSchema.parse> {
  const line = stdout.split("\n").find(value => value.startsWith(marker));
  if (!line) throw new GvisorComputerError("remote_failed", "The host did not return verified gVisor evidence.");
  try {
    const payload = JSON.parse(line.slice(marker.length));
    return marker === RESULT ? GvisorComputerReceiptSchema.parse(payload) : GvisorExecReceiptSchema.parse(payload);
  } catch { throw new GvisorComputerError("remote_failed", "The host returned invalid gVisor evidence."); }
}

async function invoke(userId: string, targetId: string, request: GvisorComputerRequest, binding?: GvisorBinding) {
  return (await invokeOnTarget(userId, targetId, request, binding)).receipt;
}

/** invoke, also answering which adapter the host ran (Update re-pins to it). */
type LifecycleProof = "mutation" | "delete-observation";

function identityGuard(expectedAdapterSha: string, expectedRuntimeSha: string, runAdapter: string) {
  return `set -euo pipefail
identity_fail() { printf 'HIVRA_GVISOR_IDENTITY_MISMATCH\\n' >&2; exit 1; }
[ "$(stat -c '%U:%G:%a' '${ADAPTER}')" = 'root:root:700' ] || identity_fail
[ "$(sha256sum '${ADAPTER}' | awk '{print $1}')" = '${expectedAdapterSha}' ] || identity_fail
[ "$(sha256sum /usr/local/bin/runsc | awk '{print $1}')" = '${expectedRuntimeSha}' ] || identity_fail
[ "$(readlink -f "$(/usr/bin/docker info --format '{{(index .Runtimes "runsc").Path}}')")" = /usr/local/bin/runsc ] || identity_fail
[ "$(stat -c '%U:%G:%a' /opt/hivra/gvisor-adapter/gvisor-bin.sha256)" = 'root:root:600' ] || identity_fail
(cd / && sha256sum -c /opt/hivra/gvisor-adapter/gvisor-bin.sha256 >/dev/null) || identity_fail
${runAdapter}`;
}

async function invokeOnTarget(userId: string, targetId: string, request: GvisorComputerRequest, binding?: GvisorBinding,
  exactManaged = false, proof?: LifecycleProof) {
  const authority = await executionAuthority(userId, targetId, binding, request.operation, exactManaged);
  if (binding?.gvisor_claude_terminal_image) {
    request = { ...request, workload: { kind: "claude-terminal", image: binding.gvisor_claude_terminal_image } };
  }
  const requireDiskAdmission = exactManaged && managedGvisorDiskAdmissionEnabled()
    && (request.operation === "create" || request.operation === "start");
  const parsed = GvisorComputerRequestSchema.parse((request.operation === "create" || request.operation === "start"
    || request.operation === "resize" || request.operation === "update")
    ? { ...request, hostMemoryReserveMb: resolveProxmoxHostCapacityPolicy(authority.connection.configuration?.capacityPolicy).hostMemoryReserveMb,
      ...(requireDiskAdmission ? { requireDiskAdmission: true } : {}) }
    : request);
  const expectedAdapterSha = String((authority.target.capabilities.adapter as { sha256: string }).sha256);
  const expectedRuntimeSha = String((authority.target.capabilities.runtime as { sha256: string }).sha256);
  // The pinned adapter has no operation-ID field. Bind this response to the
  // current invocation with a fresh acknowledgement emitted only after exit 0.
  const acknowledgement = proof ? `HIVRA_GVISOR_LIFECYCLE_ACK ${randomUUID()}` : null;
  const previousContainerCheck = proof === "delete-observation"
    ? `\nprevious="$(/usr/bin/docker container ls -a --filter 'name=^/hivra-gvisor-${parsed.sandboxId}-previous$' --format '{{.Names}}')"\n[ -z "$previous" ]`
    : "";
  const runAdapter = acknowledgement
    ? `'${ADAPTER}'${previousContainerCheck}\nprintf '%s\\n' '${acknowledgement}'`
    : `exec '${ADAPTER}'`;
  const guard = identityGuard(expectedAdapterSha, expectedRuntimeSha, runAdapter);
  const result = await runProxmoxHostScriptWithStdin(guard, JSON.stringify(parsed), authority.env,
    { timeoutMs: parsed.operation === "create" || parsed.operation === "update" ? 360_000 : 90_000, maxOutputBytes: 96 * 1024 });
  if (!result.ok) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (output.includes("HIVRA_GVISOR_IDENTITY_MISMATCH")) {
      throw new GvisorComputerError("not_ready", "The installed gVisor runtime identity changed. Inspect or prepare this host before another operation.");
    }
    if (output.includes("does not have enough uncommitted capacity")
      || output.includes("needs explicit CPU and memory limits")) {
      throw new GvisorComputerError("not_ready", "This host cannot safely admit the requested limits. Reduce the sandbox size or add limits to its existing Docker workloads.", null, true);
    }
    throw new GvisorComputerError("remote_failed", "The gVisor computer operation could not be confirmed.");
  }
  if (acknowledgement) {
    const lines = result.stdout.split("\n");
    const receipts = lines.map((line, index) => line.startsWith(parsed.operation === "exec" ? EXEC_RESULT : RESULT)
      || line.startsWith(ADMISSION_RESULT) ? index : -1).filter(index => index !== -1);
    if (receipts.length !== 1 || lines.indexOf(acknowledgement) <= receipts[0]
      || lines.lastIndexOf(acknowledgement) !== lines.indexOf(acknowledgement)) {
      throw new GvisorComputerError("remote_failed", "The managed adapter did not acknowledge this operation.");
    }
    const line = lines[receipts[0]];
    if (line.startsWith(ADMISSION_RESULT)) {
      let payload: unknown;
      try { payload = JSON.parse(line.slice(ADMISSION_RESULT.length)); } catch { payload = undefined; }
      const denial = DiskAdmissionResult.safeParse(payload);
      if (!requireDiskAdmission || proof !== "mutation" || !denial.success || denial.data.operation !== parsed.operation
        || denial.data.computerId !== parsed.computerId || denial.data.sandboxId !== parsed.sandboxId) {
        throw new GvisorComputerError("remote_failed", "The host returned invalid gVisor admission evidence.");
      }
      throw new GvisorComputerError("capacity_limit", denial.data.code === "disk_capacity"
        ? "The host does not have enough available storage. Free storage before trying again."
        : "The host could not verify safe storage capacity. Try again after the host storage check passes.", null, true);
    }
  }
  const adapter = authority.target.capabilities.adapter as { version: string; sha256: string };
  const receipt = parseReceipt(result.stdout, parsed.operation === "exec" ? EXEC_RESULT : RESULT);
  if ("state" in receipt
    && (receipt.computerId !== parsed.computerId || receipt.sandboxId !== parsed.sandboxId
      || (receipt.state !== "absent" && receipt.workload?.image !== parsed.workload?.image))) {
    throw new GvisorComputerError("remote_failed", "The host returned evidence for a different sandbox.");
  }
  return { receipt, adapter: { version: adapter.version, sha256: adapter.sha256 } };
}

async function loadAgent(userId: string, agentId: string): Promise<GvisorAgent> {
  if (!UUID.test(agentId)) throw new GvisorComputerError("not_found", "Computer not found.");
  const { data, error } = await db().from("hivra_agents").select("id,user_id,name,status,desired_state,operation_id,operation_kind,operation_payload,computer_substrate,deployment_mode,gvisor_sandbox_id,gvisor_adapter_version,gvisor_adapter_sha256,gvisor_runtime_sha256,gvisor_claude_terminal_image,gvisor_observation,infrastructure_connection_id,deployment_target_id,infrastructure_connection_revision,cpu,ram")
    .eq("id", agentId).eq("user_id", userId).maybeSingle();
  if (error) throw new GvisorComputerError("database_failed", "The computer could not be read.");
  if (!data || data.id !== agentId || data.user_id !== userId
    || data.computer_substrate !== "gvisor" || !UUID.test(String(data.gvisor_sandbox_id))) {
    throw new GvisorComputerError("not_found", "gVisor computer not found.");
  }
  return data as GvisorAgent;
}

function requireSelfManagedGvisorDispatch(agent: GvisorAgent): void {
  if (agent.deployment_mode !== "self-managed") {
    throw new GvisorComputerError("not_ready", "Managed Linux terminal lifecycle is unavailable.");
  }
}

async function cancelUndispatchedManagedGvisor(agent: GvisorAgent) {
  const { data, error } = await db().rpc("cancel_undispatched_hivra_managed_gvisor", {
    p_customer: agent.user_id,
    p_computer: agent.id,
  });
  if (error) throw new GvisorComputerError("database_failed", "Managed Linux terminal cancellation could not be confirmed.");
  if (data?.status === "not_found") throw new GvisorComputerError("not_found", "gVisor computer not found.");
  const cancelled = data?.agent;
  if (data?.status !== "cancelled" || cancelled?.id !== agent.id || cancelled?.user_id !== agent.user_id
    || cancelled?.deployment_mode !== "hivra-managed" || cancelled?.computer_substrate !== "gvisor"
    || cancelled?.status !== "deleted" || cancelled?.operation_id !== null) {
    throw new GvisorComputerError("conflict", "Managed Linux terminal cancellation is unconfirmed. The reservation may still be held.");
  }
  return cancelled;
}

async function recordProvisionFailure(userId: string, targetId: string, agent: GvisorAgent,
  operationId: string, error: unknown) {
  let absenceReceipt: GvisorComputerReceipt | null = null;
  try {
    const observation = await invoke(userId, targetId, { operation: "status", ownerHash: ownerHash(userId),
      computerId: agent.id, sandboxId: agent.gvisor_sandbox_id }, agent);
    if ((observation as GvisorComputerReceipt).state === "absent") absenceReceipt = observation as GvisorComputerReceipt;
  } catch { /* Retain the provision lease when absence cannot be proven. */ }
  await db().from("hivra_agents").update(absenceReceipt
    ? { status: "error", operation_id: null, operation_kind: null, operation_started_at: null,
      operation_payload: null, gvisor_observation: absenceReceipt,
      error: error instanceof GvisorComputerError && error.code === "not_ready"
        ? "gvisor_admission_rejected" : "gvisor_launch_failed_before_create" }
    : { error: "gvisor_launch_unconfirmed" }).eq("id", agent.id).eq("operation_id", operationId);
  return absenceReceipt !== null;
}

async function createAndStartGvisorComputer(userId: string, targetId: string, agent: GvisorAgent, cpu: number, ramGb: number) {
  let receipt = await invoke(userId, targetId, { operation: "create", ownerHash: ownerHash(userId),
    computerId: agent.id, sandboxId: agent.gvisor_sandbox_id, cpu, memoryMb: ramGb * 1024 }, agent) as GvisorComputerReceipt;
  if (receipt.state === "stopped") {
    receipt = await invoke(userId, targetId, { operation: "start", ownerHash: ownerHash(userId),
      computerId: agent.id, sandboxId: agent.gvisor_sandbox_id }, agent) as GvisorComputerReceipt;
  }
  if (receipt.state !== "running") throw new GvisorComputerError("remote_failed", "The sandbox did not reach its requested running state.");
  return receipt;
}

export async function prepareGvisorHost(userId: string, connectionId: string) {
  const connection = await loadInfrastructureConnectionSecret(userId, connectionId);
  if (!hasRuntimeHostAuthority(connection)) throw new GvisorComputerError("not_ready", LINUX_SANDBOX_PRIVILEGE_COPY);
  // Prepare checks the inspection before anything is installed; its route
  // runs preflight straight after, which needs the same evidence.
  const snapshot = await loadCurrentHostDiscoverySnapshot(userId, connectionId, connection.revision)
    .catch(() => { throw new GvisorComputerError("database_failed", "Host discovery evidence could not be read."); });
  if (!snapshot) {
    throw new GvisorComputerError("not_ready", "Hivra's last look at this server has expired. Inspect it again, then set up Linux Sandbox.");
  }
  if (!hasHostAdministratorAuthority(connection, snapshot)) throw new GvisorComputerError("not_ready", LINUX_SANDBOX_PRIVILEGE_COPY);
  const destination = await resolveValidatedSshDestination(connection.endpoint.sshHost, { userId });
  const env = buildUserProxmoxEnvironment({ id: connection.id, sshHost: connection.endpoint.sshHost,
    sshPort: connection.endpoint.sshPort, sshUser: connection.endpoint.sshUser,
    sshHostFingerprintSha256: connection.endpoint.sshHostFingerprintSha256!, sshPrivateKey: connection.credentials.sshPrivateKey,
    sshPrivilege: connection.endpoint.sshPrivilege, sshHostKeyType: connection.endpoint.sshHostKeyType }, destination);
  const root = path.join(process.cwd(), "provisioner", "gvisor");
  const [prepare, adapter, xfsWorkspace, storageProbe] = await Promise.all(
    ["prepare-gvisor-host.sh", "hivra-gvisor-adapter.py", "hivra-gvisor-xfs-workspace.py", "hivra-gvisor-storage-probe.py"]
      .map(file => readFile(path.join(root, file))),
  );
  const adapterSha = createHash("sha256").update(adapter).digest("hex");
  const xfsWorkspaceSha = createHash("sha256").update(xfsWorkspace).digest("hex");
  const storageProbeSha = createHash("sha256").update(storageProbe).digest("hex");
  const script = prepare.toString("utf8");
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  if (!await beginInfrastructureConnectionPreparation(userId, connectionId, connection.revision, runId, startedAt)) {
    throw new GvisorComputerError("conflict", "Another infrastructure preparation or inspection is already running.");
  }
  try {
    const previous = HIVRA_GVISOR_PREVIOUS_ADAPTERS.map(entry => entry.sha256).join(" ");
    const remote = await runProxmoxHostScript(`export HIVRA_GVISOR_BUNDLE_URL='${HIVRA_GVISOR_BUNDLE_URL}'\nexport HIVRA_GVISOR_BUNDLE_SHA256='${HIVRA_GVISOR_BUNDLE_SHA256}'\nexport HIVRA_GVISOR_ADAPTER_SHA256='${adapterSha}'\nexport HIVRA_GVISOR_PREVIOUS_ADAPTER_SHA256S='${previous}'\nexport HIVRA_GVISOR_ADAPTER_SOURCE='${adapter.toString("base64")}'\nexport HIVRA_GVISOR_XFS_WORKSPACE_SHA256='${xfsWorkspaceSha}'\nexport HIVRA_GVISOR_XFS_WORKSPACE_SOURCE='${xfsWorkspace.toString("base64")}'\nexport HIVRA_GVISOR_STORAGE_PROBE_SHA256='${storageProbeSha}'\nexport HIVRA_GVISOR_STORAGE_PROBE_SOURCE='${storageProbe.toString("base64")}'\n${script}`, env, {
      // Prepare installs packages: under sudo it runs without the remote
      // TERM/KILL limit, so apt and dpkg are never killed mid-install.
      timeoutMs: 360_000, maxOutputBytes: 64 * 1024, remoteLimit: "none",
    });
    const receipt = remote.stdout.split("\n").find(value => value.startsWith(`HIVRA_GVISOR_PREPARED_V1 ${HIVRA_GVISOR_BUNDLE_SHA256} `));
    const runscSha256 = receipt?.split(" ")[2];
    if (!remote.ok || !receipt || !/^[0-9a-f]{64}$/.test(runscSha256 ?? "") || !receipt.endsWith(` ${adapterSha}`)) {
      const stage = preparationFailureStage(remote.stdout, remote.stderr);
      throw new GvisorPreparationError(preparationFailureMessage(stage), stage);
    }
    return { adapterVersion: HIVRA_GVISOR_ADAPTER_VERSION, adapterSha256: adapterSha,
      bundleUrl: HIVRA_GVISOR_BUNDLE_URL, bundleSha256: HIVRA_GVISOR_BUNDLE_SHA256, runscSha256,
      runId, connectionRevision: connection.revision };
  } catch (error) {
    await completeInfrastructureConnectionPreflight(userId, connectionId, connection.revision, runId, {
      connectionStatus: "error", checkedAt: new Date().toISOString(), lastErrorCode: "PROVISIONER_UNAVAILABLE", target: null,
    }).catch(() => false);
    throw error;
  }
}

/** Owner-bound receipt lookup for a gVisor launch whose original HTTP response
 * was lost. This reads the immutable launch request identity and never
 * dispatches or resumes host work. */
export async function findGvisorComputerByLaunchRequest(userId: string, launchRequestId: string) {
  const canonicalLaunchRequestId = launchRequestId.toLowerCase();
  if (!UUID.test(canonicalLaunchRequestId)) throw new GvisorComputerError("not_found", "Launch receipt not found.");
  const { data, error } = await db().from("hivra_agents").select("*")
    .eq("user_id", userId).eq("gvisor_launch_request_id", canonicalLaunchRequestId).maybeSingle();
  if (error) throw new GvisorComputerError("database_failed", "The launch receipt could not be read.");
  if (!data) return null;
  if (data.user_id !== userId || data.gvisor_launch_request_id !== canonicalLaunchRequestId
    || data.computer_substrate !== "gvisor" || data.type !== "linux-terminal"
    || data.computer_profile !== "linux-terminal" || !UUID.test(String(data.id))) {
    throw new GvisorComputerError("database_failed", "The launch receipt identity did not match.");
  }
  return data as Record<string, unknown>;
}

export async function launchGvisorComputer(input: { userId: string; targetId: string; launchRequestId: string; name: string; cpu: number; ramGb: number; claudeTerminal?: boolean }) {
  const pilot = input.claudeTerminal ? claudeSandboxPilot(input.userId) : null;
  if (input.claudeTerminal && (!pilot || pilot.target !== input.targetId)) {
    throw new GvisorComputerError("not_found", "Claude Code sandboxes are not available on this target.");
  }
  const image = pilot?.image ?? null;
  const { data: replay, error: replayError } = await db().from("hivra_agents").select("*")
    .eq("user_id", input.userId).eq("gvisor_launch_request_id", input.launchRequestId).maybeSingle();
  if (replayError) throw new GvisorComputerError("database_failed", "The launch request could not be reconciled.");
  if (replay) {
    if (replay.user_id !== input.userId || replay.deployment_mode !== "self-managed"
      || replay.computer_substrate !== "gvisor" || replay.deployment_target_id !== input.targetId
      || (replay.gvisor_claude_terminal_image ?? null) !== image) {
      throw new GvisorComputerError("conflict", "This launch request ID is already bound to different Computer settings.");
    }
    const settingsMatch = replay.name === input.name && Number(replay.cpu) === input.cpu && Number(replay.ram) === input.ramGb;
    if (replay.status === "running" && !replay.operation_id) {
      if (!settingsMatch) throw new GvisorComputerError("conflict", "This launch request already created a Computer with different settings.");
      return replay;
    }
    if (replay.status === "error" && !replay.operation_id) {
      const operationId = randomUUID();
      const { data: reclaimed, error: reclaimError } = await db().from("hivra_agents").update({ name: input.name,
        cpu: input.cpu, ram: input.ramGb, cpu_max: input.cpu, ram_max: input.ramGb, status: "provisioning",
        desired_state: "running", error: null, operation_id: operationId, operation_kind: "provision",
        operation_started_at: new Date().toISOString(), operation_payload: { sandboxId: replay.gvisor_sandbox_id,
          cpu: input.cpu, ram: input.ramGb } }).eq("id", replay.id).eq("user_id", input.userId)
        .is("operation_id", null).eq("status", "error").select("*").single();
      if (reclaimError || !reclaimed) throw new GvisorComputerError("conflict", "The failed launch changed before retry.");
      replay.operation_id = operationId; replay.operation_kind = "provision";
    } else if (!settingsMatch) {
      throw new GvisorComputerError("conflict", "Resume the pending launch with its original Computer settings.");
    }
    if (replay.operation_kind !== "provision" || !replay.operation_id || !UUID.test(String(replay.gvisor_sandbox_id))) {
      throw new GvisorComputerError("conflict", "This launch request is already bound to a Computer that cannot be resumed.");
    }
    let receipt: GvisorComputerReceipt;
    try {
      receipt = await createAndStartGvisorComputer(input.userId, input.targetId, replay as GvisorAgent, input.cpu, input.ramGb);
    } catch (error) {
      const absent = await recordProvisionFailure(input.userId, input.targetId, replay as GvisorAgent, replay.operation_id, error);
      if (absent && error instanceof GvisorComputerError) {
        throw new GvisorComputerError(error.code, error.message, replay.id);
      }
      throw error;
    }
    const { data: completed, error: completeError } = await db().from("hivra_agents").update({ status: "running",
      provisioned_at: replay.provisioned_at ?? new Date().toISOString(), operation_id: null, operation_kind: null,
      operation_started_at: null, operation_payload: null, error: null, gvisor_observation: receipt })
      .eq("id", replay.id).eq("user_id", input.userId).eq("operation_id", replay.operation_id).select("*").single();
    if (completeError || !completed) throw new GvisorComputerError("database_failed", "The resumed sandbox could not be committed.");
    return completed;
  }
  const authority = await executionAuthority(input.userId, input.targetId);
  const adapterSha256 = String((authority.target.capabilities.adapter as { sha256: string }).sha256);
  const runtimeSha256 = String((authority.target.capabilities.runtime as { sha256: string }).sha256);
  if (pilot && adapterSha256 !== pilot.adapter) {
    throw new GvisorComputerError("not_ready", "The Claude Code sandbox host must be qualified again.");
  }
  const computerId = randomUUID(), sandboxId = randomUUID(), operationId = randomUUID();
  const { data, error } = await db().from("hivra_agents").insert({ id: computerId, user_id: input.userId, type: "linux-terminal",
    computer_profile: "linux-terminal", name: input.name, status: "provisioning", desired_state: "running", deployment_mode: "self-managed",
    computer_substrate: "gvisor", proxmox_host: "__hivra_self_managed_no_ambient_authority__", vmid: null, cpu: input.cpu, ram: input.ramGb,
    cpu_max: input.cpu, ram_max: input.ramGb, infrastructure_connection_id: authority.connection.id, deployment_target_id: input.targetId,
    infrastructure_connection_revision: authority.connection.revision, infrastructure_binding_token_hash: ownerHash(input.userId),
    infrastructure_binding_token_enforced: true, gvisor_sandbox_id: sandboxId, gvisor_adapter_version: HIVRA_GVISOR_ADAPTER_VERSION,
    gvisor_adapter_sha256: adapterSha256, gvisor_runtime_sha256: runtimeSha256,
    ...(image ? { gvisor_claude_terminal_image: image } : {}),
    gvisor_launch_request_id: input.launchRequestId, operation_id: operationId, operation_kind: "provision", operation_started_at: new Date().toISOString(),
    operation_payload: { sandboxId, cpu: input.cpu, ram: input.ramGb } }).select("*").single();
  if (error || !data) throw new GvisorComputerError("database_failed", "The gVisor computer reservation failed.");
  try {
    const receipt = await createAndStartGvisorComputer(input.userId, input.targetId, data as GvisorAgent, input.cpu, input.ramGb);
    const { data: completed, error: completeError } = await db().from("hivra_agents").update({ status: "running", provisioned_at: new Date().toISOString(),
      operation_id: null, operation_kind: null, operation_started_at: null, operation_payload: null, error: null, gvisor_observation: receipt })
      .eq("id", computerId).eq("user_id", input.userId).eq("operation_id", operationId).select("*").single();
    if (completeError || !completed) throw new GvisorComputerError("database_failed", "The running sandbox could not be committed.");
    return completed;
  } catch (error) {
    const absent = await recordProvisionFailure(input.userId, input.targetId, data as GvisorAgent, operationId, error);
    if (absent && error instanceof GvisorComputerError) {
      throw new GvisorComputerError(error.code, error.message, computerId);
    }
    throw error;
  }
}

const ManagedGvisorClaim = z.object({
  status: z.enum(["claimed", "observe"]), action: z.enum(["start", "stop", "delete"]).optional(), claimId: z.string().uuid(), customerId: z.string(), computerId: z.string().uuid(),
  operationId: z.string().uuid(), operatorId: z.string(), connectionId: z.string().uuid(), targetId: z.string().uuid(),
  revision: z.number().int().positive().safe(), sandboxId: z.string().uuid(),
  adapterSha: z.string().regex(/^[0-9a-f]{64}$/), runtimeSha: z.string().regex(/^[0-9a-f]{64}$/),
  cpu: z.number(), ram: z.number(),
}).strict();

type ManagedGvisorBinding = z.infer<typeof ManagedGvisorClaim>;

function managedGvisorHostBinding(binding: ManagedGvisorBinding): GvisorBinding {
  return {
    infrastructure_connection_id: binding.connectionId, deployment_target_id: binding.targetId,
    infrastructure_connection_revision: binding.revision, gvisor_adapter_version: HIVRA_GVISOR_ADAPTER_VERSION,
    gvisor_adapter_sha256: binding.adapterSha, gvisor_runtime_sha256: binding.runtimeSha,
  };
}

async function invokeManagedGvisor(binding: ManagedGvisorBinding,
  operation: "create" | "start" | "stop" | "delete" | "status", proof?: LifecycleProof) {
  const { receipt } = await invokeOnTarget(binding.operatorId, binding.targetId, {
    operation, ownerHash: ownerHash(binding.customerId), computerId: binding.computerId, sandboxId: binding.sandboxId,
    ...(operation === "create" ? { cpu: binding.cpu, memoryMb: binding.ram * 1024 } : {}),
  }, managedGvisorHostBinding(binding), true, proof);
  const validated = GvisorComputerReceiptSchema.parse(receipt);
  if (validated.computerId !== binding.computerId || validated.sandboxId !== binding.sandboxId
    || (validated.state !== "absent" && (validated.adapterVersion !== HIVRA_GVISOR_ADAPTER_VERSION
      || validated.cpu !== binding.cpu || validated.memoryMb !== binding.ram * 1024
      || validated.workspace !== `hivra-gvisor-workspace-${binding.sandboxId}`
      || validated.network !== `hivra-gvisor-net-${binding.sandboxId}`))) {
    throw new GvisorComputerError("remote_failed", "The managed adapter receipt did not match the reservation.");
  }
  return validated;
}

function managedProvisionFence(binding: ManagedGvisorBinding) {
  return { p_customer: binding.customerId, p_computer: binding.computerId,
    p_operation: binding.operationId, p_claim: binding.claimId };
}

async function completeManagedProvision(binding: ManagedGvisorBinding, receipt: GvisorComputerReceipt) {
  if (receipt.state !== "running") return false;
  const { data, error } = await db().rpc("complete_hivra_managed_gvisor_ready", {
    ...managedProvisionFence(binding), p_receipt: receipt,
  });
  return data === true && !error;
}

async function readManagedGvisorBinding(userId: string, computerId: string, expectedOperationId?: string, requireRunning = false) {
  const { data, error } = await db().rpc("read_hivra_managed_gvisor_observation", {
    p_customer: userId, p_computer: computerId, ...(requireRunning ? { p_require_running: true } : {}),
  });
  const result = ManagedGvisorClaim.safeParse(data);
  if (error || !result.success || result.data.status !== "observe" || result.data.customerId !== userId
    || result.data.computerId !== computerId || (expectedOperationId && result.data.operationId !== expectedOperationId)) {
    throw new GvisorComputerError("not_ready", "The managed sandbox observation authority could not be confirmed.");
  }
  return result.data;
}

async function observeManagedProvision(userId: string, computerId: string, expectedOperationId?: string) {
  const binding = await readManagedGvisorBinding(userId, computerId, expectedOperationId);
  const receipt = await invokeManagedGvisor(binding, "status", expectedOperationId ? "mutation" : undefined);
  if (expectedOperationId && receipt.state === "running" && !await completeManagedProvision(binding, receipt)) {
    throw new GvisorComputerError("conflict", "The managed running receipt could not be committed.");
  }
  return receipt;
}

async function readTierHandoff(userId: string, computerId: string) {
  if (!isCanonicalGitCanaryDeployment() || process.env.HIVRA_MANAGED_GVISOR_TIER_COMPUTER_ID !== computerId) return null;
  const { data, error } = await db().rpc("read_hivra_gvisor_tier_handoff", {
    p_customer: userId, p_computer: computerId,
  });
  if (error) throw new GvisorComputerError("database_failed", "The managed sandbox placement could not be verified.");
  if (data === null) return null;
  const row = GvisorTierHandoff.safeParse(data);
  if (!row.success || row.data.computer_id !== computerId || row.data.customer_id !== userId) {
    throw new GvisorComputerError("not_ready", "The managed sandbox placement did not match.");
  }
  return row.data;
}

function tierPilotFor(agent: GvisorAgent, row?: GvisorTierHandoff, retire = false) {
  const pilot = gvisorTierPilot(process.env, retire && row ? Date.parse(row.created_at) : Date.now());
  return pilot && pilot.ownerId === agent.user_id && pilot.computer === agent.id
    && (!row || (row.operator_id === pilot.authorityUserId && row.source_connection_id === pilot.connectionId
      && row.source_target_id === pilot.targetId && row.source_revision === pilot.connectionRevision
      && row.source_sandbox_id === agent.gvisor_sandbox_id
      && row.adapter_sha256 === agent.gvisor_adapter_sha256 && row.runtime_sha256 === agent.gvisor_runtime_sha256
      && row.destination_connection_id === pilot.destinationConnection && row.destination_target_id === pilot.destinationTarget
      && row.destination_revision === pilot.destinationRevision && (retire || Date.parse(row.expires_at) > Date.now())))
    ? pilot : null;
}

function tierBinding(row: GvisorTierHandoff, side: "source" | "destination"): GvisorBinding {
  return {
    deployment_target_id: row[`${side}_target_id`],
    infrastructure_connection_id: row[`${side}_connection_id`],
    infrastructure_connection_revision: row[`${side}_revision`],
    gvisor_adapter_version: HIVRA_GVISOR_ADAPTER_VERSION,
    gvisor_adapter_sha256: row.adapter_sha256,
    gvisor_runtime_sha256: row.runtime_sha256,
    hostIdentityDigest: row[`${side}_host_identity_digest`],
  };
}

async function invokeTier(agent: GvisorAgent, row: GvisorTierHandoff,
  operation: "tier-checkpoint" | "tier-restore" | "tier-retire", side: "source" | "destination") {
  const pilot = tierPilotFor(agent, row, operation === "tier-retire");
  if (!pilot) throw new GvisorComputerError("not_ready", "The managed sandbox storage pilot is not active.");
  const restore = operation === "tier-restore";
  const binding = tierBinding(row, side);
  const authority = await executionAuthority(row.operator_id, binding.deployment_target_id, binding, restore ? "create" : "status", true);
  const sandboxId = row[`${side}_sandbox_id`];
  const acknowledgement = `HIVRA_GVISOR_TIER_ACK ${randomUUID()}`;
  const guard = identityGuard(row.adapter_sha256, row.runtime_sha256, `'${ADAPTER}'
printf '%s\\n' '${acknowledgement}'`);
  const response = await runProxmoxHostScriptWithStdin(guard, JSON.stringify({
    operation, ownerHash: ownerHash(agent.user_id), computerId: agent.id, sandboxId,
    ...(restore ? { cpu: Number(agent.cpu), memoryMb: Math.round(Number(agent.ram) * 1024),
      hostMemoryReserveMb: resolveProxmoxHostCapacityPolicy(authority.connection.configuration?.capacityPolicy).hostMemoryReserveMb } : {}),
    tier: { generation: row.generation, logicalSandboxId: row.source_sandbox_id, runtime: row.runtime_sha256, helperSha: pilot.helperSha,
      ...(operation !== "tier-retire" ? { codecSha: pilot.codecSha,
        key: gvisorTierKey(pilot.key, ownerHash(agent.user_id), agent.id, row.generation) } : {}),
      ...(restore ? { receipt: row.checkpoint_receipt?.archive } : {}) },
  }), authority.env, { timeoutMs: 90_000, maxOutputBytes: 16 * 1024 });
  const lines = response.stdout.split("\n");
  const evidence = lines.filter(line => line.startsWith(TIER_RESULT));
  const ack = lines.filter(line => line === acknowledgement);
  if (!response.ok || evidence.length !== 1 || ack.length !== 1 || lines.indexOf(evidence[0]) >= lines.indexOf(ack[0])) {
    throw new GvisorComputerError("remote_failed", "The managed sandbox storage handoff is unconfirmed.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(evidence[0].slice(TIER_RESULT.length)); } catch { parsed = null; }
  const receipt = z.object({ generation: z.literal(row.generation), computerId: z.literal(agent.id),
    sandboxId: z.literal(sandboxId), hostMs: z.number().int().nonnegative().safe(), result: z.unknown() }).strict().safeParse(parsed);
  if (!receipt.success) throw new GvisorComputerError("remote_failed", "The managed sandbox handoff evidence was invalid.");
  const identity = { version: 1, computerId: agent.id, generation: row.generation, sandboxId,
    connectionId: binding.infrastructure_connection_id, targetId: binding.deployment_target_id,
    revision: binding.infrastructure_connection_revision, hostIdentityDigest: binding.hostIdentityDigest };
  if (operation === "tier-checkpoint") {
    const archive = GvisorTierArchive.safeParse(receipt.data.result);
    if (!archive.success) throw new GvisorComputerError("remote_failed", "The checkpoint archive evidence was invalid.");
    return { ...identity, state: "checkpointed", checkpointDigest: archive.data.sha256, archive: archive.data };
  }
  const health = GvisorComputerReceiptSchema.safeParse(receipt.data.result);
  if (operation === "tier-retire") {
    if (!health.success || health.data.state !== "absent" || health.data.computerId !== agent.id || health.data.sandboxId !== sandboxId) {
      throw new GvisorComputerError("remote_failed", "The retired sandbox absence evidence was invalid.");
    }
    return { ...identity, state: "absent" };
  }
  if (!health.success || health.data.state !== "running" || health.data.computerId !== agent.id
    || health.data.sandboxId !== sandboxId || health.data.adapterVersion !== HIVRA_GVISOR_ADAPTER_VERSION
    || health.data.cpu !== Number(agent.cpu) || health.data.memoryMb !== Math.round(Number(agent.ram) * 1024)
    || health.data.workspace !== `hivra-gvisor-workspace-${sandboxId}`
    || health.data.network !== `hivra-gvisor-net-${sandboxId}` || !row.checkpoint_receipt) {
    throw new GvisorComputerError("remote_failed", "The restored sandbox health evidence was invalid.");
  }
  log.info("Managed gVisor tier restore ready", { source: "gvisor-tier", hostMs: receipt.data.hostMs });
  return { ...identity, state: "running", checkpointDigest: row.checkpoint_receipt.checkpointDigest };
}

export async function sleepManagedGvisorTier(userId: string, computerId: string, mode: "manual" | "auto" = "manual") {
  const agent = await loadAgent(userId, computerId);
  const pilot = tierPilotFor(agent);
  if (!pilot || agent.deployment_mode !== "hivra-managed" || agent.status !== "running" || agent.operation_id) {
    if (mode === "auto") return false;
    throw new GvisorComputerError("not_ready", "This sandbox is not enrolled in the shared storage pilot.");
  }
  const entitlement = await resolveEffectiveSubscription(userId, { throwOnQueryError: true });
  if (!entitlement || !paysForHostedCompute(entitlement)) {
    if (mode === "auto") return false;
    throw new GvisorComputerError("plan_required", HOSTED_COMPUTE_REQUIRES_PLAN_MESSAGE);
  }
  const idleHours = mode === "auto" ? gvisorTierIdleHours(entitlement.plan) : null;
  if (mode === "auto" && idleHours === null) return false;
  let row = await readTierHandoff(userId, computerId);
  if (mode === "auto" && row) return false;
  if (!row) {
    const { data, error } = await db().rpc("begin_hivra_gvisor_tier_handoff", {
      p_customer: userId, p_computer: computerId, p_operator: pilot.authorityUserId, p_source_connection: pilot.connectionId,
      p_source_target: pilot.targetId, p_source_revision: pilot.connectionRevision, p_destination_connection: pilot.destinationConnection,
      p_destination_target: pilot.destinationTarget, p_destination_revision: pilot.destinationRevision,
      p_generation: randomUUID(), p_destination_sandbox: randomUUID(), p_expires_at: new Date(pilot.expiresAtMs).toISOString(),
      ...(idleHours !== null ? { p_idle_hours: idleHours } : {}),
    });
    if (error) throw new GvisorComputerError("database_failed", "The managed sandbox handoff claim could not be confirmed.");
    const candidate = GvisorTierHandoff.safeParse(data);
    if (data === null && mode === "auto") return false;
    if (candidate.success && candidate.data.computer_id === computerId && candidate.data.customer_id === userId) row = candidate.data;
  }
  if (!row || !tierPilotFor(agent, row) || row.phase === "running" || row.phase === "retiring") {
    throw new GvisorComputerError("conflict", "The managed sandbox cannot be checkpointed in its current placement.");
  }
  if (row.phase === "sleeping") return true;
  const receipt = await invokeTier(agent, row, "tier-checkpoint", "source");
  const { data, error } = await db().rpc("commit_hivra_gvisor_tier_checkpoint", {
    p_customer: userId, p_computer: computerId, p_generation: row.generation, p_receipt: receipt,
  });
  const saved = GvisorTierHandoff.safeParse(data);
  if (error || !saved.success || saved.data.phase !== "sleeping" || saved.data.generation !== row.generation) {
    throw new GvisorComputerError("conflict", "The source is fenced, but the checkpoint record is unconfirmed.");
  }
  return true;
}

async function wakeTier(agent: GvisorAgent, row: GvisorTierHandoff) {
  if (row.phase !== "sleeping" && row.phase !== "running") {
    throw new GvisorComputerError("conflict", "The workspace is not available to wake.");
  }
  if (row.phase === "running") return;
  const receipt = await invokeTier(agent, row, "tier-restore", "destination");
  const { data, error } = await db().rpc("commit_hivra_gvisor_tier_running", {
    p_customer: agent.user_id, p_computer: agent.id, p_generation: row.generation, p_receipt: receipt,
  });
  const saved = GvisorTierHandoff.safeParse(data);
  if (error || !saved.success || saved.data.phase !== "running" || saved.data.generation !== row.generation) {
    throw new GvisorComputerError("conflict", "The restored sandbox placement could not be committed.");
  }
}

async function retireTier(agent: GvisorAgent, row: GvisorTierHandoff) {
  if (!tierPilotFor(agent, row, true)) throw new GvisorComputerError("not_ready", "The managed sandbox storage pilot is not active.");
  const claim = { p_customer: agent.user_id, p_computer: agent.id, p_generation: row.generation, p_operator: row.operator_id };
  const { data, error } = await db().rpc("claim_hivra_gvisor_tier_retire", claim);
  const held = GvisorTierHandoff.safeParse(data);
  if (error || !held.success || held.data.phase !== "retiring" || held.data.generation !== row.generation
    || held.data.computer_id !== agent.id || held.data.customer_id !== agent.user_id) {
    throw new GvisorComputerError("conflict", "The sandbox retirement could not be claimed.");
  }
  const [source, destination] = await Promise.all([
    invokeTier(agent, held.data, "tier-retire", "source"),
    invokeTier(agent, held.data, "tier-retire", "destination"),
  ]);
  const settled = await db().rpc("commit_hivra_gvisor_tier_retire", {
    ...claim, p_source_receipt: source, p_destination_receipt: destination,
  });
  if (settled.error || settled.data !== true) throw new GvisorComputerError("conflict", "The sandbox retirement is unconfirmed.");
  return loadAgent(agent.user_id, agent.id);
}

/** The server launch gate supplies paid limits and exact operator authority. */
export async function reserveAndDispatchManagedGvisor(input: {
  userId: string; launchRequestId: string; name: string; cpu: number; ramGb: number; authority: ManagedGvisorAuthority;
}): Promise<{ state: "reconciling" | "cleaned" | "ready"; computerId: string }> {
  const { userId, authority, launchRequestId, name, cpu, ramGb } = input;
  if (managedGvisorDiskAdmissionEnabled() && previousAdapter(HIVRA_GVISOR_ADAPTER_VERSION, authority.adapterSha)) {
    throw new GvisorComputerError("not_ready", "This host needs the managed storage admission adapter before launching.");
  }
  const { data: reserved, error } = await db().rpc("reserve_hivra_managed_gvisor", {
    p_customer: userId, p_request: launchRequestId, p_name: name, p_cpu: cpu, p_ram: ramGb,
    p_agent_limit: authority.agentLimit, p_operator: authority.authorityUserId, p_connection: authority.connectionId,
    p_target: authority.targetId, p_revision: authority.connectionRevision,
    p_adapter_sha: authority.adapterSha, p_runtime_sha: authority.runtimeSha,
    p_cpu_budget: authority.cpuBudget, p_ram_budget_mb: authority.ramBudgetMb,
    p_max_cpu: authority.maxCpu, p_max_ram_mb: authority.maxRamMb,
  });
  if (error) throw new GvisorComputerError("database_failed", "The reservation could not be confirmed. Reuse the original request ID.");
  if (reserved?.status === "ready" && UUID.test(String(reserved.computerId))) {
    return { state: "ready", computerId: reserved.computerId };
  }
  if (reserved?.status === "plan_agent_limit" || reserved?.status === "plan_compute_limit") {
    throw new GvisorComputerError("capacity_limit", "This Linux terminal sandbox exceeds the remaining capacity or limits of your plan.");
  }
  if (["conflict", "cancelled", "authority_changed"].includes(reserved?.status)) {
    throw new GvisorComputerError("conflict", "This managed reservation could not proceed.");
  }
  if ((reserved?.status !== "reserved" && reserved?.status !== "replay")
    || !UUID.test(String(reserved.computerId)) || !UUID.test(String(reserved.operationId))) {
    throw new GvisorComputerError("database_failed", "The reservation could not be confirmed. Reuse the original request ID.");
  }
  const { computerId, operationId } = reserved;
  const pending = { state: "reconciling" as const, computerId };
  try {
    const { data, error: claimError } = await db().rpc("claim_hivra_managed_gvisor_dispatch", {
      p_customer: userId, p_computer: computerId, p_operation: operationId,
    });
    if (claimError) return pending;
    if (data?.status === "held") {
      const receipt = await observeManagedProvision(userId, computerId, operationId);
      return receipt.state === "running" ? { state: "ready", computerId } : pending;
    }
    const parsedClaim = ManagedGvisorClaim.safeParse(data);
    if (!parsedClaim.success || parsedClaim.data.status !== "claimed") return pending;
    const claim = parsedClaim.data;
    if (claim.customerId !== userId || claim.computerId !== computerId || claim.operationId !== operationId
      || claim.operatorId !== authority.authorityUserId || claim.targetId !== authority.targetId
      || claim.connectionId !== authority.connectionId || claim.revision !== authority.connectionRevision
      || claim.adapterSha !== authority.adapterSha || claim.runtimeSha !== authority.runtimeSha
      || claim.cpu !== cpu || claim.ram !== ramGb) return pending;
    let created: GvisorComputerReceipt;
    try {
      created = await invokeManagedGvisor(claim, "create", "mutation");
    } catch (error) {
      if (!(error instanceof GvisorComputerError) || !error.definiteAdmissionRejection) throw error;
      const observation = await invokeManagedGvisor(claim, "status", "mutation").catch(() => null);
      if (observation?.state !== "absent") return pending;
      const fence = managedProvisionFence(claim);
      const { data: cleanup, error: cleanupError } = await db().rpc("begin_hivra_managed_gvisor_cleanup", fence);
      if (cleanup !== true || cleanupError) return pending;
      const { data: released, error: releaseError } = await db().rpc("release_hivra_managed_gvisor_absent", {
        ...fence, p_receipt: observation,
      });
      return released === true && !releaseError ? { state: "cleaned", computerId } : pending;
    }
    const started = created.state === "stopped" ? await invokeManagedGvisor(claim, "start", "mutation") : created;
    if (started.state === "running") {
      return await completeManagedProvision(claim, started) ? { state: "ready", computerId } : pending;
    }
    if (started.state !== "stopped") return pending;
    // Fence cleanup against read-only reconciliation before submitting delete.
    const fence = managedProvisionFence(claim);
    const { data: cleanup, error: cleanupError } = await db().rpc("begin_hivra_managed_gvisor_cleanup", fence);
    if (cleanup !== true || cleanupError) return pending;
    const absent = await invokeManagedGvisor(claim, "delete", "mutation");
    if (absent.state !== "absent") return pending;
    const { data: released, error: releaseError } = await db().rpc("release_hivra_managed_gvisor_absent", {
      ...fence, p_receipt: absent,
    });
    return released === true && !releaseError ? { state: "cleaned", computerId } : pending;
  } catch {
    // A claimed operation is intentionally durable across every unknown result.
    return pending;
  }
}

export async function observeGvisorComputer(userId: string, agentId: string) {
  const agent = await loadAgent(userId, agentId);
  if (agent.deployment_mode === "hivra-managed") {
    const row = await readTierHandoff(userId, agent.id);
    const pilot = tierPilotFor(agent, row ?? undefined);
    if (!row) {
      const result = await observeManagedProvision(userId, agent.id, agent.operation_kind === "provision" ? agent.operation_id ?? undefined : undefined);
      return pilot && agent.status === "running" && !agent.operation_id ? { ...result, tierState: "eligible" as const } : result;
    }
    if (!pilot) throw new GvisorComputerError("not_ready", "The managed sandbox storage pilot is not active.");
    if (row.phase !== "running") {
      return { state: "stopped" as const, tierState: row.phase };
    }
    const { receipt } = await invokeOnTarget(row.operator_id, row.destination_target_id, {
      operation: "status", ownerHash: ownerHash(userId), computerId: agent.id, sandboxId: row.destination_sandbox_id,
    }, tierBinding(row, "destination"), true);
    const observed = GvisorComputerReceiptSchema.parse(receipt);
    if (observed.computerId !== agent.id || observed.sandboxId !== row.destination_sandbox_id) {
      throw new GvisorComputerError("not_ready", "The managed sandbox placement did not match.");
    }
    return { ...observed, tierState: "moved" as const };
  }
  requireSelfManagedGvisorDispatch(agent);
  return invoke(userId, agent.deployment_target_id, { operation: "status", ownerHash: ownerHash(userId), computerId: agent.id, sandboxId: agent.gvisor_sandbox_id }, agent);
}

export async function openClaudeSandboxTerminal(userId: string, agentId: string) {
  const pilot = claudeSandboxPilot(userId);
  if (!pilot) throw new GvisorComputerError("not_found", "Claude Code sandbox not found.");
  const agent = await loadAgent(userId, agentId);
  if (agent.deployment_mode !== "self-managed" || agent.deployment_target_id !== pilot.target
    || agent.gvisor_claude_terminal_image !== pilot.image || agent.gvisor_adapter_sha256 !== pilot.adapter) {
    throw new GvisorComputerError("not_found", "Claude Code sandbox not found.");
  }
  if (agent.status !== "running" || agent.operation_id) {
    throw new GvisorComputerError("not_ready", "Start this sandbox before opening Claude Code.");
  }
  const receipt = await invoke(userId, pilot.target, { operation: "status", ownerHash: ownerHash(userId),
    computerId: agent.id, sandboxId: agent.gvisor_sandbox_id }, agent);
  if (!("state" in receipt) || receipt.state !== "running" || receipt.workloadReady !== true) {
    throw new GvisorComputerError("not_ready", "Claude Code is not ready yet. Try again from the sandbox.");
  }
  const expires = Math.floor(Date.now() / 1000) + 45;
  const nonce = randomBytes(16).toString("hex");
  const mac = createHmac("sha256", Buffer.from(pilot.grantKey, "hex"))
    .update(`v1\n${pilot.origin}\n${ownerHash(userId)}\n${agent.gvisor_sandbox_id}\n${expires}\n${nonce}`).digest("hex");
  return { origin: pilot.origin, token: `v1.${expires}.${nonce}.${mac}` };
}

export async function executeGvisorComputerCommand(userId: string, agentId: string, argv: string[]) {
  const requested = performance.now();
  const agent = await loadAgent(userId, agentId);
  if (agent.deployment_mode === "hivra-managed") {
    if (agent.status !== "running" || agent.operation_id) {
      throw new GvisorComputerError("not_ready", "The managed sandbox terminal is not ready.");
    }
    const tier = await readTierHandoff(userId, agent.id);
    if (tier) {
      if (!tierPilotFor(agent, tier)) throw new GvisorComputerError("not_ready", "The managed sandbox storage pilot is not active.");
      if (tier.phase === "sleeping") {
        const entitlement = await resolveEffectiveSubscription(userId, { throwOnQueryError: true });
        if (!paysForHostedCompute(entitlement)) throw new GvisorComputerError("plan_required", HOSTED_COMPUTE_REQUIRES_PLAN_MESSAGE);
      }
      await wakeTier(agent, tier);
      const result = await invokeOnTarget(tier.operator_id, tier.destination_target_id, {
        operation: "exec", ownerHash: ownerHash(userId), computerId: agent.id, sandboxId: tier.destination_sandbox_id, argv,
      }, tierBinding(tier, "destination"), true, "mutation");
      if (tier.phase === "sleeping") {
        log.info("Managed gVisor tier wake command returned", {
          source: "gvisor-tier", durationMs: Math.round(performance.now() - requested),
        });
      }
      return result.receipt;
    }
    const binding = await readManagedGvisorBinding(userId, agent.id, undefined, true);
    if (binding.sandboxId !== agent.gvisor_sandbox_id || binding.adapterSha !== agent.gvisor_adapter_sha256
      || binding.runtimeSha !== agent.gvisor_runtime_sha256) {
      throw new GvisorComputerError("not_ready", "The managed sandbox terminal authority could not be confirmed.");
    }
    const pilot = managedGvisorIdlePilotConfig() ?? tierPilotFor(agent);
    let commandClaim: string | null = null;
    if (pilot && pilot.ownerId === userId && matchesIdlePilotTarget(pilot, binding)) {
      const { data, error } = await db().rpc("claim_hivra_managed_gvisor_pilot_command", {
        p_customer: userId, p_computer: agent.id, p_expires_at: new Date(pilot.expiresAtMs).toISOString(),
      });
      if (error) throw new GvisorComputerError("database_failed", "The managed sandbox command claim could not be confirmed.");
      if (typeof data !== "string" || !UUID.test(data)) {
        throw new GvisorComputerError("conflict", "The sandbox is busy or stopped. Check its status before running another command.");
      }
      commandClaim = data;
    }
    const result = await invokeOnTarget(binding.operatorId, binding.targetId, {
      operation: "exec", ownerHash: ownerHash(userId), computerId: agent.id, sandboxId: binding.sandboxId, argv,
    }, managedGvisorHostBinding(binding), true, "mutation");
    if (commandClaim) {
      const { data, error } = await db().rpc("complete_hivra_managed_gvisor_pilot_command", {
        p_customer: userId, p_computer: agent.id, p_claim: commandClaim,
      });
      if (error || data !== true) throw new GvisorComputerError("conflict", "The sandbox command finished but its activity could not be confirmed. Do not replay it automatically.");
    }
    return result.receipt;
  }
  requireSelfManagedGvisorDispatch(agent);
  return invoke(userId, agent.deployment_target_id, { operation: "exec", ownerHash: ownerHash(userId), computerId: agent.id, sandboxId: agent.gvisor_sandbox_id, argv }, agent);
}

type ManagedGvisorIdlePilot = NonNullable<ReturnType<typeof managedGvisorIdlePilotConfig>>;

function matchesIdlePilotTarget(pilot: ManagedGvisorIdlePilot, binding: ManagedGvisorBinding): boolean {
  return binding.operatorId === pilot.authorityUserId && binding.connectionId === pilot.connectionId
    && binding.targetId === pilot.targetId && binding.revision === pilot.connectionRevision;
}

export async function runManagedGvisorIdlePilot(): Promise<"disabled" | "idle" | "stopped" | "tier-slept"> {
  const tier = gvisorTierPilot();
  if (tier) {
    if (process.env.HIVRA_MANAGED_GVISOR_TIER_AUTO_ENABLED !== "true") return "disabled";
    return await sleepManagedGvisorTier(tier.ownerId, tier.computer, "auto") ? "tier-slept" : "idle";
  }
  const pilot = managedGvisorIdlePilotConfig();
  if (!pilot) return "disabled";
  const { data, error } = await db().rpc("claim_hivra_managed_gvisor_pilot_idle_stop", {
    p_customer: pilot.ownerId, p_operator: pilot.authorityUserId, p_connection: pilot.connectionId,
    p_target: pilot.targetId, p_revision: pilot.connectionRevision, p_expires_at: new Date(pilot.expiresAtMs).toISOString(),
  });
  if (error) throw new GvisorComputerError("database_failed", "The managed sandbox idle stop claim could not be confirmed.");
  if (data === null) return "idle";
  const parsed = ManagedGvisorClaim.safeParse(data);
  if (!parsed.success || parsed.data.status !== "claimed" || parsed.data.action !== "stop"
    || parsed.data.customerId !== pilot.ownerId || !matchesIdlePilotTarget(pilot, parsed.data)) {
    throw new GvisorComputerError("not_ready", "The managed sandbox idle stop authority could not be confirmed.");
  }
  const agent = await loadAgent(pilot.ownerId, parsed.data.computerId);
  if (agent.operation_id !== parsed.data.operationId || agent.operation_kind !== "stop") {
    throw new GvisorComputerError("conflict", "The managed sandbox idle stop claim changed before dispatch.");
  }
  await dispatchManagedGvisorLifecycle(agent, "stop", parsed.data);
  return "stopped";
}

async function mutateReadyManagedGvisor(agent: GvisorAgent, action: "start" | "stop" | "delete") {
  if (action === "start") {
    if (agent.status === "stopped" && managedGvisorDiskAdmissionEnabled()
      && previousAdapter(agent.gvisor_adapter_version, agent.gvisor_adapter_sha256)) {
      throw new GvisorComputerError("not_ready", "This host needs the managed storage admission adapter before starting.");
    }
    let entitlement;
    try {
      entitlement = await resolveEffectiveSubscription(agent.user_id, { throwOnQueryError: true });
    } catch {
      throw new GvisorComputerError("database_failed", "The hosted compute plan could not be verified.");
    }
    if (!paysForHostedCompute(entitlement)) {
      throw new GvisorComputerError("plan_required", HOSTED_COMPUTE_REQUIRES_PLAN_MESSAGE);
    }
  }
  const { data, error } = await db().rpc("claim_hivra_managed_gvisor_lifecycle", {
    p_customer: agent.user_id, p_computer: agent.id, p_action: action,
  });
  if (error) throw new GvisorComputerError("database_failed", "The managed lifecycle claim could not be confirmed.");
  return dispatchManagedGvisorLifecycle(agent, action, data);
}

async function dispatchManagedGvisorLifecycle(
  agent: GvisorAgent, action: "start" | "stop" | "delete", data: Record<string, unknown> | null,
) {
  const desired = action === "start" ? "running" : action === "stop" ? "stopped" : "deleted";
  const matchesAgent = (row: unknown) => {
    const candidate = row as Record<string, unknown> | undefined;
    return candidate?.id === agent.id && candidate.user_id === agent.user_id
      && candidate.deployment_mode === "hivra-managed" && candidate.computer_substrate === "gvisor"
      && candidate.status === desired && candidate.operation_id === null;
  };
  if (data?.status === "not_found") throw new GvisorComputerError("not_found", "gVisor computer not found.");
  if (data?.status === "settled" && matchesAgent(data.agent)) return data.agent;
  if (data?.status === "held") {
    throw new GvisorComputerError("conflict", "A managed sandbox operation is still unconfirmed.");
  }
  const parsed = ManagedGvisorClaim.safeParse(data);
  if (!parsed.success || parsed.data.action !== action || parsed.data.customerId !== agent.user_id || parsed.data.computerId !== agent.id
    || parsed.data.sandboxId !== agent.gvisor_sandbox_id || parsed.data.operationId !== parsed.data.claimId
    || parsed.data.adapterSha !== agent.gvisor_adapter_sha256 || parsed.data.runtimeSha !== agent.gvisor_runtime_sha256
    || parsed.data.cpu !== Number(agent.cpu) || parsed.data.ram !== Number(agent.ram)
    || (parsed.data.status === "observe" && action !== "delete")) {
    throw new GvisorComputerError("not_ready", "The managed sandbox lifecycle authority could not be confirmed.");
  }
  const claim = parsed.data;
  const observing = claim.status === "observe";
  let receipt;
  try {
    receipt = await invokeManagedGvisor(claim, observing ? "status" : action, observing ? "delete-observation" : "mutation");
  } catch (error) {
    if (action === "start" && !observing && error instanceof GvisorComputerError
      && error.code === "capacity_limit" && error.definiteAdmissionRejection) {
      const stopped = await invokeManagedGvisor(claim, "status", "mutation").catch(() => null);
      if (stopped?.state === "stopped") {
        const { data: rejected, error: rejectionError } = await db().rpc("reject_hivra_managed_gvisor_start", {
          p_customer: agent.user_id, p_computer: agent.id, p_operation: claim.operationId, p_receipt: stopped,
        });
        if (rejected === true && !rejectionError) throw error;
      }
    }
    throw new GvisorComputerError("conflict", "The managed sandbox outcome is unconfirmed. Its reservation is still held.");
  }
  if (receipt.state !== (action === "delete" ? "absent" : desired)) {
    throw new GvisorComputerError("conflict", "The managed sandbox outcome is unconfirmed. Its reservation is still held.");
  }
  const { data: completed, error: completionError } = await db().rpc("complete_hivra_managed_gvisor_lifecycle", {
    p_customer: agent.user_id, p_computer: agent.id, p_operation: claim.operationId, p_action: action, p_receipt: receipt,
  });
  if (completionError || !matchesAgent(completed)) {
    throw new GvisorComputerError("conflict", "The managed sandbox result could not be committed. Check its status before retrying.");
  }
  return completed;
}

/**
 * Start, Stop, Resize, Delete, and Update: recreate the sandbox's container on
 * the pinned image, keeping /workspace (the adapter's update). Update holds
 * the runtime_update lease; on completion it also re-pins a sandbox created
 * by an earlier Hivra adapter to the host's current one.
 */
export async function mutateGvisorComputer(userId: string, agentId: string, input: { action: "start" | "stop" | "resize" | "delete" | "update"; cpu?: number; ramGb?: number }) {
  const agent = await loadAgent(userId, agentId);
  if (agent.deployment_mode === "hivra-managed") {
    const tier = await readTierHandoff(userId, agent.id);
    if (tier) {
      if (input.action === "delete") return retireTier(agent, tier);
      throw new GvisorComputerError("conflict", "Use the terminal to wake this pilot sandbox. Its lifecycle is managed separately.");
    }
    if (input.action === "delete" && agent.status === "provisioning") return cancelUndispatchedManagedGvisor(agent);
    if ((agent.status === "running" || agent.status === "stopped" || agent.status === "deleted")
      && (input.action === "start" || input.action === "stop" || input.action === "delete")) {
      return mutateReadyManagedGvisor(agent, input.action);
    }
  }
  requireSelfManagedGvisorDispatch(agent);
  if (input.action === "update" && agent.gvisor_claude_terminal_image) {
    throw new GvisorComputerError("not_ready", "Claude Code sandbox image updates are not available.");
  }
  const priorObservation = GvisorComputerReceiptSchema.safeParse(agent.gvisor_observation);
  if (input.action === "delete" && agent.status === "error" && !agent.operation_id
    && priorObservation.success && priorObservation.data.state === "absent"
    && priorObservation.data.computerId === agent.id && priorObservation.data.sandboxId === agent.gvisor_sandbox_id) {
    const verifiedCleanup = cleanupReceipt(agent, priorObservation.data);
    const { data: deleted, error } = await db().from("hivra_agents").update({ status: "deleted", desired_state: "deleted",
      error: null, infrastructure_connection_id: null, deployment_target_id: null, infrastructure_connection_revision: null,
      gvisor_cleanup_receipt: verifiedCleanup }).eq("id", agent.id).eq("user_id", userId)
      .eq("status", "error").is("operation_id", null).select("*").maybeSingle();
    if (error || !deleted) throw new GvisorComputerError("conflict", "The failed launch changed before it could be cancelled.");
    return deleted;
  }
  if (input.action === "resize" && (input.cpu === undefined || input.ramGb === undefined)) {
    throw new GvisorComputerError("not_ready", "Choose both CPU and memory limits.");
  }
  const deletingUncertainProvision = input.action === "delete" && agent.operation_kind === "provision" && Boolean(agent.operation_id);
  const kind = input.action === "update" ? "runtime_update" : input.action;
  if (agent.operation_id && agent.operation_kind !== kind && !deletingUncertainProvision) {
    throw new GvisorComputerError("conflict", "Another computer operation is still running.");
  }
  if (agent.operation_id && input.action === "resize") {
    const payload = agent.operation_payload;
    if (Number(payload?.cpu) !== input.cpu || Number(payload?.ram) !== input.ramGb) {
      throw new GvisorComputerError("conflict", "Resume the pending resize with its original CPU and memory limits.");
    }
  }
  const operationId = agent.operation_id ?? randomUUID(), startedAt = new Date().toISOString();
  const desired = input.action === "stop" ? "stopped" : input.action === "delete" ? "deleted"
    : input.action === "update" ? (agent.desired_state === "stopped" ? "stopped" : "running") : "running";
  if (input.action === "update" && !agent.operation_id) {
    if (agent.status !== "running" && agent.status !== "stopped") {
      throw new GvisorComputerError("conflict", "Wait until this sandbox is running or stopped before updating it.");
    }
    // Refuse a host that can't run the update before taking the lease, so a
    // refusal never leaves the sandbox locked against Start and Stop.
    await executionAuthority(userId, agent.deployment_target_id, agent, "update");
  }
  if (!agent.operation_id) {
    const { data: claimed, error } = await db().from("hivra_agents").update({ operation_id: operationId, operation_kind: kind,
      operation_started_at: startedAt, operation_payload: input.action === "resize" ? { cpu: input.cpu, ram: input.ramGb,
        maximumCpu: input.cpu, maximumRam: input.ramGb } : {}, desired_state: desired, status: "provisioning" })
      .eq("id", agent.id).eq("user_id", userId).is("operation_id", null).select("id").maybeSingle();
    if (error || !claimed) throw new GvisorComputerError("conflict", "The computer changed before this operation started.");
  }
  try {
    const request: GvisorComputerRequest = { operation: input.action, ownerHash: ownerHash(userId), computerId: agent.id, sandboxId: agent.gvisor_sandbox_id,
      ...(input.action === "resize" ? { cpu: input.cpu, memoryMb: input.ramGb === undefined ? undefined : input.ramGb * 1024 } : {}) };
    const { receipt, adapter } = await invokeOnTarget(userId, agent.deployment_target_id, request, agent);
    const state = (receipt as GvisorComputerReceipt).state;
    const updates: Record<string, unknown> = { status: state === "absent" ? "deleted" : state, desired_state: desired,
      operation_id: null, operation_kind: null,
      operation_started_at: null, operation_payload: null, error: null, gvisor_observation: receipt };
    if (input.action === "resize") Object.assign(updates, { cpu: input.cpu, ram: input.ramGb, cpu_max: input.cpu, ram_max: input.ramGb });
    if (input.action === "update" && adapter.sha256 !== agent.gvisor_adapter_sha256) {
      Object.assign(updates, { gvisor_adapter_version: adapter.version, gvisor_adapter_sha256: adapter.sha256 });
    }
    if (input.action === "delete") Object.assign(updates, {
      infrastructure_connection_id: null, deployment_target_id: null, infrastructure_connection_revision: null,
      gvisor_cleanup_receipt: cleanupReceipt(agent, receipt as GvisorComputerReceipt),
    });
    const { data: completed, error: completeError } = await db().from("hivra_agents").update(updates).eq("id", agent.id).eq("user_id", userId)
      .eq("operation_id", operationId).select("*").single();
    if (completeError || !completed) throw new GvisorComputerError("database_failed", "The computer operation result could not be committed.");
    return completed;
  } catch (cause) {
    let rejectionReconciled = false;
    if (cause instanceof GvisorComputerError && cause.definiteAdmissionRejection
      && (input.action === "resize" || input.action === "start" || input.action === "update")) {
      try {
        const observation = await invoke(userId, agent.deployment_target_id, { operation: "status",
          ownerHash: ownerHash(userId), computerId: agent.id, sandboxId: agent.gvisor_sandbox_id }, agent) as GvisorComputerReceipt;
        const unchanged = (observation.state === "running" || observation.state === "stopped")
          && observation.computerId === agent.id && observation.sandboxId === agent.gvisor_sandbox_id
          && observation.runtime === "runsc" && observation.reservationEqualsMaximum === true
          && Number(observation.cpu) === Number(agent.cpu)
          && observation.memoryMb === Math.round(Number(agent.ram) * 1024);
        if (unchanged) {
          const { data: restored, error: restoreError } = await db().from("hivra_agents").update({
            status: observation.state, desired_state: observation.state, operation_id: null, operation_kind: null,
            operation_started_at: null, operation_payload: null, gvisor_observation: observation,
            error: `gvisor_${input.action}_admission_rejected`,
          }).eq("id", agent.id).eq("user_id", userId).eq("operation_id", operationId).select("id").maybeSingle();
          rejectionReconciled = !restoreError && Boolean(restored);
        }
      } catch { /* Unknown or changed runtime state retains the matching operation lease. */ }
    }
    if (!rejectionReconciled) {
      await db().from("hivra_agents").update({ error: `gvisor_${input.action}_unconfirmed` }).eq("id", agent.id).eq("operation_id", operationId);
    }
    throw cause;
  }
}
