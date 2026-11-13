import { z } from "zod";

/** A provider/model selection, not infrastructure credentials or a recipient.
 * Shared by launch admission and durable settings delivery so a request cannot
 * pass a weaker launch check and fail only after a computer has been allocated. */
export const VENICE_DEFAULT_MODEL = "deepseek-v4-1-flash";
const Model = z.string().trim().regex(/^[A-Za-z0-9._:\/\[\]-]{1,64}$|^$/).optional()
  .transform(value => value || VENICE_DEFAULT_MODEL);

export const ModelKeySelectionSchema = z.discriminatedUnion("mode", [
  z.object({
    provider: z.literal("venice"), mode: z.literal("byok"),
    apiKey: z.string().trim().regex(/^[\x21-\x7e]{8,256}$/), model: Model,
    walletType: z.undefined().optional(),
  }).strict(),
  z.object({
    provider: z.literal("venice"), mode: z.literal("managed"), model: Model,
    walletType: z.enum(["card", "hermesos"]).default("hermesos"),
    apiKey: z.undefined().optional(),
  }).strict(),
]).nullable();

/** Model Claude Code uses on Hivra credits when the launch names none. */
export const MANAGED_CLAUDE_CODE_DEFAULT_MODEL = "claude-sonnet-4-6";

/** Model DeepSeek Harness runs on, on Hivra credits or the owner's Venice key. */
export const DEEPSEEK_HARNESS_DEFAULT_MODEL = "deepseek-v4-1-flash";
/** The model a Hermes computer starts on (Hermes itself lets the owner change it). */
export const HERMES_DEFAULT_MODEL = "deepseek-v4-1-flash";
