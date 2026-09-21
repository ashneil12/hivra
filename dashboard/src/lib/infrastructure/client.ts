"use client";

import { z } from "zod";

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
import { PreparedCapacityCreateRequestSchema, ProviderComputerSetupRequestSchema, ProviderComputerSetupViewSchema,
  type PreparedCapacityCreateRequest, type ProviderComputerSetupRequest } from "./provider-computer-setup-contracts";

const ApiErrorSchema = z
  .object({
    error: z.string().trim().min(1).optional(),
    code: z.string().trim().min(1).optional(),
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
    data: z
      .object({
        connection: InfrastructureConnectionDtoSchema.refine(
          (connection) => connection.provider === "hetzner-cloud",
        ),
        inventory: z.array(HetznerCloudServerInventoryDtoSchema),
      })
      .strict(),
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

export class InfrastructureApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "InfrastructureApiError";
  }
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function requestJson<T>(
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
    throw new InfrastructureApiError(
      parsedError.success && parsedError.data.error
        ? parsedError.data.error
        : `Infrastructure request failed (${response.status}).`,
      response.status,
      parsedError.success ? parsedError.data.code : undefined,
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
  const body = await requestJson(
    "/api/infrastructure/connections",
    { method: "POST", body: JSON.stringify(validated) },
    ConnectionResponseSchema,
  );
  return body.data.connection;
}

export async function connectHetznerCloudProject(
  input: HetznerCloudConnectionCreate,
): Promise<{
  connection: HetznerCloudConnectionDto;
  inventory: HetznerCloudServerInventoryDto[];
}> {
  const validated = InfrastructureConnectionCreateSchema.parse(input);
  if (validated.provider !== "hetzner-cloud") {
    throw new InfrastructureApiError("A Hetzner Cloud connection is required.", 0);
  }
  const body = await requestJson(
    "/api/infrastructure/connections",
    { method: "POST", body: JSON.stringify(validated) },
    HetznerCloudConnectionResponseSchema,
  );
  if (body.data.connection.provider !== "hetzner-cloud") {
    throw new InfrastructureApiError(
      "The infrastructure service returned the wrong provider.",
      0,
    );
  }
  return {
    connection: body.data.connection,
    inventory: body.data.inventory,
  };
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
export async function listProviderComputerSetups(connectionId: string) {
  const result = await requestJson(setupEndpoint(connectionId), { method: "GET", redirect: "error" },
    z.object({ success: z.literal(true), data: z.object({ computers: z.array(ProviderComputerSetupViewSchema).max(20) }).strict() }).passthrough());
  return result.data.computers;
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

export async function discoverInfrastructureHost(
  id: string,
): Promise<HostDiscoveryResult> {
  const body = await requestJson(
    `/api/infrastructure/connections/${encodeURIComponent(id)}/discover`,
    { method: "POST" },
    HostDiscoveryResponseSchema,
  );
  return body.data.discovery;
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
