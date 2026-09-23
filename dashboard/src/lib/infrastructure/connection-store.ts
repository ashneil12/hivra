import "server-only";

import { z } from "zod";

import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { normalizeProxmoxSshHostFingerprint } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

import {
  DeploymentTargetDtoSchema,
  GvisorDeploymentTargetDtoSchema,
  ProviderVmDeploymentTargetDtoSchema,
  DIGITALOCEAN_CONNECTION_CAPABILITIES,
  HETZNER_CLOUD_CONNECTION_CAPABILITIES,
  InfrastructureConnectionDtoSchema,
  isProviderApiConnection,
  PortableHivraRuntimeCompatibilitySchema,
  ProxmoxConnectionCredentialsSchema,
  type DeploymentTargetDto,
  type DigitalOceanConnectionErrorCode,
  type HetznerCloudConnectionErrorCode,
  type InfrastructurePreflightTargetEvidence as ValidatedInfrastructurePreflightTargetEvidence,
  type InfrastructureConnectionDto,
  type InfrastructureConnectionCreate,
  type ProxmoxConnectionUpdate,
  type SshInfrastructureConnectionCreate,
  type SshInfrastructureConnectionDto,
  type ProxmoxPreflightErrorCode,
} from "./contracts";
import { isCompatibleProxmoxProvisionerVersion } from "./portable-provisioner-contract";

const CONNECTION_SELECT = [
  "id",
  "user_id",
  "name",
  "provider",
  "operating_mode",
  "setup_mode",
  "status",
  "ssh_host",
  "ssh_port",
  "ssh_user",
  "ssh_host_fingerprint_sha256",
  "config",
  "revision",
  "preflight_run_id",
  "preflight_lease_expires_at",
  "pending_binding_rebind_from_revision",
  "last_checked_at",
  "last_error_code",
  "created_at",
  "updated_at",
].join(",");

// Deliberately excludes user_id and every credential-bearing column. Ownership
// is enforced by the query predicate; it is not part of the public read model.
const DEPLOYMENT_TARGET_SELECT = [
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

const SecretBundleSchema = z
  .object({
    version: z.literal(1),
    sshPrivateKey: ProxmoxConnectionCredentialsSchema.shape.sshPrivateKey,
  })
  .strict();

type SecretBundle = z.infer<typeof SecretBundleSchema>;

type InfrastructureConnectionRow = {
  id: string;
  user_id: string;
  name: string;
  provider: InfrastructureConnectionDto["provider"];
  operating_mode: "self-managed";
  setup_mode: "simple" | "advanced";
  status: InfrastructureConnectionDto["status"];
  ssh_host: string | null;
  ssh_port: number | null;
  ssh_user: string | null;
  ssh_host_fingerprint_sha256: string | null;
  config: unknown;
  revision: number;
  preflight_run_id: string | null;
  preflight_lease_expires_at: string | null;
  pending_binding_rebind_from_revision: number | null;
  last_checked_at: string | null;
  last_error_code: ProxmoxPreflightErrorCode | HetznerCloudConnectionErrorCode | DigitalOceanConnectionErrorCode | null;
  created_at: string;
  updated_at: string;
};

type SecretRow = {
  connection_id: string;
  encrypted_bundle: string;
  key_version: number;
};

type DeploymentTargetRow = {
  id: string;
  connection_id: string;
  evidence_connection_revision: number;
  external_id: string;
  display_name: string;
  status: DeploymentTargetDto["status"];
  capacity: unknown;
  capabilities: unknown;
  supported_isolation_drivers: DeploymentTargetDto["supportedIsolationDrivers"];
  isolation_class: DeploymentTargetDto["isolationClass"];
  last_preflight_at: string | null;
  last_error_code: DeploymentTargetDto["lastErrorCode"];
  created_at: string;
  updated_at: string;
};

export type LoadedInfrastructureConnection = Omit<
  SshInfrastructureConnectionDto,
  "credentialsConfigured"
> & {
  revision: number;
  /** Internal recovery bridge; never exposed by the public DTO. */
  pendingBindingRebindFromRevision: number | null;
  credentials: {
    sshPrivateKey: string;
  };
};

export type InfrastructureConnectionStoreErrorCode =
  | "not_found"
  | "conflict"
  | "invalid_request"
  | "database_unavailable"
  | "database_error"
  | "credential_error"
  | "credential_reconnect_required"
  | "quote_limit"
  | "capacity_busy"
  | "capacity_force_forget_required"
  | "force_forget_not_available"
  | "agents_bound";

/**
 * Stable, secret-free store error. Database and crypto error messages are not
 * copied into this object because callers may safely pass it to API logging.
 */
export class InfrastructureConnectionStoreError extends Error {
  constructor(
    public readonly code: InfrastructureConnectionStoreErrorCode,
    public readonly connectionRevision: number | null = null,
  ) {
    super(`Infrastructure connection store failed: ${code}`);
    this.name = "InfrastructureConnectionStoreError";
  }
}

export type InfrastructurePreflightTargetEvidence =
  ValidatedInfrastructurePreflightTargetEvidence;

export type InfrastructurePreflightCompletion = {
  connectionStatus: "ready" | "error";
  checkedAt: string;
  lastErrorCode: ProxmoxPreflightErrorCode | null;
  target: InfrastructurePreflightTargetEvidence | null;
};

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
    isDatabaseCode(error, "23514") ||
    isDatabaseCode(error, "55000") ||
    isDatabaseCode(error, "55006")
  ) {
    return new InfrastructureConnectionStoreError("conflict");
  }
  return new InfrastructureConnectionStoreError("database_error");
}

