import "server-only";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase";

import {
  HETZNER_CLOUD_CONNECTION_CAPABILITIES,
  HetznerCloudCapacityOperationDtoSchema,
  HetznerCloudCapacityQuoteDtoSchema,
  HetznerCloudServerInventoryDtoSchema,
  InfrastructureConnectionDtoSchema,
  type HetznerCloudConnectionDto,
  type HetznerCloudConnectionErrorCode,
  type HetznerCloudCapacityErrorCode,
  type HetznerCloudCapacityOperationDto,
  type HetznerCloudCapacityQuoteDto,
  type HetznerCloudServerInventoryDto,
} from "./contracts";
import { InfrastructureConnectionStoreError } from "./connection-store";
import {
  HetznerCreationReceiptSchema,
  type HetznerCreationReceipt,
} from "./hetzner-creation-receipt";
import { HetznerCleanupStateSchema, type HetznerCleanupState, type HetznerCleanupAbsence } from "./hetzner-cleanup-contracts";
import {
  parseHetznerCurrentServerShapeEvidence,
  type HetznerCurrentServerShape,
} from "./hetzner-current-server-shape";

const HETZNER_CONNECTION_SELECT = [
  "id",
  "user_id",
  "name",
  "provider",
  "operating_mode",
  "setup_mode",
  "status",
  "revision",
  "last_checked_at",
  "last_error_code",
  "created_at",
  "updated_at",
].join(",");

const INVENTORY_SELECT = [
  "id",
  "connection_id",
  "provider_resource_id",
  "name",
  "provider_status",
  "server_type",
  "location",
  "public_network",
  "provider_created_at",
  "discovered_at",
  "created_at",
  "updated_at",
].join(",");

const CAPACITY_ORDER_SELECT = [
  "id",
  "user_id",
  "connection_id",
  "active_connection_id",
  "connection_revision",
  "provider",
  "status",
  "server_name",
  "provider_labels",
  "quote_snapshot",
  "quote_fingerprint_sha256",
  "quote_expires_at",
  "idempotency_key",
  "encrypted_bootstrap_bundle",
  "bootstrap_key_version",
  "bootstrap_public_key",
  "bootstrap_public_key_fingerprint",
  "ssh_key_post_attempted_at",
  "provider_ssh_key_status",
  "provider_ssh_key_id",
  "server_post_attempted_at",
  "provider_server_status",
  "provider_resource_id",
  "provider_action_id",
  "provider_action_command",
  "provider_action_status",
  "provider_next_actions",
  "provider_creation_receipt",
  "current_server_shape",
  "current_server_shape_fingerprint_sha256",
  "external_cleanup_resolution_id",
  "cleanup_idempotency_key",
  "cleanup_resource_fingerprint",
  "cleanup_absence",
  "cleanup_firewall_receipt",
  "cleanup_last_error",
  "cleanup_started_at",
  "cleanup_observed_at",
  "cleanup_finished_at",
  "cleanup_abandoned_at",
  "observed_server_status",
  "provider_observed_at",
  "last_error_code",
  "created_at",
  "updated_at",
  "detached_at",
].join(",");

const HetznerSecretBundleV1Schema = z
  .object({
    version: z.literal(1),
    provider: z.literal("hetzner-cloud"),
    apiToken: z.string().min(1).max(512),
  })
  .strict();

const HetznerSecretBundleV2Schema = z
  .object({
    version: z.literal(2),
    provider: z.literal("hetzner-cloud"),
    userId: z.string().trim().min(1).max(256),
    connectionId: z.string().uuid(),
    connectionRevision: z.number().int().positive(),
    apiToken: z.string().min(1).max(512),
  })
  .strict();

const HetznerSecretBundleSchema = z.union([
  HetznerSecretBundleV1Schema,
  HetznerSecretBundleV2Schema,
]);

const HetznerBootstrapBundleSchema = z
  .object({
    version: z.literal(2),
    provider: z.literal("hetzner-cloud"),
    userId: z.string().trim().min(1).max(256),
    connectionId: z.string().uuid(),
    connectionRevision: z.number().int().positive(),
    orderId: z.string().uuid(),
    quoteFingerprintSha256: z.string().regex(/^[0-9a-f]{64}$/),
    privateKeyOpenSsh: z
      .string()
      .min(64)
      .max(16_384)
      .regex(/^-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]+-----END OPENSSH PRIVATE KEY-----\n?$/),
    publicKeyOpenSsh: z
      .string()
      .min(40)
      .max(1_024)
      .regex(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2} hivra-capacity$/),
    publicKeyFingerprint: z
      .string()
      .regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
  })
  .strict();

const HetznerProviderLabelsSchema = z
  .object({
    "hivra-operation": z.string().uuid(),
    "hivra-quote": z.string().regex(/^[0-9a-f]{32}$/),
    "hivra-managed": z.literal("true"),
  })
  .strict();

type HetznerConnectionRow = {
  id: string;
  user_id: string;
  name: string;
  provider: string;
  operating_mode: string;
  setup_mode: string;
  status: string;
  revision: number;
  last_checked_at: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
};

type InventoryRow = {
  id: string;
  connection_id: string;
  provider_resource_id: string;
  name: string;
  provider_status: string;
  server_type: unknown;
  location: unknown;
  public_network: unknown;
  provider_created_at: string;
  discovered_at: string;
  created_at: string;
  updated_at: string;
};

