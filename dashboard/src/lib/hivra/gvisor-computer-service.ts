import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { supabaseAdmin } from "@/lib/supabase";
import { beginInfrastructureConnectionPreparation, completeInfrastructureConnectionPreflight,
  loadInfrastructureConnectionSecret } from "@/lib/infrastructure/connection-store";
import { buildUserProxmoxEnvironment, resolveValidatedSshDestination } from "@/lib/infrastructure/connection-runtime";
import { resolveProxmoxHostCapacityPolicy } from "@/lib/infrastructure/host-capacity-policy";
import { runProxmoxHostScript, runProxmoxHostScriptWithStdin } from "@/lib/services/proxmox-instance-service";
import {
  GvisorComputerReceiptSchema, GvisorComputerRequestSchema, GvisorExecReceiptSchema,
  HIVRA_GVISOR_ADAPTER_VERSION, HIVRA_GVISOR_BUNDLE_SHA256, HIVRA_GVISOR_BUNDLE_URL,
  isGvisorPendingBoundObservation, isGvisorPreflightFresh,
  type GvisorComputerReceipt, type GvisorComputerRequest,
} from "./gvisor-computer-contract";

const ADAPTER = "/opt/hivra/gvisor-adapter/hivra-gvisor-adapter";
const RESULT = "HIVRA_GVISOR_V1 ";
const EXEC_RESULT = "HIVRA_GVISOR_EXEC_V1 ";
const PREPARE_FAILURE = "HIVRA_GVISOR_PREPARE_FAILED_V1 ";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class GvisorComputerError extends Error {
  constructor(readonly code: "not_found" | "not_ready" | "conflict" | "remote_failed" | "database_failed", message: string,
    readonly computerId: string | null = null, readonly definiteAdmissionRejection = false) {
    super(message); this.name = "GvisorComputerError";
  }
}

