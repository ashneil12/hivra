import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  createHetznerCloudProjectClient,
  createHetznerCloudPowerClient,
  createHetznerCloudCleanupClient,
  type HetznerAction,
  type HetznerCloudProjectClient,
  type HetznerCloudPowerClient,
  type HetznerCloudCleanupClient,
  type HetznerServer,
} from "@/lib/hetzner/client";
import {
  HETZNER_CLOUD_SIMPLE_MODE_POLICY,
  type HetznerCloudOfferCatalogDto,
} from "@/lib/infrastructure/contracts";
import {
  assertServerIdentityMatchesShape,
  getHetznerCloudOfferCatalogForBoundClient,
  type HetznerServerShape,
} from "@/lib/infrastructure/hetzner-cloud";
import {
  parseHetznerCurrentServerShapeEvidence,
} from "@/lib/infrastructure/hetzner-current-server-shape";
import { loadHetznerCloudConnectionSecret } from "@/lib/infrastructure/hetzner-cloud-store";
import { getAgent } from "./agent-catalog";
import { providerComputerResourceFloor } from "./provider-computer-resource-floor";
import { inspectProviderResizeReadiness } from "./provider-resize-readiness";
import {
  PROVIDER_RESIZE_BILLING_CONFIRMATION,
  PROVIDER_RESIZE_DOWNTIME_NOTICE,
  ProviderResizeCatalogSchema,
  ProviderResizeOperationViewSchema,
  ProviderResizeQuoteSchema,
  providerResizeMessage,
  type ProviderResizeCatalog,
  type ProviderResizeOperationView,
  type ProviderResizeQuote,
  type ProviderResizeSize,
} from "./provider-agent-resize-contract";
import {
  beginProviderResizeDispatch,
  beginProviderResizeShutdown,
  recordProviderResizeShutdown,
  recordProviderResizeReadiness,
  recordProviderResizeServerAbsent,
  cancelProviderResizeOperation,
  claimProviderResizeOperation,
  completeProviderResizeOperation,
  createProviderResizeQuoteRecord,
  failProviderResizeOperation,
  findActiveProviderResizeOperation,
  loadProviderResizeAuthority,
  loadProviderResizeOperation,
  recordProviderResizeAction,
  recordProviderResizeObservation,
  ProviderAgentResizeStoreError,
  type ProviderResizeAuthority,
  type ProviderResizeObservation,
  type ProviderResizeOperationInput,
  type StoredProviderResizeOperation,
} from "./provider-agent-resize-store";

export type ProviderResizeErrorCode =
  | "not_found"
  | "not_supported"
  | "computer_busy"
  | "computer_must_be_stopped"
  | "selection_invalid"
  | "quote_expired"
  | "quote_changed"
  | "operation_conflict"
  | "provider_unavailable"
  | "provider_response_invalid"
  | "operation_unverified";

export class ProviderAgentResizeError extends Error {
  constructor(readonly code: ProviderResizeErrorCode) {
    super(`Provider resize failed: ${code}`);
    this.name = "ProviderAgentResizeError";
  }
}

type Dependencies = {
  now(): Date;
  monotonicNow(): number;
  authority: typeof loadProviderResizeAuthority;
  active: typeof findActiveProviderResizeOperation;
  load: typeof loadProviderResizeOperation;
  catalog: typeof getHetznerCloudOfferCatalogForBoundClient;
  secret: typeof loadHetznerCloudConnectionSecret;
  client(token: string): HetznerCloudProjectClient;
  powerClient(token: string): HetznerCloudPowerClient;
  absenceClient(token: string): Pick<HetznerCloudCleanupClient, "getServer">;
  createQuote: typeof createProviderResizeQuoteRecord;
  claim: typeof claimProviderResizeOperation;
  begin: typeof beginProviderResizeDispatch;
  recordAction: typeof recordProviderResizeAction;
  beginShutdown: typeof beginProviderResizeShutdown;
  inspectReadiness: typeof inspectProviderResizeReadiness;
  recordReadiness: typeof recordProviderResizeReadiness;
  recordShutdown: typeof recordProviderResizeShutdown;
  recordAbsent: typeof recordProviderResizeServerAbsent;
  recordObservation: typeof recordProviderResizeObservation;
  complete: typeof completeProviderResizeOperation;
  fail: typeof failProviderResizeOperation;
  cancel: typeof cancelProviderResizeOperation;
};

const defaults: Dependencies = {
  now: () => new Date(),
  monotonicNow: () => performance.now(),
  authority: loadProviderResizeAuthority,
  active: findActiveProviderResizeOperation,
  load: loadProviderResizeOperation,
  catalog: getHetznerCloudOfferCatalogForBoundClient,
  secret: loadHetznerCloudConnectionSecret,
  client: (token) => createHetznerCloudProjectClient(token),
  powerClient: (token) => createHetznerCloudPowerClient(token),
  absenceClient: (token) => createHetznerCloudCleanupClient(token),
  createQuote: createProviderResizeQuoteRecord,
  claim: claimProviderResizeOperation,
  begin: beginProviderResizeDispatch,
  recordAction: recordProviderResizeAction,
  beginShutdown: beginProviderResizeShutdown,
  inspectReadiness: inspectProviderResizeReadiness,
  recordReadiness: recordProviderResizeReadiness,
  recordShutdown: recordProviderResizeShutdown,
  recordAbsent: recordProviderResizeServerAbsent,
  recordObservation: recordProviderResizeObservation,
  complete: completeProviderResizeOperation,
  fail: failProviderResizeOperation,
  cancel: cancelProviderResizeOperation,
};

