import { z } from "zod";

export const CANONICAL_AGENT_COMPUTER_CONTRACT_VERSION = "2026-09-04" as const;

export const CANONICAL_COMPUTER_ACTIONS = [
  "provision",
  "start",
  "stop",
  "reboot",
  "delete",
  "resize",
  "snapshot",
  "restore",
] as const;

const CanonicalUuidSchema = z.string().uuid();
const SourceEventIdSchema = z.string().regex(/^[1-9][0-9]*$/);
const OwnerIdSchema = z.string().trim().min(1).max(256);
const NameSchema = z.string().trim().min(1).max(256);
const RuntimeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const CanonicalLegacySourceSchema = z
  .object({
    kind: z.enum(["hermes", "hivra"]),
    id: CanonicalUuidSchema,
  })
  .strict();

export const CanonicalCapacityReferenceSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.enum(["pool", "legacy-hermes-host"]),
      id: CanonicalUuidSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("deployment-target"),
      id: CanonicalUuidSchema,
      connectionId: CanonicalUuidSchema,
      connectionRevision: z.number().int().positive().safe(),
    })
    .strict(),
]);

export const CanonicalComputerCapabilitiesSchema = z
  .object({
    surfaces: z
      .array(
        z.enum(["workspace", "files", "git", "terminal", "browser", "desktop", "native"]),
      )
      .refine((values) => new Set(values).size === values.length, "Surfaces must be unique"),
    actions: z
      .array(z.enum(CANONICAL_COMPUTER_ACTIONS))
      .refine((values) => new Set(values).size === values.length, "Actions must be unique"),
  })
  .strict();

const CanonicalComputerOperationSchema = z
  .object({
    state: z.enum([
      "provisioning",
      "starting",
      "stopping",
      "rebooting",
      "resizing",
      "snapshotting",
      "restoring",
      "deleting",
      "failed",
      "unknown",
    ]),
    id: CanonicalUuidSchema.optional(),
  })
  .strict();

export const CanonicalComputerStateSchema = z
  .object({
    desired: z.enum(["absent", "running", "stopped", "unknown"]),
    observed: z.enum([
      "unknown",
      "missing",
      "provisioning",
      "running",
      "stopped",
      "suspended",
      "deleting",
      "error",
    ]),
    health: z.enum(["unknown", "healthy", "degraded", "unreachable", "incompatible"]),
    operation: CanonicalComputerOperationSchema.nullable(),
  })
  .strict();

export const CanonicalComputerSchema = z
  .object({
    contractVersion: z.literal(CANONICAL_AGENT_COMPUTER_CONTRACT_VERSION),
    id: CanonicalUuidSchema,
    ownerId: OwnerIdSchema,
    name: NameSchema,
    resourceKind: z.enum(["agent", "computer"]),
    osProfile: RuntimeIdSchema.nullable(),
    capacity: CanonicalCapacityReferenceSchema.nullable(),
    capabilities: CanonicalComputerCapabilitiesSchema,
    state: CanonicalComputerStateSchema,
    source: CanonicalLegacySourceSchema,
    compatibilityAliases: z.array(z.string().min(3).max(160)).length(1),
    sourceEventId: SourceEventIdSchema,
    tombstoned: z.boolean(),
  })
  .strict();

export const CanonicalAgentIdentitySchema = z
  .object({
    contractVersion: z.literal(CANONICAL_AGENT_COMPUTER_CONTRACT_VERSION),
    id: CanonicalUuidSchema,
    ownerId: OwnerIdSchema,
    name: NameSchema,
    status: z.enum(["active", "archived"]),
    source: CanonicalLegacySourceSchema,
    sourceEventId: SourceEventIdSchema,
  })
  .strict();

export const CanonicalRuntimeInstallationSchema = z
  .object({
    contractVersion: z.literal(CANONICAL_AGENT_COMPUTER_CONTRACT_VERSION),
    id: CanonicalUuidSchema,
    ownerId: OwnerIdSchema,
    computerId: CanonicalUuidSchema,
    runtimeId: RuntimeIdSchema,
    status: z.enum(["unknown", "installing", "ready", "failed", "removed"]),
    sourceEventId: SourceEventIdSchema,
  })
  .strict();

