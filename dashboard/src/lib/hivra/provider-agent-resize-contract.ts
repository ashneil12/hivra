import { z } from "zod";

export const PROVIDER_RESIZE_BILLING_CONFIRMATION =
  "Resize this server and accept the new Hetzner billing" as const;

export const PROVIDER_RESIZE_DOWNTIME_NOTICE =
  "The computer must stay powered off while Hetzner changes its server type. Hivra leaves it stopped after the resize so you can review the result before starting it again." as const;

const ProviderResizeMoneySchema = z.object({
  currency: z.string().trim().length(3),
  hourlyGross: z.string().regex(/^\d+(?:\.\d+)?$/),
  monthlyGross: z.string().regex(/^\d+(?:\.\d+)?$/),
}).strict();

const ProviderResizeSizeSchema = z.object({
  serverTypeId: z.number().int().positive().safe(),
  serverType: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/),
  architecture: z.enum(["x86", "arm"]),
  cores: z.number().int().positive().max(1_024),
  memoryGb: z.number().int().positive().max(65_536),
  /** Advertised plan disk. The operation always keeps the existing disk. */
  advertisedDiskGb: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  cpuType: z.enum(["shared", "dedicated"]).nullable(),
  price: ProviderResizeMoneySchema,
}).strict();

const ProviderResizeOfferSchema = ProviderResizeSizeSchema.extend({
  description: z.string().trim().min(1).max(128).nullable(),
}).strict();

export const ProviderResizeCatalogSchema = z.object({
  capability: z.literal("hetzner-change-type-v1"),
  agentId: z.string().uuid(),
  providerServerId: z.string().regex(/^[1-9][0-9]{0,15}$/),
  location: z.string().trim().min(1).max(64),
  providerPowerState: z.enum([
    "running", "off", "initializing", "starting", "stopping", "deleting",
    "rebuilding", "migrating", "unknown",
  ]),
  providerLocked: z.boolean(),
  requiresPowerOff: z.literal(true),
  upgradeDisk: z.literal(false),
  existingDiskGb: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  current: ProviderResizeSizeSchema,
  offers: z.array(ProviderResizeOfferSchema).max(128),
  observedAt: z.string().datetime({ offset: true }),
  downtimeNotice: z.literal(PROVIDER_RESIZE_DOWNTIME_NOTICE),
}).strict();

export const ProviderResizeQuoteSchema = z.object({
  operationId: z.string().uuid(),
  quoteFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  agentId: z.string().uuid(),
  providerServerId: z.string().regex(/^[1-9][0-9]{0,15}$/),
  location: z.string().trim().min(1).max(64),
  source: ProviderResizeSizeSchema,
  target: ProviderResizeSizeSchema,
  existingDiskGb: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  upgradeDisk: z.literal(false),
  observedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  downtimeNotice: z.literal(PROVIDER_RESIZE_DOWNTIME_NOTICE),
  billingConfirmation: z.literal(PROVIDER_RESIZE_BILLING_CONFIRMATION),
}).strict().superRefine((quote, context) => {
  if (quote.source.serverType === quote.target.serverType) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["target", "serverType"], message: "Choose a different server type" });
  }
  if (quote.source.architecture !== quote.target.architecture) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["target", "architecture"], message: "Architecture must be preserved" });
  }
  if (quote.target.advertisedDiskGb < quote.existingDiskGb) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["target", "advertisedDiskGb"], message: "Target plan cannot hold the existing disk" });
  }
  if (Date.parse(quote.expiresAt) <= Date.parse(quote.observedAt)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["expiresAt"], message: "Quote expiry must follow observation" });
  }
});

export const ProviderResizeStageSchema = z.enum([
  "quoted",
  "dispatch_pending",
  "request_uncertain",
  "action_pending",
  "provider_pending",
  "manual_attention",
  "succeeded",
  "failed",
  "cancelled",
  "removed",
]);
export type ProviderResizeStage = z.infer<typeof ProviderResizeStageSchema>;

export const ProviderResizeOperationViewSchema = z.object({
  operationId: z.string().uuid(),
  stage: ProviderResizeStageSchema,
  quote: ProviderResizeQuoteSchema,
  providerActionId: z.number().int().positive().safe().nullable(),
  providerActionStatus: z.enum(["running", "success", "error"]).nullable(),
  observedProviderState: z.string().trim().min(1).max(64).nullable(),
  observedServerType: z.string().trim().min(1).max(64).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  shutdownRequired: z.boolean().optional(),
  shutdownReadinessWaiting: z.boolean().optional(),
  message: z.string().trim().min(1).max(500),
}).strict();

const ProviderResizeQuoteRequestSchema = z.object({
  mode: z.literal("quote"),
  operationId: z.string().uuid(),
  targetServerType: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9.-]*$/),
}).strict();

const ProviderResizeApplyRequestSchema = z.object({
  mode: z.literal("apply"),
  operationId: z.string().uuid(),
  quoteFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  billingConfirmation: z.literal(PROVIDER_RESIZE_BILLING_CONFIRMATION),
}).strict();

export const ProviderResizeMutationRequestSchema = z.discriminatedUnion("mode", [
  ProviderResizeQuoteRequestSchema,
  ProviderResizeApplyRequestSchema,
]);

export type ProviderResizeCatalog = z.infer<typeof ProviderResizeCatalogSchema>;
export type ProviderResizeQuote = z.infer<typeof ProviderResizeQuoteSchema>;
export type ProviderResizeSize = z.infer<typeof ProviderResizeSizeSchema>;
export type ProviderResizeOperationView = z.infer<typeof ProviderResizeOperationViewSchema>;

const providerResizeMessages: Record<ProviderResizeStage, string> = {
  quoted: "Review the fresh Hetzner price and downtime before confirming this resize.",
  dispatch_pending: "The resize is reserved for this computer. No provider request has been repeated.",
  request_uncertain: "The resize request may have reached Hetzner, but its action receipt was not confirmed. Hivra will only reconcile the original server; it will not send the request again.",
  action_pending: "Hetzner accepted the original change-type request. Waiting for its action and the server's actual type to agree.",
  provider_pending: "The provider action finished, but the server's actual type has not matched the reviewed target yet.",
  manual_attention: "The provider state no longer matches the reviewed resize. The original computer remains bound and locked for inspection in Hetzner Console.",
  succeeded: "Hetzner confirms the reviewed server type. The existing disk and computer binding were retained, and the computer remains stopped.",
  failed: "Hetzner rejected the resize. The existing server type, disk, computer binding, and cleanup authority were retained.",
  cancelled: "No resize request was sent. Refresh the computer and request a new review.",
  removed: "The original server is verified absent. Resize evidence is retained; remaining provider resources still need normal deletion cleanup.",
};

export function providerResizeMessage(stage: ProviderResizeStage): string {
  return providerResizeMessages[ProviderResizeStageSchema.parse(stage)];
}
