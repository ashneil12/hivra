import { z } from "zod";
import { parseAttachmentActivationRecord } from "./attachment-activation-store";
import { parseAttachmentExecutionSnapshot, type AttachmentExecutionSnapshot } from "./attachment-execution-snapshot";

const Id = z.string().length(36).regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const Pid = z.number().int().min(2).max(2147483647);
const Started = z.object({ version: z.literal(1), request: z.unknown(), phase: z.literal("service_started"),
  unitIdentity: z.tuple([z.number().int().nonnegative().safe(), z.number().int().nonnegative().safe()]), mainPid: Pid,
}).strict();
const Observation = z.object({ version: z.literal(1),
  state: z.enum(["process_running", "service_inactive", "activation_unresolved"]),
  journalPhase: z.enum(["preparing", "start_requested", "service_started", "start_failed"]),
  operationId: Id, activationId: Id, installationId: Id, bootId: Id,
  serviceDefinitionSha256: z.string().length(64).regex(/^[0-9a-f]{64}$/), mainPid: Pid.optional(),
}).strict().superRefine((value, ctx) => {
  const observable = value.journalPhase === "start_requested" || value.journalPhase === "service_started";
  if ((value.state === "process_running" && (!observable || value.mainPid === undefined))
    || (value.state !== "process_running" && value.mainPid !== undefined)
    || (value.state === "service_inactive" && !observable)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Inconsistent activation observation." });
  }
});
export type AttachmentActivationObservation = z.infer<typeof Observation>;
export type AttachmentActivationStarted = z.infer<typeof Started>;

/** Output parsing is not native readiness, dispatch permission or lease release. */
export function parseAttachmentActivationResult(
  action: "start" | "observe", stdout: string, record: unknown, input: AttachmentExecutionSnapshot,
): AttachmentActivationStarted | AttachmentActivationObservation | null {
  try {
    if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > 32768) return null;
    const snapshot = parseAttachmentExecutionSnapshot(input, input?.ownerId, input?.operationId);
    const expected = snapshot && parseAttachmentActivationRecord(record, snapshot);
    if (!snapshot || !expected) return null;
    const value = JSON.parse(stdout);
    if (action === "start") {
      const parsed = Started.safeParse(value);
      if (!parsed.success) return null;
      const request = parseAttachmentActivationRecord(parsed.data.request, snapshot);
      return request && JSON.stringify(request) === JSON.stringify(expected) ? { ...parsed.data, request } : null;
    }
    if (action !== "observe") return null;
    const parsed = Observation.safeParse(value);
    if (!parsed.success) return null;
    const result = parsed.data;
    return result.operationId === expected.operationId && result.activationId === expected.activationId
      && result.installationId === expected.staged.identity.installationId && result.bootId === expected.staged.bootId
      && result.serviceDefinitionSha256 === expected.serviceDefinitionSha256 ? result : null;
  } catch { return null; }
}
