"use client";

import { z } from "zod";

import { tryAgainInMinutes } from "@/lib/retry-after-copy";

import {
  DeploymentTargetDtoSchema,
  HetznerCloudCapacityOperationDtoSchema,
  HetznerCloudCapacityQuoteDtoSchema,
  HetznerCloudCapacityQuoteRequestSchema,
  HetznerCloudForceForgetRequestSchema,
  HetznerCloudForceForgetResultSchema,
  HetznerCloudOfferCatalogDtoSchema,
  HetznerCloudServerInventoryDtoSchema,
  InfrastructureConnectionCreateSchema,
  InfrastructureConnectionDtoSchema,
  ProxmoxConnectionUpdateSchema,
  ProxmoxPreflightResultSchema,
  type DeploymentTargetDto,
  type HetznerCloudCapacityOperationDto,
  type HetznerCloudCapacityQuoteDto,
  type HetznerCloudCapacityQuoteRequest,
  type HetznerCloudConnectionCreate,
  type HetznerCloudConnectionDto,
  type HetznerCloudForceForgetRequest,
  type HetznerCloudForceForgetResult,
  type HetznerCloudOfferCatalogDto,
  type HetznerCloudServerInventoryDto,
  type InfrastructureConnectionDto,
  type InfrastructureConnectionCreate,
  type ProxmoxConnectionUpdate,
  type ProxmoxPreflightResult,
} from "./contracts";
import {
  HostDiscoveryResultSchema,
  type HostDiscoveryResult,
} from "./host-discovery-contracts";
import {
  HetznerCloudCapacitySlotDtoSchema,
  HetznerCloudConnectResultSchema,
  HetznerCloudTokenReplaceRequestSchema,
  HetznerCloudTokenReplaceResultSchema,
  type HetznerCloudCapacitySlotDto,
  type HetznerCloudTokenReplaceResult,
  type HetznerCloudWriteCheck,
} from "./hetzner-cloud-token-contracts";
import { PreparedCapacityCreateRequestSchema, ProviderComputerSetupEvidenceSchema, ProviderComputerSetupRequestSchema,
  ProviderComputerSetupViewSchema, type PreparedCapacityCreateRequest, type ProviderComputerSetupEvidence,
  type ProviderComputerSetupRequest } from "./provider-computer-setup-contracts";

const ApiErrorSchema = z
  .object({
    error: z.string().trim().min(1).optional(),
    code: z.string().trim().min(1).optional(),
    cause: z.string().regex(/^[a-z_]{1,48}$/).optional(),
    stage: z.string().regex(/^[a-z-]{1,48}$/).optional(),
  })
  .passthrough();

const ConnectionsResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ connections: z.array(InfrastructureConnectionDtoSchema) }).strict(),
  })
  .passthrough();

const ConnectionResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ connection: InfrastructureConnectionDtoSchema }).strict(),
  })
  .passthrough();

const HetznerCloudConnectionResponseSchema = z
  .object({
    success: z.literal(true),
    data: HetznerCloudConnectResultSchema,
  })
  .passthrough();

const HetznerCloudTokenReplaceResponseSchema = z
  .object({
    success: z.literal(true),
    data: HetznerCloudTokenReplaceResultSchema,
  })
  .passthrough();

const HetznerCloudCapacitySlotResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ slot: HetznerCloudCapacitySlotDtoSchema }).strict(),
  })
  .passthrough();

const HetznerCloudInventoryResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ inventory: z.array(HetznerCloudServerInventoryDtoSchema) }).strict(),
  })
  .passthrough();

const HetznerCloudCatalogResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ catalog: HetznerCloudOfferCatalogDtoSchema }).strict(),
  })
  .passthrough();

const HetznerCloudCapacityQuoteResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ quote: HetznerCloudCapacityQuoteDtoSchema }).strict(),
  })
  .passthrough();

const HetznerCloudCapacityCreateResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        operation: HetznerCloudCapacityOperationDtoSchema,
        inventory: z.array(HetznerCloudServerInventoryDtoSchema),
      })
      .strict(),
  })
  .passthrough();

const HetznerCloudForceForgetResponseSchema = z
  .object({
    success: z.literal(true),
    data: HetznerCloudForceForgetResultSchema,
  })
  .passthrough();

const DeleteResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ deleted: z.literal(true) }).strict(),
  })
  .passthrough();

const PreflightResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ preflight: ProxmoxPreflightResultSchema }).strict(),
  })
  .passthrough();

const HostDiscoveryResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ discovery: HostDiscoveryResultSchema }).strict(),
  })
  .passthrough();

const TargetsResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ targets: z.array(DeploymentTargetDtoSchema) }).strict(),
  })
  .passthrough();

