import { z } from "zod";

export const HIVRA_GVISOR_ADAPTER_VERSION = "2026.09.15.1" as const;
export const HIVRA_GVISOR_IMAGE = "python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285" as const;
export const HIVRA_GVISOR_DRIVER = "gvisor-runsc" as const;
export const HIVRA_GVISOR_ISOLATION_CLASS = "application-kernel" as const;
export const HIVRA_GVISOR_BUNDLE_URL = "https://github.com/google/gvisor/releases/download/release-20260907.0/gvisor-x86_64.tar.bz2" as const;
export const HIVRA_GVISOR_BUNDLE_SHA256 = "81416511897ab8abd4e723d66823c5b0461a2ee3311cfa70d152404ef9b860cf" as const;
export const HIVRA_GVISOR_PREFLIGHT_TTL_MS = 15 * 60_000;

/** The named stages of provisioner/gvisor/prepare-gvisor-host.sh, in the order
 * it runs them. A failed run reports the stage it stopped in; every earlier
 * stage finished. Keep in step with the script's prepare_stage values. */
export const HIVRA_GVISOR_PREPARE_STAGES = [
  "host-eligibility",
  "prerequisites",
  "bundle-download",
  "bundle-checksum",
  "bundle-validation",
  "installed-adapter-check",
  "installed-identity-check",
  "asset-installation",
  "runtime-registration",
  "sidecar-validation",
  "image-pull",
  "sandbox-smoke-test",
] as const;
export type HivraGvisorPrepareStage = (typeof HIVRA_GVISOR_PREPARE_STAGES)[number];

export function isHivraGvisorPrepareStage(value: unknown): value is HivraGvisorPrepareStage {
  return typeof value === "string" && (HIVRA_GVISOR_PREPARE_STAGES as readonly string[]).includes(value);
}

export function isGvisorPreflightFresh(lastPreflightAt: string | null, now = Date.now()): boolean {
  if (!lastPreflightAt) return false;
  const observedAt = Date.parse(lastPreflightAt);
  return Number.isFinite(observedAt) && observedAt <= now && now - observedAt <= HIVRA_GVISOR_PREFLIGHT_TTL_MS;
}

export function isGvisorPendingBoundObservation(input: {
  operation: string | undefined;
  connectionStatus: string;
  connectionRevision: number;
  pendingFromRevision: number | null;
  bindingRevision: number | null;
  targetRevision: number;
}): boolean {
  return (input.operation === "status" || input.operation === "delete")
    && input.bindingRevision !== null
    && input.connectionStatus === "pending"
    && input.pendingFromRevision === input.bindingRevision
    && input.connectionRevision === input.bindingRevision + 1
    && input.targetRevision === input.bindingRevision;
}

const UuidSchema = z.string().uuid();
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const GvisorComputerRequestSchema = z.object({
  operation: z.enum(["create", "status", "start", "stop", "resize", "exec", "delete"]),
  ownerHash: DigestSchema,
  computerId: UuidSchema,
  sandboxId: UuidSchema,
  cpu: z.number().min(0.5).max(32).optional(),
  memoryMb: z.number().int().min(512).max(131072).optional(),
  hostMemoryReserveMb: z.number().int().min(512).max(1048576).optional(),
  argv: z.array(z.string().min(1).max(4096)).min(1).max(32).optional(),
}).strict().superRefine((value, context) => {
  if ((value.operation === "create" || value.operation === "resize")
    && (value.cpu === undefined || value.memoryMb === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Resource limits are required" });
  }
  if ((value.operation === "create" || value.operation === "start" || value.operation === "resize")
    && value.hostMemoryReserveMb === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Host memory reserve is required" });
  }
  if (value.operation === "exec" && value.argv === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Command arguments are required" });
  }
});

export const GvisorComputerReceiptSchema = z.object({
  version: z.literal(1),
  adapterVersion: z.literal(HIVRA_GVISOR_ADAPTER_VERSION).optional(),
  computerId: UuidSchema,
  sandboxId: UuidSchema,
  state: z.enum(["running", "stopped", "absent"]),
  isolationDriver: z.literal(HIVRA_GVISOR_DRIVER).optional(),
  isolationClass: z.literal(HIVRA_GVISOR_ISOLATION_CLASS).optional(),
  outerHostBoundary: z.literal("operator-owned-host").optional(),
  runtime: z.literal("runsc").optional(),
  cpu: z.number().min(0.5).max(32).optional(),
  memoryMb: z.number().int().min(512).max(131072).optional(),
  image: z.literal(HIVRA_GVISOR_IMAGE).optional(),
  workspace: z.string().min(1).max(160).optional(),
  network: z.string().min(1).max(160).optional(),
  publicPorts: z.array(z.never()).optional(),
  reservationEqualsMaximum: z.literal(true).optional(),
}).strict().superRefine((receipt, context) => {
  if (receipt.state !== "absent" && [receipt.adapterVersion, receipt.isolationDriver,
    receipt.isolationClass, receipt.outerHostBoundary, receipt.runtime, receipt.cpu,
    receipt.memoryMb, receipt.image, receipt.workspace, receipt.network,
    receipt.publicPorts, receipt.reservationEqualsMaximum].some(value => value === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Running computer evidence is incomplete" });
  }
});

export const GvisorExecReceiptSchema = z.object({
  exitCode: z.number().int().min(0).max(255),
  stdout: z.string().max(65536),
  stderr: z.string().max(65536),
}).strict();

export type GvisorComputerRequest = z.infer<typeof GvisorComputerRequestSchema>;
export type GvisorComputerReceipt = z.infer<typeof GvisorComputerReceiptSchema>;

export function gvisorIsolationDisclosure() {
  return {
    title: "Lightweight Linux sandbox",
    summary: "Runs one Linux terminal and Python application workspace with gVisor on your connected host.",
    boundary: "gVisor provides an application-kernel boundary. Your server operator still controls the host kernel.",
    limitations: ["Linux terminal workloads only", "No graphical desktop or Windows", "No public ports", "Reserved resources equal maximum limits"],
  } as const;
}
