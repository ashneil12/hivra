import { isIP } from "node:net";
import { z } from "zod";
import type { RemoteDesktopAgentRow } from "@/lib/remote-computers/guest-installation";
import { ATTACHED_CODEX_STAGER_SHA256 } from "./attachment-staging-receipt";
import { ATTACHMENT_GUEST_WORKER_SHA256, parseAttachmentGuestResult,
  type ExpectedAttachmentGuestResult } from "./attachment-guest-result";

const Id = z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Authority = z.object({ id: Id, user_id: z.string().min(1), type: z.literal("linux-desktop"),
  computer_profile: z.literal("ubuntu-desktop"), computer_substrate: z.literal("proxmox-kvm"),
  deployment_mode: z.enum(["hivra-managed", "self-managed"]), proxmox_host: z.string().nullable(),
  infrastructure_connection_id: Id.nullable(), deployment_target_id: Id.nullable(),
  infrastructure_connection_revision: z.number().int().nonnegative().nullable(),
  infrastructure_binding_token_hash: z.string().length(64).regex(/^[0-9a-f]{64}$/),
  infrastructure_binding_token_enforced: z.literal(true), vmid: z.number().int().min(100).max(999999999),
  ip: z.string().refine(value => isIP(value) === 4), chat_url: z.string().nullable(),
  managed_provisioner_channel: z.enum(["default", "canary"]),
}).strict();
const Snapshot = z.object({ version: z.literal(1), operationId: Id, ownerId: z.string().min(1), computerId: Id,
  generation: z.string().refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value).toString() === value
    && BigInt(value) >= 2n && BigInt(value) <= 9223372036854775807n),
  authorityCommandId: Id, phase: z.enum(["claimed", "dispatched"]), guestAuthority: Authority,
  desiredState: z.enum(["running", "deleted"]),
  installation: z.object({ installationId: Id, bindingId: Id, architecture: z.enum(["x86_64", "aarch64"]),
    installerSha256: z.literal(ATTACHED_CODEX_STAGER_SHA256) }).strict().nullable(),
  observation: z.object({ bootId: Id, workerSha256: z.literal(ATTACHMENT_GUEST_WORKER_SHA256) }).strict().nullable(),
  dispatchId: Id.nullable(), staged: z.unknown().refine(value => value !== undefined),
}).strict();
export type AttachmentExecutionSnapshot = z.infer<typeof Snapshot>;

/** Validate a private consistent DB result, never browser input or a dispatch
 * token. Parsed values are cloned so async work cannot be retargeted by callers.
 */
export function parseAttachmentExecutionSnapshot(value: unknown, ownerId: string, operationId: string): AttachmentExecutionSnapshot | null {
  const parsed = Snapshot.safeParse(value);
  if (!parsed.success) return null;
  const result = parsed.data;
  if (result.ownerId !== ownerId || result.operationId !== operationId || result.guestAuthority.user_id !== ownerId
    || (result.observation !== null && result.installation === null)
    || (result.phase === "claimed" && (result.dispatchId !== null || result.staged !== null))
    || (result.phase === "dispatched" && (!result.dispatchId || !result.installation || !result.observation))) return null;
  if (result.staged !== null) {
    const expected = attachmentExecutionExpectation(result);
    const staged = expected && parseAttachmentGuestResult(JSON.stringify(result.staged), expected);
    if (!staged) return null;
    result.staged = staged;
  }
  return result;
}

export function attachmentExecutionExpectation(
  snapshot: AttachmentExecutionSnapshot, dispatchId = snapshot.dispatchId,
): ExpectedAttachmentGuestResult | null {
  if (!snapshot.installation || !snapshot.observation || !dispatchId) return null;
  return { identity: { operationId: snapshot.operationId, dispatchId, computerId: snapshot.computerId,
    sourceId: snapshot.guestAuthority.id, installationId: snapshot.installation.installationId,
    bindingId: snapshot.installation.bindingId, architecture: snapshot.installation.architecture }, bootId: snapshot.observation.bootId };
}

export function attachmentExecutionAgent(snapshot: AttachmentExecutionSnapshot): RemoteDesktopAgentRow {
  return { ...snapshot.guestAuthority, status: "running", desired_state: snapshot.desiredState,
    operation_id: snapshot.operationId, operation_kind: "agent_attach" };
}
