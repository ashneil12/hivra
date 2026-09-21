import { z } from "zod";

const Uuid = z.string().uuid();
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const ProviderId = z.string().regex(/^[1-9][0-9]{0,15}$/)
  .refine((value) => Number.isSafeInteger(Number(value)) && String(Number(value)) === value);
const ProviderTypeId = z.number().int().positive().safe();

/**
 * The creation quote remains immutable. This evidence is the append-only
 * successor shape proven by a terminal Hetzner change_type observation.
 * `previousShapeFingerprintSha256` chains the successor either to the original
 * creation quote fingerprint or to the preceding verified resize shape.
 */
export const HetznerCurrentServerShapeSchema = z.object({
  version: z.literal(1),
  provider: z.literal("hetzner-cloud"),
  capacityOrderId: Uuid,
  connectionId: Uuid,
  connectionRevision: z.number().int().positive().safe(),
  providerServerId: ProviderId,
  resizeOperationId: Uuid,
  resizeQuoteFingerprintSha256: Digest,
  previousShapeFingerprintSha256: Digest,
  serverType: z.object({
    id: ProviderTypeId,
    name: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/),
    architecture: z.enum(["x86", "arm"]),
    cores: z.number().int().positive().max(1_024),
    memoryGb: z.number().int().positive().max(65_536),
    advertisedDiskGb: z.number().int().positive().safe(),
    cpuType: z.enum(["shared", "dedicated"]),
  }).strict(),
  /** Actual retained primary disk, not the target plan's advertised disk. */
  primaryDiskGb: z.number().int().positive().safe(),
  observedAt: z.string().datetime({ offset: true }),
}).strict();

export type HetznerCurrentServerShape = z.infer<typeof HetznerCurrentServerShapeSchema>;

export function parseHetznerCurrentServerShapeEvidence(input: {
  shape: unknown;
  fingerprintSha256: unknown;
  capacityOrderId: string;
  connectionId: string;
  connectionRevision: number;
  providerServerId: string;
}): { shape: HetznerCurrentServerShape; fingerprintSha256: string } | null {
  if (input.shape == null && input.fingerprintSha256 == null) return null;
  const shape = HetznerCurrentServerShapeSchema.parse(input.shape);
  const fingerprintSha256 = Digest.parse(input.fingerprintSha256);
  if (
    shape.capacityOrderId !== input.capacityOrderId
    || shape.connectionId !== input.connectionId
    || shape.connectionRevision !== input.connectionRevision
    || shape.providerServerId !== input.providerServerId
  ) throw new Error("Hetzner current server shape binding changed");
  return { shape, fingerprintSha256 };
}
