import { z } from "zod";
import { HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION } from "./contracts";

export const HETZNER_CLEANUP_CONFIRMATION = "Delete server and its original IPs" as const;
export const HETZNER_FIRST_BOOT_CLEANUP_CONFIRMATION = "Delete this setup computer, its data and all original resources" as const;
export const HetznerCleanupAbsenceSchema = z.object({
  server: z.boolean(), ipv4: z.boolean(), ipv6: z.boolean(), sshKey: z.boolean(),
  firewall: z.boolean().optional(),
}).strict();
export const HetznerCleanupStateSchema = z.object({
  idempotencyKey: z.string().uuid(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  absence: HetznerCleanupAbsenceSchema,
  error: z.enum(["resource_changed", "resource_busy", "provider_unavailable", "connection_changed"]).nullable(),
  startedAt: z.string().datetime({ offset: true }),
  observedAt: z.string().datetime({ offset: true }).nullable(),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
  abandonedAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();
export const HetznerCleanupRequestSchema = z.object({
  orderId: z.string().uuid(), idempotencyKey: z.string().uuid(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  serverName: z.string().regex(/^hivra-[0-9a-f]{20}$/),
  confirmation: z.enum([HETZNER_CLEANUP_CONFIRMATION, HETZNER_FIRST_BOOT_CLEANUP_CONFIRMATION]),
}).strict();
export type HetznerCleanupState = z.infer<typeof HetznerCleanupStateSchema>;
export type HetznerCleanupRequest = z.infer<typeof HetznerCleanupRequestSchema>;
export type HetznerCleanupAbsence = z.infer<typeof HetznerCleanupAbsenceSchema>;
export const HetznerCleanupAbandonRequestSchema = z.object({
  orderId:z.string().uuid(),idempotencyKey:z.string().uuid(),
  fingerprint:z.string().regex(/^[0-9a-f]{64}$/),
  confirmation:z.literal(HETZNER_CLOUD_FORCE_FORGET_CONFIRMATION),
}).strict();
export type HetznerCleanupAbandonRequest = z.infer<typeof HetznerCleanupAbandonRequestSchema>;
