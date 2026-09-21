import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const FIRST_BOOT_RECIPE_VERSION = "2026.08.27.1" as const;
export const FIRST_BOOT_ENROLLMENT_TTL_MS = 15 * 60_000;
export const FIRST_BOOT_ENROLLMENT_BODY_LIMIT = 2_048;
const PURPOSE = "hivra/hetzner-first-boot/ssh-host-enrollment/v1";
// Canonical, non-nil UUIDs agree with the guest and the durable record keys.
const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const DIGEST = z.string().regex(/^[0-9a-f]{64}$/);
const TOKEN = /^hbe1_[A-Za-z0-9_-]{43}$/;
const DATE = z.string().datetime().refine(value => {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
});
const PROVIDER_ID = z.string().regex(/^[1-9][0-9]{0,15}$/).refine(
  value => Number.isSafeInteger(Number(value)),
);

const BindingSchema = z.object({
  userId: z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/),
  connectionId: UUID,
  connectionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  orderId: UUID,
  attemptId: UUID,
  quoteFingerprint: DIGEST,
  recipeVersion: z.literal(FIRST_BOOT_RECIPE_VERSION),
}).strict();

const ChallengeSchema = z.object({
  version: z.literal(1),
  binding: BindingSchema,
  issuedAt: DATE,
  expiresAt: DATE,
  verifierSha256: DIGEST,
}).strict();

export const FirstBootRegistrationSchema = z.object({
  version: z.literal(1),
  orderId: UUID,
  attemptId: UUID,
  providerServerId: PROVIDER_ID,
  hostPublicKey: z.string().min(1).max(256),
}).strict();

export type FirstBootBinding = z.infer<typeof BindingSchema>;
export type FirstBootChallenge = z.infer<typeof ChallengeSchema>;
export type FirstBootRegistration = z.infer<typeof FirstBootRegistrationSchema>;
export type FirstBootEnrollmentRecord = {
  challenge: FirstBootChallenge;
  phase: "awaiting_identity" | "enrolled" | "revoked" | "failed";
  enrolledHostPublicKey: string | null;
};

export class FirstBootEnrollmentError extends Error {
  constructor(public readonly code:
    "invalid_binding" | "invalid_proof" | "expired" | "not_active" | "identity_changed") {
    super("First-boot enrollment failed: " + code);
    this.name = "FirstBootEnrollmentError";
  }
}

function reject(code: FirstBootEnrollmentError["code"]): never {
  throw new FirstBootEnrollmentError(code);
}

function bindingTuple(binding: FirstBootBinding): unknown[] {
  return [
    binding.userId, binding.connectionId, binding.connectionRevision,
    binding.orderId, binding.attemptId, binding.quoteFingerprint, binding.recipeVersion,
  ];
}

function digestProof(challenge: Omit<FirstBootChallenge, "verifierSha256">, token: string) {
  return createHash("sha256").update(JSON.stringify([
    PURPOSE, challenge.version, ...bindingTuple(challenge.binding),
    challenge.issuedAt, challenge.expiresAt, token,
  ])).digest();
}

/** Server-side only. Persist the verifier in the private operation record.
 * If delivery must survive a create retry, seal the token separately using the
 * existing owner/purpose-bound secret store. Neither value belongs in a DTO.
 */
export function createFirstBootChallenge(binding: FirstBootBinding, now = new Date()): {
  token: string; challenge: FirstBootChallenge;
} {
  const parsed = BindingSchema.safeParse(binding);
  if (!parsed.success || !Number.isFinite(now.getTime())) reject("invalid_binding");
  const expires = now.getTime() + FIRST_BOOT_ENROLLMENT_TTL_MS;
  if (!Number.isFinite(new Date(expires).getTime())) reject("invalid_binding");
  const token = "hbe1_" + randomBytes(32).toString("base64url");
  const unsigned = {
    version: 1 as const, binding: parsed.data,
    issuedAt: now.toISOString(), expiresAt: new Date(expires).toISOString(),
  };
  if (!DATE.safeParse(unsigned.issuedAt).success || !DATE.safeParse(unsigned.expiresAt).success) {
    reject("invalid_binding");
  }
  return { token, challenge: {
    ...unsigned, verifierSha256: digestProof(unsigned, token).toString("hex"),
  } };
}

