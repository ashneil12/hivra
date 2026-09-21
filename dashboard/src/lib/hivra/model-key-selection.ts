import { z } from "zod";

/** A provider/model selection, not infrastructure credentials or a recipient.
 * Shared by launch admission and durable settings delivery so a request cannot
 * pass a weaker launch check and fail only after a computer has been allocated. */
export const VENICE_DEFAULT_MODEL = "deepseek-v4-pro";
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
