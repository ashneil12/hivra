import { z } from "zod";

export const ApiKeySchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1, "Key name is required"),
  provider: z.string().min(1, "Provider is required"),
  key: z.string().min(1, "API Key is required").optional(), 
});