type CapacityOrderRow = {
  id: string;
  user_id: string;
  connection_id: string;
  active_connection_id: string | null;
  connection_revision: number;
  provider: string;
  status: string;
  server_name: string;
  provider_labels: unknown;
  quote_snapshot: unknown;
  quote_fingerprint_sha256: string;
  quote_expires_at: string;
  idempotency_key: string | null;
  encrypted_bootstrap_bundle: string | null;
  bootstrap_key_version: number | null;
  bootstrap_public_key: string | null;
  bootstrap_public_key_fingerprint: string | null;
  ssh_key_post_attempted_at: string | null;
  provider_ssh_key_status: "pending" | "accepted" | "ambiguous" | "rejected" | null;
  provider_ssh_key_id: string | null;
  server_post_attempted_at: string | null;
  provider_server_status: "pending" | "accepted" | "ambiguous" | null;
  provider_resource_id: string | null;
  provider_action_id: string | null;
  provider_action_command: string | null;
  provider_action_status: string | null;
  provider_next_actions: unknown;
  provider_creation_receipt: unknown;
  current_server_shape?: unknown | null;
  current_server_shape_fingerprint_sha256?: string | null;
  external_cleanup_resolution_id?: string | null;
  cleanup_idempotency_key?: string | null;
  cleanup_resource_fingerprint?: string | null;
  cleanup_absence?: unknown;
  cleanup_firewall_receipt?: unknown;
  cleanup_last_error?: string | null;
  cleanup_started_at?: string | null;
  cleanup_observed_at?: string | null;
  cleanup_finished_at?: string | null;
  cleanup_abandoned_at?: string | null;
  observed_server_status: string | null;
  provider_observed_at: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  detached_at: string | null;
};

export type HetznerBootstrapBundle = z.infer<typeof HetznerBootstrapBundleSchema>;

export type StoredHetznerCloudCapacityOrder = {
  operation: HetznerCloudCapacityOperationDto;
  connectionRevision: number;
  providerLabels: Record<string, string>;
  quoteFingerprintSha256: string;
  sshKeyPostAttemptedAt: string | null;
  providerSshKeyStatus: CapacityOrderRow["provider_ssh_key_status"];
  providerSshKeyId: string | null;
  serverPostAttemptedAt: string | null;
  providerServerStatus: CapacityOrderRow["provider_server_status"];
  creationReceipt: HetznerCreationReceipt | null;
  currentServerShape?: HetznerCurrentServerShape | null;
  currentServerShapeFingerprintSha256?: string | null;
  cleanup?: HetznerCleanupState | null;
  cleanupFirewallReceipt?: unknown;
  bootstrapPublicKey: string;
  bootstrapPublicKeyFingerprint: string;
};

export type SanitizedHetznerCloudServer = Omit<
  HetznerCloudServerInventoryDto,
  "id" | "connectionId" | "createdAt" | "updatedAt"
>;

function database() {
  if (!supabaseAdmin) {
    throw new InfrastructureConnectionStoreError("database_unavailable");
  }
  return supabaseAdmin;
}

function isDatabaseCode(error: unknown, code: string): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === code,
  );
}

function databaseError(error: unknown): InfrastructureConnectionStoreError {
  if (
    isDatabaseCode(error, "23505") ||
    isDatabaseCode(error, "23503") ||
    isDatabaseCode(error, "23514")
  ) {
    return new InfrastructureConnectionStoreError("conflict");
  }
  return new InfrastructureConnectionStoreError("database_error");
}

function connectionDto(row: HetznerConnectionRow): HetznerCloudConnectionDto {
  return InfrastructureConnectionDtoSchema.parse({
    id: row.id,
    name: row.name,
    provider: "hetzner-cloud",
    operatingMode: "self-managed",
    setupMode: "simple",
    status: row.status,
    endpoint: null,
    configuration: null,
    capabilities: HETZNER_CLOUD_CONNECTION_CAPABILITIES,
    credentialsConfigured: true,
    lastCheckedAt: row.last_checked_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }) as HetznerCloudConnectionDto;
}

function inventoryDto(row: InventoryRow): HetznerCloudServerInventoryDto {
  const serverType = row.server_type as Record<string, unknown>;
  const location = row.location as Record<string, unknown>;
  return HetznerCloudServerInventoryDtoSchema.parse({
    id: row.id,
    connectionId: row.connection_id,
    providerResourceId: row.provider_resource_id,
    name: row.name,
    status: row.provider_status,
    serverType,
    location,
    publicNetwork: row.public_network,
    providerCreatedAt: row.provider_created_at,
    discoveredAt: row.discovered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    launchReady: false,
    launchBlockedReason: HETZNER_CLOUD_CONNECTION_CAPABILITIES.reason,
  });
}

