import { z } from "zod";

export const HETZNER_EXTERNAL_CLEANUP_CONFIRMATION = "Verify resources I removed in Hetzner" as const;
export const HetznerExternalCleanupRequestSchema = z.object({
  orderId: z.string().uuid(),
  idempotencyKey: z.string().uuid(),
  serverName: z.string().regex(/^hivra-[0-9a-f]{20}$/),
  confirmation: z.literal(HETZNER_EXTERNAL_CLEANUP_CONFIRMATION),
}).strict();
export type HetznerExternalCleanupRequest = z.infer<typeof HetznerExternalCleanupRequestSchema>;
export const HetznerExternalCleanupResultSchema = z.object({
  resolutionId: z.string().uuid(), resolvedAt: z.string().datetime({ offset: true }),
}).strict();
