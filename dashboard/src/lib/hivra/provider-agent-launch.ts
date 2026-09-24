import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase";
import { getInfrastructureDeploymentTarget } from "@/lib/infrastructure/connection-store";
import { ProviderVmDeploymentTargetDtoSchema, type ProviderVmDeploymentTargetDto } from "@/lib/infrastructure/contracts";
import { loadHetznerCloudConnectionMetadata, loadHetznerCloudCleanupOrder, loadHetznerCloudCapacityBootstrap } from "@/lib/infrastructure/hetzner-cloud-store";
import { loadFirstBootOperationForOrder } from "@/lib/infrastructure/first-boot-operations";
import { FIRST_BOOT_RECIPE_VERSION } from "@/lib/infrastructure/first-boot-enrollment";
import { verifyEnrolledProviderReceipt } from "@/lib/infrastructure/enrolled-provider-receipt";
import { inspectFirstBootGuest } from "@/lib/infrastructure/first-boot-ssh";
import { parseProviderGuestDiscoveryOutput } from "@/lib/infrastructure/host-discovery";
import { assertProviderComputerEnvironment } from "@/lib/infrastructure/provider-computer-preparation";
import { loadPortableProvisionerBundle } from "@/lib/infrastructure/connection-preparation";
import { providerGuestBundleReceipt } from "@/lib/infrastructure/provider-guest-bundle";
import { isTunnelConfigured } from "@/lib/services/cloudflare-tunnel";
import { isLocalAuthMode } from "@/lib/self-host/config";
import { provisionHivraAgentTunnel } from "./agent-tunnel-provisioning";
import { getAgent } from "./agent-catalog";
import { providerComputerResourceFloor } from "./provider-computer-resource-floor";
import { targetSupportsCatalogRuntime, targetSupportsLaunchModelSettings } from "./agent-placement";
import type { LaunchModelAdmission, LaunchModelAdmissionService } from "./launch-model-admission";
import { ModelKeySelectionSchema } from "./model-key-selection";
import { sanitizeHivraAgentRow, validateLlmInput } from "./agent-llm";
import { SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL } from "./agent-authority";
import { advanceProviderAgentInstaller } from "./provider-agent-installer";
import { advanceProviderNativeInstaller } from "./provider-native-installer";
import { advanceProviderDesktopInstaller } from "./provider-desktop-installer";
import { parseProviderDesktopControlOrigin } from "@/lib/infrastructure/provider-desktop-launch-contract";
import { recordHivraAgentOperationFailure } from "./agent-operation-store";
import { MAX_CONTEXT_LEN } from "./agent-limits";
import { bindProviderDirectAccess } from "./provider-direct-access";

const Input = z.object({
  userId: z.string().min(1).max(256), targetId: z.string().uuid(), connectionId: z.string().uuid(),
  expectedConnectionRevision: z.number().int().positive().safe(),
  type: z.enum(["claude-code", "codex", "aeon", "openclaw", "agent-zero", "deepseek-harness", "linux-desktop"]),
  computerProfile: z.literal("ubuntu-desktop").optional(),
  launchOperationId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(256), browser: z.boolean(),
  goal: z.string().max(32).nullable(), context: z.string().max(MAX_CONTEXT_LEN).nullable(),
  personality: z.string().max(48).nullable(), emoji: z.string().max(16).nullable(),
  managedVenice: z.boolean(), llm: z.unknown(), templateSkills: z.array(z.string().max(128)).max(100),
}).strict().refine(input => input.type === "linux-desktop" ? input.computerProfile === "ubuntu-desktop" && !input.browser
  : input.computerProfile === undefined);
export type ProviderAgentLaunchInput = z.infer<typeof Input>;
export type ProviderAgentModelLaunch = { service: LaunchModelAdmissionService; admission: LaunchModelAdmission };

export class ProviderAgentLaunchError extends Error {
  constructor(readonly code: "not_ready" | "capacity" | "model" | "template" | "access" | "conflict" | "unconfirmed") {
    super({
      not_ready: "This cloud computer is not ready for launch. Check its setup in Capacity.",
      capacity: "This computer does not have enough measured free resources for that agent. Choose a larger computer or turn off browser automation.",
      model: "This model connection needs a supported runtime, a saved launch request and a model-ready computer. Prepare the computer again, or launch with native sign-in and connect your account there.",
      template: "Installing template skills on a provider computer is not supported yet. Launch a fresh agent and customize it in its native interface.",
      access: "Secure access is not configured on this Hivra installation. No agent was created.",
      conflict: "This computer is already assigned or its connection changed. Refresh Capacity before launching again.",
      unconfirmed: "The launch response could not be confirmed. Check your agents before trying again; no replacement computer was created.",
    }[code]);
    this.name = "ProviderAgentLaunchError";
  }
}