export const CanonicalPrimaryAgentBindingSchema = z
  .object({
    contractVersion: z.literal(CANONICAL_AGENT_COMPUTER_CONTRACT_VERSION),
    id: CanonicalUuidSchema,
    ownerId: OwnerIdSchema,
    computerId: CanonicalUuidSchema,
    agentIdentityId: CanonicalUuidSchema,
    role: z.literal("primary"),
    status: z.enum(["active", "detached"]),
    sourceEventId: SourceEventIdSchema,
  })
  .strict();

export const CanonicalSourceMappingSchema = z
  .object({
    contractVersion: z.literal(CANONICAL_AGENT_COMPUTER_CONTRACT_VERSION),
    ownerId: OwnerIdSchema,
    resourceKind: z.enum(["agent", "computer"]),
    source: CanonicalLegacySourceSchema,
    compatibilityAlias: z.string().min(3).max(160),
    computerId: CanonicalUuidSchema,
    agentIdentityId: CanonicalUuidSchema.nullable(),
    runtimeInstallationId: CanonicalUuidSchema.nullable(),
    primaryBindingId: CanonicalUuidSchema.nullable(),
    sourceEventId: SourceEventIdSchema,
  })
  .strict();

export const CanonicalResourceShadowSchema = z
  .object({
    computer: CanonicalComputerSchema,
    agentIdentity: CanonicalAgentIdentitySchema.nullable(),
    runtimeInstallation: CanonicalRuntimeInstallationSchema.nullable(),
    primaryBinding: CanonicalPrimaryAgentBindingSchema.nullable(),
    sourceMapping: CanonicalSourceMappingSchema,
  })
  .strict()
  .superRefine((shadow, context) => {
    const related = [
      shadow.agentIdentity,
      shadow.runtimeInstallation,
      shadow.primaryBinding,
    ];
    const mappingIds = [
      shadow.sourceMapping.agentIdentityId,
      shadow.sourceMapping.runtimeInstallationId,
      shadow.sourceMapping.primaryBindingId,
    ];
    const requiresAgent = shadow.computer.resourceKind === "agent";
    const compatibilityAlias = legacyComputerAlias(shadow.computer.source);
    if (related.some(Boolean) !== requiresAgent || related.some((value) => Boolean(value) !== requiresAgent)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Agent resources require one complete identity, installation, and primary binding",
      });
    }
    if (mappingIds.some(Boolean) !== requiresAgent || mappingIds.some((value) => Boolean(value) !== requiresAgent)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Source mapping relationship IDs must match the resource kind",
      });
    }
    if (
      shadow.sourceMapping.computerId !== shadow.computer.id ||
      shadow.sourceMapping.ownerId !== shadow.computer.ownerId ||
      shadow.sourceMapping.resourceKind !== shadow.computer.resourceKind ||
      shadow.sourceMapping.source.kind !== shadow.computer.source.kind ||
      shadow.sourceMapping.source.id !== shadow.computer.source.id ||
      shadow.sourceMapping.sourceEventId !== shadow.computer.sourceEventId ||
      shadow.sourceMapping.compatibilityAlias !== compatibilityAlias ||
      shadow.computer.compatibilityAliases[0] !== compatibilityAlias
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Computer source mapping does not match" });
    }
    if (
      shadow.agentIdentity &&
      (shadow.agentIdentity.id !== shadow.sourceMapping.agentIdentityId ||
        shadow.agentIdentity.ownerId !== shadow.computer.ownerId ||
        shadow.agentIdentity.source.kind !== shadow.computer.source.kind ||
        shadow.agentIdentity.source.id !== shadow.computer.source.id ||
        shadow.agentIdentity.sourceEventId !== shadow.computer.sourceEventId)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Agent identity mapping does not match" });
    }
    if (
      shadow.runtimeInstallation &&
      (shadow.runtimeInstallation.id !== shadow.sourceMapping.runtimeInstallationId ||
        shadow.runtimeInstallation.computerId !== shadow.computer.id ||
        shadow.runtimeInstallation.ownerId !== shadow.computer.ownerId ||
        shadow.runtimeInstallation.sourceEventId !== shadow.computer.sourceEventId)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Runtime installation mapping does not match" });
    }
    if (
      shadow.primaryBinding &&
      (shadow.primaryBinding.id !== shadow.sourceMapping.primaryBindingId ||
        shadow.primaryBinding.computerId !== shadow.computer.id ||
        shadow.primaryBinding.agentIdentityId !== shadow.agentIdentity?.id ||
        shadow.primaryBinding.ownerId !== shadow.computer.ownerId ||
        shadow.primaryBinding.sourceEventId !== shadow.computer.sourceEventId)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Primary binding mapping does not match" });
    }
    if (
      shadow.agentIdentity &&
      (shadow.agentIdentity.status !== (shadow.computer.tombstoned ? "archived" : "active") ||
        shadow.primaryBinding?.status !== (shadow.computer.tombstoned ? "detached" : "active") ||
        (shadow.runtimeInstallation?.status === "removed") !== shadow.computer.tombstoned)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Agent relationship state must match the computer tombstone",
      });
    }
  });

