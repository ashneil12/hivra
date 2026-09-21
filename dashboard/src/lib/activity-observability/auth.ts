import "server-only";

import crypto from "node:crypto";
import { z } from "zod";

const PREFIX = "hvra_otlp_v1";
const ClaimsSchema = z.object({
  v: z.literal(1),
  userId: z.string().min(1).max(256),
  resourceIds: z.array(z.string().uuid()).min(1).max(100),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
}).strict();

export type ActivityCollectorClaims = z.infer<typeof ClaimsSchema>;

function secret(): string | null {
  const value = process.env.ACTIVITY_COLLECTOR_SIGNING_SECRET?.trim();
  return value && value.length >= 32 ? value : null;
}

function sign(encodedClaims: string, key: string): string {
  return crypto.createHmac("sha256", key).update(`${PREFIX}.${encodedClaims}`, "utf8").digest("base64url");
}

export function mintActivityCollectorToken(
  claims: Omit<ActivityCollectorClaims, "v">,
  signingSecret = secret(),
): string {
  if (!signingSecret || signingSecret.length < 32) throw new Error("activity collector signing secret is not configured");
  const parsed = ClaimsSchema.parse({ v: 1, ...claims });
  if (parsed.exp <= parsed.iat) throw new Error("collector token expiry must follow issuance");
  const encoded = Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
  return `${PREFIX}.${encoded}.${sign(encoded, signingSecret)}`;
}

export function verifyActivityCollectorToken(
  authorization: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): ActivityCollectorClaims | null {
  const key = secret();
  const bearer = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (!key || !bearer || bearer.length > 8192) return null;
  const [prefix, encoded, receivedSignature, extra] = bearer.split(".");
  if (prefix !== PREFIX || !encoded || !receivedSignature || extra) return null;
  const expected = Buffer.from(sign(encoded, key), "utf8");
  const received = Buffer.from(receivedSignature, "utf8");
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
  try {
    const claims = ClaimsSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    if (claims.iat > nowSeconds + 60 || claims.exp <= nowSeconds) return null;
    return { ...claims, resourceIds: [...new Set(claims.resourceIds)] };
  } catch {
    return null;
  }
}