async function reserve(row: Record<string, unknown>) {
  if (!supabaseAdmin) throw new ProviderAgentLaunchError("unconfirmed");
  const { data, error } = await supabaseAdmin.from("hivra_agents").insert(row).select("*").single();
  if (error || !data) {
    if (error?.code === "23505" || error?.code === "55006") throw new ProviderAgentLaunchError("conflict");
    throw new ProviderAgentLaunchError("unconfirmed");
  }
  return data as Record<string, unknown>;
}
async function current(userId: string, agentId: string) {
  if (!supabaseAdmin) throw new ProviderAgentLaunchError("unconfirmed");
  const { data, error } = await supabaseAdmin.from("hivra_agents").select("*")
    .eq("user_id", userId).eq("id", agentId).eq("computer_substrate", "provider-vm").maybeSingle();
  if (error || !data) throw new ProviderAgentLaunchError("unconfirmed");
  return data as Record<string, unknown>;
}
type Dependencies = {
  target: typeof getInfrastructureDeploymentTarget; connection: typeof loadHetznerCloudConnectionMetadata;
  order: typeof loadHetznerCloudCleanupOrder; boot: typeof loadFirstBootOperationForOrder;
  verify: typeof verifyEnrolledProviderReceipt; bootstrap: typeof loadHetznerCloudCapacityBootstrap;
  inspect: typeof inspectFirstBootGuest; bundle: typeof loadPortableProvisionerBundle;
  accessConfigured: typeof isTunnelConfigured; tunnel: typeof provisionHivraAgentTunnel;
  localMode: typeof isLocalAuthMode; directAccess: typeof bindProviderDirectAccess;
  reserve: typeof reserve; current: typeof current; installer: typeof advanceProviderAgentInstaller;
  nativeInstaller: typeof advanceProviderNativeInstaller;
  desktopInstaller: typeof advanceProviderDesktopInstaller; controlOrigin: () => string;
  failure: typeof recordHivraAgentOperationFailure;
  newId: () => string; bindingHash: () => string; now: () => Date; monotonicNow: () => number;
};
const defaults: Dependencies = { target: getInfrastructureDeploymentTarget, connection: loadHetznerCloudConnectionMetadata,
  order: loadHetznerCloudCleanupOrder, boot: loadFirstBootOperationForOrder, verify: verifyEnrolledProviderReceipt,
  bootstrap: loadHetznerCloudCapacityBootstrap, inspect: inspectFirstBootGuest, bundle: loadPortableProvisionerBundle,
  accessConfigured: isTunnelConfigured, tunnel: provisionHivraAgentTunnel, reserve, current,
  localMode: isLocalAuthMode, directAccess: bindProviderDirectAccess,
  installer: advanceProviderAgentInstaller, nativeInstaller: advanceProviderNativeInstaller,
  desktopInstaller: advanceProviderDesktopInstaller,
  controlOrigin: () => { const key = "NEXT_PUBLIC_APP_URL"; return process.env[key] ?? ""; },
  failure: recordHivraAgentOperationFailure,
  newId: randomUUID, bindingHash: () => createHash("sha256").update(randomBytes(32)).digest("hex"),
  now: () => new Date(), monotonicNow: () => performance.now() };

function boundTarget(target: unknown, input: ProviderAgentLaunchInput): ProviderVmDeploymentTargetDto {
  const parsed = ProviderVmDeploymentTargetDtoSchema.safeParse(target);
  if (!parsed.success || parsed.data.id !== input.targetId || parsed.data.connectionId !== input.connectionId
    || parsed.data.evidenceConnectionRevision !== input.expectedConnectionRevision
    || !targetSupportsCatalogRuntime(parsed.data, input.type)) throw new ProviderAgentLaunchError("not_ready");
  return parsed.data;
}

/** Launch on one already-purchased, prepared computer. The SQL insert reserves
 * its original identity before tunnel/guest mutation. No provider purchase,
 * managed pool, Proxmox allocator, nested VM, hard fallback or automatic retry.
 * Unknown outcomes retain the original row/operation for observation/removal. */