export interface CanonicalShadowIds {
  computerId: string;
  agentIdentityId: string | null;
  runtimeInstallationId: string | null;
  primaryBindingId: string | null;
}

export interface CanonicalShadowProjectionOptions {
  sourceOperation?: "insert" | "update" | "delete" | "backfill";
}

export interface CanonicalHermesShadowRecord {
  id: string;
  user_id: string;
  name: string;
  status?: string | null;
  lifecycle_state?: string | null;
  backend?: string | null;
  agent_type?: string | null;
  host_id?: string | null;
  pool_id?: string | null;
}

export interface CanonicalHivraShadowRecord {
  id: string;
  user_id: string;
  name: string;
  type?: string | null;
  computer_profile?: string | null;
  status?: string | null;
  desired_state?: string | null;
  operation_id?: string | null;
  operation_kind?: string | null;
  deployment_mode?: string | null;
  computer_substrate?: string | null;
  pool_id?: string | null;
  deployment_target_id?: string | null;
  infrastructure_connection_id?: string | null;
  infrastructure_connection_revision?: number | null;
  cpu?: number | null;
  ram?: number | null;
}

const KNOWN_HERMES_BACKENDS = new Set(["gateway", "webui"]);
const KNOWN_HIVRA_CLI_RUNTIMES = new Set([
  "hermes",
  "claude-code",
  "codex",
  "openclaw",
  "agent-zero",
  "deepseek-harness",
]);
const KNOWN_HIVRA_DASHBOARD_RUNTIMES = new Set(["aeon"]);

function normalized(value: string | null | undefined): string | null {
  const result = value?.trim().toLowerCase();
  return result || null;
}

function eventId(value: bigint | number | string): string {
  return SourceEventIdSchema.parse(String(value));
}

export function legacyComputerAlias(source: z.infer<typeof CanonicalLegacySourceSchema>): string {
  const parsed = CanonicalLegacySourceSchema.parse(source);
  return `${parsed.kind === "hermes" ? "h" : "x"}-${parsed.id}`;
}

function observedState(status: string | null) {
  switch (status) {
    case "provisioning":
    case "redeploying":
    case "restoring":
      return "provisioning" as const;
    case "running":
      return "running" as const;
    case "stopped":
    case "paused":
      return "stopped" as const;
    case "suspended":
      return "suspended" as const;
    case "deleting":
      return "deleting" as const;
    case "deleted":
      return "missing" as const;
    case "error":
    case "failed":
      return "error" as const;
    default:
      return "unknown" as const;
  }
}

function hermesDesiredState(lifecycle: string | null, status: string | null) {
  if (lifecycle === "deleted" || status === "deleted") return "absent" as const;
  if (lifecycle === "active") return "running" as const;
  if (lifecycle === "paused" || lifecycle === "suspended") return "stopped" as const;
  if (lifecycle === "pending" || lifecycle === "provisioning") return "running" as const;
  return "unknown" as const;
}

function hivraDesiredState(desired: string | null, status: string | null) {
  if (desired === "deleted" || status === "deleted") return "absent" as const;
  if (desired === "running") return "running" as const;
  if (desired === "stopped") return "stopped" as const;
  return "unknown" as const;
}

