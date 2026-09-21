import { z } from "zod";
import { ATTACHED_CODEX_ARCHIVES } from "./attachment-staging-receipt";
import { snapshotAttachmentGuestExpectation, type ExpectedAttachmentGuestResult } from "./attachment-guest-result";

const Result = z.object({ version: z.literal(1), state: z.literal("available"),
  architecture: z.enum(["x86_64", "aarch64"]), bootId: z.string(),
  archiveSha256: z.string(), size: z.number().int(), path: z.string(),
}).strict();
export type AttachmentArtifactResult = z.infer<typeof Result>;
const SIZES = { x86_64: 99_479_490, aarch64: 91_899_352 } as const;

/** Cache acquisition only, never installation, readiness or dispatch authority. */
export function parseAttachmentArtifactResult(stdout: string, input: ExpectedAttachmentGuestResult): AttachmentArtifactResult | null {
  const expected = snapshotAttachmentGuestExpectation(input);
  if (!expected || typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > 4096) return null;
  try {
    const parsed = Result.safeParse(JSON.parse(stdout));
    if (!parsed.success) return null;
    const result = parsed.data;
    const architecture = expected.identity.architecture;
    const digest = ATTACHED_CODEX_ARCHIVES[architecture];
    return result.architecture === architecture && result.bootId === expected.bootId
      && result.archiveSha256 === digest && result.size === SIZES[architecture]
      && result.path === `/var/lib/hivra/attachment-artifacts/${digest}.tar.gz` ? result : null;
  } catch { return null; }
}