/** Strip the non-authoritative comment; validate exact SSH wire framing.
 * Possession of the matching private key is proved later by pinned SSH,
 * not by accepting this public-key string.
 */
export function canonicalFirstBootHostKey(raw: string): {
  publicKey: string; fingerprintSha256: string;
} {
  if (typeof raw !== "string" || raw.length > 256) reject("invalid_proof");
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]{68})(?: [\x21-\x7e]{1,128})?$/.exec(raw);
  if (!match) reject("invalid_proof");
  const blob = Buffer.from(match[1], "base64");
  const prefix = Buffer.from("0000000b7373682d6564323535313900000020", "hex");
  if (blob.length !== 51 || blob.toString("base64") !== match[1]
    || !blob.subarray(0, 19).equals(prefix)
    || blob.subarray(19).every(byte => byte === 0)) reject("invalid_proof");
  return {
    publicKey: "ssh-ed25519 " + match[1],
    fingerprintSha256: "SHA256:" + createHash("sha256").update(blob)
      .digest("base64").replace(/=+$/, ""),
  };
}

/** Checks only the scoped bootstrap secret. No consumption, identity or
 * provider readiness is implied; those remain separate authority checks.
 */
export function verifyFirstBootChallengeSecret(input: {
  challenge: unknown; currentBinding: FirstBootBinding; token: string; now?: Date;
}): FirstBootChallenge {
  const challenge = ChallengeSchema.safeParse(input.challenge);
  const current = BindingSchema.safeParse(input.currentBinding);
  if (!challenge.success || !current.success
    || typeof input.token !== "string" || !TOKEN.test(input.token)) reject("invalid_proof");
  const c = challenge.data;
  if (JSON.stringify(bindingTuple(c.binding)) !== JSON.stringify(bindingTuple(current.data))) reject("invalid_proof");
  const now = (input.now ?? new Date()).getTime();
  const issued = Date.parse(c.issuedAt);
  const expires = Date.parse(c.expiresAt);
  if (!Number.isFinite(now) || expires - issued !== FIRST_BOOT_ENROLLMENT_TTL_MS
    || now < issued || now >= expires) reject("expired");
  if (!timingSafeEqual(digestProof(c, input.token), Buffer.from(c.verifierSha256, "hex"))) {
    reject("invalid_proof");
  }
  return c;
}

/** Validate a candidate, NOT a successful enrollment or ready computer.
 *
 * The caller must supply fresh owner/connection/receipt authority, validate the
 * current provider resource, and atomically consume/pin under its database
 * lease. This function performs no writes and cannot make a target launchable.
 */
export function inspectFirstBootEnrollmentProof(input: {
  record: FirstBootEnrollmentRecord;
  currentBinding: FirstBootBinding;
  expectedProviderServerId: string;
  token: string;
  registration: unknown;
  now?: Date;
}): {
  kind: "candidate" | "acknowledgement_replay";
  registration: FirstBootRegistration;
  hostPublicKey: string;
  hostFingerprintSha256: string;
} {
  const c = verifyFirstBootChallengeSecret({ challenge: input.record?.challenge,
    currentBinding: input.currentBinding, token: input.token, now: input.now });
  const registration = FirstBootRegistrationSchema.safeParse(input.registration);
  if (!registration.success || !PROVIDER_ID.safeParse(input.expectedProviderServerId).success) reject("invalid_proof");
  const r = registration.data;
  if (r.orderId !== c.binding.orderId || r.attemptId !== c.binding.attemptId
    || r.providerServerId !== input.expectedProviderServerId) reject("invalid_proof");
  if (input.record.phase !== "awaiting_identity" && input.record.phase !== "enrolled") {
    reject("not_active");
  }
  const host = canonicalFirstBootHostKey(r.hostPublicKey);
  if (input.record.phase === "enrolled") {
    if (input.record.enrolledHostPublicKey !== host.publicKey) reject("identity_changed");
  } else if (input.record.enrolledHostPublicKey !== null) {
    reject("not_active");
  }
  return {
    kind: input.record.phase === "enrolled" ? "acknowledgement_replay" : "candidate",
    registration: { ...r, hostPublicKey: host.publicKey },
    hostPublicKey: host.publicKey,
    hostFingerprintSha256: host.fingerprintSha256,
  };
}