function hivraOperation(kind: string | null, id: string | null | undefined) {
  if (!kind && !id) return null;
  const state = {
    provision: "provisioning",
    start: "starting",
    stop: "stopping",
    restart: "rebooting",
    resize: "resizing",
    snapshot: "snapshotting",
    restore: "restoring",
    delete: "deleting",
  }[kind ?? ""] as
    | "provisioning"
    | "starting"
    | "stopping"
    | "rebooting"
    | "resizing"
    | "snapshotting"
    | "restoring"
    | "deleting"
    | undefined;
  return CanonicalComputerOperationSchema.parse({
    state: state ?? "unknown",
    ...(id ? { id } : {}),
  });
}

function hermesCapabilities(status: string | null, backend: string | null) {
  if (!status || !backend || status === "deleted" || !KNOWN_HERMES_BACKENDS.has(backend)) {
    return { surfaces: [], actions: [] };
  }
  if (status === "running") {
    return {
      surfaces: ["workspace", "terminal", "browser", "native"] as const,
      actions: ["stop", "reboot", "delete"] as const,
    };
  }
  if (["stopped", "paused", "suspended"].includes(status)) {
    return { surfaces: [], actions: ["start", "delete"] as const };
  }
  if (["provisioning", "redeploying", "restoring", "deleting"].includes(status)) {
    return { surfaces: [], actions: ["delete"] as const };
  }
  if (["error", "failed"].includes(status)) {
    return { surfaces: [], actions: ["start", "delete"] as const };
  }
  return { surfaces: [], actions: [] };
}

function hivraCapabilities(
  type: string | null,
  status: string | null,
  isComputer: boolean,
  computerSubstrate: string | null,
) {
  const knownAgent = Boolean(
    type && (KNOWN_HIVRA_CLI_RUNTIMES.has(type) || KNOWN_HIVRA_DASHBOARD_RUNTIMES.has(type)),
  );
  if (!status || (!isComputer && !knownAgent) || status === "deleted") {
    return { surfaces: [], actions: [] };
  }
  if (isComputer) {
    const hasProxmoxLifecycle = computerSubstrate === "proxmox-kvm";
    const isGvisorTerminal = computerSubstrate === "gvisor";
    if (status === "running") {
      return {
        surfaces: isGvisorTerminal
          ? (["terminal"] as const)
          : (["files", "terminal", "desktop"] as const),
        actions: isGvisorTerminal
          ? (["stop", "delete", "resize"] as const)
          : hasProxmoxLifecycle
          ? (["stop", "reboot", "delete", "resize", "snapshot", "restore"] as const)
          : (["stop", "reboot", "delete"] as const),
      };
    }
    if (status === "stopped") {
      return {
        surfaces: [],
        actions: isGvisorTerminal
          ? (["start", "delete", "resize"] as const)
          : hasProxmoxLifecycle
          ? (["start", "delete", "resize", "snapshot", "restore"] as const)
          : (["start", "delete"] as const),
      };
    }
    if (status === "error") {
      return {
        surfaces: [],
        actions: isGvisorTerminal
          ? (["start", "delete", "resize"] as const)
          : hasProxmoxLifecycle
          ? (["start", "delete", "restore"] as const)
          : (["start", "delete"] as const),
      };
    }
    if (status === "provisioning") return { surfaces: [], actions: ["delete"] as const };
    return { surfaces: [], actions: [] };
  }
  const surfaces = status === "running"
    ? KNOWN_HIVRA_CLI_RUNTIMES.has(type ?? "")
      ? (["workspace", "files", "git", "terminal"] as const)
      : (["workspace"] as const)
    : [];
  return { surfaces, actions: ["delete"] as const };
}

function runtimeInstallationStatus(status: string | null, tombstoned: boolean) {
  if (tombstoned) return "removed" as const;
  if (status === "running") return "ready" as const;
  if (["provisioning", "redeploying", "restoring"].includes(status ?? "")) {
    return "installing" as const;
  }
  if (status === "error" || status === "failed") return "failed" as const;
  return "unknown" as const;
}

