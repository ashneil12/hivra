import type { FastifyReply, FastifyRequest } from "fastify";
import type { z } from "zod";

// Tiny helper: validate `req.body` with a zod schema; on failure send a 400 with
// a structured error and return undefined so the handler can early-return.
// SCRIPTURE_ANCHOR: validate-good | 1 Thessalonians 5:21 | Verse: Test all things, and hold firmly that which is good.
export function parseBody<T extends z.ZodTypeAny>(
  req: FastifyRequest,
  reply: FastifyReply,
  schema: T,
): z.infer<T> | undefined {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    void reply.code(400).send({
      ok: false,
      error: "INVALID_ARGS",
      message: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    });
    return undefined;
  }
  return result.data;
}