function capacityOperationDto(
  row: CapacityOrderRow,
  replayed: boolean,
): HetznerCloudCapacityOperationDto {
  if (!row.idempotency_key) {
    throw new InfrastructureConnectionStoreError("database_error");
  }
  return HetznerCloudCapacityOperationDtoSchema.parse({
    id: row.id,
    connectionId: row.connection_id,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    providerServerId: row.provider_resource_id,
    providerActionId: row.provider_action_id,
    providerActionCommand: row.provider_action_command,
    providerActionStatus: row.provider_action_status,
    providerNextActions: row.provider_next_actions,
    observedServerStatus: row.observed_server_status,
    providerObservedAt: row.provider_observed_at,
    errorCode: row.last_error_code,
    canarySlotHeld:
      !row.external_cleanup_resolution_id && row.status !== "deleted" && (
        ["creating", "ambiguous", "created_off", "cleaning"].includes(row.status)
        || row.provider_ssh_key_id !== null
      ),
    externalCleanupResolutionId: row.external_cleanup_resolution_id ?? null,
    replayed,
    quote: row.quote_snapshot,
    createdPoweredOff: row.status === "created_off",
    launchReady: false,
    launchBlockedReason: HETZNER_CLOUD_CONNECTION_CAPABILITIES.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function storedCapacityOrder(
  row: CapacityOrderRow,
  replayed: boolean,
): StoredHetznerCloudCapacityOrder {
  if (
    !row.bootstrap_public_key
    || !row.bootstrap_public_key_fingerprint
  ) {
    throw new InfrastructureConnectionStoreError("database_error");
  }
  try {
    const operation = capacityOperationDto(row, replayed);
    const currentShape = parseHetznerCurrentServerShapeEvidence({
      shape: row.current_server_shape,
      fingerprintSha256: row.current_server_shape_fingerprint_sha256,
      capacityOrderId: operation.id,
      connectionId: operation.connectionId,
      connectionRevision: row.connection_revision,
      providerServerId: operation.providerServerId ?? "",
    });
    return {
      operation,
      connectionRevision: row.connection_revision,
      providerLabels: HetznerProviderLabelsSchema.parse(row.provider_labels),
      quoteFingerprintSha256: row.quote_fingerprint_sha256,
      sshKeyPostAttemptedAt: row.ssh_key_post_attempted_at,
      providerSshKeyStatus: row.provider_ssh_key_status,
      providerSshKeyId: row.provider_ssh_key_id,
      serverPostAttemptedAt: row.server_post_attempted_at,
      providerServerStatus: row.provider_server_status,
      creationReceipt: row.provider_creation_receipt == null
        ? null
        : HetznerCreationReceiptSchema.parse(row.provider_creation_receipt),
      currentServerShape: currentShape?.shape ?? null,
      currentServerShapeFingerprintSha256: currentShape?.fingerprintSha256 ?? null,
      cleanup: row.cleanup_idempotency_key == null ? null : HetznerCleanupStateSchema.parse({
        idempotencyKey: row.cleanup_idempotency_key,
        fingerprint: row.cleanup_resource_fingerprint,
        absence: row.cleanup_absence,
        error: row.cleanup_last_error,
        startedAt: row.cleanup_started_at,
        observedAt: row.cleanup_observed_at,
        finishedAt: row.cleanup_finished_at,
        abandonedAt: row.cleanup_abandoned_at ?? null,
      }),
      cleanupFirewallReceipt: row.cleanup_firewall_receipt ?? null,
      bootstrapPublicKey: row.bootstrap_public_key,
      bootstrapPublicKeyFingerprint: row.bootstrap_public_key_fingerprint,
    };
  } catch (error) {
    if (error instanceof InfrastructureConnectionStoreError) throw error;
    throw new InfrastructureConnectionStoreError("database_error");
  }
}

function serializedInventory(inventory: SanitizedHetznerCloudServer[]): Array<Record<string, unknown>> {
  return inventory.map((server) => ({
    provider_resource_id: server.providerResourceId,
    name: server.name,
    provider_status: server.status,
    server_type: server.serverType,
    location: server.location,
    public_network: server.publicNetwork,
    provider_created_at: server.providerCreatedAt,
    discovered_at: server.discoveredAt,
  }));
}

export async function createHetznerCloudConnectionRecord(input: {
  userId: string;
  name: string;
  apiToken: string;
  discoveredAt: string;
  inventory: SanitizedHetznerCloudServer[];
}): Promise<{
  connection: HetznerCloudConnectionDto;
  inventory: HetznerCloudServerInventoryDto[];
}> {
  const connectionId = randomUUID();
  const encryptedBundle = encryptSecret(
    JSON.stringify({
      version: 2,
      provider: "hetzner-cloud",
      userId: input.userId,
      connectionId,
      connectionRevision: 1,
      apiToken: input.apiToken,
    }),
  );
  const { data, error } = await database().rpc(
    "create_hetzner_cloud_infrastructure_connection_v2",
    {
      p_connection_id: connectionId,
      p_user_id: input.userId,
      p_name: input.name,
      p_encrypted_bundle: encryptedBundle,
      p_key_version: 2,
      p_discovered_at: input.discoveredAt,
      p_inventory: serializedInventory(input.inventory),
    },
  );
  if (error || !data || typeof data !== "object") throw databaseError(error);
  const result = data as { connection?: unknown; inventory?: unknown };
  const connection = connectionDto(result.connection as HetznerConnectionRow);
  if (connection.id !== connectionId) {
    throw new InfrastructureConnectionStoreError("database_error");
  }
  const inventory = Array.isArray(result.inventory)
    ? result.inventory.map((row) => inventoryDto(row as InventoryRow))
    : [];
  return { connection, inventory };
}

export async function loadHetznerCloudConnectionSecret(
  userId: string,
  connectionId: string,
  options: { requireBoundToken?: boolean } = {},
): Promise<{
  connection: HetznerCloudConnectionDto;
  revision: number;
  apiToken: string;
}> {
  const { data: rawConnection, error: connectionError } = await database()
    .from("infrastructure_connections")
    .select(HETZNER_CONNECTION_SELECT)
    .eq("id", connectionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (connectionError) throw databaseError(connectionError);
  if (!rawConnection) throw new InfrastructureConnectionStoreError("not_found");
  const row = rawConnection as unknown as HetznerConnectionRow;
  if (row.provider !== "hetzner-cloud") {
    throw new InfrastructureConnectionStoreError("invalid_request");
  }

  const { data: rawSecret, error: secretError } = await database()
    .from("infrastructure_connection_secrets")
    .select("encrypted_bundle,key_version")
    .eq("connection_id", connectionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (secretError) throw databaseError(secretError);
  const keyVersion = Number((rawSecret as { key_version?: unknown } | null)?.key_version);
  if (!rawSecret || (keyVersion !== 1 && keyVersion !== 2)) {
    throw new InfrastructureConnectionStoreError("credential_error", row.revision);
  }

  try {
    const bundle = HetznerSecretBundleSchema.parse(
      JSON.parse(
        decryptSecret(String((rawSecret as { encrypted_bundle: unknown }).encrypted_bundle)),
      ),
    );
    if (bundle.version === 1) {
      if (keyVersion !== 1) {
        throw new InfrastructureConnectionStoreError("credential_error", row.revision);
      }
      if (options.requireBoundToken) {
        throw new InfrastructureConnectionStoreError(
          "credential_reconnect_required",
          row.revision,
        );
      }
    } else if (
      keyVersion !== 2
      || bundle.userId !== userId
      || bundle.connectionId !== connectionId
      || bundle.connectionRevision !== row.revision
    ) {
      throw new InfrastructureConnectionStoreError("credential_error", row.revision);
    }
    return {
      connection: connectionDto(row),
      revision: row.revision,
      apiToken: bundle.apiToken,
    };
  } catch (error) {
    if (error instanceof InfrastructureConnectionStoreError) throw error;
    throw new InfrastructureConnectionStoreError("credential_error", row.revision);
  }
}

export async function listHetznerCloudInventory(
  userId: string,
  connectionId: string,
): Promise<HetznerCloudServerInventoryDto[]> {
  // Resolve the owner/provider binding first. A raw inventory query alone must
  // never become a cross-provider oracle.
  await loadHetznerCloudConnectionMetadata(userId, connectionId);
  const { data, error } = await database()
    .from("infrastructure_capacity_inventory")
    .select(INVENTORY_SELECT)
    .eq("user_id", userId)
    .eq("connection_id", connectionId)
    .order("created_at", { ascending: false });
  if (error) throw databaseError(error);
  return (data ?? []).map((row) => inventoryDto(row as unknown as InventoryRow));
}

export async function loadHetznerCloudConnectionMetadata(
  userId: string,
  connectionId: string,
): Promise<HetznerConnectionRow> {
  const { data, error } = await database()
    .from("infrastructure_connections")
    .select(HETZNER_CONNECTION_SELECT)
    .eq("id", connectionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw databaseError(error);
  if (!data) throw new InfrastructureConnectionStoreError("not_found");
  const row = data as unknown as HetznerConnectionRow;
  if (row.provider !== "hetzner-cloud") {
    throw new InfrastructureConnectionStoreError("invalid_request");
  }
  return row;
}

export async function reconcileHetznerCloudInventory(input: {
  userId: string;
  connectionId: string;
  expectedRevision: number;
  discoveredAt: string;
  inventory: SanitizedHetznerCloudServer[];
}): Promise<HetznerCloudServerInventoryDto[]> {
  const { data, error } = await database().rpc("reconcile_hetzner_cloud_inventory", {
    p_user_id: input.userId,
    p_connection_id: input.connectionId,
    p_expected_revision: input.expectedRevision,
    p_discovered_at: input.discoveredAt,
    p_inventory: serializedInventory(input.inventory),
  });
  if (error) throw databaseError(error);
  if (!Array.isArray(data)) {
    throw new InfrastructureConnectionStoreError("conflict");
  }
  return data.map((row) => inventoryDto(row as InventoryRow));
}

export async function upsertHetznerCloudInventoryServer(input: {
  userId: string;
  connectionId: string;
  expectedRevision: number;
  server: SanitizedHetznerCloudServer;
}): Promise<HetznerCloudServerInventoryDto> {
  const serialized = serializedInventory([input.server])[0];
  const { data, error } = await database().rpc(
    "upsert_hetzner_cloud_inventory_server",
    {
      p_user_id: input.userId,
      p_connection_id: input.connectionId,
      p_expected_revision: input.expectedRevision,
      p_discovered_at: input.server.discoveredAt,
      p_server: serialized,
    },
  );
  if (error) throw databaseError(error);
  if (!data || typeof data !== "object") {
    throw new InfrastructureConnectionStoreError("conflict");
  }
  return inventoryDto(data as InventoryRow);
}

export async function recordHetznerCloudInventoryFailure(input: {
  userId: string;
  connectionId: string;
  expectedRevision: number;
  checkedAt: string;
  lastErrorCode: HetznerCloudConnectionErrorCode;
}): Promise<boolean> {
  const { data, error } = await database().rpc(
    "record_hetzner_cloud_inventory_failure",
    {
      p_user_id: input.userId,
      p_connection_id: input.connectionId,
      p_expected_revision: input.expectedRevision,
      p_checked_at: input.checkedAt,
      p_last_error_code: input.lastErrorCode,
    },
  );
  if (error) throw databaseError(error);
  return data === true;
}

export async function createHetznerCloudCapacityQuoteRecord(input: {
  userId: string;
  connectionId: string;
  expectedRevision: number;
  quote: HetznerCloudCapacityQuoteDto;
  providerLabels: Record<string, string>;
  quoteFingerprintSha256: string;
}): Promise<HetznerCloudCapacityQuoteDto> {
  const quote = HetznerCloudCapacityQuoteDtoSchema.parse(input.quote);
  const providerLabels = HetznerProviderLabelsSchema.parse(input.providerLabels);
  if (
    quote.connectionId !== input.connectionId
    || quote.connectionRevision !== input.expectedRevision
    || providerLabels["hivra-operation"] !== quote.id
    || providerLabels["hivra-quote"]
      !== input.quoteFingerprintSha256.slice(0, 32)
  ) {
    throw new InfrastructureConnectionStoreError("invalid_request");
  }
  const now = new Date().toISOString();
  const { data, error } = await database().rpc(
    "create_hetzner_cloud_capacity_quote",
    {
      p_user_id: input.userId,
      p_connection_id: input.connectionId,
      p_expected_revision: input.expectedRevision,
      p_quote_id: quote.id,
      p_server_name: quote.serverName,
      p_provider_labels: providerLabels,
      p_quote_snapshot: quote,
      p_quote_fingerprint_sha256: input.quoteFingerprintSha256,
      p_quote_expires_at: quote.expiresAt,
      p_now: now,
    },
  );
  if (error || !data) throw databaseError(error);
  if (typeof data !== "object") {
    throw new InfrastructureConnectionStoreError("database_error");
  }
  const result = data as { outcome?: unknown; order?: unknown };
  if (result.outcome === "quote_rate_limited") {
    throw new InfrastructureConnectionStoreError("quote_limit");
  }
  if (result.outcome === "connection_changed") {
    throw new InfrastructureConnectionStoreError("conflict");
  }
  if (result.outcome !== "created" || !result.order) {
    throw new InfrastructureConnectionStoreError("database_error");
  }
  const row = result.order as CapacityOrderRow;
  if (
    row.user_id !== input.userId
    || row.connection_id !== input.connectionId
    || row.provider !== "hetzner-cloud"
    || row.status !== "quoted"
  ) {
    throw new InfrastructureConnectionStoreError("database_error");
  }
  return HetznerCloudCapacityQuoteDtoSchema.parse(row.quote_snapshot);
}

export type StoredHetznerCloudCapacityQuote = {
  quote: HetznerCloudCapacityQuoteDto;
  connectionRevision: number;
  providerLabels: Record<string, string>;
  quoteFingerprintSha256: string;
};

/**
 * Reads only the immutable, non-secret quote binding needed to create and
 * encrypt the per-order bootstrap key before the atomic claim. It deliberately
 * excludes the connection token and any encrypted bootstrap material.
 */
export async function loadHetznerCloudCapacityQuote(input: {
  userId: string;
  connectionId: string;
  quoteId: string;
}): Promise<StoredHetznerCloudCapacityQuote> {
  const { data, error } = await database()
    .from("infrastructure_capacity_orders")
    .select([
      "id",
      "user_id",
      "connection_id",
      "active_connection_id",
      "connection_revision",
      "provider",
      "status",
      "provider_labels",
      "quote_snapshot",
      "quote_fingerprint_sha256",
      "idempotency_key",
    ].join(","))
    .eq("id", input.quoteId)
    .eq("user_id", input.userId)
    .eq("connection_id", input.connectionId)
    .eq("active_connection_id", input.connectionId)
    .maybeSingle();
  if (error) throw databaseError(error);
  if (!data) throw new InfrastructureConnectionStoreError("not_found");
  const row = data as unknown as Pick<
    CapacityOrderRow,
    | "id"
    | "user_id"
    | "connection_id"
    | "active_connection_id"
    | "connection_revision"
    | "provider"
    | "status"
    | "provider_labels"
    | "quote_snapshot"
    | "quote_fingerprint_sha256"
    | "idempotency_key"
  >;
  if (
    row.provider !== "hetzner-cloud"
    || row.active_connection_id !== input.connectionId
  ) {
    throw new InfrastructureConnectionStoreError("conflict");
  }
  try {
    const quote = HetznerCloudCapacityQuoteDtoSchema.parse(row.quote_snapshot);
    const providerLabels = HetznerProviderLabelsSchema.parse(row.provider_labels);
    if (
      quote.id !== row.id
      || quote.connectionId !== input.connectionId
      || quote.connectionRevision !== row.connection_revision
      || providerLabels["hivra-operation"] !== row.id
      || providerLabels["hivra-quote"]
        !== row.quote_fingerprint_sha256.slice(0, 32)
    ) {
      throw new InfrastructureConnectionStoreError("database_error");
    }
    return {
      quote,
      connectionRevision: row.connection_revision,
      providerLabels,
      quoteFingerprintSha256: row.quote_fingerprint_sha256,
    };
  } catch (error) {
    if (error instanceof InfrastructureConnectionStoreError) throw error;
    throw new InfrastructureConnectionStoreError("database_error");
  }
}

export type ClaimHetznerCloudCapacityOrderResult =
  | {
      outcome: "claimed" | "replay";
      execute: boolean;
      order: StoredHetznerCloudCapacityOrder;
    }
  | {
      outcome:
        | "not_found"
        | "quote_expired"
        | "connection_changed"
        | "idempotency_conflict"
        | "canary_capacity_limit"
        | "unresolved_operation";
    };

export async function claimHetznerCloudCapacityOrder(input: {
  userId: string;
  connectionId: string;
  expectedRevision: number;
  quoteId: string;
  idempotencyKey: string;
  bootstrap: HetznerBootstrapBundle;
  now: string;
}): Promise<ClaimHetznerCloudCapacityOrderResult> {
  const bootstrap = HetznerBootstrapBundleSchema.parse(input.bootstrap);
  if (
    bootstrap.userId !== input.userId
    || bootstrap.connectionId !== input.connectionId
    || bootstrap.connectionRevision !== input.expectedRevision
    || bootstrap.orderId !== input.quoteId
  ) {
    throw new InfrastructureConnectionStoreError("invalid_request");
  }
  const encryptedBootstrapBundle = encryptSecret(JSON.stringify(bootstrap));
  const { data, error } = await database().rpc(
    "claim_hetzner_cloud_capacity_order",
    {
      p_user_id: input.userId,
      p_connection_id: input.connectionId,
      p_expected_revision: input.expectedRevision,
      p_quote_id: input.quoteId,
      p_idempotency_key: input.idempotencyKey,
      p_encrypted_bootstrap_bundle: encryptedBootstrapBundle,
      p_bootstrap_key_version: 2,
      p_bootstrap_public_key: bootstrap.publicKeyOpenSsh,
      p_bootstrap_public_key_fingerprint: bootstrap.publicKeyFingerprint,
      p_now: input.now,
    },
  );
  if (error || !data || typeof data !== "object") throw databaseError(error);
  const result = data as { outcome?: unknown; execute?: unknown; order?: unknown };
  if (
    result.outcome === "not_found"
    || result.outcome === "quote_expired"
    || result.outcome === "connection_changed"
    || result.outcome === "idempotency_conflict"
    || result.outcome === "canary_capacity_limit"
    || result.outcome === "unresolved_operation"
  ) {
    return { outcome: result.outcome };
  }
  if (
    (result.outcome !== "claimed" && result.outcome !== "replay")
    || typeof result.execute !== "boolean"
    || !result.order
    || typeof result.order !== "object"
  ) {
    throw new InfrastructureConnectionStoreError("database_error");
  }
  return {
    outcome: result.outcome,
    execute: result.execute,
    order: storedCapacityOrder(
      result.order as CapacityOrderRow,
      result.outcome === "replay",
    ),
  };
}

/**
 * Narrow decryption boundary used only immediately before SSH-key/server
 * creation. Passive operation reads and terminal replays never decrypt the
 * private bootstrap key.
 */
export async function loadHetznerCloudCapacityBootstrap(input: {
  userId: string;
  connectionId: string;
  expectedRevision: number;
  orderId: string;
  idempotencyKey: string;
  quoteFingerprintSha256: string;
}): Promise<HetznerBootstrapBundle> {
  const { data, error } = await database()
    .from("infrastructure_capacity_orders")
    .select(CAPACITY_ORDER_SELECT)
    .eq("id", input.orderId)
    .eq("user_id", input.userId)
    .eq("connection_id", input.connectionId)
    .eq("active_connection_id", input.connectionId)
    .eq("connection_revision", input.expectedRevision)
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (error) throw databaseError(error);
  if (!data) throw new InfrastructureConnectionStoreError("not_found");
  const row = data as unknown as CapacityOrderRow;
  if (
    !row.encrypted_bootstrap_bundle
    || row.bootstrap_key_version !== 2
    || row.quote_fingerprint_sha256 !== input.quoteFingerprintSha256
  ) {
    throw new InfrastructureConnectionStoreError("credential_error");
  }
  try {
    const bundle = HetznerBootstrapBundleSchema.parse(
      JSON.parse(decryptSecret(row.encrypted_bootstrap_bundle)),
    );
    if (
      bundle.userId !== input.userId
      || bundle.connectionId !== input.connectionId
      || bundle.connectionRevision !== input.expectedRevision
      || bundle.orderId !== input.orderId
      || bundle.quoteFingerprintSha256 !== input.quoteFingerprintSha256
      || bundle.publicKeyOpenSsh !== row.bootstrap_public_key
      || bundle.publicKeyFingerprint !== row.bootstrap_public_key_fingerprint
    ) {
      throw new InfrastructureConnectionStoreError("credential_error");
    }
    return bundle;
  } catch (error) {
    if (error instanceof InfrastructureConnectionStoreError) throw error;
    throw new InfrastructureConnectionStoreError("credential_error");
  }
}

/** Rate classification only. The durable POST marker forbids another provider
 * purchase; a browser's replay flag, quote, or request key alone is not proof.
 * Read no bootstrap/credential fields and never create or claim an order here.
 */
export async function hasDispatchedHetznerCapacityRequest(
  userId: string, connectionId: string, orderId: string, idempotencyKey: string,
): Promise<boolean> {
  const { data, error } = await database().from("infrastructure_capacity_orders")
    .select("id,idempotency_key,server_post_attempted_at")
    .eq("user_id", userId).eq("connection_id", connectionId).eq("active_connection_id", connectionId)
    .eq("provider", "hetzner-cloud").eq("id", orderId).eq("idempotency_key", idempotencyKey)
    .not("server_post_attempted_at", "is", null).maybeSingle();
  if (error) throw databaseError(error);
  return Boolean(data && data.id === orderId && data.idempotency_key === idempotencyKey
    && typeof data.server_post_attempted_at === "string"
    && Number.isFinite(Date.parse(data.server_post_attempted_at)));
}

export async function loadHetznerCloudCleanupOrder(userId: string, connectionId: string, orderId: string) {
  await loadHetznerCloudConnectionMetadata(userId, connectionId);
  const { data, error } = await database().from("infrastructure_capacity_orders")
    .select(CAPACITY_ORDER_SELECT).eq("user_id", userId).eq("connection_id", connectionId)
    .eq("active_connection_id", connectionId).eq("id", orderId).maybeSingle();
  if (error) throw databaseError(error);
  if (!data) throw new InfrastructureConnectionStoreError("not_found");
  return storedCapacityOrder(data as unknown as CapacityOrderRow, false);
}

export async function listHetznerCloudCleanupOrders(userId: string, connectionId: string) {
  await loadHetznerCloudConnectionMetadata(userId, connectionId);
  const { data, error } = await database().from("infrastructure_capacity_orders")
    .select(CAPACITY_ORDER_SELECT).eq("user_id", userId).eq("connection_id", connectionId)
    .eq("active_connection_id", connectionId).in("status", ["created_off", "cleaning", "deleted"])
    .order("created_at", { ascending: false }).limit(20);
  if (error) throw databaseError(error);
  return (data ?? []).map(row => storedCapacityOrder(row as unknown as CapacityOrderRow, false));
}

type CleanupBinding = { userId: string; connectionId: string; expectedRevision: number; orderId: string; leaseId: string };
const cleanupBindingArgs = (input: CleanupBinding) => ({
  p_user_id: input.userId, p_connection_id: input.connectionId,
  p_expected_revision: input.expectedRevision, p_order_id: input.orderId, p_lease_id: input.leaseId,
});

export async function claimHetznerCleanup(input: CleanupBinding & {
  idempotencyKey: string; fingerprint: string; serverName: string; expectedFirewallReceipt?: unknown;
}): Promise<{ outcome: "claimed" | "busy" | "complete"; order: StoredHetznerCloudCapacityOrder }
  | { outcome: "connection_changed" | "not_found" | "not_eligible" | "confirmation_changed" | "target_in_use" }> {
  const { data, error } = await database().rpc("claim_hetzner_cleanup_with_firewall", {
    ...cleanupBindingArgs(input), p_idempotency_key: input.idempotencyKey,
    p_fingerprint: input.fingerprint, p_server_name: input.serverName,
    p_expected_firewall_receipt: input.expectedFirewallReceipt ?? null,
  });
  if (error || !data || typeof data !== "object") throw databaseError(error);
  const result = data as { outcome: string; order?: CapacityOrderRow };
  if (["connection_changed", "not_found", "not_eligible", "confirmation_changed", "target_in_use"].includes(result.outcome)) {
    return { outcome: result.outcome as "connection_changed" | "not_found" | "not_eligible" | "confirmation_changed" | "target_in_use" };
  }
  if (!["claimed", "busy", "complete"].includes(result.outcome) || !result.order) throw databaseError(null);
  return { outcome: result.outcome as "claimed" | "busy" | "complete", order: storedCapacityOrder(result.order, false) };
}

export async function verifyHetznerCleanupLease(input: CleanupBinding): Promise<boolean> {
  const { data, error } = await database().rpc("verify_hetzner_cleanup_lease", cleanupBindingArgs(input));
  if (error) throw databaseError(error);
  return data === true;
}

export async function abandonHetznerCleanup(input: {
  userId:string;connectionId:string;orderId:string;idempotencyKey:string;fingerprint:string;
}) {
  const {data,error}=await database().rpc("abandon_hetzner_cleanup",{
    p_user_id:input.userId,p_connection_id:input.connectionId,p_order_id:input.orderId,
    p_idempotency_key:input.idempotencyKey,p_fingerprint:input.fingerprint,
  });
  if (isDatabaseCode(error,"55006")) throw new InfrastructureConnectionStoreError("capacity_busy");
  if(error)throw databaseError(error);
  if(data!==true)throw new InfrastructureConnectionStoreError("not_found");
}

export async function recordHetznerCleanupObservation(input: CleanupBinding & {
  absence: HetznerCleanupAbsence; error: HetznerCleanupState["error"];
}) {
  const { data, error } = await database().rpc("record_hetzner_cleanup_observation", {
    ...cleanupBindingArgs(input), p_absence: input.absence, p_error: input.error,
  });
  if (error) throw databaseError(error);
  if (!data || typeof data !== "object") throw new InfrastructureConnectionStoreError("conflict");
  return storedCapacityOrder(data as CapacityOrderRow, false);
}

export async function markHetznerCloudServerPostAttempted(input: {
  userId: string;
  connectionId: string;
  expectedRevision: number;
  orderId: string;
  idempotencyKey: string;
  providerSshKeyId: string;
  attemptedAt: string;
}): Promise<boolean> {
  const { data, error } = await database().rpc(
    "mark_hetzner_cloud_server_post_attempted",
    {
      p_user_id: input.userId,
      p_connection_id: input.connectionId,
      p_expected_revision: input.expectedRevision,
      p_order_id: input.orderId,
      p_idempotency_key: input.idempotencyKey,
      p_provider_ssh_key_id: input.providerSshKeyId,
      p_attempted_at: input.attemptedAt,
    },
  );
  if (error) throw databaseError(error);
  return data === true;
}

export async function markHetznerCloudSshKeyPostAttempted(input: {
  userId: string;
  connectionId: string;
  expectedRevision: number;
  orderId: string;
  idempotencyKey: string;
  attemptedAt: string;
}): Promise<boolean> {
  const { data, error } = await database().rpc(
    "mark_hetzner_cloud_ssh_key_post_attempted",
    {
      p_user_id: input.userId,
      p_connection_id: input.connectionId,
      p_expected_revision: input.expectedRevision,
      p_order_id: input.orderId,
      p_idempotency_key: input.idempotencyKey,
      p_attempted_at: input.attemptedAt,
    },
  );
  if (error) throw databaseError(error);
  return data === true;
}

export async function recordHetznerCloudSshKeyResult(input: {
  userId: string;
  connectionId: string;
  orderId: string;
  idempotencyKey: string;
  status: "accepted" | "ambiguous" | "rejected";
  providerSshKeyId?: string | null;
  errorCode?: HetznerCloudCapacityErrorCode | null;
  replayed?: boolean;
}): Promise<StoredHetznerCloudCapacityOrder> {
  const { data, error } = await database().rpc(
    "record_hetzner_cloud_ssh_key_result",
    {
      p_user_id: input.userId,
      p_connection_id: input.connectionId,
      p_order_id: input.orderId,
      p_idempotency_key: input.idempotencyKey,
      p_status: input.status,
      p_provider_ssh_key_id: input.providerSshKeyId ?? null,
      p_last_error_code: input.errorCode ?? null,
    },
  );
  if (error) throw databaseError(error);
  if (!data || typeof data !== "object") {
    throw new InfrastructureConnectionStoreError("conflict");
  }
  return storedCapacityOrder(
    data as CapacityOrderRow,
    input.replayed ?? false,
  );
}

type HetznerCapacityActionReceipt = {
  id: string;
  command: string;
  status: "running" | "success" | "error";
};

export async function recordHetznerCloudCapacityOrderProgress(input: {
  userId: string;
  connectionId: string;
  orderId: string;
  idempotencyKey: string;
  providerServerId: string;
  providerActionId: string;
  providerActionCommand: string;
  providerActionStatus: "running" | "success" | "error";
  providerNextActions: HetznerCapacityActionReceipt[];
  providerObservedAt?: string | null;
  observedServerStatus?: HetznerCloudCapacityOperationDto["observedServerStatus"];
  replayed?: boolean;
  creation?: {
    expectedRevision: number;
    receipt: HetznerCreationReceipt;
  };
}): Promise<StoredHetznerCloudCapacityOrder> {
  const { data, error } = await database().rpc(
    input.creation
      ? "record_hetzner_cloud_capacity_creation_progress"
      : "record_hetzner_cloud_capacity_order_progress",
    {
      p_user_id: input.userId,
      p_connection_id: input.connectionId,
      p_order_id: input.orderId,
      p_idempotency_key: input.idempotencyKey,
      p_provider_resource_id: input.providerServerId,
      p_provider_action_id: input.providerActionId,
      p_provider_action_command: input.providerActionCommand,
      p_provider_action_status: input.providerActionStatus,
      p_provider_next_actions: input.providerNextActions,
      p_provider_observed_at: input.providerObservedAt ?? null,
      p_observed_server_status: input.observedServerStatus ?? null,
      ...(input.creation ? {
        p_expected_revision: input.creation.expectedRevision,
        p_creation_receipt: HetznerCreationReceiptSchema.parse(input.creation.receipt),
      } : {}),
    },
  );
  if (error) throw databaseError(error);
  if (!data || typeof data !== "object") {
    throw new InfrastructureConnectionStoreError("conflict");
  }
  return storedCapacityOrder(data as CapacityOrderRow, input.replayed ?? false);
}

export async function recordHetznerCloudCapacityOrderResult(input: {
  userId: string;
  connectionId: string;
  orderId: string;
  idempotencyKey: string;
  status: "created_off" | "ambiguous" | "provider_rejected";
  providerServerId?: string | null;
  providerActionId?: string | null;
  providerActionCommand?: string | null;
  providerActionStatus?: "running" | "success" | "error" | null;
  providerNextActions?: HetznerCapacityActionReceipt[];
  providerObservedAt?: string | null;
  observedServerStatus?: HetznerCloudCapacityOperationDto["observedServerStatus"];
  errorCode?: HetznerCloudCapacityErrorCode | null;
  replayed?: boolean;
}): Promise<StoredHetznerCloudCapacityOrder> {
  const { data, error } = await database().rpc(
    "record_hetzner_cloud_capacity_order_result",
    {
      p_user_id: input.userId,
      p_connection_id: input.connectionId,
      p_order_id: input.orderId,
      p_idempotency_key: input.idempotencyKey,
      p_status: input.status,
      p_provider_resource_id: input.providerServerId ?? null,
      p_provider_action_id: input.providerActionId ?? null,
      p_provider_action_command: input.providerActionCommand ?? null,
      p_provider_action_status: input.providerActionStatus ?? null,
      p_provider_next_actions: input.providerNextActions ?? [],
      p_provider_observed_at: input.providerObservedAt ?? null,
      p_observed_server_status: input.observedServerStatus ?? null,
      p_last_error_code: input.errorCode ?? null,
    },
  );
  if (error) throw databaseError(error);
  if (!data || typeof data !== "object") {
    throw new InfrastructureConnectionStoreError("conflict");
  }
  return storedCapacityOrder(
    data as CapacityOrderRow,
    input.replayed ?? false,
  );
}
