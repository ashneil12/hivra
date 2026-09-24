import { z } from "zod";
import { HetznerCloudCapacityCreateRequestSchema } from "./contracts";

// Shared consent text only: no enrollment token or provider credentials.
export const FIRST_BOOT_PREPARATION_CONFIRMATION = "Prepare this computer for agent launch" as const;
export const PreparedCapacityCreateRequestSchema = HetznerCloudCapacityCreateRequestSchema.extend({
  preparationConfirmation: z.literal(FIRST_BOOT_PREPARATION_CONFIRMATION).optional(),
});
export const ProviderComputerSetupRequestSchema = z.object({
  orderId: z.string().uuid(),
  expectedConnectionRevision: z.number().int().positive().safe(),
}).strict();
export const ProviderComputerSetupViewSchema = z.object({
  orderId: z.string().uuid(), connectionId: z.string().uuid(), connectionRevision: z.number().int().positive().safe(),
  serverName: z.string().min(1).max(128), providerServerId: z.string().regex(/^[1-9][0-9]{0,15}$/).nullable(),
  stage: z.enum(["not_requested", "waiting_for_capacity", "awaiting_setup", "busy", "firewall_requested",
    "waiting_for_firewall", "firewall_outcome_unknown", "power_requested", "power_outcome_unknown", "waiting_for_power",
    "waiting_for_identity", "identity_enrolled", "waiting_for_provider", "environment_prepared", "expired", "stopped", "retired"]),
  targetId: z.string().uuid().nullable(),
  observedAt: z.string().datetime({ offset: true }).nullable(),
  launchReady: z.boolean(),
  /** When this server's setup must be finished by. Present only while the
   * server has not yet connected back; the server decides expiry. For a
   * "since_start" server it is null until Start setup has powered it on. */
  enrollmentExpiresAt: z.string().datetime({ offset: true }).nullable(),
  /** Which rule the server was created with: 15 minutes from creation (older
   * servers) or 15 minutes from Start setup. Null when setup was not requested. */
  enrollmentWindow: z.enum(["since_creation", "since_start"]).nullable(),
}).strict().refine(value => !value.launchReady || (value.stage === "environment_prepared" && value.targetId !== null && value.observedAt !== null));
export type ProviderComputerSetupView = z.infer<typeof ProviderComputerSetupViewSchema>;

/**
 * Hivra's own record that it sent a server request through this connection,
 * for every order that may have created a server (not only the ones with a
 * setup view). The card labels an inventory server "Created by Hivra" from
 * this, and says "Not created by Hivra" only after this list has loaded.
 */
export const HETZNER_CREATED_SERVER_STATUSES = [
  "creating", "ambiguous", "created_off", "provider_rejected", "cleaning", "cleanup_abandoned",
] as const;
export const HetznerCloudCreatedServerSchema = z.object({
  orderId: z.string().uuid(),
  serverName: z.string().min(1).max(128),
  /** Null until Hetzner confirmed a server id; then only an id match counts. */
  providerServerId: z.string().regex(/^[1-9][0-9]{0,15}$/).nullable(),
  status: z.enum(HETZNER_CREATED_SERVER_STATUSES),
}).strict();
export type HetznerCloudCreatedServer = z.infer<typeof HetznerCloudCreatedServerSchema>;
export const HETZNER_CREATED_SERVERS_MAX = 100;

export const ProviderComputerSetupEvidenceSchema = z.object({
  computers: z.array(ProviderComputerSetupViewSchema).max(20),
  createdServers: z.array(HetznerCloudCreatedServerSchema).max(HETZNER_CREATED_SERVERS_MAX),
}).strict();
export type ProviderComputerSetupEvidence = z.infer<typeof ProviderComputerSetupEvidenceSchema>;

/** Which Hivra order, if any, created this inventory server. An order with a
 * confirmed server id matches only that id; one still being confirmed matches
 * its own Hivra-generated name. Scoped to one connection by the caller. */
export function hetznerCreatedServerFor(
  createdServers: readonly HetznerCloudCreatedServer[],
  server: { providerResourceId: string; name: string },
): HetznerCloudCreatedServer | null {
  return createdServers.find((order) => order.providerServerId
    ? order.providerServerId === server.providerResourceId
    : order.serverName === server.name) ?? null;
}
export type ProviderComputerSetupRequest = z.infer<typeof ProviderComputerSetupRequestSchema>;
export type PreparedCapacityCreateRequest = z.infer<typeof PreparedCapacityCreateRequestSchema>;

export const PROVIDER_SETUP_STAGE_LABELS: Record<ProviderComputerSetupView["stage"], string> = {
  not_requested: "Created without automatic setup", waiting_for_capacity: "Waiting for server creation",
  awaiting_setup: "Ready to begin setup", busy: "Another setup step is finishing",
  firewall_requested: "Firewall requested", waiting_for_firewall: "Waiting for the firewall",
  firewall_outcome_unknown: "Firewall result needs inspection", power_requested: "Starting the computer",
  power_outcome_unknown: "Power-on result needs inspection", waiting_for_power: "Waiting for startup",
  waiting_for_identity: "Waiting for the computer to connect", identity_enrolled: "Connection verified",
  waiting_for_provider: "Waiting for the provider", environment_prepared: "Environment prepared",
  expired: "Setup window expired", stopped: "Setup stopped", retired: "Computer retired",
};

export const PROVIDER_SETUP_TERMINAL_STAGES = new Set<ProviderComputerSetupView["stage"]>([
  "not_requested", "expired", "stopped", "retired", "firewall_outcome_unknown", "power_outcome_unknown",
]);

export function isProviderComputerSetupTerminal(view: ProviderComputerSetupView) {
  return PROVIDER_SETUP_TERMINAL_STAGES.has(view.stage) || (view.stage === "environment_prepared" && view.launchReady);
}
