import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase";

import {
  DIGITALOCEAN_CONNECTION_CAPABILITIES,
  DigitalOceanDeploymentTargetDtoSchema,
  InfrastructureConnectionDtoSchema,
  type DigitalOceanConnectionDto,
  type DigitalOceanConnectionErrorCode,
  type DigitalOceanDeploymentTargetDto,
} from "./contracts";
import { InfrastructureConnectionStoreError } from "./connection-store";

const CONNECTION_SELECT = [
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

const TARGET_SELECT = [
  "id",
  "connection_id",
  "evidence_connection_revision",
  "external_id",
  "display_name",
  "status",
  "capacity",
  "capabilities",
  "supported_isolation_drivers",
  "isolation_class",
  "last_preflight_at",
  "last_error_code",
  "created_at",
  "updated_at",
].join(",");

type ConnectionRow = {
  id: string;
  user_id: string;
  name: string;
  provider: string;
  operating_mode: "self-managed";
  status: DigitalOceanConnectionDto["status"];
  revision: number;
  last_checked_at: string | null;
  last_error_code: DigitalOceanConnectionErrorCode | null;
  created_at: string;
  updated_at: string;
};

type TargetRow = {
  id: string;
  connection_id: string;
  evidence_connection_revision: number;
  external_id: string;
  display_name: string;
  status: string;
  capacity: unknown;
  capabilities: unknown;
  supported_isolation_drivers: string[];
  isolation_class: string | null;
  last_preflight_at: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
};

/** Target evidence Hivra publishes after validating the token with DigitalOcean. */
export type DigitalOceanTargetEvidence = {
  capacity: DigitalOceanDeploymentTargetDto["capacity"];
  capabilities: DigitalOceanDeploymentTargetDto["capabilities"];
};

const SecretBundleSchema = z.object({
  version: z.literal(2),
  provider: z.literal("digitalocean"),
  userId: z.string().min(1),
  connectionId: z.string().uuid(),
  connectionRevision: z.number().int().positive(),
  apiToken: z.string().min(20).max(512),
}).strict();

function database() {
  if (!supabaseAdmin) throw new InfrastructureConnectionStoreError("database_unavailable");
  return supabaseAdmin;
}

function databaseError(error: unknown): InfrastructureConnectionStoreError {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : null;
  if (code === "23505" || code === "23503" || code === "23514" || code === "55006") {
    return new InfrastructureConnectionStoreError("conflict");
  }
  return new InfrastructureConnectionStoreError("database_error");
}

export function digitalOceanConnectionDto(row: ConnectionRow): DigitalOceanConnectionDto {
  if (row.provider !== "digitalocean") throw new InfrastructureConnectionStoreError("invalid_request");
  return InfrastructureConnectionDtoSchema.parse({
    id: row.id,
    name: row.name,
    provider: "digitalocean",
    operatingMode: "self-managed",
    setupMode: "simple",
    status: row.status,
    endpoint: null,
    configuration: null,
    capabilities: DIGITALOCEAN_CONNECTION_CAPABILITIES,
    credentialsConfigured: true,
    lastCheckedAt: row.last_checked_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }) as DigitalOceanConnectionDto;
}

export function digitalOceanTargetDto(row: TargetRow): DigitalOceanDeploymentTargetDto {
  return DigitalOceanDeploymentTargetDtoSchema.parse({
    id: row.id,
    connectionId: row.connection_id,
    evidenceConnectionRevision: Number(row.evidence_connection_revision),
    externalId: row.external_id,
    displayName: row.display_name,
    status: row.status,
    capacity: row.capacity,
    capabilities: row.capabilities,
    supportedIsolationDrivers: row.supported_isolation_drivers,
    isolationClass: row.isolation_class,
    lastPreflightAt: row.last_preflight_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export async function createDigitalOceanConnectionRecord(input: {
  userId: string;
  name: string;
  apiToken: string;
  checkedAt: string;
  target: DigitalOceanTargetEvidence;
}): Promise<{ connection: DigitalOceanConnectionDto; target: DigitalOceanDeploymentTargetDto }> {
  const connectionId = randomUUID();
  const encryptedBundle = encryptSecret(JSON.stringify({
    version: 2,
    provider: "digitalocean",
    userId: input.userId,
    connectionId,
    connectionRevision: 1,
    apiToken: input.apiToken,
  } satisfies z.infer<typeof SecretBundleSchema>));
  const { data, error } = await database().rpc("create_digitalocean_infrastructure_connection", {
    p_connection_id: connectionId,
    p_user_id: input.userId,
    p_name: input.name,
    p_encrypted_bundle: encryptedBundle,
    p_key_version: 2,
    p_checked_at: input.checkedAt,
    p_target: input.target,
  });
  if (error || !data || typeof data !== "object") throw databaseError(error);
  const result = data as { connection?: unknown; target?: unknown };
  const connection = digitalOceanConnectionDto(result.connection as ConnectionRow);
  const target = digitalOceanTargetDto(result.target as TargetRow);
  if (connection.id !== connectionId || target.connectionId !== connectionId) {
    throw new InfrastructureConnectionStoreError("database_error");
  }
  return { connection, target };
}

/**
 * Narrow decryption boundary. Callers use the token for one DigitalOcean call
 * sequence and must never serialize, log, or return it.
 */
export async function loadDigitalOceanConnectionSecret(userId: string, connectionId: string): Promise<{
  connection: DigitalOceanConnectionDto;
  revision: number;
  apiToken: string;
}> {
  const db = database();
  const { data: rawConnection, error: connectionError } = await db
    .from("infrastructure_connections")
    .select(CONNECTION_SELECT)
    .eq("id", connectionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (connectionError) throw databaseError(connectionError);
  if (!rawConnection) throw new InfrastructureConnectionStoreError("not_found");
  const row = rawConnection as unknown as ConnectionRow;
  if (row.provider !== "digitalocean") throw new InfrastructureConnectionStoreError("invalid_request");

  const { data: rawSecret, error: secretError } = await db
    .from("infrastructure_connection_secrets")
    .select("encrypted_bundle,key_version")
    .eq("connection_id", connectionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (secretError) throw databaseError(secretError);
  if (!rawSecret || Number((rawSecret as { key_version?: unknown }).key_version) !== 2) {
    throw new InfrastructureConnectionStoreError("credential_error", row.revision);
  }
  try {
    const bundle = SecretBundleSchema.parse(JSON.parse(
      decryptSecret(String((rawSecret as { encrypted_bundle: unknown }).encrypted_bundle)),
    ));
    if (bundle.userId !== userId || bundle.connectionId !== connectionId || bundle.connectionRevision !== Number(row.revision)) {
      throw new InfrastructureConnectionStoreError("credential_error", row.revision);
    }
    return { connection: digitalOceanConnectionDto(row), revision: Number(row.revision), apiToken: bundle.apiToken };
  } catch (error) {
    if (error instanceof InfrastructureConnectionStoreError) throw error;
    throw new InfrastructureConnectionStoreError("credential_error", row.revision);
  }
}

/**
 * Replace the stored token for the same connection revision. The swap is a
 * compare-and-set on the envelope the caller validated against, so a
 * concurrent replacement cannot be silently overwritten. Callers must prove
 * the new token reaches the same DigitalOcean team before calling this.
 */
export async function replaceDigitalOceanConnectionToken(input: {
  userId: string;
  connectionId: string;
  expectedRevision: number;
  apiToken: string;
}): Promise<void> {
  const db = database();
  const { data: rawConnection, error: connectionError } = await db
    .from("infrastructure_connections")
    .select(CONNECTION_SELECT)
    .eq("id", input.connectionId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (connectionError) throw databaseError(connectionError);
  if (!rawConnection) throw new InfrastructureConnectionStoreError("not_found");
  const row = rawConnection as unknown as ConnectionRow;
  if (row.provider !== "digitalocean") throw new InfrastructureConnectionStoreError("invalid_request");
  if (Number(row.revision) !== input.expectedRevision) throw new InfrastructureConnectionStoreError("conflict");

  const { data: rawSecret, error: secretError } = await db
    .from("infrastructure_connection_secrets")
    .select("encrypted_bundle,key_version")
    .eq("connection_id", input.connectionId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (secretError) throw databaseError(secretError);
  if (!rawSecret || Number((rawSecret as { key_version?: unknown }).key_version) !== 2) {
    throw new InfrastructureConnectionStoreError("credential_error", row.revision);
  }
  const encryptedBundle = encryptSecret(JSON.stringify({
    version: 2,
    provider: "digitalocean",
    userId: input.userId,
    connectionId: input.connectionId,
    connectionRevision: input.expectedRevision,
    apiToken: input.apiToken,
  } satisfies z.infer<typeof SecretBundleSchema>));
  const { data: swapped, error: swapError } = await db.rpc("rotate_infrastructure_connection_secret", {
    p_connection_id: input.connectionId,
    p_expected_encrypted_bundle: String((rawSecret as { encrypted_bundle: unknown }).encrypted_bundle),
    p_encrypted_bundle: encryptedBundle,
    p_key_version: 2,
  });
  if (swapError) throw databaseError(swapError);
  if (swapped !== true) throw new InfrastructureConnectionStoreError("conflict");
}

export async function listDigitalOceanTargets(userId: string): Promise<DigitalOceanDeploymentTargetDto[]> {
  const { data, error } = await database()
    .from("deployment_targets")
    .select(TARGET_SELECT)
    .eq("user_id", userId)
    .eq("capabilities->>kind", "digitalocean-managed-agents")
    .order("created_at", { ascending: false });
  if (error) throw databaseError(error);
  return (data ?? []).map((row) => digitalOceanTargetDto(row as unknown as TargetRow));
}

export async function loadDigitalOceanTarget(userId: string, targetId: string): Promise<DigitalOceanDeploymentTargetDto> {
  const { data, error } = await database()
    .from("deployment_targets")
    .select(TARGET_SELECT)
    .eq("id", targetId)
    .eq("user_id", userId)
    .eq("capabilities->>kind", "digitalocean-managed-agents")
    .maybeSingle();
  if (error) throw databaseError(error);
  if (!data) throw new InfrastructureConnectionStoreError("not_found");
  return digitalOceanTargetDto(data as unknown as TargetRow);
}

export async function refreshDigitalOceanTargetRecord(input: {
  userId: string;
  connectionId: string;
  expectedRevision: number;
  checkedAt: string;
  target: DigitalOceanTargetEvidence | null;
  errorCode: DigitalOceanConnectionErrorCode | null;
}): Promise<{ connection: DigitalOceanConnectionDto; target: DigitalOceanDeploymentTargetDto }> {
  const { data, error } = await database().rpc("refresh_digitalocean_infrastructure_target", {
    p_user_id: input.userId,
    p_connection_id: input.connectionId,
    p_expected_revision: input.expectedRevision,
    p_checked_at: input.checkedAt,
    p_target: input.target ?? {},
    p_error_code: input.errorCode,
  });
  if (error) throw databaseError(error);
  if (!data || typeof data !== "object") throw new InfrastructureConnectionStoreError("conflict");
  const result = data as { connection?: unknown; target?: unknown };
  return {
    connection: digitalOceanConnectionDto(result.connection as ConnectionRow),
    target: digitalOceanTargetDto(result.target as TargetRow),
  };
}