function agentIds(ids: CanonicalShadowIds, expectsAgent: boolean): CanonicalShadowIds {
  const parsed = {
    computerId: CanonicalUuidSchema.parse(ids.computerId),
    agentIdentityId: ids.agentIdentityId ? CanonicalUuidSchema.parse(ids.agentIdentityId) : null,
    runtimeInstallationId: ids.runtimeInstallationId
      ? CanonicalUuidSchema.parse(ids.runtimeInstallationId)
      : null,
    primaryBindingId: ids.primaryBindingId ? CanonicalUuidSchema.parse(ids.primaryBindingId) : null,
  };
  const related = [parsed.agentIdentityId, parsed.runtimeInstallationId, parsed.primaryBindingId];
  if (related.some(Boolean) !== expectsAgent || related.some((value) => Boolean(value) !== expectsAgent)) {
    throw new Error(expectsAgent ? "Agent shadow requires complete canonical IDs" : "Computer shadow cannot own agent relationship IDs");
  }
  return parsed;
}

function buildShadow(input: {
  source: z.infer<typeof CanonicalLegacySourceSchema>;
  ownerId: string;
  name: string;
  runtimeId: string;
  resourceKind: "agent" | "computer";
  osProfile: string | null;
  capacity: z.infer<typeof CanonicalCapacityReferenceSchema> | null;
  capabilities: z.infer<typeof CanonicalComputerCapabilitiesSchema>;
  state: z.infer<typeof CanonicalComputerStateSchema>;
  tombstoned: boolean;
  ids: CanonicalShadowIds;
  sourceEventId: string;
}) {
  const ids = agentIds(input.ids, input.resourceKind === "agent");
  const compatibilityAlias = legacyComputerAlias(input.source);
  const common = {
    contractVersion: CANONICAL_AGENT_COMPUTER_CONTRACT_VERSION,
    ownerId: input.ownerId,
    sourceEventId: input.sourceEventId,
  } as const;
  const agentIdentity = ids.agentIdentityId
    ? {
        ...common,
        id: ids.agentIdentityId,
        name: input.name,
        status: input.tombstoned ? ("archived" as const) : ("active" as const),
        source: input.source,
      }
    : null;
  const runtimeInstallation = ids.runtimeInstallationId
    ? {
        ...common,
        id: ids.runtimeInstallationId,
        computerId: ids.computerId,
        runtimeId: input.runtimeId,
        status: runtimeInstallationStatus(input.state.observed, input.tombstoned),
      }
    : null;
  const primaryBinding = ids.primaryBindingId && ids.agentIdentityId
    ? {
        ...common,
        id: ids.primaryBindingId,
        computerId: ids.computerId,
        agentIdentityId: ids.agentIdentityId,
        role: "primary" as const,
        status: input.tombstoned ? ("detached" as const) : ("active" as const),
      }
    : null;
  return CanonicalResourceShadowSchema.parse({
    computer: {
      ...common,
      id: ids.computerId,
      name: input.name,
      resourceKind: input.resourceKind,
      osProfile: input.osProfile,
      capacity: input.capacity,
      capabilities: input.capabilities,
      state: input.state,
      source: input.source,
      compatibilityAliases: [compatibilityAlias],
      tombstoned: input.tombstoned,
    },
    agentIdentity,
    runtimeInstallation,
    primaryBinding,
    sourceMapping: {
      ...common,
      resourceKind: input.resourceKind,
      source: input.source,
      compatibilityAlias,
      computerId: ids.computerId,
      agentIdentityId: ids.agentIdentityId,
      runtimeInstallationId: ids.runtimeInstallationId,
      primaryBindingId: ids.primaryBindingId,
    },
  });
}

