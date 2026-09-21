import { z } from "zod";
import { parseAttachmentStagingReceipt, type AttachmentStagingReceipt } from "./attachment-staging-receipt";

export const ATTACHMENT_GUEST_WORKER_SHA256 = "2a0aee3e5e3fc0d4403d41a93dbece648648c8a84ab4349a71d7fe87243121ab";

const Id = z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Identity = z.object({
  operationId: Id, dispatchId: Id, installationId: Id, bindingId: Id,
  computerId: Id, sourceId: Id, architecture: z.enum(["x86_64", "aarch64"]),
}).strict();
const Expected = z.object({ identity: Identity, bootId: Id }).strict();
const Envelope = z.object({
  version: z.literal(1), identity: Identity, bootId: Id,
  phase: z.literal("staged"), receipt: z.unknown(),
}).strict();

type AttachmentGuestIdentity = z.infer<typeof Identity>;
export type ExpectedAttachmentGuestResult = z.infer<typeof Expected>;
export type AttachmentGuestResult = Omit<z.infer<typeof Envelope>, "receipt"> & {
  receipt: AttachmentStagingReceipt;
};

export function snapshotAttachmentGuestExpectation(value: unknown): ExpectedAttachmentGuestResult | null {
  const parsed = Expected.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Expected values must come from the authorized durable dispatch and a fresh
 * bound guest observation, never from this output. This verifies correspondence,
 * not transport authenticity, current process release or runtime readiness.
 * In particular, accepting `staged` does not authorize releasing the DB lease.
 */
export function parseAttachmentGuestResult(stdout: string, expected: ExpectedAttachmentGuestResult): AttachmentGuestResult | null {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > 16384) return null;
  const checkedExpected = Expected.safeParse(expected);
  if (!checkedExpected.success) return null;
  try {
    const parsed = Envelope.safeParse(JSON.parse(stdout));
    if (!parsed.success) return null;
    const result = parsed.data;
    if (result.bootId !== checkedExpected.data.bootId
      || Object.entries(checkedExpected.data.identity).some(([key, value]) => result.identity[key as keyof AttachmentGuestIdentity] !== value)) return null;
    const { operationId, installationId, architecture } = checkedExpected.data.identity;
    const receipt = parseAttachmentStagingReceipt(JSON.stringify(result.receipt), { operationId, installationId, architecture });
    return receipt ? { ...result, receipt } : null;
  } catch { return null; }
}
