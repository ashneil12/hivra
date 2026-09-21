import { z } from "zod";

export const ATTACHED_CODEX_STAGER_SHA256 = "77d72e2e8346cc19ef74264e8458bbca8802772d1c668c3fdffa653c4273d375";
export const ATTACHED_CODEX_FETCHER_SHA256 = "252f4037e8bdc3ba4f3cfe68633031cb4abe1e2f1215ab72eda5510067b9b1b3";
export const ATTACHED_CODEX_ARCHIVES = {
  x86_64: "e24fb784c7d71140d67afb620f56e9137496cf7f6c9e19217fa3666dcf306278",
  aarch64: "14df6802e39a956de994e844b90d51d8254bcc8057b6e66f0f3e3b8f7e2da5b0",
} as const;
// Hashes of the sole executable member of each pinned archive, not guesses
// supplied by a guest or a claim that the reported bytes are currently running.
export const ATTACHED_CODEX_BINARIES = {
  x86_64: "73dc5888888f411c1f0fa7b81d866e721dcc86b527ce8e3b2cf4708661e823ba",
  aarch64: "2447e3fef519401ff6d6e90759ab1bf66082da48966fc6e4fe9a77108f9c20d8",
} as const;

const Id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Architecture = z.enum(["x86_64", "aarch64"]);
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
const UnixId = z.number().int().min(1).max(4294967294);
const Expected = z.object({ operationId: Id, installationId: Id, architecture: Architecture }).strict();
const StagingReceipt = z.object({
  version: z.literal(1), state: z.literal("staged"), operationId: Id, installationId: Id,
  runtimeId: z.literal("codex"), runtimeVersion: z.literal("0.149.1"), architecture: Architecture,
  archiveSha256: Digest, binarySha256: Digest, account: z.string(), uid: UnixId, gid: UnixId,
  home: z.string(), executable: z.string(),
}).strict();

export type AttachmentStagingReceipt = z.infer<typeof StagingReceipt>;
export type ExpectedAttachmentStaging = z.infer<typeof Expected>;

/** A validated staging record, NOT proof of transport authenticity, process
 * release, runtime readiness, model authentication or permission to unlock the
 * computer. The bound guest observer and durable command must supply those.
 */
export function parseAttachmentStagingReceipt(stdout: string, expected: ExpectedAttachmentStaging): AttachmentStagingReceipt | null {
  if (typeof stdout !== "string" || stdout.length > 8192 || !Expected.safeParse(expected).success) return null;
  try {
    const parsed = StagingReceipt.safeParse(JSON.parse(stdout));
    if (!parsed.success) return null;
    const receipt = parsed.data;
    if (receipt.operationId !== expected.operationId || receipt.installationId !== expected.installationId
      || receipt.architecture !== expected.architecture
      || receipt.archiveSha256 !== ATTACHED_CODEX_ARCHIVES[expected.architecture]
      || receipt.binarySha256 !== ATTACHED_CODEX_BINARIES[expected.architecture]
      || receipt.account !== `hva_${expected.installationId.replaceAll("-", "").slice(0, 24)}`
      || receipt.home !== `/var/lib/hivra/agent-homes/${expected.installationId}`
      || receipt.executable !== `/opt/hivra/agent-installations/${expected.installationId}/codex`) return null;
    return receipt;
  } catch { return null; }
}
