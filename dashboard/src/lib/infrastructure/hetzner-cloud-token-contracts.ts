import { z } from "zod";

import {
  HetznerCloudConnectionCreateSchema,
  InfrastructureConnectionDtoSchema,
  HetznerCloudServerInventoryDtoSchema,
} from "./contracts";

/**
 * Connect-time and Replace-token write check. Hivra adds, then removes, one
 * SSH key in the project so a read-only token fails before any purchase. The
 * key's private half is discarded at creation and it is never attached to a
 * server. Browser-safe shared vocabulary; no token or key material.
 */
export const HETZNER_WRITE_CHECK_KEY_PREFIX = "hivra-check-" as const;
export const HETZNER_WRITE_CHECK_LABEL = "hivra-check" as const;
export const HetznerWriteCheckKeyNameSchema = z
  .string()
  .regex(/^hivra-check-[0-9a-f]{12}$/);

export const HetznerCloudWriteCheckSchema = z
  .object({
    /** Set only when Hivra added its test key but could not remove it. */
    strayKeyName: HetznerWriteCheckKeyNameSchema.nullable(),
  })
  .strict();
export type HetznerCloudWriteCheck = z.infer<typeof HetznerCloudWriteCheckSchema>;

export const HETZNER_CLOUD_TOKEN_CHECK_ERROR_CODES = [
  "token_read_only",
  "token_project_mismatch",
  "write_check_blocked",
  "write_check_unconfirmed",
] as const;
export type HetznerCloudTokenCheckErrorCode =
  (typeof HETZNER_CLOUD_TOKEN_CHECK_ERROR_CODES)[number];

export function hetznerCloudTokenCheckMessage(
  code: HetznerCloudTokenCheckErrorCode,
  strayKeyName: string | null = null,
): string {
  switch (code) {
    case "token_read_only":
      return "This token is read-only. Generate a Read & Write token in the same project and paste it here.";
    case "token_project_mismatch":
      return "This token is for a different Hetzner project. It can't see the servers or keys Hivra created here. Generate a Read & Write token in the same project and paste it here.";
    case "write_check_blocked":
      return "Hetzner refused Hivra's test SSH key because this project has reached its SSH key limit. Delete an unused SSH key in Hetzner Console, then try again.";
    case "write_check_unconfirmed":
      return strayKeyName
        ? `Hetzner didn't confirm the test SSH key. If Security → SSH keys lists ${strayKeyName}, delete it, then try again.`
        : "Hetzner didn't confirm the test SSH key. Try again in a minute.";
  }
}

export function hetznerStrayWriteCheckKeyMessage(strayKeyName: string): string {
  return `Hivra couldn't remove its test SSH key ${strayKeyName}. Delete it in Hetzner Console → Security → SSH keys. It isn't attached to any server.`;
}

export const HetznerCloudTokenReplaceRequestSchema = z
  .object({
    apiToken: HetznerCloudConnectionCreateSchema.shape.credentials.shape.apiToken,
  })
  .strict();
export type HetznerCloudTokenReplaceRequest = z.infer<typeof HetznerCloudTokenReplaceRequestSchema>;

export const HetznerCloudConnectResultSchema = z
  .object({
    connection: InfrastructureConnectionDtoSchema.refine(
      (connection) => connection.provider === "hetzner-cloud",
    ),
    inventory: z.array(HetznerCloudServerInventoryDtoSchema),
    writeCheck: HetznerCloudWriteCheckSchema,
  })
  .strict();

/**
 * How Replace token knew the new token reaches the same project.
 * - confirmed: it can see a server or generated SSH key Hivra created here, or
 *   a server the saved list saw (Hetzner ids are unique across projects).
 * - unconfirmed: Hivra holds nothing here and the new token can't see any
 *   server Hivra saw before, so there was nothing to compare. Nothing Hivra
 *   created can be stranded, so the token is saved and the user is told.
 */
export const HetznerCloudTokenProjectCheckSchema = z.enum(["confirmed", "unconfirmed"]);
export type HetznerCloudTokenProjectCheck = z.infer<typeof HetznerCloudTokenProjectCheckSchema>;

export const HetznerCloudTokenReplaceResultSchema = z
  .object({
    connection: HetznerCloudConnectResultSchema.shape.connection,
    /** Null when the token was saved but the server list couldn't be saved or
     * read back; the caller syncs instead of showing an empty project. */
    inventory: z.array(HetznerCloudServerInventoryDtoSchema).nullable(),
    writeCheck: HetznerCloudWriteCheckSchema,
    projectCheck: HetznerCloudTokenProjectCheckSchema,
  })
  .strict();
export type HetznerCloudTokenReplaceResult = z.infer<typeof HetznerCloudTokenReplaceResultSchema>;

/** Why a Replace token didn't finish, beyond the token checks above. */
export const HETZNER_CLOUD_TOKEN_REPLACE_ERROR_CODES = [
  "token_in_use",
  "server_request_in_progress",
  "replaced_unconfirmed",
] as const;
export type HetznerCloudTokenReplaceErrorCode =
  (typeof HETZNER_CLOUD_TOKEN_REPLACE_ERROR_CODES)[number];

export function hetznerCloudTokenReplaceMessage(code: HetznerCloudTokenReplaceErrorCode): string {
  switch (code) {
    case "token_in_use":
      return "A server removal or setup step is using this project's token right now. Nothing was replaced; try again when it finishes.";
    case "server_request_in_progress":
      return "Hivra is creating a server in this project right now. Nothing was replaced; try again in 2 minutes, once it finishes.";
    case "replaced_unconfirmed":
      // The swap already happened. Never say "nothing was replaced" here.
      return "Hivra saved your new token but couldn't confirm it's the one this project uses now. It may have changed again straight after. Use Sync servers to check it.";
  }
}

/** One line for the page once a token is replaced. */
export function hetznerCloudTokenReplacedNotice(name: string, projectCheck: HetznerCloudTokenProjectCheck): string {
  return projectCheck === "confirmed"
    ? `Token replaced for ${name}. Its servers and setup carried over.`
    : `Token replaced for ${name}. Hivra hadn't created anything in this project and can't see any server it saw before, so it couldn't confirm this is the same project. The list now shows the servers this token can see.`;
}

/**
 * The account-wide in-app Hetzner server slot, from the same predicate as the
 * database's one-capacity unique index. Observation only: the claim itself
 * stays authoritative at purchase time.
 */
export const HetznerCloudCapacitySlotDtoSchema = z
  .object({
    held: z.boolean(),
    serverName: z.string().trim().min(1).max(128).nullable(),
    connectionId: z.string().uuid().nullable(),
    status: z.enum(["creating", "ambiguous", "created_off", "cleaning", "provider_rejected", "quoted", "cleanup_abandoned"]).nullable(),
  })
  .strict()
  .refine((slot) => slot.held || (slot.serverName === null && slot.connectionId === null && slot.status === null));
export type HetznerCloudCapacitySlotDto = z.infer<typeof HetznerCloudCapacitySlotDtoSchema>;

/** Why Create is unavailable while the account's one server slot is used. */
export function hetznerCapacitySlotReason(slot: HetznerCloudCapacitySlotDto | null): string {
  const server = slot?.serverName ? `${slot.serverName} is using it` : "A server Hivra created is using it";
  return `Right now Hivra can create one Hetzner server per account. ${server}. Remove it with Remove created server on its project to create another.`;
}
