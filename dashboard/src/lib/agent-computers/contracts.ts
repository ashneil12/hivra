import { z } from "zod";

export const AGENT_COMPUTER_CONTRACT_VERSION = "2026-08-24" as const;

export const AGENT_COMPUTER_SOURCE_KINDS = ["hermes", "hivra"] as const;
export const AGENT_COMPUTER_SURFACES = [
  "workspace",
  "files",
  "git",
  "terminal",
  "browser",
  "desktop",
  "native",
] as const;
export const AGENT_COMPUTER_ACTIONS = [
  "provision",
  "start",
  "stop",
  "reboot",
  "delete",
  "resize",
  "snapshot",
  "restore",
] as const;
// Capability discovery may describe mature legacy lifecycle lanes before this
// compatibility dispatcher owns them. Keep its command surface deliberately
// narrower until a later write-authority cutover.
export const AGENT_COMPUTER_COMMAND_ACTIONS = [
  "provision",
  "start",
  "stop",
  "reboot",
  "delete",
] as const;
export const AGENT_COMPUTER_DESIRED_STATES = [
  "absent",
  "running",
  "stopped",
  "archived",
  "unknown",
] as const;
export const AGENT_COMPUTER_OBSERVED_STATES = [
  "unknown",
  "missing",
  "provisioning",
  "running",
  "stopped",
  "suspended",
  "deleting",
  "error",
] as const;
export const AGENT_COMPUTER_HEALTH_STATES = [
  "unknown",
  "enrolling",
  "healthy",
  "degraded",
  "unreachable",
  "incompatible",
] as const;
export const AGENT_COMPUTER_OPERATION_STATES = [
  "idle",
  "provisioning",
  "starting",
  "stopping",
  "resizing",
  "snapshotting",
  "restoring",
  "archiving",
  "deleting",
  "reconciling",
  "failed",
  "unknown",
] as const;

const BoundedIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const IsoDateTimeSchema = z.string().datetime({ offset: true });

function uniqueValues<T extends string>(values: T[]): boolean {
  return new Set(values).size === values.length;
}

export const AgentComputerSourceIdentitySchema = z
  .object({
    kind: z.enum(AGENT_COMPUTER_SOURCE_KINDS),
    id: BoundedIdSchema,
  })
  .strict();

export const AgentComputerCapabilitiesSchema = z
  .object({
    surfaces: z
      .array(z.enum(AGENT_COMPUTER_SURFACES))
      .max(AGENT_COMPUTER_SURFACES.length)
      .refine(uniqueValues, "Surfaces must be unique"),
    actions: z
      .array(z.enum(AGENT_COMPUTER_ACTIONS))
      .max(AGENT_COMPUTER_ACTIONS.length)
      .refine(uniqueValues, "Actions must be unique"),
  })
  .strict();

export const AgentComputerOperationSchema = z
  .object({
    state: z.enum(AGENT_COMPUTER_OPERATION_STATES),
    id: BoundedIdSchema.optional(),
    idempotencyKey: BoundedIdSchema.optional(),
    observedAt: IsoDateTimeSchema.optional(),
  })
  .strict();

export const AgentComputerStateSchema = z
  .object({
    desired: z.enum(AGENT_COMPUTER_DESIRED_STATES),
    observed: z.enum(AGENT_COMPUTER_OBSERVED_STATES),
    health: z.enum(AGENT_COMPUTER_HEALTH_STATES),
    operation: AgentComputerOperationSchema.nullable(),
  })
  .strict();

export const AgentComputerCompatibilitySchema = z
  .object({
    mode: z.literal("projected"),
    sourceStatus: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

export const AgentComputerSchema = z
  .object({
    contractVersion: z.literal(AGENT_COMPUTER_CONTRACT_VERSION),
    id: BoundedIdSchema,
    name: z.string().trim().min(1).max(128),
    source: AgentComputerSourceIdentitySchema,
    capabilities: AgentComputerCapabilitiesSchema,
    state: AgentComputerStateSchema,
    compatibility: AgentComputerCompatibilitySchema,
  })
  .strict();

function commandSchema<TAction extends (typeof AGENT_COMPUTER_COMMAND_ACTIONS)[number]>(
  action: TAction
) {
  return z
    .object({
      computerId: BoundedIdSchema,
      requestId: BoundedIdSchema,
      action: z.literal(action),
    })
    .strict();
}

export const AgentComputerCommandSchema = z.discriminatedUnion("action", [
  commandSchema("provision"),
  commandSchema("start"),
  commandSchema("stop"),
  commandSchema("reboot"),
  commandSchema("delete"),
]);

const AgentComputerCommandAcceptedSchema = z
  .object({
    ok: z.literal(true),
    status: z.literal("accepted"),
    requestId: BoundedIdSchema,
    operationId: BoundedIdSchema.optional(),
    observedAt: IsoDateTimeSchema.optional(),
  })
  .strict();

const AgentComputerCommandRejectedSchema = z
  .object({
    ok: z.literal(false),
    status: z.literal("rejected"),
    requestId: BoundedIdSchema,
    code: z.enum([
      "UNSUPPORTED_ACTION",
      "INVALID_COMMAND",
      "AUTHORITY_ERROR",
    ]),
  })
  .strict();

export const AgentComputerCommandResultSchema = z.discriminatedUnion("ok", [
  AgentComputerCommandAcceptedSchema,
  AgentComputerCommandRejectedSchema,
]);

export type AgentComputerSourceIdentity = z.infer<
  typeof AgentComputerSourceIdentitySchema
>;
export type AgentComputerSurface = (typeof AGENT_COMPUTER_SURFACES)[number];
export type AgentComputerAction = (typeof AGENT_COMPUTER_ACTIONS)[number];
export type AgentComputerCommandAction =
  (typeof AGENT_COMPUTER_COMMAND_ACTIONS)[number];
export type AgentComputerDesiredState = z.infer<
  typeof AgentComputerStateSchema
>["desired"];
export type AgentComputerObservedState = z.infer<
  typeof AgentComputerStateSchema
>["observed"];
export type AgentComputerHealthState = z.infer<
  typeof AgentComputerStateSchema
>["health"];
export type AgentComputerOperationState = z.infer<
  typeof AgentComputerOperationSchema
>["state"];
export type AgentComputerOperation = z.infer<typeof AgentComputerOperationSchema>;
export type AgentComputerCapabilities = z.infer<
  typeof AgentComputerCapabilitiesSchema
>;
export type AgentComputerState = z.infer<typeof AgentComputerStateSchema>;
export type AgentComputer = z.infer<typeof AgentComputerSchema>;
export type AgentComputerCommand = z.infer<typeof AgentComputerCommandSchema>;
export type AgentComputerCommandResult = z.infer<
  typeof AgentComputerCommandResultSchema
>;