const InfrastructurePreparationSchema = z
  .object({
    ok: z.literal(true),
    connectionId: z.string().uuid(),
    provisionerVersion: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
    preflight: ProxmoxPreflightResultSchema,
  })
  .strict();

const PreparationResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ preparation: InfrastructurePreparationSchema }).strict(),
  })
  .passthrough();

export type InfrastructurePreparation = z.infer<typeof InfrastructurePreparationSchema>;

// The gVisor routes return the saved deployment_targets row. The dialog needs
// only which target it is and whether it came back ready; launch reloads the
// full owner-scoped target before anything starts.
const GvisorTargetResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        target: z.object({ id: z.string().uuid(), status: z.string() }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export type GvisorTargetResult = { targetId: string; ready: boolean };

export class InfrastructureApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    /** Seconds until the server accepts this request again, from Retry-After. */
    public readonly retryAfterSeconds: number | null = null,
    /** A fixed failure cause or step name the server reported, if any. */
    public readonly detail: { cause?: string; stage?: string } = {},
    /** The parsed error body, for callers whose failures carry a result. */
    public readonly failureBody?: unknown,
  ) {
    super(message);
    this.name = "InfrastructureApiError";
  }
}

/** Retry-After as whole seconds: either delta-seconds or an HTTP date. */
export function parseRetryAfterSeconds(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1_000)) : null;
}

const GENERIC_RATE_LIMIT_MESSAGE = "Too Many Requests";

function rateLimitedMessage(retryAfterSeconds: number | null): string {
  return `Too many tries in a row. ${retryAfterSeconds !== null
    ? tryAgainInMinutes(retryAfterSeconds)
    : "Wait a minute, then try again."}`;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Fetch one infrastructure API response and validate it. Throws
 * InfrastructureApiError with the server's plain message on failure. */
export async function requestJson<T>(
  input: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, {
      cache: "no-store",
      ...init,
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new InfrastructureApiError(
      "Hivra could not reach the infrastructure service. Check your connection and try again.",
      0,
    );
  }

  const body = await responseJson(response);
  if (!response.ok) {
    const parsedError = ApiErrorSchema.safeParse(body);
    const serverMessage = parsedError.success ? parsedError.data.error : undefined;
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers?.get?.("Retry-After") ?? null);
    throw new InfrastructureApiError(
      // A bare limiter refusal says only "Too Many Requests"; say when the
      // owner can try again instead.
      response.status === 429 && (!serverMessage || serverMessage === GENERIC_RATE_LIMIT_MESSAGE)
        ? rateLimitedMessage(retryAfterSeconds)
        : serverMessage ?? `Infrastructure request failed (${response.status}).`,
      response.status,
      parsedError.success ? parsedError.data.code : undefined,
      retryAfterSeconds,
      parsedError.success ? { cause: parsedError.data.cause, stage: parsedError.data.stage } : {},
      body,
    );
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new InfrastructureApiError(
      "The infrastructure service returned an unexpected response. Refresh and try again.",
      response.status,
    );
  }
  return parsed.data;
}

export async function listInfrastructureConnections(
  signal?: AbortSignal,
): Promise<InfrastructureConnectionDto[]> {
  const body = await requestJson(
    "/api/infrastructure/connections",
    { method: "GET", signal },
    ConnectionsResponseSchema,
  );
  return body.data.connections;
}

export async function listInfrastructureTargets(
  connectionId?: string,
  signal?: AbortSignal,
): Promise<DeploymentTargetDto[]> {
  const query = connectionId
    ? `?connectionId=${encodeURIComponent(connectionId)}`
    : "";
  const body = await requestJson(
    `/api/infrastructure/targets${query}`,
    { method: "GET", signal },
    TargetsResponseSchema,
  );
  return body.data.targets;
}

export async function createInfrastructureConnection(
  input: InfrastructureConnectionCreate,
): Promise<InfrastructureConnectionDto> {
  const validated = InfrastructureConnectionCreateSchema.parse(input);
  if (validated.provider === "hetzner-cloud") {
    return (await connectHetznerCloudProject(validated)).connection;
  }
  if (validated.provider === "digitalocean") {
    // DigitalOcean connects through its own client, which also returns the
    // published serverless target.
    throw new InfrastructureApiError("Use the DigitalOcean connection dialog.", 0);
  }
  const body = await requestJson(
    "/api/infrastructure/connections",
    { method: "POST", body: JSON.stringify(validated) },
    ConnectionResponseSchema,
  );
  return body.data.connection;
}

export type HetznerCloudTokenReplaceOutcome = Omit<HetznerCloudTokenReplaceResult, "connection"> & {
  connection: HetznerCloudConnectionDto;
};

type HetznerCloudConnectResult = {
  connection: HetznerCloudConnectionDto;
  inventory: HetznerCloudServerInventoryDto[];
  writeCheck: HetznerCloudWriteCheck;
};