function normalizedConfiguration(config: unknown): InfrastructureConnectionDto["configuration"] {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  return Object.keys(config).length > 0
    ? (config as InfrastructureConnectionDto["configuration"])
    : null;
}

function configurationWithoutCapacityPolicy(
  configuration: InfrastructureConnectionDto["configuration"],
): Record<string, unknown> {
  if (!configuration) return {};
  const { capacityPolicy: _capacityPolicy, ...rest } = configuration;
  return rest;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalJsonValue(nested)]),
    );
  }
  return value;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right))
  );
}

function dtoFromRow(
  row: InfrastructureConnectionRow,
  credentialsConfigured: boolean,
): InfrastructureConnectionDto {
  if (row.provider === "digitalocean") {
    return InfrastructureConnectionDtoSchema.parse({
      id: row.id,
      name: row.name,
      provider: row.provider,
      operatingMode: row.operating_mode,
      setupMode: "simple",
      status: row.status,
      endpoint: null,
      configuration: null,
      capabilities: DIGITALOCEAN_CONNECTION_CAPABILITIES,
      credentialsConfigured,
      lastCheckedAt: row.last_checked_at,
      lastErrorCode: row.last_error_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  if (row.provider === "hetzner-cloud") {
    return InfrastructureConnectionDtoSchema.parse({
      id: row.id,
      name: row.name,
      provider: row.provider,
      operatingMode: row.operating_mode,
      setupMode: "simple",
      status: row.status,
      endpoint: null,
      configuration: null,
      capabilities: HETZNER_CLOUD_CONNECTION_CAPABILITIES,
      credentialsConfigured,
      lastCheckedAt: row.last_checked_at,
      lastErrorCode: row.last_error_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  if (
    row.ssh_host === null ||
    row.ssh_port === null ||
    row.ssh_user === null ||
    row.ssh_host_fingerprint_sha256 === null
  ) {
    throw new InfrastructureConnectionStoreError("database_error");
  }
  return InfrastructureConnectionDtoSchema.parse({
    id: row.id,
    name: row.name,
    provider: row.provider,
    operatingMode: row.operating_mode,
    setupMode: row.setup_mode,
    status: row.status,
    endpoint: {
      sshHost: row.ssh_host,
      sshPort: row.ssh_port,
      sshUser: row.ssh_user,
      sshHostFingerprintSha256: row.ssh_host_fingerprint_sha256,
    },
    configuration: normalizedConfiguration(row.config),
    credentialsConfigured,
    lastCheckedAt: row.last_checked_at,
    lastErrorCode: row.last_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function isDigitalOceanTargetRow(row: DeploymentTargetRow): boolean {
  const capabilities = row.capabilities;
  return Boolean(capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)
    && (capabilities as Record<string, unknown>).kind === "digitalocean-managed-agents");
}

function deploymentTargetDtoFromRow(row: DeploymentTargetRow): DeploymentTargetDto {
  if (isDigitalOceanTargetRow(row)) {
    // Never admit a DigitalOcean target through host/VM target contracts.
    throw new InfrastructureConnectionStoreError("invalid_request");
  }
  const rawCapabilities = row.capabilities;
  const capabilities = rawCapabilities &&
    typeof rawCapabilities === "object" &&
    !Array.isArray(rawCapabilities)
    ? rawCapabilities as Record<string, unknown>
    : null;
  if (capabilities?.kind === "provider-vm") {
    // Never normalize provider evidence through Proxmox version admission.
    // Provider admission uses its exact guest bundle, never a Proxmox ABI.
    return ProviderVmDeploymentTargetDtoSchema.parse({
      id: row.id,
      connectionId: row.connection_id,
      evidenceConnectionRevision: row.evidence_connection_revision,
      externalId: row.external_id,
      displayName: row.display_name,
      status: row.status,
      capacity: row.capacity,
      capabilities,
      supportedIsolationDrivers: row.supported_isolation_drivers,
      isolationClass: row.isolation_class,
      lastPreflightAt: row.last_preflight_at,
      lastErrorCode: row.last_error_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  if (capabilities?.kind === "gvisor") {
    // gVisor readiness is bound to its exact direct-host adapter and discovery
    // revision. It must never be normalized through the Proxmox runtime ABI.
    return GvisorDeploymentTargetDtoSchema.parse({
      id: row.id,
      connectionId: row.connection_id,
      evidenceConnectionRevision: row.evidence_connection_revision,
      externalId: row.external_id,
      displayName: row.display_name,
      status: row.status,
      capacity: row.capacity,
      capabilities,
      supportedIsolationDrivers: row.supported_isolation_drivers,
      isolationClass: row.isolation_class,
      lastPreflightAt: row.last_preflight_at,
      lastErrorCode: row.last_error_code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
  const compatibilityEvidencePresent = Boolean(
    capabilities && Object.prototype.hasOwnProperty.call(capabilities, "runtimeCompatibility"),
  );
  const rawCompatibility = capabilities?.runtimeCompatibility;
  const parsedCompatibility = PortableHivraRuntimeCompatibilitySchema.safeParse(
    rawCompatibility,
  );
  const rawProvisioner = capabilities?.provisioner;
  const observedProvisionerVersion = rawProvisioner
    && typeof rawProvisioner === "object"
    && !Array.isArray(rawProvisioner)
    && typeof (rawProvisioner as Record<string, unknown>).version === "string"
    ? (rawProvisioner as Record<string, unknown>).version
    : null;
  const compatibilityEvidenceCurrent = compatibilityEvidencePresent && (
    rawCompatibility === null || (
      parsedCompatibility.success
      && isCompatibleProxmoxProvisionerVersion(parsedCompatibility.data.provisionerVersion)
      && observedProvisionerVersion === parsedCompatibility.data.provisionerVersion
    )
  );
  // Rows written before the runtime-compatibility contract existed cannot
  // authorize a launch. The same applies to a stale/malformed compatibility
  // record; an explicit null remains valid evidence that no catalog runtime is
  // authorized. Rehydrate stale rows as superseded instead of guessing.
  const normalizedCapabilities = capabilities && !compatibilityEvidenceCurrent
    ? { ...capabilities, launchReady: false, runtimeCompatibility: null }
    : rawCapabilities;
  return DeploymentTargetDtoSchema.parse({
    id: row.id,
    connectionId: row.connection_id,
    evidenceConnectionRevision: row.evidence_connection_revision,
    externalId: row.external_id,
    displayName: row.display_name,
    status: compatibilityEvidenceCurrent ? row.status : "unavailable",
    capacity: row.capacity,
    capabilities: normalizedCapabilities,
    supportedIsolationDrivers: compatibilityEvidenceCurrent
      ? row.supported_isolation_drivers
      : [],
    isolationClass: compatibilityEvidenceCurrent ? row.isolation_class : null,
    lastPreflightAt: row.last_preflight_at,
    lastErrorCode: compatibilityEvidenceCurrent
      ? row.last_error_code
      : "PREFLIGHT_SUPERSEDED",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function metadataForCreate(
  userId: string,
  input: SshInfrastructureConnectionCreate,
) {
  return {
    user_id: userId,
    name: input.name,
    provider: input.provider,
    operating_mode: input.operatingMode,
    setup_mode: input.setupMode,
    status: "pending" as const,
    ssh_host: input.endpoint.sshHost,
    ssh_port: input.endpoint.sshPort,
    ssh_user: input.endpoint.sshUser,
    ssh_host_fingerprint_sha256: normalizeProxmoxSshHostFingerprint(
      input.endpoint.sshHostFingerprintSha256,
    ),
    config: "configuration" in input ? input.configuration ?? {} : {},
    last_checked_at: null,
    last_error_code: null,
  };
}

function encryptedSecretBundle(sshPrivateKey: string): string {
  const bundle: SecretBundle = { version: 1, sshPrivateKey };
  return encryptSecret(JSON.stringify(bundle));
}

async function ownerConnectionRow(
  userId: string,
  connectionId: string,
): Promise<InfrastructureConnectionRow> {
  const { data, error } = await database()
    .from("infrastructure_connections")
    .select(CONNECTION_SELECT)
    .eq("id", connectionId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw databaseError(error);
  if (!data) throw new InfrastructureConnectionStoreError("not_found");
  return data as unknown as InfrastructureConnectionRow;
}

async function credentialsConfigured(userId: string, connectionId: string): Promise<boolean> {
  const { data, error } = await database()
    .from("infrastructure_connection_secrets")
    .select("connection_id")
    .eq("connection_id", connectionId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw databaseError(error);
  return Boolean(data);
}

export async function listInfrastructureConnections(
  userId: string,
): Promise<InfrastructureConnectionDto[]> {
  const db = database();
  const { data: connectionRows, error: connectionError } = await db
    .from("infrastructure_connections")
    .select(CONNECTION_SELECT)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (connectionError) throw databaseError(connectionError);

  // Presence only: encrypted_bundle is intentionally never selected here.
  const { data: secretRows, error: secretError } = await db
    .from("infrastructure_connection_secrets")
    .select("connection_id")
    .eq("user_id", userId);
  if (secretError) throw databaseError(secretError);

  const configuredIds = new Set(
    (secretRows ?? []).map((row) => String((row as { connection_id: unknown }).connection_id)),
  );
  return (connectionRows ?? []).map((rawRow) => {
    const row = rawRow as unknown as InfrastructureConnectionRow;
    return dtoFromRow(row, configuredIds.has(row.id));
  });
}

export async function getInfrastructureConnection(
  userId: string,
  connectionId: string,
): Promise<InfrastructureConnectionDto> {
  const row = await ownerConnectionRow(userId, connectionId);
  return dtoFromRow(row, await credentialsConfigured(userId, connectionId));
}

export async function listInfrastructureDeploymentTargets(
  userId: string,
  options: { connectionId?: string } = {},
): Promise<DeploymentTargetDto[]> {
  let targetQuery = database()
    .from("deployment_targets")
    .select(DEPLOYMENT_TARGET_SELECT)
    .eq("user_id", userId);
  if (options.connectionId) {
    targetQuery = targetQuery.eq("connection_id", options.connectionId);
  }

  const { data, error } = await targetQuery.order("created_at", { ascending: false });
  if (error) throw databaseError(error);
  return (data ?? [])
    // DigitalOcean's serverless target has its own read model and launch path.
    .filter((row) => !isDigitalOceanTargetRow(row as unknown as DeploymentTargetRow))
    .map((row) => deploymentTargetDtoFromRow(row as unknown as DeploymentTargetRow));
}

export async function getInfrastructureDeploymentTarget(
  userId: string,
  targetId: string,
): Promise<DeploymentTargetDto> {
  const { data, error } = await database()
    .from("deployment_targets")
    .select(DEPLOYMENT_TARGET_SELECT)
    .eq("id", targetId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw databaseError(error);
  if (!data) throw new InfrastructureConnectionStoreError("not_found");
  return deploymentTargetDtoFromRow(data as unknown as DeploymentTargetRow);
}

export async function createInfrastructureConnection(
  userId: string,
  input: InfrastructureConnectionCreate,
): Promise<InfrastructureConnectionDto> {
  if (input.provider === "hetzner-cloud" || input.provider === "digitalocean") {
    // Provider-token validation and first persistence use the dedicated
    // provider services. This SSH-only path must never reinterpret a provider
    // credential as a private key.
    throw new InfrastructureConnectionStoreError("invalid_request");
  }
  // Resolve encryption configuration before the transaction starts. The RPC
  // inserts metadata and its credential envelope atomically, so neither row can
  // outlive a failure in the other insert.
  const encryptedBundle = encryptedSecretBundle(input.credentials.sshPrivateKey);
  const metadata = metadataForCreate(userId, input);
  const rpcName = input.provider === "host"
    ? "create_host_infrastructure_connection"
    : "create_infrastructure_connection";
  const rpcParameters = input.provider === "host"
    ? {
        p_user_id: userId,
        p_name: metadata.name,
        p_ssh_host: metadata.ssh_host,
        p_ssh_port: metadata.ssh_port,
        p_ssh_user: metadata.ssh_user,
        p_ssh_host_fingerprint_sha256: metadata.ssh_host_fingerprint_sha256,
        p_encrypted_bundle: encryptedBundle,
        p_key_version: 1,
      }
    : {
        p_user_id: userId,
        p_name: metadata.name,
        p_setup_mode: metadata.setup_mode,
        p_ssh_host: metadata.ssh_host,
        p_ssh_port: metadata.ssh_port,
        p_ssh_user: metadata.ssh_user,
        p_ssh_host_fingerprint_sha256: metadata.ssh_host_fingerprint_sha256,
        p_config: metadata.config,
        p_encrypted_bundle: encryptedBundle,
        p_key_version: 1,
      };
  const { data: inserted, error } = await database()
    .rpc(rpcName, rpcParameters)
    .select(CONNECTION_SELECT)
    .single();
  if (error || !inserted) throw databaseError(error);
  return dtoFromRow(inserted as unknown as InfrastructureConnectionRow, true);
}

export async function updateInfrastructureConnection(
  userId: string,
  connectionId: string,
  input: ProxmoxConnectionUpdate,
): Promise<InfrastructureConnectionDto> {
  const current = await ownerConnectionRow(userId, connectionId);
  if (isProviderApiConnection(current)) {
    throw new InfrastructureConnectionStoreError("invalid_request");
  }
  if (
    !(await recoverExpiredRunFromObservedConnection({
      userId,
      observed: current,
      recoveredAt: new Date().toISOString(),
      allowedRunId: null,
    }))
  ) {
    throw new InfrastructureConnectionStoreError("conflict");
  }
  const nextSetupMode = input.setupMode ?? current.setup_mode;
  const currentConfiguration = normalizedConfiguration(current.config);
  const requestedConfiguration =
    input.configuration !== undefined
      ? input.configuration
      : nextSetupMode === "simple" && current.setup_mode !== "simple"
        ? currentConfiguration?.capacityPolicy
          ? { capacityPolicy: currentConfiguration.capacityPolicy }
          : null
        : currentConfiguration;

  if (
    nextSetupMode === "simple" &&
    requestedConfiguration !== null &&
    Object.keys(requestedConfiguration).some((key) => key !== "capacityPolicy")
  ) {
    throw new InfrastructureConnectionStoreError("invalid_request");
  }

  // Encryption/key configuration is validated before either table changes,
  // but the encrypted value is not persisted until metadata succeeds.
  const rotatedEncryptedBundle = input.credentials
    ? encryptedSecretBundle(input.credentials.sshPrivateKey)
    : null;
  // Resolve the response-only credential-presence flag before the atomic
  // mutation. A transient read failure must not turn a committed PATCH into an
  // ambiguous 500 that callers may retry.
  const hasCredentials = input.credentials
    ? true
    : await credentialsConfigured(userId, connectionId);

  const capacityPolicyOnly = Boolean(
    input.configuration !== undefined &&
      input.name === undefined &&
      input.setupMode === undefined &&
      input.endpoint === undefined &&
      input.credentials === undefined &&
      sameJsonValue(
        configurationWithoutCapacityPolicy(requestedConfiguration),
        configurationWithoutCapacityPolicy(currentConfiguration),
      ),
  );
  if (capacityPolicyOnly) {
    const requestedPolicy = requestedConfiguration?.capacityPolicy ?? null;
    const currentPolicy = currentConfiguration?.capacityPolicy ?? null;
    if (sameJsonValue(requestedPolicy, currentPolicy)) {
      return dtoFromRow(current, hasCredentials);
    }
    const { data: updatedPolicy, error: policyError } = await database()
      .rpc("update_infrastructure_capacity_policy", {
        p_user_id: userId,
        p_connection_id: connectionId,
        p_expected_revision: current.revision,
        p_capacity_policy: requestedPolicy,
      })
      .select(CONNECTION_SELECT)
      .maybeSingle();
    if (policyError) throw databaseError(policyError);
    if (!updatedPolicy) throw new InfrastructureConnectionStoreError("conflict");
    return dtoFromRow(
      updatedPolicy as unknown as InfrastructureConnectionRow,
      hasCredentials,
    );
  }

  const credentialRecoveryOnly = Boolean(
    input.credentials &&
      input.name === undefined &&
      input.setupMode === undefined &&
      input.endpoint === undefined &&
      input.configuration === undefined,
  );
  if (credentialRecoveryOnly && rotatedEncryptedBundle) {
    const { data: recovered, error: recoveryError } = await database()
      .rpc("recover_infrastructure_connection_credentials", {
        p_user_id: userId,
        p_connection_id: connectionId,
        p_expected_revision: current.revision,
        p_encrypted_bundle: rotatedEncryptedBundle,
        p_key_version: 1,
      })
      .select(CONNECTION_SELECT)
      .maybeSingle();
    if (isDatabaseCode(recoveryError, "P0002")) {
      throw new InfrastructureConnectionStoreError("credential_error");
    }
    if (recoveryError) throw databaseError(recoveryError);
    if (!recovered) throw new InfrastructureConnectionStoreError("conflict");
    return dtoFromRow(recovered as unknown as InfrastructureConnectionRow, true);
  }

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.setupMode !== undefined) {
    patch.setup_mode = input.setupMode;
    if (input.setupMode === "simple") {
      patch.config = requestedConfiguration?.capacityPolicy
        ? { capacityPolicy: requestedConfiguration.capacityPolicy }
        : {};
    }
  }
  if (input.endpoint !== undefined) {
    patch.ssh_host = input.endpoint.sshHost;
    patch.ssh_port = input.endpoint.sshPort;
    patch.ssh_user = input.endpoint.sshUser;
    patch.ssh_host_fingerprint_sha256 = normalizeProxmoxSshHostFingerprint(
      input.endpoint.sshHostFingerprintSha256,
    );
  }
  if (input.configuration !== undefined) {
    patch.config = input.configuration ?? {};
  }

  const operationalChange = Boolean(
    input.setupMode !== undefined ||
      input.endpoint !== undefined ||
      input.configuration !== undefined ||
      input.credentials !== undefined,
  );
  const { data: updated, error: updateError } = await database()
    .rpc("update_infrastructure_connection", {
      p_user_id: userId,
      p_connection_id: connectionId,
      p_expected_revision: current.revision,
      p_patch: patch,
      p_operational_change: operationalChange,
      p_rotate_credentials: Boolean(input.credentials),
      p_encrypted_bundle: rotatedEncryptedBundle,
      p_key_version: 1,
    })
    .select(CONNECTION_SELECT)
    .maybeSingle();
  if (isDatabaseCode(updateError, "P0002")) {
    throw new InfrastructureConnectionStoreError("credential_error");
  }
  if (updateError) throw databaseError(updateError);
  // ownerConnectionRow succeeded above, so an empty optimistic update means a
  // concurrent PATCH changed the revision rather than a cross-owner lookup.
  if (!updated) throw new InfrastructureConnectionStoreError("conflict");

  return dtoFromRow(updated as unknown as InfrastructureConnectionRow, hasCredentials);
}

export async function deleteInfrastructureConnection(
  userId: string,
  connectionId: string,
): Promise<void> {
  const current = await ownerConnectionRow(userId, connectionId);
  if (
    !(await recoverExpiredRunFromObservedConnection({
      userId,
      observed: current,
      recoveredAt: new Date().toISOString(),
      allowedRunId: null,
    }))
  ) {
    throw new InfrastructureConnectionStoreError("conflict");
  }
  if (current.provider === "digitalocean") {
    // The target foreign key already refuses this delete; say why up front so
    // the owner deletes the sessions (and stops their billing) first.
    const { count, error: boundError } = await database()
      .from("hivra_agents")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("infrastructure_connection_id", connectionId)
      .neq("status", "deleted");
    if (boundError) throw databaseError(boundError);
    if ((count ?? 0) > 0) throw new InfrastructureConnectionStoreError("agents_bound");
  }
  const { data: disposition, error: deleteError } = await database().rpc(
    "delete_infrastructure_connection",
    {
      p_user_id: userId,
      p_connection_id: connectionId,
    },
  );
  if (deleteError) throw databaseError(deleteError);
  if (disposition === "not_found") {
    throw new InfrastructureConnectionStoreError("not_found");
  }
  if (disposition === "blocked" || disposition === "capacity_busy") {
    throw new InfrastructureConnectionStoreError(
      disposition === "capacity_busy" ? "capacity_busy" : "conflict",
    );
  }
  if (disposition === "capacity_force_forget_required") {
    throw new InfrastructureConnectionStoreError("capacity_force_forget_required");
  }
  if (disposition !== "deleted") {
    throw new InfrastructureConnectionStoreError("database_error");
  }
}

export async function forceForgetHetznerCloudConnection(
  userId: string,
  connectionId: string,
): Promise<void> {
  const { data: disposition, error } = await database().rpc(
    "force_forget_hetzner_cloud_connection",
    {
      p_user_id: userId,
      p_connection_id: connectionId,
    },
  );
  if (error) throw databaseError(error);
  if (disposition === "not_found") {
    throw new InfrastructureConnectionStoreError("not_found");
  }
  if (disposition === "invalid_provider") {
    throw new InfrastructureConnectionStoreError("invalid_request");
  }
  if (disposition === "blocked" || disposition === "capacity_busy") {
    throw new InfrastructureConnectionStoreError("capacity_busy");
  }
  if (disposition === "not_ambiguous") {
    throw new InfrastructureConnectionStoreError("force_forget_not_available");
  }
  if (disposition !== "forgotten") {
    throw new InfrastructureConnectionStoreError("database_error");
  }
}

/**
 * Server-only credential loader for preflight and, later, lifecycle adapters.
 * Callers must never serialize or log this return value.
 */
export async function loadInfrastructureConnectionSecret(
  userId: string,
  connectionId: string,
): Promise<LoadedInfrastructureConnection> {
  const row = await ownerConnectionRow(userId, connectionId);
  if (isProviderApiConnection(row)) {
    throw new InfrastructureConnectionStoreError("invalid_request", row.revision);
  }
  const { data, error } = await database()
    .from("infrastructure_connection_secrets")
    .select("connection_id, encrypted_bundle, key_version")
    .eq("connection_id", connectionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw databaseError(error);
  if (!data) {
    throw new InfrastructureConnectionStoreError("credential_error", row.revision);
  }

  const secretRow = data as SecretRow;
  if (secretRow.key_version !== 1) {
    throw new InfrastructureConnectionStoreError("credential_error", row.revision);
  }

  let bundle: SecretBundle;
  try {
    bundle = SecretBundleSchema.parse(JSON.parse(decryptSecret(secretRow.encrypted_bundle)));
  } catch {
    throw new InfrastructureConnectionStoreError("credential_error", row.revision);
  }

  const { credentialsConfigured, ...rawConnection } = dtoFromRow(row, true);
  void credentialsConfigured;
  if (rawConnection.provider !== "proxmox" && rawConnection.provider !== "host") {
    throw new InfrastructureConnectionStoreError("invalid_request", row.revision);
  }
  const connection: Omit<SshInfrastructureConnectionDto, "credentialsConfigured"> =
    rawConnection;
  return {
    ...connection,
    revision: row.revision,
    pendingBindingRebindFromRevision: row.pending_binding_rebind_from_revision,
    credentials: { sshPrivateKey: bundle.sshPrivateKey },
  };
}

export async function beginInfrastructureConnectionPreflight(
  userId: string,
  connectionId: string,
  expectedRevision: number,
  runId: string,
  startedAt: string,
): Promise<boolean> {
  if (
    !(await recoverObservedExpiredInfrastructureConnectionRun({
      userId,
      connectionId,
      expectedRevision,
      runId,
      startedAt,
    }))
  ) {
    return false;
  }
  const { data, error } = await database().rpc(
    "begin_infrastructure_connection_preflight",
    {
      p_user_id: userId,
      p_connection_id: connectionId,
      p_expected_revision: expectedRevision,
      p_run_id: runId,
      p_started_at: startedAt,
    },
  );
  if (error) throw databaseError(error);
  return data === true;
}

export async function beginInfrastructureConnectionPreparation(
  userId: string,
  connectionId: string,
  expectedRevision: number,
  runId: string,
  startedAt: string,
): Promise<boolean> {
  if (
    !(await recoverObservedExpiredInfrastructureConnectionRun({
      userId,
      connectionId,
      expectedRevision,
      runId,
      startedAt,
    }))
  ) {
    return false;
  }
  const { data, error } = await database().rpc(
    "begin_infrastructure_connection_preparation",
    {
      p_user_id: userId,
      p_connection_id: connectionId,
      p_expected_revision: expectedRevision,
      p_run_id: runId,
      p_started_at: startedAt,
    },
  );
  if (error) throw databaseError(error);
  return data === true;
}

export async function recoverExpiredInfrastructureConnectionRun(input: {
  userId: string;
  connectionId: string;
  expectedRevision: number;
  expectedRunId: string;
  recoveredAt: string;
}): Promise<boolean> {
  const { data, error } = await database().rpc(
    "recover_expired_infrastructure_connection_run",
    {
      p_user_id: input.userId,
      p_connection_id: input.connectionId,
      p_expected_revision: input.expectedRevision,
      p_expected_run_id: input.expectedRunId,
      p_recovered_at: input.recoveredAt,
    },
  );
  if (error) throw databaseError(error);
  return data === true;
}

async function recoverObservedExpiredInfrastructureConnectionRun(input: {
  userId: string;
  connectionId: string;
  expectedRevision: number;
  runId: string;
  startedAt: string;
}): Promise<boolean> {
  const observed = await ownerConnectionRow(input.userId, input.connectionId);
  if (observed.revision !== input.expectedRevision) return false;
  return recoverExpiredRunFromObservedConnection({
    userId: input.userId,
    observed,
    recoveredAt: input.startedAt,
    allowedRunId: input.runId,
  });
}

async function recoverExpiredRunFromObservedConnection(input: {
  userId: string;
  observed: InfrastructureConnectionRow;
  recoveredAt: string;
  allowedRunId: string | null;
}): Promise<boolean> {
  const observed = input.observed;
  if (
    !observed.preflight_run_id ||
    (input.allowedRunId !== null && observed.preflight_run_id === input.allowedRunId)
  ) {
    return true;
  }

  const leaseExpiresAt = observed.preflight_lease_expires_at
    ? Date.parse(observed.preflight_lease_expires_at)
    : Number.NaN;
  const recoveredAt = Date.parse(input.recoveredAt);
  if (
    !Number.isFinite(leaseExpiresAt) ||
    !Number.isFinite(recoveredAt) ||
    leaseExpiresAt >= recoveredAt
  ) {
    return false;
  }

  // Recovery names the exact observed owner and revision. If that owner
  // renewed its lease, or another caller won recovery, the RPC returns false
  // and this caller must not attempt to acquire the preparation/preflight
  // lease using stale evidence.
  return recoverExpiredInfrastructureConnectionRun({
    userId: input.userId,
    connectionId: observed.id,
    expectedRevision: observed.revision,
    expectedRunId: observed.preflight_run_id,
    recoveredAt: input.recoveredAt,
  });
}

export async function completeInfrastructureConnectionPreflight(
  userId: string,
  connectionId: string,
  expectedRevision: number,
  runId: string,
  completion: InfrastructurePreflightCompletion,
): Promise<boolean> {
  const { data, error } = await database().rpc(
    "complete_infrastructure_connection_preflight",
    {
      p_user_id: userId,
      p_connection_id: connectionId,
      p_expected_revision: expectedRevision,
      p_run_id: runId,
      p_connection_status: completion.connectionStatus,
      p_checked_at: completion.checkedAt,
      p_last_error_code: completion.lastErrorCode,
      p_target: completion.target,
    },
  );
  if (error) throw databaseError(error);
  return data === true;
}

export async function invalidateInfrastructureConnectionPreflight(
  userId: string,
  connectionId: string,
  expectedRevision: number,
  checkedAt: string,
  lastErrorCode: ProxmoxPreflightErrorCode,
): Promise<boolean> {
  const { data, error } = await database().rpc(
    "invalidate_infrastructure_connection_preflight",
    {
      p_user_id: userId,
      p_connection_id: connectionId,
      p_expected_revision: expectedRevision,
      p_checked_at: checkedAt,
      p_last_error_code: lastErrorCode,
    },
  );
  if (error) throw databaseError(error);
  return data === true;
}