export function projectCanonicalHermesShadow(
  record: CanonicalHermesShadowRecord,
  ids: CanonicalShadowIds,
  rawSourceEventId: bigint | number | string,
  options: CanonicalShadowProjectionOptions = {},
) {
  const source = CanonicalLegacySourceSchema.parse({ kind: "hermes", id: record.id });
  const status = normalized(record.status);
  const lifecycle = normalized(record.lifecycle_state);
  const tombstoned =
    options.sourceOperation === "delete" || status === "deleted" || lifecycle === "deleted";
  const capacity = record.host_id
    ? CanonicalCapacityReferenceSchema.parse({ kind: "legacy-hermes-host", id: record.host_id })
    : record.pool_id
      ? CanonicalCapacityReferenceSchema.parse({ kind: "pool", id: record.pool_id })
      : null;
  return buildShadow({
    source,
    ownerId: record.user_id,
    name: record.name,
    runtimeId: normalized(record.agent_type) ?? "hermes",
    resourceKind: "agent",
    osProfile: null,
    capacity,
    capabilities: CanonicalComputerCapabilitiesSchema.parse(
      hermesCapabilities(tombstoned ? "deleted" : status, normalized(record.backend)),
    ),
    state: {
      desired: tombstoned ? "absent" : hermesDesiredState(lifecycle, status),
      observed: tombstoned ? "missing" : observedState(status),
      health: "unknown",
      operation: tombstoned
        ? null
        : status === "provisioning" || status === "redeploying"
          ? { state: "provisioning" }
          : status === "restoring"
            ? { state: "restoring" }
            : null,
    },
    tombstoned,
    ids,
    sourceEventId: eventId(rawSourceEventId),
  });
}

export function projectCanonicalHivraShadow(
  record: CanonicalHivraShadowRecord,
  ids: CanonicalShadowIds,
  rawSourceEventId: bigint | number | string,
  options: CanonicalShadowProjectionOptions = {},
) {
  const source = CanonicalLegacySourceSchema.parse({ kind: "hivra", id: record.id });
  const status = normalized(record.status);
  const type = normalized(record.type) ?? "unknown";
  const osProfile = normalized(record.computer_profile);
  const computerSubstrate = normalized(record.computer_substrate);
  const isComputer = Boolean(osProfile || type === "linux-desktop");
  const tombstoned =
    options.sourceOperation === "delete" ||
    status === "deleted" ||
    normalized(record.desired_state) === "deleted";
  const hasTargetReference = Boolean(
    record.deployment_target_id ||
      record.infrastructure_connection_id ||
      record.infrastructure_connection_revision,
  );
  let capacity: z.infer<typeof CanonicalCapacityReferenceSchema> | null = null;
  if (hasTargetReference) {
    capacity = CanonicalCapacityReferenceSchema.parse({
      kind: "deployment-target",
      id: record.deployment_target_id,
      connectionId: record.infrastructure_connection_id,
      connectionRevision: record.infrastructure_connection_revision,
    });
  } else if (record.pool_id) {
    capacity = CanonicalCapacityReferenceSchema.parse({ kind: "pool", id: record.pool_id });
  }
  return buildShadow({
    source,
    ownerId: record.user_id,
    name: record.name,
    runtimeId: type,
    resourceKind: isComputer ? "computer" : "agent",
    osProfile,
    capacity,
    capabilities: CanonicalComputerCapabilitiesSchema.parse(
      hivraCapabilities(
        type,
        tombstoned ? "deleted" : status,
        isComputer,
        computerSubstrate,
      ),
    ),
    state: {
      desired: tombstoned
        ? "absent"
        : hivraDesiredState(normalized(record.desired_state), status),
      observed: tombstoned ? "missing" : observedState(status),
      health: "unknown",
      operation: tombstoned
        ? null
        : hivraOperation(normalized(record.operation_kind), record.operation_id),
    },
    tombstoned,
    ids,
    sourceEventId: eventId(rawSourceEventId),
  });
}

export type CanonicalComputer = z.infer<typeof CanonicalComputerSchema>;
export type CanonicalAgentIdentity = z.infer<typeof CanonicalAgentIdentitySchema>;
export type CanonicalRuntimeInstallation = z.infer<typeof CanonicalRuntimeInstallationSchema>;
export type CanonicalPrimaryAgentBinding = z.infer<typeof CanonicalPrimaryAgentBindingSchema>;
export type CanonicalSourceMapping = z.infer<typeof CanonicalSourceMappingSchema>;
export type CanonicalResourceShadow = z.infer<typeof CanonicalResourceShadowSchema>;