function hetznerConnectResult(data: {
  connection: InfrastructureConnectionDto;
  inventory: HetznerCloudServerInventoryDto[];
  writeCheck: HetznerCloudWriteCheck;
}): HetznerCloudConnectResult {
  if (data.connection.provider !== "hetzner-cloud") {
    throw new InfrastructureApiError(
      "The infrastructure service returned the wrong provider.",
      0,
    );
  }
  return { connection: data.connection, inventory: data.inventory, writeCheck: data.writeCheck };
}

export async function connectHetznerCloudProject(
  input: HetznerCloudConnectionCreate,
): Promise<HetznerCloudConnectResult> {
  const validated = InfrastructureConnectionCreateSchema.parse(input);
  if (validated.provider !== "hetzner-cloud") {
    throw new InfrastructureApiError("A Hetzner Cloud connection is required.", 0);
  }
  const body = await requestJson(
    "/api/infrastructure/connections",
    { method: "POST", body: JSON.stringify(validated) },
    HetznerCloudConnectionResponseSchema,
  );
  return hetznerConnectResult(body.data);
}

/** Swap a Hetzner project's token in place. The server proves the new token
 * reaches the same project and can write before replacing anything. */
export async function replaceHetznerCloudToken(
  connectionId: string,
  apiToken: string,
): Promise<HetznerCloudTokenReplaceOutcome> {
  const validated = HetznerCloudTokenReplaceRequestSchema.parse({ apiToken });
  const body = await requestJson(
    `/api/infrastructure/connections/${z.string().uuid().parse(connectionId)}/hetzner-cloud/token`,
    { method: "POST", body: JSON.stringify(validated) },
    HetznerCloudTokenReplaceResponseSchema,
  );
  const { connection } = body.data;
  if (connection.provider !== "hetzner-cloud") {
    throw new InfrastructureApiError("The infrastructure service returned the wrong provider.", 0);
  }
  return { ...body.data, connection };
}

export async function getHetznerCloudCapacitySlot(signal?: AbortSignal): Promise<HetznerCloudCapacitySlotDto> {
  const body = await requestJson(
    "/api/infrastructure/hetzner-cloud/capacity-slot",
    { method: "GET", signal },
    HetznerCloudCapacitySlotResponseSchema,
  );
  return body.data.slot;
}

export async function getHetznerCloudInventory(
  connectionId: string,
  signal?: AbortSignal,
): Promise<HetznerCloudServerInventoryDto[]> {
  const body = await requestJson(
    `/api/infrastructure/connections/${encodeURIComponent(connectionId)}/hetzner-cloud/inventory`,
    { method: "GET", signal },
    HetznerCloudInventoryResponseSchema,
  );
  return body.data.inventory;
}

export async function refreshHetznerCloudInventory(
  connectionId: string,
): Promise<HetznerCloudServerInventoryDto[]> {
  const body = await requestJson(
    `/api/infrastructure/connections/${encodeURIComponent(connectionId)}/hetzner-cloud/inventory`,
    { method: "POST" },
    HetznerCloudInventoryResponseSchema,
  );
  return body.data.inventory;
}

export async function getHetznerCloudOfferCatalog(
  connectionId: string,
  signal?: AbortSignal,
): Promise<HetznerCloudOfferCatalogDto> {
  const body = await requestJson(
    `/api/infrastructure/connections/${encodeURIComponent(connectionId)}/hetzner-cloud/catalog`,
    { method: "GET", signal },
    HetznerCloudCatalogResponseSchema,
  );
  return body.data.catalog;
}

export async function quoteHetznerCloudCapacity(
  connectionId: string,
  input: HetznerCloudCapacityQuoteRequest,
): Promise<HetznerCloudCapacityQuoteDto> {
  const validated = HetznerCloudCapacityQuoteRequestSchema.parse(input);
  const body = await requestJson(
    `/api/infrastructure/connections/${encodeURIComponent(connectionId)}/hetzner-cloud/capacity/quote`,
    { method: "POST", body: JSON.stringify(validated) },
    HetznerCloudCapacityQuoteResponseSchema,
  );
  return body.data.quote;
}

export async function createHetznerCloudCapacity(
  connectionId: string,
  input: PreparedCapacityCreateRequest,
): Promise<{
  operation: HetznerCloudCapacityOperationDto;
  inventory: HetznerCloudServerInventoryDto[];
}> {
  const validated = PreparedCapacityCreateRequestSchema.parse(input);
  const body = await requestJson(
    `/api/infrastructure/connections/${encodeURIComponent(connectionId)}/hetzner-cloud/capacity`,
    { method: "POST", body: JSON.stringify(validated) },
    HetznerCloudCapacityCreateResponseSchema,
  );
  return body.data;
}

