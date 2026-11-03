import { z } from "zod";

export const PREPARED_OMARCHY_REFRESH_STAGE = "prepared_omarchy_refresh";
export const PREPARED_OMARCHY_REFRESH_MARKER = "HIVRA_PREPARED_OMARCHY_REFRESH ";
const UUID = z.string().uuid();
export const PreparedDesktopSlotSchema = z.object({
  host: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  node: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  vmid: z.number().int().min(100).max(999999999),
  ip: z.string().ip({ version: "v4" }),
  claim: UUID,
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional(),
}).strict();
export const OmarchyRefreshReleaseSchema = z.object({
  release: z.string().regex(/^v4\.[0-9]{1,4}\.[0-9]{1,4}$/),
  releaseCommit: z.string().regex(/^[a-f0-9]{40}$/),
  isoUrl: z.string(), isoFilename: z.string(), isoSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(value => value.isoFilename === `omarchy-${value.release.slice(1)}.iso`
  && value.isoUrl === `https://iso.omarchy.org/${value.isoFilename}`);
export type OmarchyRefreshRelease = z.infer<typeof OmarchyRefreshReleaseSchema>;
export const OmarchyRefreshRequestSchema = z.object({
  version: z.literal(1), operationId: UUID, computerId: UUID,
  bindingTag: z.string().regex(/^hivra-bind-[a-f0-9]{32}$/),
  slot: PreparedDesktopSlotSchema, release: OmarchyRefreshReleaseSchema,
}).strict();
export type OmarchyRefreshRequest = z.infer<typeof OmarchyRefreshRequestSchema>;
const Base = z.object({
  version: z.literal(1), operationId: UUID, computerId: UUID,
  vmid: z.number().int().min(100).max(999999999),
  bindingTag: z.string().regex(/^hivra-bind-[a-f0-9]{32}$/),
  requestedRelease: OmarchyRefreshReleaseSchema,
  guestUpdaterStopped: z.literal(true),
});
const Observed = z.object({
  packageVersion: z.string().regex(/^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}-[0-9]{1,4}(?:\.[0-9]{1,4})?$/),
  osVersion: z.string().regex(/^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/),
  kernelRelease: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,95}$/),
  selectedKernel: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,95}$/),
  bootIdBefore: UUID, bootIdAfter: UUID, desktopReady: z.literal(true), migrationsComplete: z.literal(true),
  observedAt: z.string().datetime(),
}).strict().refine(value => value.packageVersion.split("-")[0] === value.osVersion
  && value.kernelRelease === value.selectedKernel && value.bootIdBefore !== value.bootIdAfter);
export const OmarchyRefreshReceiptSchema = z.discriminatedUnion("state", [
  Base.extend({ state: z.literal("complete"), observed: Observed }).strict(),
  Base.extend({ state: z.literal("failed"), errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/) }).strict(),
  Base.extend({ state: z.literal("cancelled"), bindingReleased: z.literal(true) }).strict(),
]).refine(value => value.state !== "complete" || value.observed.osVersion === value.requestedRelease.release.slice(1));
export type OmarchyRefreshReceipt = z.infer<typeof OmarchyRefreshReceiptSchema>;
export type OmarchyRefreshHostStatus = {
  state: "queued" | "running" | "unconfirmed"; phase?: string;
} | { state: "terminal"; receipt: OmarchyRefreshReceipt };

export function preparedOmarchyRefreshPending(row: Record<string, unknown>): boolean {
  return row.computer_profile === "omarchy" && row.operation_kind === "provision"
    && typeof row.operation_payload === "object" && row.operation_payload !== null
    && (row.operation_payload as Record<string, unknown>).stage === PREPARED_OMARCHY_REFRESH_STAGE;
}

export function readOmarchyRefreshHostStatus(stdout: string): OmarchyRefreshHostStatus {
  const lines = stdout.split(/\r?\n/).filter(line => line.startsWith(PREPARED_OMARCHY_REFRESH_MARKER));
  if (lines.length !== 1) throw new Error("prepared_refresh_unconfirmed");
  const value = JSON.parse(lines[0].slice(PREPARED_OMARCHY_REFRESH_MARKER.length));
  if (value?.state === "terminal") return { state: "terminal", receipt: OmarchyRefreshReceiptSchema.parse(value.receipt) };
  if (!["queued", "running", "unconfirmed"].includes(value?.state)
    || (value.phase !== undefined && (typeof value.phase !== "string" || !/^[a-z_]{1,32}$/.test(value.phase)))) {
    throw new Error("prepared_refresh_unconfirmed");
  }
  return { state: value.state, ...(value.phase ? { phase: value.phase } : {}) };
}
