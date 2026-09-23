// Browser-safe contracts for DigitalOcean Managed Agents sessions in Hivra.

import { z } from "zod";

import {
  DIGITALOCEAN_HARNESSES,
  DIGITALOCEAN_SANDBOX_SIZES,
  type DigitalOceanHarness,
  type DigitalOceanSandboxSize,
} from "@/lib/infrastructure/contracts";

const ModelKeySchema = z
  .string()
  .trim()
  .min(20, "The model API key is incomplete")
  .max(512, "The model API key is too long")
  .refine((value) => !/[\s\u0000-\u001f\u007f]/.test(value), { message: "The model API key cannot contain spaces" });

export const ManagedSessionModelSchema = z.discriminatedUnion("mode", [
  // The vendor key for the harness: Anthropic for Claude Code, OpenAI for Codex.
  z.object({ mode: z.literal("vendor"), apiKey: ModelKeySchema }).strict(),
  // DigitalOcean Serverless Inference, billed to the same DigitalOcean team.
  z.object({
    mode: z.literal("digitalocean-inference"),
    apiKey: ModelKeySchema,
    model: z.string().trim().regex(/^[A-Za-z0-9._:/-]{1,128}$/, "Enter a DigitalOcean model slug"),
  }).strict(),
]);

export const ManagedSessionLaunchSchema = z.object({
  launchRequestId: z.string().uuid(),
  connectionId: z.string().uuid(),
  targetId: z.string().uuid(),
  harness: z.enum(DIGITALOCEAN_HARNESSES),
  size: z.enum(DIGITALOCEAN_SANDBOX_SIZES),
  name: z.string().trim().min(1, "Name the agent").max(64, "Use 64 characters or fewer"),
  model: ManagedSessionModelSchema,
  firstTask: z.string().trim().max(8_000).optional().transform((value) => value || undefined),
}).strict();

export type ManagedSessionLaunchInput = z.infer<typeof ManagedSessionLaunchSchema>;

export const ManagedSessionInputSchema = z.object({
  text: z.string().trim().min(1, "Type a message").max(32_000, "That message is too long"),
}).strict();

export const ManagedSessionActionSchema = z.object({
  action: z.enum(["pause", "resume", "delete"]),
}).strict();

export const ManagedSessionApprovalSchema = z.object({
  outcome: z.enum(["approve", "reject"]),
}).strict();

export type ManagedSessionStatus = "provisioning" | "ready" | "paused" | "error" | "deleting" | "deleted";

export interface ManagedSessionDto {
  agentId: string;
  name: string;
  harness: DigitalOceanHarness;
  size: DigitalOceanSandboxSize;
  status: ManagedSessionStatus;
  /** DigitalOcean's own last observed status enum, shown for support. */
  providerStatus: string | null;
  pauseReason: string | null;
  sessionId: string | null;
  connectionId: string | null;
  error: string | null;
  createdAt: string;
}

export const DIGITALOCEAN_HARNESS_LABELS: Record<DigitalOceanHarness, { name: string; vendorKey: string | null }> = {
  "claude-code": { name: "Claude Code", vendorKey: "Anthropic API key" },
  codex: { name: "Codex", vendorKey: "OpenAI API key" },
  hermes: { name: "Hermes", vendorKey: null },
};

export function managedSessionPauseCopy(reason: string | null): string {
  if (reason === "idle") return "Paused after 15 minutes idle. Send a message to resume it.";
  if (reason === "low_balance") return "DigitalOcean paused this session because the Harness Runtime prepaid balance is low. Top it up in DigitalOcean, then resume.";
  if (reason === "manual") return "Paused. Compute billing is stopped; the workspace is kept.";
  return "Paused. Send a message or resume to continue.";
}