export async function launchProviderAgent(raw: ProviderAgentLaunchInput, dependencies: Partial<Dependencies> = {}, modelLaunch?: ProviderAgentModelLaunch) {
  const deps = { ...defaults, ...dependencies }, input = Input.parse(structuredClone(raw));
  const modelRequest = modelLaunch ? { service: modelLaunch.service, admission: structuredClone(modelLaunch.admission) } : null;
  const deadline = deps.monotonicNow() + 30_000;
  const fence = () => { if (!Number.isFinite(deadline) || deps.monotonicNow() >= deadline) throw new ProviderAgentLaunchError("not_ready"); };
  const desktop = input.type === "linux-desktop";
  const definition = getAgent(input.type), floor = providerComputerResourceFloor(input.type, input.browser);
  let desktopControlOrigin: string | null = null;
  if (desktop) {
    try { desktopControlOrigin = parseProviderDesktopControlOrigin(deps.controlOrigin()); }
    catch { throw new ProviderAgentLaunchError("access"); }
  }
  const llm = validateLlmInput(input.llm, input.type);
  // DeepSeek remains absent from the public catalog, but this typed adapter is
  // callable by the acceptance harness for an already prepared owner-bound VM.
  if ((!definition?.available && input.type !== "deepseek-harness") || !definition
    || (input.browser && !definition.browser)) throw new ProviderAgentLaunchError("not_ready");
  // A model selection requires the server's already validated request context,
  // never a browser-provided owner/recipient or early installer key parameter.
  const selectedModel = ModelKeySelectionSchema.safeParse(input.llm);
  if (!llm.ok || input.managedVenice || (modelRequest
    ? input.type !== "codex" || modelRequest.admission.userId !== input.userId
      || modelRequest.admission.intent.browser !== input.browser || !selectedModel.success || !selectedModel.data
      || JSON.stringify(selectedModel.data) !== JSON.stringify(modelRequest.admission.intent.llm)
    : Boolean(llm.input))) throw new ProviderAgentLaunchError("model");
  if (input.templateSkills.length) throw new ProviderAgentLaunchError("template");
  const localMode = deps.localMode();
  if (!localMode && !deps.accessConfigured()) throw new ProviderAgentLaunchError("access");
  let target: ProviderVmDeploymentTargetDto, cpu: number, ram: number, address: string;
  try {
    fence(); target = boundTarget(await deps.target(input.userId, input.targetId), input); fence();
    if (modelRequest && !targetSupportsLaunchModelSettings(target, input.type)) throw new ProviderAgentLaunchError("model");
    const connection = await deps.connection(input.userId, input.connectionId); fence();
    if (connection.id !== input.connectionId || connection.provider !== "hetzner-cloud"
      || connection.status !== "ready" || connection.revision !== input.expectedConnectionRevision) throw new Error();
    const order = await deps.order(input.userId, input.connectionId, target.capabilities.capacityOrderId); fence();
    if (order.operation.id !== target.capabilities.capacityOrderId || order.operation.connectionId !== input.connectionId
      || order.connectionRevision !== input.expectedConnectionRevision || order.operation.status !== "created_off"
      || order.operation.providerServerId !== target.externalId || order.cleanup) throw new Error();
    const boot = await deps.boot({ binding: { userId: input.userId, connectionId: input.connectionId,
      connectionRevision: input.expectedConnectionRevision, orderId: order.operation.id,
      quoteFingerprint: order.quoteFingerprintSha256, recipeVersion: FIRST_BOOT_RECIPE_VERSION }, providerServerId: target.externalId });
    fence();
    if (!boot || boot.binding.attemptId !== target.capabilities.enrollmentAttemptId) throw new Error();
    const scope = { binding: boot.binding, providerServerId: target.externalId };
    const assets = await deps.bundle(); fence();
    const receipt = providerGuestBundleReceipt(scope, assets), p = target.capabilities.provisioner;
    if (receipt.bundleSha256 !== p.bundleSha256 || receipt.scopeSha256 !== p.scopeSha256
      || receipt.provisionerVersion !== p.version) throw new Error();
    const verified = await deps.verify({ scope, operation: boot, dispatchDeadlineMs: deadline,
      ...(localMode ? { requireDirectHttps: true } : {}) }, { monotonicNow: deps.monotonicNow }); fence();
    if (verified.stage !== "provider_verified" || JSON.stringify(verified.scope) !== JSON.stringify(scope)) throw new Error();
    const bootstrap = await deps.bootstrap({ userId: input.userId, connectionId: input.connectionId,
      expectedRevision: input.expectedConnectionRevision, orderId: order.operation.id,
      idempotencyKey: verified.capacityIdempotencyKey, quoteFingerprintSha256: order.quoteFingerprintSha256 }); fence();
    const inspected = await deps.inspect({ connectionId: input.connectionId, address: verified.address,
      hostPublicKey: verified.hostPublicKey, administratorPublicKey: bootstrap.publicKeyOpenSsh,
      administratorPrivateKey: bootstrap.privateKeyOpenSsh, dispatchDeadlineMs: deadline }, { monotonicNow: deps.monotonicNow }); fence();
    if (inspected.hostVerified !== true || inspected.administratorAuthenticated !== true
      || inspected.hostFingerprintSha256 !== verified.hostFingerprintSha256) throw new Error();
    address = verified.address;
    const snapshot = parseProviderGuestDiscoveryOutput({ output: inspected.output, discoveryId: deps.newId(),
      connectionId: input.connectionId, connectionRevision: input.expectedConnectionRevision,
      capacityOrderId: order.operation.id, enrollmentAttemptId: boot.binding.attemptId, providerServerId: target.externalId,
      normalizedHostFingerprint: target.capabilities.hostIdentityDigest, observedAt: deps.now() });
    assertProviderComputerEnvironment(snapshot);
    cpu = order.operation.quote.serverType.cores; ram = order.operation.quote.serverType.memoryGb;
    // This is an existing whole VM. Persist its provider size, not a fictitious
    // requested RAM slice; require fresh free headroom for the chosen runtime.
    const capacity = snapshot.host.capacity;
    if (cpu !== capacity.cpu.logicalCores || cpu < floor.cpu || ram < floor.ram
      || (desktop && (capacity.memoryBytes.total ?? 0) < floor.ram * 1024 ** 3)
      || (capacity.memoryBytes.available ?? 0) < floor.ram * 1024 ** 3
      || (capacity.rootStorageBytes.available ?? 0) < 30 * 1024 ** 3) throw new ProviderAgentLaunchError("capacity");
    fence();
  } catch (error) {
    if (error instanceof ProviderAgentLaunchError) throw error;
    throw new ProviderAgentLaunchError("not_ready");
  }
  const operation = { userId: input.userId, agentId: z.string().uuid().parse(deps.newId()),
    operationId: input.launchOperationId ?? z.string().uuid().parse(deps.newId()) };
  const row = {
    id: operation.agentId, user_id: input.userId, type: input.type, name: input.name, status: "provisioning",
    ...(desktop ? { computer_profile: "ubuntu-desktop" } : {}),
    desired_state: "running", operation_kind: "provision", operation_id: operation.operationId,
    allocation_operation_id: operation.operationId, operation_started_at: deps.now().toISOString(),
    operation_payload: { stage: "pre_allocation_access" }, deployment_mode: "self-managed", computer_substrate: "provider-vm",
    managed_provisioner_channel: "default",
    vmid: null, proxmox_host: SELF_MANAGED_HIVRA_PROXMOX_HOST_SENTINEL,
    infrastructure_connection_id: input.connectionId, infrastructure_connection_revision: input.expectedConnectionRevision,
    deployment_target_id: target.id, provider_capacity_order_id: target.capabilities.capacityOrderId,
    provider_enrollment_attempt_id: target.capabilities.enrollmentAttemptId, provider_server_id: target.externalId,
    infrastructure_binding_token_hash: z.string().regex(/^[0-9a-f]{64}$/).parse(deps.bindingHash()), infrastructure_binding_token_enforced: true,
    cpu, ram, pool_id: null, goal: input.goal, context: input.context, personality: input.personality, emoji: input.emoji,
    managed_venice: false, llm_config: null, llm_api_key_encrypted: null,
    template_skills: input.templateSkills.length ? input.templateSkills : null,
  };
  let agent: Record<string, unknown>;
  const matches = (value: Record<string, unknown>) => value.id === row.id && value.user_id === row.user_id
    && value.type === row.type && (!desktop || value.computer_profile === "ubuntu-desktop")
    && value.computer_substrate === row.computer_substrate && value.provider_capacity_order_id === row.provider_capacity_order_id
    && value.provider_server_id === row.provider_server_id && value.deployment_target_id === row.deployment_target_id
    && value.provider_enrollment_attempt_id === row.provider_enrollment_attempt_id
    && value.infrastructure_connection_id === row.infrastructure_connection_id
    && value.infrastructure_connection_revision === row.infrastructure_connection_revision
    && value.allocation_operation_id === row.allocation_operation_id;
  try {
    if (modelRequest) {
      const reservation = await modelRequest.service.reserve(modelRequest.admission, {
        id: row.id, type: "codex", name: row.name, cpu, ram, deployment_mode: "self-managed", computer_substrate: "provider-vm",
        managed_provisioner_channel: "default",
        operation_id: row.operation_id, proxmox_host: row.proxmox_host, infrastructure_binding_token_hash: row.infrastructure_binding_token_hash,
        pool_id: null, goal: row.goal, context: row.context, personality: row.personality, emoji: row.emoji, template_skills: row.template_skills,
        infrastructure_connection_id: row.infrastructure_connection_id, infrastructure_connection_revision: row.infrastructure_connection_revision,
        deployment_target_id: row.deployment_target_id, provider_capacity_order_id: row.provider_capacity_order_id,
        provider_enrollment_attempt_id: row.provider_enrollment_attempt_id, provider_server_id: row.provider_server_id,
      // An agent on the owner's own cloud uses the owner's capacity and is not
      // counted toward the plan's agent limit; the reservation does not count it.
      }, 0);
      if (!reservation.created) return { agent: sanitizeHivraAgentRow(reservation.agent), launchRequestId: reservation.requestId };
      agent = reservation.agent;
    } else agent = await deps.reserve(row);
    if (!matches(agent) || agent.operation_id !== operation.operationId || agent.desired_state !== "running") throw new ProviderAgentLaunchError("unconfirmed");
  } catch (error) {
    // An unacknowledged insert may have committed. Only read that exact generated
    // ID; never repeat insertion, create access, or dispatch the guest here.
    try { const saved = await deps.current(input.userId, operation.agentId); if (matches(saved)) return { agent: sanitizeHivraAgentRow(saved),
      ...(modelRequest ? { launchRequestId: modelRequest.admission.requestId } : {}) }; } catch { /* generic error below */ }
    if (error instanceof ProviderAgentLaunchError) throw error;
    throw new ProviderAgentLaunchError("unconfirmed");
  }
  try {
    const direct = localMode ? await deps.directAccess({ ...operation, address }) : null;
    const tunnel = localMode ? null : await deps.tunnel(operation);
    if (localMode ? !direct : !tunnel) throw new Error();
    const access = { tunnelToken: tunnel?.token ?? null, accessHostname: direct?.hostname ?? null };
    if (input.type === "linux-desktop") {
      const publicOrigin = direct?.origin ?? tunnel?.url;
      if (!publicOrigin || !desktopControlOrigin) throw new Error();
      await deps.desktopInstaller({ ...operation, action: "start", launch: { version: 3,
        computerSubstrate: "provider-vm", agentKind: "linux-desktop", computerId: operation.agentId,
        controlOrigin: desktopControlOrigin, publicOrigin, wantBrowser: null,
        modelKey: "", modelBaseUrl: "", model: "", ...access } });
    } else if (input.type === "deepseek-harness") {
      const publicOrigin = direct?.origin ?? tunnel?.url;
      if (!publicOrigin) throw new Error();
      await deps.nativeInstaller({ ...operation, action: "start", launch: { version: 2,
        computerSubstrate: "provider-vm", agentKind: "deepseek-harness", wantBrowser: false,
        modelKey: "", modelBaseUrl: "", model: "", ...access, publicOrigin } });
    } else {
      await deps.installer({ ...operation, action: "start", launch: { version: 1, computerSubstrate: "provider-vm",
        agentKind: input.type === "claude-code" ? "claude" : input.type, wantBrowser: input.browser,
        modelKey: "", modelBaseUrl: "", model: "", ...access } });
    }
  } catch {
    await deps.failure({ ...operation, error: "Launch setup could not be confirmed. The original cloud computer and operation are retained. Inspect it in Manage; provider billing may continue." }).catch(() => false);
  }
  // The original page observes installer, runtime and public readiness. A
  // returned start acknowledgement never manufactures running or completion.
  const saved = await deps.current(input.userId, operation.agentId);
  if (!matches(saved)) throw new ProviderAgentLaunchError("unconfirmed");
  return { agent: sanitizeHivraAgentRow(saved), ...(modelRequest ? { launchRequestId: modelRequest.admission.requestId } : {}) };
}