const ServerStatus = z.enum([
  "running", "off", "initializing", "starting", "stopping", "deleting",
  "rebuilding", "migrating", "unknown",
]);
const ServerTypeName = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/);
type ResizeSize = ProviderResizeSize;

function safeProviderStatus(value: unknown): z.infer<typeof ServerStatus> {
  const parsed = ServerStatus.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function exactAction(raw: HetznerAction, serverId: number, actionId?: number): HetznerAction {
  if (
    !Number.isSafeInteger(raw.id)
    || raw.id <= 0
    || (actionId !== undefined && raw.id !== actionId)
    || raw.command !== "change_server_type"
    || !["running", "success", "error"].includes(raw.status)
    || !Array.isArray(raw.resources)
    || raw.resources.length !== 1
    || raw.resources[0]?.type !== "server"
    || raw.resources[0]?.id !== serverId
  ) throw new ProviderAgentResizeError("provider_response_invalid");
  return raw;
}

function exactServerIdentity(
  server: HetznerServer,
  authority: ProviderResizeAuthority,
  shape: HetznerServerShape | null,
): void {
  const serverId = Number(authority.agent.provider_server_id);
  const receipt = authority.order.provider_creation_receipt;
  if (
    server.id !== serverId
    || server.name !== authority.order.server_name
    || receipt.serverId !== String(server.id)
    || String(server.public_net?.ipv4?.id) !== receipt.primaryIpv4.id
    || server.public_net?.ipv4?.ip !== receipt.primaryIpv4.ip
    || String(server.public_net?.ipv6?.id) !== receipt.primaryIpv6.id
    || server.public_net?.ipv6?.ip !== receipt.primaryIpv6.ip
  ) throw new ProviderAgentResizeError("operation_conflict");
  try {
    assertServerIdentityMatchesShape(
      server,
      authority.order.quote_snapshot,
      authority.order.provider_labels,
      shape,
    );
  } catch {
    throw new ProviderAgentResizeError("operation_conflict");
  }
}

function currentServerShape(authority: ProviderResizeAuthority): HetznerServerShape | null {
  let current: ReturnType<typeof parseHetznerCurrentServerShapeEvidence>;
  try {
    current = parseHetznerCurrentServerShapeEvidence({
      shape: authority.order.current_server_shape,
      fingerprintSha256: authority.order.current_server_shape_fingerprint_sha256,
      capacityOrderId: authority.order.id,
      connectionId: authority.order.connection_id,
      connectionRevision: authority.order.connection_revision,
      providerServerId: authority.order.provider_resource_id,
    });
  } catch {
    throw new ProviderAgentResizeError("operation_conflict");
  }
  return current?.shape ?? null;
}

function livePrice(
  serverType: HetznerCloudOfferCatalogDto["serverTypes"][number],
  location: string,
  currency: string,
) {
  const prices = serverType.prices.filter((price) => price.location === location);
  if (
    prices.length !== 1
    || prices[0].hourly.currency !== currency
    || prices[0].monthly.currency !== currency
  ) throw new ProviderAgentResizeError("provider_response_invalid");
  return {
    currency,
    hourlyGross: prices[0].hourly.gross,
    monthlyGross: prices[0].monthly.gross,
  };
}

function sizeFromCatalog(
  serverType: HetznerCloudOfferCatalogDto["serverTypes"][number],
  location: string,
  currency: string,
): ResizeSize {
  if (!serverType.architecture) throw new ProviderAgentResizeError("provider_response_invalid");
  return {
    serverTypeId: serverType.id,
    serverType: serverType.name,
    architecture: serverType.architecture,
    cores: serverType.cores,
    memoryGb: serverType.memoryGb,
    advertisedDiskGb: serverType.diskGb,
    cpuType: serverType.cpuType,
    price: livePrice(serverType, location, currency),
  };
}

type LiveResizeSnapshot = {
  authority: ProviderResizeAuthority;
  provider: HetznerCloudProjectClient;
  server: HetznerServer;
  catalog: ProviderResizeCatalog;
  planFingerprint: string;
};

async function liveSnapshot(
  userId: string,
  agentId: string,
  dependencies: Partial<Dependencies> = {},
): Promise<LiveResizeSnapshot> {
  const deps = { ...defaults, ...dependencies };
  let authority: ProviderResizeAuthority;
  try {
    authority = await deps.authority(userId, agentId);
  } catch (error) {
    if (error instanceof ProviderAgentResizeStoreError && error.code === "computer_busy") {
      throw new ProviderAgentResizeError("computer_busy");
    }
    if (error instanceof ProviderAgentResizeStoreError && error.code === "not_found") {
      throw new ProviderAgentResizeError("not_found");
    }
    if (error instanceof ProviderAgentResizeStoreError && error.code === "conflict") {
      throw new ProviderAgentResizeError("not_supported");
    }
    throw new ProviderAgentResizeError("operation_unverified");
  }
  const { agent } = authority;
  if (agent.operation_id !== null || agent.status === "provisioning") {
    throw new ProviderAgentResizeError("computer_busy");
  }
  let loaded: Awaited<ReturnType<typeof loadHetznerCloudConnectionSecret>>;
  try {
    loaded = await deps.secret(userId, agent.infrastructure_connection_id, { requireBoundToken: true });
  } catch {
    throw new ProviderAgentResizeError("provider_unavailable");
  }
  if (
    loaded.connection.id !== agent.infrastructure_connection_id
    || loaded.connection.status !== "ready"
    || loaded.revision !== agent.infrastructure_connection_revision
  ) throw new ProviderAgentResizeError("operation_conflict");
  const provider = deps.client(loaded.apiToken);
  let offerCatalog: HetznerCloudOfferCatalogDto;
  let server: HetznerServer;
  try {
    [offerCatalog, server] = await Promise.all([
      deps.catalog(provider, deps.now().toISOString()),
      provider.getServer(Number(agent.provider_server_id)),
    ]);
  } catch {
    throw new ProviderAgentResizeError("provider_unavailable");
  }
  exactServerIdentity(server, authority, currentServerShape(authority));
  const observedAt = deps.now().toISOString();
  const location = server.location?.name ?? server.datacenter?.location?.name;
  const architecture = server.server_type?.architecture;
  const existingDiskGb = server.primary_disk_size;
  const sourceTypes = offerCatalog.serverTypes.filter((candidate) =>
    candidate.id === server.server_type?.id && candidate.name === server.server_type?.name);
  if (
    !location
    || (architecture !== "x86" && architecture !== "arm")
    || !Number.isSafeInteger(existingDiskGb)
    || Number(existingDiskGb) <= 0
    || sourceTypes.length !== 1
  ) throw new ProviderAgentResizeError("provider_response_invalid");
  const source = sourceTypes[0];
  if (
    source.architecture !== architecture
    || source.cores !== server.server_type.cores
    || source.memoryGb !== server.server_type.memory
    || source.diskGb !== server.server_type.disk
    || source.cores !== agent.cpu
    || source.memoryGb !== agent.ram
  ) throw new ProviderAgentResizeError("operation_conflict");
  const current = sizeFromCatalog(source, location, offerCatalog.currency);
  const floor = providerComputerResourceFloor(agent.type, Boolean(getAgent(agent.type)?.browser));
  const policy = HETZNER_CLOUD_SIMPLE_MODE_POLICY;
  if (source.cpuType !== policy.cpuType) {
    throw new ProviderAgentResizeError("not_supported");
  }
  const policyCap = policy.maxMonthlyGrossByCurrency.find((entry) => entry.currency === offerCatalog.currency);
  const compatible = offerCatalog.serverTypes.filter((candidate) => {
    const availability = candidate.locations.filter((entry) => entry.name === location);
    const price = candidate.prices.filter((entry) => entry.location === location);
    return candidate.id !== source.id
      && candidate.name !== source.name
      && !candidate.deprecated
      && candidate.architecture === architecture
      && candidate.cpuType === policy.cpuType
      && candidate.cores >= policy.minCores
      && candidate.memoryGb >= policy.minMemoryGb
      && candidate.cores >= floor.cpu
      && candidate.memoryGb >= floor.ram
      && candidate.cores <= policy.maxCores
      && candidate.memoryGb <= policy.maxMemoryGb
      && candidate.diskGb <= policy.maxDiskGb
      && candidate.diskGb >= Number(existingDiskGb)
      && availability.length === 1
      && availability[0].available
      && !availability[0].deprecated
      && price.length === 1
      && policyCap !== undefined
      && price[0].monthly.currency === offerCatalog.currency
      && Number.isFinite(Number(price[0].monthly.gross))
      && Number(price[0].monthly.gross) <= Number(policyCap.amount);
  });
  const offers = compatible.map((candidate) => ({
    ...sizeFromCatalog(candidate, location, offerCatalog.currency),
    description: candidate.description,
  })).sort((left, right) => left.memoryGb - right.memoryGb || left.cores - right.cores || left.serverType.localeCompare(right.serverType));
  const providerPowerState = safeProviderStatus(server.status);
  const catalog = ProviderResizeCatalogSchema.parse({
    capability: "hetzner-change-type-v1",
    agentId: agent.id,
    providerServerId: agent.provider_server_id,
    location,
    providerPowerState,
    providerLocked: server.locked === true,
    requiresPowerOff: true,
    upgradeDisk: false,
    existingDiskGb: Number(existingDiskGb),
    current,
    offers,
    observedAt,
    downtimeNotice: PROVIDER_RESIZE_DOWNTIME_NOTICE,
  });
  const planFingerprint = digest({
    contract: catalog.capability,
    agentId: agent.id,
    connectionId: agent.infrastructure_connection_id,
    connectionRevision: agent.infrastructure_connection_revision,
    targetId: agent.deployment_target_id,
    capacityOrderId: agent.provider_capacity_order_id,
    enrollmentAttemptId: agent.provider_enrollment_attempt_id,
    allocationOperationId: agent.allocation_operation_id,
    providerServerId: agent.provider_server_id,
    location,
    providerPowerState,
    providerLocked: catalog.providerLocked,
    existingDiskGb: catalog.existingDiskGb,
    current,
    offers,
    upgradeDisk: false,
  });
  return { authority, provider, server, catalog, planFingerprint };
}

export async function getProviderResizeCatalog(
  userId: string,
  agentId: string,
  dependencies: Partial<Dependencies> = {},
): Promise<ProviderResizeCatalog> {
  return (await liveSnapshot(userId, agentId, dependencies)).catalog;
}

export async function quoteProviderResize(input: {
  userId: string;
  agentId: string;
  operationId: string;
  targetServerType: string;
}, dependencies: Partial<Dependencies> = {}): Promise<ProviderResizeQuote> {
  const deps = { ...defaults, ...dependencies };
  const operationId = z.string().uuid().parse(input.operationId);
  const targetServerType = ServerTypeName.parse(input.targetServerType);
  try {
    const saved = await deps.load({ userId: input.userId, agentId: input.agentId, operationId });
    if (saved.quote.target.serverType !== targetServerType) {
      throw new ProviderAgentResizeError("operation_conflict");
    }
    return saved.quote;
  } catch (error) {
    if (error instanceof ProviderAgentResizeError) throw error;
    if (!(error instanceof ProviderAgentResizeStoreError) || error.code !== "not_found") {
      throw new ProviderAgentResizeError("operation_conflict");
    }
  }
  const snapshot = await liveSnapshot(input.userId, input.agentId, deps);
  if (
    snapshot.authority.agent.status !== "stopped"
    || snapshot.authority.agent.desired_state !== "stopped"
    || snapshot.catalog.providerPowerState !== "off"
    || snapshot.catalog.providerLocked
  ) throw new ProviderAgentResizeError("computer_must_be_stopped");
  const targets = snapshot.catalog.offers.filter((offer) => offer.serverType === targetServerType);
  if (targets.length !== 1) throw new ProviderAgentResizeError("selection_invalid");
  const selected = targets[0];
  const target: ResizeSize = {
    serverTypeId: selected.serverTypeId,
    serverType: selected.serverType,
    architecture: selected.architecture,
    cores: selected.cores,
    memoryGb: selected.memoryGb,
    advertisedDiskGb: selected.advertisedDiskGb,
    cpuType: selected.cpuType,
    price: selected.price,
  };
  const observedAt = snapshot.catalog.observedAt;
  const expiresAt = new Date(Date.parse(observedAt) + 5 * 60_000).toISOString();
  const quoteWithoutFingerprint = {
    operationId,
    agentId: snapshot.authority.agent.id,
    providerServerId: snapshot.authority.agent.provider_server_id,
    location: snapshot.catalog.location,
    source: snapshot.catalog.current,
    target,
    existingDiskGb: snapshot.catalog.existingDiskGb,
    upgradeDisk: false as const,
    observedAt,
    expiresAt,
    downtimeNotice: PROVIDER_RESIZE_DOWNTIME_NOTICE,
    billingConfirmation: PROVIDER_RESIZE_BILLING_CONFIRMATION,
  };
  const quote = ProviderResizeQuoteSchema.parse({
    ...quoteWithoutFingerprint,
    quoteFingerprint: digest({
      contract: "hivra/provider-resize-quote/v1",
      planFingerprint: snapshot.planFingerprint,
      quote: quoteWithoutFingerprint,
    }),
  });
  const result = await deps.createQuote({
    authority: snapshot.authority,
    operationId,
    planFingerprint: snapshot.planFingerprint,
    quote,
  });
  if (result === "conflict") throw new ProviderAgentResizeError("operation_conflict");
  return quote;
}

function operationView(operation: StoredProviderResizeOperation, now = new Date()): ProviderResizeOperationView {
  const awaitingShutdown = operation.stage === "provider_pending"
    && operation.action?.status === "success"
    && operation.observation?.providerStatus === "running"
    && operation.observation.serverType === operation.quote.target.serverType;
  const readinessFresh = operation.shutdownReadiness !== null && operation.shutdownWaitStartedAt !== null
    && now.getTime() - Date.parse(operation.shutdownReadiness.observedAt) < 15_000
    && Date.parse(operation.shutdownReadiness.observedAt) <= now.getTime() + 5_000
    && now.getTime() - Date.parse(operation.shutdownWaitStartedAt) < 120_000;
  return ProviderResizeOperationViewSchema.parse({
    operationId: operation.input.operationId,
    stage: operation.stage,
    quote: operation.quote,
    providerActionId: operation.action?.id ?? null,
    providerActionStatus: operation.action?.status ?? null,
    observedProviderState: operation.observation?.providerStatus ?? null,
    observedServerType: operation.observation?.serverType ?? null,
    completedAt: operation.completedAt,
    shutdownReadinessWaiting: awaitingShutdown && !readinessFresh && operation.shutdownAttemptedAt === null
      && operation.authority.agent.desired_state === "stopped",
    shutdownRequired: awaitingShutdown && operation.shutdownAttemptedAt === null
      && readinessFresh
      && operation.authority.agent.desired_state === "stopped",
    message: operation.shutdownAttemptedAt !== null && operation.stage === "manual_attention"
      ? "The original post-resize shutdown could not be verified. No second shutdown or resize will be sent. Inspect the original server and action before continuing."
      : operation.shutdownWaitStartedAt !== null && operation.shutdownAttemptedAt === null && operation.stage === "manual_attention"
        ? "The guest shutdown listener was not verified within two minutes. No shutdown was sent; the resize remains locked for inspection."
      : operation.shutdownAttemptedAt !== null && operation.stage === "provider_pending"
        ? "The original shutdown is being checked. The computer will not be released until shutdown and the stopped state are verified."
        : awaitingShutdown && !readinessFresh
          ? "Hetzner started the resized computer. Waiting up to two minutes for its enrolled shutdown listener before sending the saved shutdown."
        : awaitingShutdown
          ? "Hetzner started the resized computer. Continue the saved resize to shut it down for review; no new resize or billing change will be sent."
          : providerResizeMessage(operation.stage),
  });
}

function observedServer(server: HetznerServer): ProviderResizeObservation {
  const diskGb = server.primary_disk_size;
  if (
    !Number.isSafeInteger(server.server_type?.id)
    || server.server_type.id <= 0
    || !ServerTypeName.safeParse(server.server_type?.name).success
    || (server.server_type.architecture !== "x86" && server.server_type.architecture !== "arm")
    || !Number.isSafeInteger(server.server_type?.cores)
    || server.server_type.cores <= 0
    || !Number.isSafeInteger(server.server_type?.memory)
    || server.server_type.memory <= 0
    || !Number.isSafeInteger(server.server_type.disk)
    || server.server_type.disk <= 0
    || (server.server_type.cpu_type !== "shared" && server.server_type.cpu_type !== "dedicated")
    || !Number.isSafeInteger(diskGb)
    || Number(diskGb) <= 0
  ) throw new ProviderAgentResizeError("provider_response_invalid");
  return {
    observedAt: new Date().toISOString(),
    providerStatus: safeProviderStatus(server.status),
    serverTypeId: server.server_type.id,
    serverType: server.server_type.name,
    architecture: server.server_type.architecture,
    cores: server.server_type.cores,
    memoryGb: server.server_type.memory,
    advertisedDiskGb: server.server_type.disk,
    cpuType: server.server_type.cpu_type,
    diskGb: Number(diskGb),
  };
}

export async function advanceProviderResize(
  raw: ProviderResizeOperationInput,
  mode: "dispatch" | "observe" | "cancel_if_undispatched" = "observe",
  dependencies: Partial<Dependencies> = {},
): Promise<ProviderResizeOperationView> {
  const deps = { ...defaults, ...dependencies };
  const input = z.object({ userId: z.string().min(1), agentId: z.string().uuid(), operationId: z.string().uuid() }).strict()
    .parse(structuredClone(raw));
  const deadline = deps.monotonicNow() + 30_000;
  const fence = () => {
    if (!Number.isFinite(deadline) || deps.monotonicNow() >= deadline) {
      throw new ProviderAgentResizeError("operation_unverified");
    }
  };
  let operation = await deps.load(input);
  if (["quoted", "succeeded", "failed", "cancelled", "removed"].includes(operation.stage)) return operationView(operation);
  if (operation.stage === "dispatch_pending") {
    if (mode === "observe") return operationView(operation);
    if (operation.authority.agent.desired_state === "deleted") {
      if (!await deps.cancel(input, "delete_requested")) throw new ProviderAgentResizeError("operation_unverified");
      return operationView(await deps.load(input));
    }
    if (mode === "cancel_if_undispatched") return operationView(operation);
    const floor = providerComputerResourceFloor(operation.authority.agent.type, Boolean(getAgent(operation.authority.agent.type)?.browser));
    if (operation.quote.target.cores < floor.cpu || operation.quote.target.memoryGb < floor.ram) {
      if (!await deps.cancel(input, "target_below_runtime_floor")) throw new ProviderAgentResizeError("operation_unverified");
      return operationView(await deps.load(input));
    }
    if (!operation.dispatchNotAfter || deps.now().getTime() >= Date.parse(operation.dispatchNotAfter)) {
      if (!await deps.cancel(input, "dispatch_expired")) throw new ProviderAgentResizeError("operation_unverified");
      return operationView(await deps.load(input));
    }
    let loaded: Awaited<ReturnType<typeof loadHetznerCloudConnectionSecret>>;
    try {
      loaded = await deps.secret(input.userId, operation.authority.agent.infrastructure_connection_id, { requireBoundToken: true });
    } catch { throw new ProviderAgentResizeError("provider_unavailable"); }
    fence();
    if (
      loaded.connection.id !== operation.authority.agent.infrastructure_connection_id
      || loaded.connection.status !== "ready"
      || loaded.revision !== operation.authority.agent.infrastructure_connection_revision
    ) throw new ProviderAgentResizeError("operation_conflict");
    const provider = deps.client(loaded.apiToken);
    let before: HetznerServer;
    try { before = await provider.getServer(Number(operation.quote.providerServerId)); }
    catch { throw new ProviderAgentResizeError("provider_unavailable"); }
    fence();
    exactServerIdentity(before, operation.authority, currentServerShape(operation.authority));
    const source = operation.quote.source;
    if (
      before.status !== "off"
      || before.locked === true
      || before.server_type.name !== source.serverType
      || before.server_type.id !== source.serverTypeId
      || before.server_type.architecture !== source.architecture
      || before.server_type.cores !== source.cores
      || before.server_type.memory !== source.memoryGb
      || before.server_type.disk !== source.advertisedDiskGb
      || before.server_type.cpu_type !== source.cpuType
      || before.primary_disk_size !== operation.quote.existingDiskGb
    ) {
      if (!await deps.cancel(input, "source_changed")) throw new ProviderAgentResizeError("operation_unverified");
      return operationView(await deps.load(input));
    }
    const grant = await deps.begin(input);
    fence();
    if (grant === "rejected") {
      if (!await deps.cancel(input, "dispatch_rejected")) throw new ProviderAgentResizeError("operation_unverified");
      return operationView(await deps.load(input));
    }
    if (grant === "observe") return operationView(await deps.load(input));
    let action: HetznerAction;
    try {
      action = exactAction(await provider.changeServerType({
        serverId: Number(operation.quote.providerServerId),
        serverType: operation.quote.target.serverType,
      }), Number(operation.quote.providerServerId));
    } catch {
      return operationView(await deps.load(input));
    }
    // A known receipt is retained even if the network response consumed the
    // dispatch deadline. It is safer evidence than leaving the request wholly
    // ambiguous, but no follow-up mutation is attempted in this call.
    if (!await deps.recordAction(input, action)) throw new ProviderAgentResizeError("operation_unverified");
    operation = await deps.load(input);
    if (deps.monotonicNow() >= deadline || action.status === "running") return operationView(operation);
  }
  let loaded: Awaited<ReturnType<typeof loadHetznerCloudConnectionSecret>>;
  try {
    loaded = await deps.secret(input.userId, operation.authority.agent.infrastructure_connection_id, { requireBoundToken: true });
  } catch { throw new ProviderAgentResizeError("provider_unavailable"); }
  if (
    loaded.connection.id !== operation.authority.agent.infrastructure_connection_id
    || loaded.connection.status !== "ready"
    || loaded.revision !== operation.authority.agent.infrastructure_connection_revision
  ) throw new ProviderAgentResizeError("operation_conflict");
  const provider = deps.client(loaded.apiToken);
  let action = operation.action;
  let actionReadFailed = false;
  if (action && action.status !== "error") {
    try {
      action = exactAction(await provider.getAction(action.id), Number(operation.quote.providerServerId), action.id);
      if (!await deps.recordAction(input, action)) throw new ProviderAgentResizeError("operation_unverified");
      if (action.status === "running") return operationView(await deps.load(input));
    } catch (error) {
      if (error instanceof ProviderAgentResizeError && error.code === "operation_unverified") throw error;
      // Action lookups can become unavailable after Hetzner has already
      // applied the request. Retain the original receipt and reconcile only
      // this bound server below; never turn a read failure into another POST.
      action = operation.action;
      actionReadFailed = true;
    }
  }
  let server: HetznerServer;
  try { server = await provider.getServer(Number(operation.quote.providerServerId)); }
  catch { throw new ProviderAgentResizeError("provider_unavailable"); }
  const observation = { ...observedServer(server), observedAt: deps.now().toISOString() };
  exactServerIdentity(server, operation.authority, {
    serverType: {
      id: observation.serverTypeId,
      name: observation.serverType,
      architecture: observation.architecture,
      cores: observation.cores,
      memoryGb: observation.memoryGb,
      advertisedDiskGb: observation.advertisedDiskGb,
      cpuType: observation.cpuType,
    },
    primaryDiskGb: observation.diskGb,
  });
  const target = operation.quote.target;
  const targetShapeMatches = server.locked !== true
    && observation.serverTypeId === target.serverTypeId
    && observation.serverType === target.serverType
    && observation.architecture === target.architecture
    && observation.cores === target.cores
    && observation.memoryGb === target.memoryGb
    && observation.advertisedDiskGb === target.advertisedDiskGb
    && observation.cpuType === target.cpuType
    && observation.diskGb === operation.quote.existingDiskGb;
  let shutdown = operation.shutdownAction;
  if (operation.shutdownAttemptedAt !== null) {
    if (shutdown && shutdown.status === "running") {
      try {
        shutdown = await deps.powerClient(loaded.apiToken).getAction({
          serverId: Number(operation.quote.providerServerId), kind: "stop", actionId: shutdown.id,
        });
        if (!await deps.recordShutdown(input, shutdown)) throw new ProviderAgentResizeError("operation_unverified");
      } catch {
        // An unreadable receipt never authorizes another shutdown.
        shutdown = operation.shutdownAction;
      }
    }
    if (shutdown?.status !== "success") {
      const expired = deps.now().getTime() - Date.parse(operation.shutdownAttemptedAt) >= 120_000;
      if (!await deps.recordObservation(input, observation,
        shutdown?.status === "error" || expired ? "manual_attention" : "provider_pending")) {
        throw new ProviderAgentResizeError("operation_unverified");
      }
      return operationView(await deps.load(input));
    }
  }
  if (targetShapeMatches && observation.providerStatus === "running" && action?.status === "success") {
    const shutdownExpired = operation.shutdownAttemptedAt !== null
      && deps.now().getTime() - Date.parse(operation.shutdownAttemptedAt) >= 120_000;
    if (!await deps.recordObservation(input, observation,
      shutdownExpired ? "manual_attention" : "provider_pending")) {
      throw new ProviderAgentResizeError("operation_unverified");
    }
    operation = await deps.load(input);
    if (operation.shutdownAttemptedAt === null && operation.authority.agent.desired_state === "stopped") {
      // Start one durable boot-readiness window, not a renewable timeout. GET
      // may observe the guest and journal evidence; it cannot dispatch power.
      if (operation.shutdownWaitStartedAt === null) {
        if (!await deps.recordReadiness(input, null)) return operationView(await deps.load(input), deps.now());
        operation = await deps.load(input);
      }
      if (!operation.shutdownWaitStartedAt
        || deps.now().getTime() - Date.parse(operation.shutdownWaitStartedAt) >= 120_000) {
        await deps.recordReadiness(input, null); // Atomically retain manual-attention on expiry.
        return operationView(await deps.load(input), deps.now());
      }
      let readiness: StoredProviderResizeOperation["shutdownReadiness"] = null;
      try {
        fence();
        const checked = await deps.inspectReadiness({ ...input, dispatchDeadlineMs: deadline },
          { monotonicNow: deps.monotonicNow });
        fence();
        if (checked.receipt.ready) readiness = { version: 1, observedAt: checked.observedAt,
          hostFingerprintSha256: checked.hostFingerprintSha256, bootId: checked.receipt.bootId,
          powerHandlerPid: checked.receipt.powerHandlerPid };
      } catch {
        // Early boot or an unavailable pinned channel is not readiness. Keep
        // the original deadline and do not consume the one-use power marker.
      }
      if (!await deps.recordReadiness(input, readiness)) return operationView(await deps.load(input), deps.now());
      operation = await deps.load(input);
      if (readiness === null) return operationView(operation, deps.now());
    }
    // GET/observe never dispatches a provider mutation. The original protected
    // apply POST continues the already-confirmed stopped-after-resize workflow.
    if (mode === "dispatch" && operation.shutdownAttemptedAt === null
      && operation.authority.agent.desired_state === "stopped" && operation.shutdownReadiness !== null) {
      fence();
      const grant = await deps.beginShutdown(input, operation.shutdownReadiness);
      fence();
      if (grant === "dispatch") {
        try {
          const beforeShutdown = await provider.getServer(Number(operation.quote.providerServerId));
          fence();
          if (deps.now().getTime() - Date.parse(operation.shutdownReadiness.observedAt) >= 15_000) {
            throw new ProviderAgentResizeError("operation_unverified");
          }
          exactServerIdentity(beforeShutdown, operation.authority, {
            serverType: { id: target.serverTypeId, name: target.serverType, architecture: target.architecture,
              cores: target.cores, memoryGb: target.memoryGb, advertisedDiskGb: target.advertisedDiskGb,
              cpuType: observation.cpuType }, primaryDiskGb: operation.quote.existingDiskGb,
          });
          if (beforeShutdown.locked === true
            // Observation time is local metadata, not provider state. Compare
            // every stable field against the exact earlier observation.
            || JSON.stringify({ ...observedServer(beforeShutdown), observedAt: observation.observedAt })
              !== JSON.stringify(observation)) {
            throw new ProviderAgentResizeError("operation_conflict");
          }
          const receipt = await deps.powerClient(loaded.apiToken).dispatch({
            serverId: Number(operation.quote.providerServerId), kind: "stop",
          });
          if (!await deps.recordShutdown(input, receipt)) throw new ProviderAgentResizeError("operation_unverified");
        } catch {
          // Durable marker remains even on an uncertain response; no replay.
        }
      }
    }
    return operationView(await deps.load(input), deps.now());
  }
  if (targetShapeMatches && observation.providerStatus === "off" && action?.status !== "error") {
    if (!await deps.recordObservation(input, observation, "provider_pending")) {
      throw new ProviderAgentResizeError("operation_unverified");
    }
    if (!await deps.complete(input, observation)) throw new ProviderAgentResizeError("operation_unverified");
    return operationView(await deps.load(input));
  }
  const source = operation.quote.source;
  const sourceMatches = observation.providerStatus === "off"
    && server.locked !== true
    && observation.serverTypeId === source.serverTypeId
    && observation.serverType === source.serverType
    && observation.architecture === source.architecture
    && observation.cores === source.cores
    && observation.memoryGb === source.memoryGb
    && observation.advertisedDiskGb === source.advertisedDiskGb
    && observation.cpuType === source.cpuType
    && observation.diskGb === operation.quote.existingDiskGb;
  if (action?.status === "error" && sourceMatches) {
    if (!await deps.recordObservation(input, observation, "provider_pending")) {
      throw new ProviderAgentResizeError("operation_unverified");
    }
    if (!await deps.fail(input, "provider_action_failed")) throw new ProviderAgentResizeError("operation_unverified");
    return operationView(await deps.load(input));
  }
  const stage: "request_uncertain" | "action_pending" | "provider_pending" | "manual_attention" =
    !action && sourceMatches ? "request_uncertain"
      : actionReadFailed && action?.status === "running" && sourceMatches ? "action_pending"
      : action?.status === "success" && sourceMatches ? "provider_pending"
      : "manual_attention";
  if (!await deps.recordObservation(input, observation, stage)) {
    throw new ProviderAgentResizeError("operation_unverified");
  }
  return operationView(await deps.load(input));
}

/** Only explicit deletion may settle an active resize from fresh original
 * server absence. This does not delete anything or prove IP/firewall/key absence;
 * the existing deletion coordinator must independently finish those resources. */
export async function reconcileAbsentProviderResizeForDelete(
  input: ProviderResizeOperationInput,
  dependencies: Partial<Dependencies> = {},
): Promise<boolean> {
  const deps = { ...defaults, ...dependencies };
  const operation = await deps.load(input);
  if (operation.authority.agent.desired_state !== "deleted"
    || operation.providerPostAttemptedAt === null
    || !["request_uncertain", "action_pending", "provider_pending", "manual_attention"].includes(operation.stage)) return false;
  const loaded = await deps.secret(input.userId, operation.authority.agent.infrastructure_connection_id, { requireBoundToken: true });
  if (loaded.connection.id !== operation.authority.agent.infrastructure_connection_id
    || loaded.connection.status !== "ready"
    || loaded.revision !== operation.authority.agent.infrastructure_connection_revision) {
    throw new ProviderAgentResizeError("operation_conflict");
  }
  // This client recognizes only the provider's structured not_found response,
  // not a proxy HTML404, timeout or unavailable provider.
  const server = await deps.absenceClient(loaded.apiToken).getServer(Number(operation.quote.providerServerId));
  if (server !== null) return false;
  if (!await deps.recordAbsent(input, operation.quote.providerServerId, deps.now().toISOString())) {
    throw new ProviderAgentResizeError("operation_unverified");
  }
  return true;
}

export async function applyProviderResize(input: {
  userId: string;
  agentId: string;
  operationId: string;
  quoteFingerprint: string;
  billingConfirmation: string;
}, dependencies: Partial<Dependencies> = {}): Promise<ProviderResizeOperationView> {
  const deps = { ...defaults, ...dependencies };
  if (input.billingConfirmation !== PROVIDER_RESIZE_BILLING_CONFIRMATION) {
    throw new ProviderAgentResizeError("operation_conflict");
  }
  const operationInput = { userId: input.userId, agentId: input.agentId, operationId: input.operationId };
  let operation = await deps.load(operationInput);
  if (operation.quote.quoteFingerprint !== input.quoteFingerprint) {
    throw new ProviderAgentResizeError("operation_conflict");
  }
  if (operation.stage === "quoted") {
    if (deps.now().getTime() >= Date.parse(operation.quote.expiresAt)) {
      throw new ProviderAgentResizeError("quote_expired");
    }
    const fresh = await liveSnapshot(input.userId, input.agentId, deps);
    const comparableOffers = fresh.catalog.offers.filter((offer) => offer.serverType === operation.quote.target.serverType);
    if (
      fresh.planFingerprint !== operation.planFingerprint
      || comparableOffers.length !== 1
      || fresh.catalog.providerPowerState !== "off"
      || fresh.catalog.providerLocked
    ) throw new ProviderAgentResizeError("quote_changed");
    const claim = await deps.claim(operationInput, input.quoteFingerprint);
    if (claim === "expired") throw new ProviderAgentResizeError("quote_expired");
    if (claim === "rejected") throw new ProviderAgentResizeError("operation_conflict");
    operation = await deps.load(operationInput);
    return advanceProviderResize(operationInput, claim === "dispatch" ? "dispatch" : "observe", deps);
  }
  return advanceProviderResize(operationInput, "dispatch", deps);
}

export async function getProviderResizeView(
  userId: string,
  agentId: string,
  dependencies: Partial<Dependencies> = {},
): Promise<{ operation: ProviderResizeOperationView | null; catalog: ProviderResizeCatalog | null }> {
  const deps = { ...defaults, ...dependencies };
  const operationId = await deps.active(userId, agentId);
  if (operationId) {
    return { operation: await advanceProviderResize({ userId, agentId, operationId }, "observe", deps), catalog: null };
  }
  return { operation: null, catalog: await getProviderResizeCatalog(userId, agentId, deps) };
}