type GvisorAgent = {
  id: string; user_id: string; name: string; status: string; desired_state: string;
  operation_id: string | null; operation_kind: string | null; operation_payload: Record<string, unknown> | null;
  computer_substrate: string; gvisor_sandbox_id: string;
  gvisor_adapter_sha256: string; gvisor_runtime_sha256: string;
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

function preparationFailureMessage(stdout: string, stderr: string): string {
  const stage = `${stdout}\n${stderr}`.split("\n")
    .find(line => line.startsWith(PREPARE_FAILURE))
    ?.slice(PREPARE_FAILURE.length);
  const messages: Record<string, string> = {
    "host-eligibility": "The host no longer meets the supported gVisor preparation requirements.",
    prerequisites: "The required Docker and installation tools could not be prepared on this host.",
    "bundle-download": "The pinned gVisor bundle could not be downloaded or verified.",
    "bundle-validation": "The pinned gVisor bundle did not contain the expected safe runtime files.",
    "installed-identity-check": "The host has a conflicting gVisor runtime identity. Existing runtime files were not replaced.",
    "asset-installation": "The pinned gVisor runtime files could not be installed.",
    "runtime-registration": "Docker did not confirm the exact runsc runtime path within 30 seconds of its configuration reload.",
    "sidecar-validation": "The installed gVisor runtime sidecars did not pass their pinned identity checks.",
    "image-pull": "The pinned Linux application image could not be downloaded.",
    "sandbox-smoke-test": "The prepared gVisor runtime did not pass its isolated sandbox test.",
  };
  return stage && messages[stage]
    ? messages[stage]
    : "The gVisor host preparation could not be confirmed.";
}

async function executionAuthority(userId: string, targetId: string, binding?: Pick<GvisorAgent,
  "infrastructure_connection_id" | "infrastructure_connection_revision" | "deployment_target_id"
  | "gvisor_adapter_sha256" | "gvisor_runtime_sha256">, operation?: GvisorComputerRequest["operation"]) {
  const { data, error } = await db().from("deployment_targets").select("id,connection_id,evidence_connection_revision,status,capabilities,supported_isolation_drivers,isolation_class,last_preflight_at")
    .eq("id", targetId).eq("user_id", userId).maybeSingle();
  if (error) throw new GvisorComputerError("database_failed", "The target could not be checked.");
  const target = data as null | { id: string; connection_id: string; evidence_connection_revision: number; status: string;
    capabilities: Record<string, unknown>; supported_isolation_drivers: string[]; isolation_class: string; last_preflight_at: string | null };
  if (!target) throw new GvisorComputerError("not_found", "The connected host target was not found.");
  if (binding && (binding.deployment_target_id !== target.id || binding.infrastructure_connection_id !== target.connection_id
    || binding.infrastructure_connection_revision !== target.evidence_connection_revision)) {
    throw new GvisorComputerError("not_ready", "This Computer's immutable host binding no longer matches its target evidence.");
  }
  const capabilities = target.capabilities;
  const adapter = capabilities?.adapter as { version?: unknown; sha256?: unknown } | undefined;
  const runtime = capabilities?.runtime as { path?: unknown; sha256?: unknown } | undefined;
  const compatibility = capabilities?.runtimeCompatibility as { contractVersion?: unknown; supportedWorkloadKinds?: unknown } | undefined;
  const resourcePolicy = capabilities?.resourcePolicy as { reservationEqualsMaximum?: unknown; aggregateAdmission?: unknown } | undefined;
  const access = capabilities?.access as { terminal?: unknown; publicPorts?: unknown } | undefined;
  if (capabilities?.kind !== "gvisor"
    || adapter?.version !== HIVRA_GVISOR_ADAPTER_VERSION || typeof adapter.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(adapter.sha256)
    || runtime?.path !== "/usr/local/bin/runsc" || typeof runtime.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(runtime.sha256)
    || compatibility?.contractVersion !== 1 || !Array.isArray(compatibility.supportedWorkloadKinds)
    || compatibility.supportedWorkloadKinds.length !== 1 || compatibility.supportedWorkloadKinds[0] !== "linux-terminal"
    || resourcePolicy?.reservationEqualsMaximum !== true || resourcePolicy.aggregateAdmission !== "serialized-host-headroom-v1"
    || access?.terminal !== "owner-gated-command-v1" || access.publicPorts !== false
    || capabilities.desktop !== false || capabilities.windows !== false) {
    throw new GvisorComputerError("not_ready", "Inspect or prepare this Linux host again before launching a sandbox.");
  }
  if (binding && (binding.gvisor_adapter_sha256 !== adapter.sha256 || binding.gvisor_runtime_sha256 !== runtime.sha256)) {
    throw new GvisorComputerError("not_ready", "This Computer's pinned gVisor adapter identity no longer matches the ready target.");
  }
  const connection = await loadInfrastructureConnectionSecret(userId, target.connection_id);
  const normalAuthority = connection.revision === target.evidence_connection_revision
    && connection.status === "ready" && target.status === "ready" && target.isolation_class === "application-kernel"
    && target.supported_isolation_drivers.length === 1 && target.supported_isolation_drivers[0] === "gvisor-runsc"
    && capabilities.launchReady === true && (binding || isGvisorPreflightFresh(target.last_preflight_at));
  const pendingBoundObservation = isGvisorPendingBoundObservation({ operation,
    connectionStatus: connection.status, connectionRevision: connection.revision,
    pendingFromRevision: connection.pendingBindingRebindFromRevision,
    bindingRevision: binding?.infrastructure_connection_revision ?? null,
    targetRevision: target.evidence_connection_revision });
  if (connection.provider !== "host" || connection.endpoint.sshUser !== "root"
    || (!normalAuthority && !pendingBoundObservation)) {
    throw new GvisorComputerError("not_ready", "The connected host authority changed. Inspect it again.");
  }
  const destination = await resolveValidatedSshDestination(connection.endpoint.sshHost);
  const env = buildUserProxmoxEnvironment({ id: connection.id, sshHost: connection.endpoint.sshHost,
    sshPort: connection.endpoint.sshPort, sshUser: connection.endpoint.sshUser,
    sshHostFingerprintSha256: connection.endpoint.sshHostFingerprintSha256!, sshPrivateKey: connection.credentials.sshPrivateKey }, destination);
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

async function invoke(userId: string, targetId: string, request: GvisorComputerRequest,
  binding?: Pick<GvisorAgent, "infrastructure_connection_id" | "infrastructure_connection_revision" | "deployment_target_id"
    | "gvisor_adapter_sha256" | "gvisor_runtime_sha256">) {
  const authority = await executionAuthority(userId, targetId, binding, request.operation);
  const parsed = GvisorComputerRequestSchema.parse((request.operation === "create" || request.operation === "start" || request.operation === "resize")
    ? { ...request, hostMemoryReserveMb: resolveProxmoxHostCapacityPolicy(authority.connection.configuration?.capacityPolicy).hostMemoryReserveMb }
    : request);
  const expectedAdapterSha = String((authority.target.capabilities.adapter as { sha256: string }).sha256);
  const expectedRuntimeSha = String((authority.target.capabilities.runtime as { sha256: string }).sha256);
  const identityGuard = `set -euo pipefail
identity_fail() { printf 'HIVRA_GVISOR_IDENTITY_MISMATCH\\n' >&2; exit 1; }
[ "$(stat -c '%U:%G:%a' '${ADAPTER}')" = 'root:root:700' ] || identity_fail
[ "$(sha256sum '${ADAPTER}' | awk '{print $1}')" = '${expectedAdapterSha}' ] || identity_fail
[ "$(sha256sum /usr/local/bin/runsc | awk '{print $1}')" = '${expectedRuntimeSha}' ] || identity_fail
[ "$(readlink -f "$(/usr/bin/docker info --format '{{(index .Runtimes "runsc").Path}}')")" = /usr/local/bin/runsc ] || identity_fail
[ "$(stat -c '%U:%G:%a' /opt/hivra/gvisor-adapter/gvisor-bin.sha256)" = 'root:root:600' ] || identity_fail
(cd / && sha256sum -c /opt/hivra/gvisor-adapter/gvisor-bin.sha256 >/dev/null) || identity_fail
exec '${ADAPTER}'`;
  const result = await runProxmoxHostScriptWithStdin(identityGuard, JSON.stringify(parsed), authority.env,
    { timeoutMs: parsed.operation === "create" ? 360_000 : 90_000, maxOutputBytes: 96 * 1024 });
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
  return parseReceipt(result.stdout, parsed.operation === "exec" ? EXEC_RESULT : RESULT);
}

async function loadAgent(userId: string, agentId: string): Promise<GvisorAgent> {
  if (!UUID.test(agentId)) throw new GvisorComputerError("not_found", "Computer not found.");
  const { data, error } = await db().from("hivra_agents").select("id,user_id,name,status,desired_state,operation_id,operation_kind,operation_payload,computer_substrate,gvisor_sandbox_id,gvisor_adapter_sha256,gvisor_runtime_sha256,gvisor_observation,infrastructure_connection_id,deployment_target_id,infrastructure_connection_revision,cpu,ram")
    .eq("id", agentId).eq("user_id", userId).maybeSingle();
  if (error) throw new GvisorComputerError("database_failed", "The computer could not be read.");
  if (!data || data.computer_substrate !== "gvisor" || !UUID.test(String(data.gvisor_sandbox_id))) {
    throw new GvisorComputerError("not_found", "gVisor computer not found.");
  }
  return data as GvisorAgent;
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
  if (connection.provider !== "host" || connection.endpoint.sshUser !== "root") throw new GvisorComputerError("not_ready", "gVisor preparation requires a root Linux host connection.");
  const destination = await resolveValidatedSshDestination(connection.endpoint.sshHost);
  const env = buildUserProxmoxEnvironment({ id: connection.id, sshHost: connection.endpoint.sshHost,
    sshPort: connection.endpoint.sshPort, sshUser: connection.endpoint.sshUser,
    sshHostFingerprintSha256: connection.endpoint.sshHostFingerprintSha256!, sshPrivateKey: connection.credentials.sshPrivateKey }, destination);
  const root = path.join(process.cwd(), "provisioner", "gvisor");
  const [prepare, adapter] = await Promise.all([readFile(path.join(root, "prepare-gvisor-host.sh")), readFile(path.join(root, "hivra-gvisor-adapter.py"))]);
  const adapterSha = createHash("sha256").update(adapter).digest("hex");
  const script = prepare.toString("utf8");
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  if (!await beginInfrastructureConnectionPreparation(userId, connectionId, connection.revision, runId, startedAt)) {
    throw new GvisorComputerError("conflict", "Another infrastructure preparation or inspection is already running.");
  }
  try {
    const remote = await runProxmoxHostScript(`export HIVRA_GVISOR_BUNDLE_URL='${HIVRA_GVISOR_BUNDLE_URL}'\nexport HIVRA_GVISOR_BUNDLE_SHA256='${HIVRA_GVISOR_BUNDLE_SHA256}'\nexport HIVRA_GVISOR_ADAPTER_SHA256='${adapterSha}'\nexport HIVRA_GVISOR_ADAPTER_SOURCE='${adapter.toString("base64")}'\n${script}`, env, { timeoutMs: 360_000, maxOutputBytes: 64 * 1024 });
    const receipt = remote.stdout.split("\n").find(value => value.startsWith(`HIVRA_GVISOR_PREPARED_V1 ${HIVRA_GVISOR_BUNDLE_SHA256} `));
    const runscSha256 = receipt?.split(" ")[2];
    if (!remote.ok || !receipt || !/^[0-9a-f]{64}$/.test(runscSha256 ?? "") || !receipt.endsWith(` ${adapterSha}`)) {
      throw new GvisorComputerError("remote_failed", preparationFailureMessage(remote.stdout, remote.stderr));
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

export async function launchGvisorComputer(input: { userId: string; targetId: string; launchRequestId: string; name: string; cpu: number; ramGb: number }) {
  const { data: replay, error: replayError } = await db().from("hivra_agents").select("*")
    .eq("user_id", input.userId).eq("gvisor_launch_request_id", input.launchRequestId).maybeSingle();
  if (replayError) throw new GvisorComputerError("database_failed", "The launch request could not be reconciled.");
  if (replay) {
    if (replay.computer_substrate !== "gvisor" || replay.deployment_target_id !== input.targetId) {
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
  const computerId = randomUUID(), sandboxId = randomUUID(), operationId = randomUUID();
  const { data, error } = await db().from("hivra_agents").insert({ id: computerId, user_id: input.userId, type: "linux-terminal",
    computer_profile: "linux-terminal", name: input.name, status: "provisioning", desired_state: "running", deployment_mode: "self-managed",
    computer_substrate: "gvisor", proxmox_host: "__hivra_self_managed_no_ambient_authority__", vmid: null, cpu: input.cpu, ram: input.ramGb,
    cpu_max: input.cpu, ram_max: input.ramGb, infrastructure_connection_id: authority.connection.id, deployment_target_id: input.targetId,
    infrastructure_connection_revision: authority.connection.revision, infrastructure_binding_token_hash: ownerHash(input.userId),
    infrastructure_binding_token_enforced: true, gvisor_sandbox_id: sandboxId, gvisor_adapter_version: HIVRA_GVISOR_ADAPTER_VERSION,
    gvisor_adapter_sha256: adapterSha256, gvisor_runtime_sha256: runtimeSha256,
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

export async function observeGvisorComputer(userId: string, agentId: string) {
  const agent = await loadAgent(userId, agentId);
  return invoke(userId, agent.deployment_target_id, { operation: "status", ownerHash: ownerHash(userId), computerId: agent.id, sandboxId: agent.gvisor_sandbox_id }, agent);
}

export async function executeGvisorComputerCommand(userId: string, agentId: string, argv: string[]) {
  const agent = await loadAgent(userId, agentId);
  return invoke(userId, agent.deployment_target_id, { operation: "exec", ownerHash: ownerHash(userId), computerId: agent.id, sandboxId: agent.gvisor_sandbox_id, argv }, agent);
}

export async function mutateGvisorComputer(userId: string, agentId: string, input: { action: "start" | "stop" | "resize" | "delete"; cpu?: number; ramGb?: number }) {
  const agent = await loadAgent(userId, agentId);
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
  if (agent.operation_id && agent.operation_kind !== input.action && !deletingUncertainProvision) {
    throw new GvisorComputerError("conflict", "Another computer operation is still running.");
  }
  if (agent.operation_id && input.action === "resize") {
    const payload = agent.operation_payload;
    if (Number(payload?.cpu) !== input.cpu || Number(payload?.ram) !== input.ramGb) {
      throw new GvisorComputerError("conflict", "Resume the pending resize with its original CPU and memory limits.");
    }
  }
  const operationId = agent.operation_id ?? randomUUID(), startedAt = new Date().toISOString();
  const desired = input.action === "stop" ? "stopped" : input.action === "delete" ? "deleted" : "running";
  if (!agent.operation_id) {
    const { data: claimed, error } = await db().from("hivra_agents").update({ operation_id: operationId, operation_kind: input.action,
      operation_started_at: startedAt, operation_payload: input.action === "resize" ? { cpu: input.cpu, ram: input.ramGb,
        maximumCpu: input.cpu, maximumRam: input.ramGb } : {}, desired_state: desired, status: "provisioning" })
      .eq("id", agent.id).eq("user_id", userId).is("operation_id", null).select("id").maybeSingle();
    if (error || !claimed) throw new GvisorComputerError("conflict", "The computer changed before this operation started.");
  }
  try {
    const request: GvisorComputerRequest = { operation: input.action, ownerHash: ownerHash(userId), computerId: agent.id, sandboxId: agent.gvisor_sandbox_id,
      ...(input.action === "resize" ? { cpu: input.cpu, memoryMb: input.ramGb === undefined ? undefined : input.ramGb * 1024 } : {}) };
    const receipt = await invoke(userId, agent.deployment_target_id, request, agent);
    const state = (receipt as GvisorComputerReceipt).state;
    const updates: Record<string, unknown> = { status: state === "absent" ? "deleted" : state, desired_state: desired,
      operation_id: null, operation_kind: null,
      operation_started_at: null, operation_payload: null, error: null, gvisor_observation: receipt };
    if (input.action === "resize") Object.assign(updates, { cpu: input.cpu, ram: input.ramGb, cpu_max: input.cpu, ram_max: input.ramGb });
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
      && (input.action === "resize" || input.action === "start")) {
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