const setupEndpoint = (id: string) => `/api/infrastructure/connections/${z.string().uuid().parse(id)}/hetzner-cloud/capacity/setup`;
/** Saved setup views plus Hivra's record of every server request on the
 * connection. Read-only; it never advances setup. */
export async function listProviderComputerSetupEvidence(connectionId: string): Promise<ProviderComputerSetupEvidence> {
  const result = await requestJson(setupEndpoint(connectionId), { method: "GET", redirect: "error" },
    z.object({ success: z.literal(true), data: ProviderComputerSetupEvidenceSchema }).passthrough());
  return result.data;
}
export async function listProviderComputerSetups(connectionId: string) {
  return (await listProviderComputerSetupEvidence(connectionId)).computers;
}
export async function advanceProviderComputerSetup(connectionId: string, request: ProviderComputerSetupRequest) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 55_000);
  try {
    const result = await requestJson(setupEndpoint(connectionId), { method: "POST", redirect: "error", signal: controller.signal,
      body: JSON.stringify(ProviderComputerSetupRequestSchema.parse(request)) },
    z.object({ success: z.literal(true), data: z.object({ computer: ProviderComputerSetupViewSchema }).strict() }).passthrough());
    return result.data.computer;
  } finally { clearTimeout(timeout); }
}

export async function forceForgetHetznerCloudConnection(
  connectionId: string,
  input: HetznerCloudForceForgetRequest,
): Promise<HetznerCloudForceForgetResult> {
  const validated = HetznerCloudForceForgetRequestSchema.parse(input);
  const body = await requestJson(
    `/api/infrastructure/connections/${encodeURIComponent(connectionId)}/hetzner-cloud/capacity/force-forget`,
    { method: "POST", body: JSON.stringify(validated) },
    HetznerCloudForceForgetResponseSchema,
  );
  return body.data;
}

export async function updateInfrastructureConnection(
  id: string,
  input: ProxmoxConnectionUpdate,
): Promise<InfrastructureConnectionDto> {
  const validated = ProxmoxConnectionUpdateSchema.parse(input);
  const body = await requestJson(
    `/api/infrastructure/connections/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(validated) },
    ConnectionResponseSchema,
  );
  return body.data.connection;
}

export async function deleteInfrastructureConnection(id: string): Promise<void> {
  await requestJson(
    `/api/infrastructure/connections/${encodeURIComponent(id)}`,
    { method: "DELETE" },
    DeleteResponseSchema,
  );
}

export async function preflightInfrastructureConnection(
  id: string,
): Promise<ProxmoxPreflightResult> {
  const body = await requestJson(
    `/api/infrastructure/connections/${encodeURIComponent(id)}/preflight`,
    { method: "POST" },
    PreflightResponseSchema,
  );
  return body.data.preflight;
}

const HostDiscoveryFailureBodySchema = z
  .object({ discovery: HostDiscoveryResultSchema })
  .passthrough();

/** An inspection that reached the server but failed still returns its
 * result (what failed and, for a changed identity, both fingerprints), so the
 * owner sees the specific reason instead of a generic error. */
export async function discoverInfrastructureHost(
  id: string,
): Promise<HostDiscoveryResult> {
  try {
    const body = await requestJson(
      `/api/infrastructure/connections/${encodeURIComponent(id)}/discover`,
      { method: "POST" },
      HostDiscoveryResponseSchema,
    );
    return body.data.discovery;
  } catch (error) {
    if (error instanceof InfrastructureApiError && error.failureBody !== undefined) {
      const parsed = HostDiscoveryFailureBodySchema.safeParse(error.failureBody);
      if (parsed.success && !parsed.data.discovery.ok) return parsed.data.discovery;
    }
    throw error;
  }
}

export async function prepareInfrastructureConnection(
  id: string,
): Promise<InfrastructurePreparation> {
  const body = await requestJson(
    `/api/infrastructure/connections/${encodeURIComponent(id)}/prepare`,
    { method: "POST" },
    PreparationResponseSchema,
  );
  return body.data.preparation;
}

async function gvisorTargetRequest(id: string, operation: "preflight" | "prepare"): Promise<GvisorTargetResult> {
  const body = await requestJson(
    `/api/infrastructure/connections/${encodeURIComponent(id)}/gvisor/${operation}`,
    { method: "POST", body: "{}" },
    GvisorTargetResponseSchema,
  );
  return { targetId: body.data.target.id.toLowerCase(), ready: body.data.target.status === "ready" };
}

/** Read-only strict check of an installed gVisor setup. */
export function checkGvisorConnection(id: string): Promise<GvisorTargetResult> {
  return gvisorTargetRequest(id, "preflight");
}

/** Installs Hivra's pinned gVisor setup on the host, then runs the strict
 * check. This changes the host; call it only from the reviewed dialog. */
export function prepareGvisorConnection(id: string): Promise<GvisorTargetResult> {
  return gvisorTargetRequest(id, "prepare");
}
