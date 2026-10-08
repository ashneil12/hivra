import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalEd25519HostKey } from "./ssh-host-key";

/** Servers created before 2026-09-24. Their guest and Hivra both enforce 15
 * minutes from creation; Hivra keeps that rule for them unchanged. */
export const FIRST_BOOT_LEGACY_RECIPE_VERSION = "2026.08.27.1" as const;
/** Every server Hivra creates now. The setup window opens only when Hivra
 * powers the server on at Start setup, and the guest measures its 15 minutes
 * from its own first boot. */
export const FIRST_BOOT_RECIPE_VERSION = "2026.09.24.1" as const;
export const FIRST_BOOT_RECIPE_VERSIONS = [FIRST_BOOT_LEGACY_RECIPE_VERSION, FIRST_BOOT_RECIPE_VERSION] as const;
export type FirstBootRecipeVersion = (typeof FIRST_BOOT_RECIPE_VERSIONS)[number];
/** Staging to server request. For the legacy recipe this is also the whole
 * enrollment window; for the current recipe it only bounds delivery. */
export const FIRST_BOOT_ENROLLMENT_TTL_MS = 15 * 60_000;
/** How long setup may take once Hivra powers the server on. */
export const FIRST_BOOT_SETUP_WINDOW_MS = 15 * 60_000;
/** Extra server-side acceptance for the time Hetzner takes to boot the server;
 * the guest's own 15 minutes start at its boot, after Hivra's power-on. */
export const FIRST_BOOT_ARMED_SLACK_MS = 2 * 60_000;
export const FIRST_BOOT_ARMED_WINDOW_MS = FIRST_BOOT_SETUP_WINDOW_MS + FIRST_BOOT_ARMED_SLACK_MS;
export const FIRST_BOOT_ENROLLMENT_BODY_LIMIT = 2_048;

/** True for recipes whose window opens at Start setup, not at creation. */
export function firstBootWindowOpensAtStart(recipeVersion: FirstBootRecipeVersion): boolean {
  return recipeVersion === FIRST_BOOT_RECIPE_VERSION;
}
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
  recipeVersion: z.enum(FIRST_BOOT_RECIPE_VERSIONS),
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
  /** When Hivra powered this server on for setup (current recipe only).
   * Recorded by the database in the same step as that power-on. */
  armedAt: string | null;
  armedExpiresAt: string | null;
};

export class FirstBootEnrollmentError extends Error {
  constructor(public readonly code:
    "invalid_binding" | "invalid_proof" | "expired" | "not_armed" | "not_active" | "identity_changed") {
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
  try {
    return canonicalEd25519HostKey(raw);
  } catch {
    return reject("invalid_proof");
  }
}

function checkedChallenge(input: { challenge: unknown; currentBinding: FirstBootBinding; token: string }): FirstBootChallenge {
  const challenge = ChallengeSchema.safeParse(input.challenge);
  const current = BindingSchema.safeParse(input.currentBinding);
  if (!challenge.success || !current.success
    || typeof input.token !== "string" || !TOKEN.test(input.token)) reject("invalid_proof");
  const c = challenge.data;
  if (JSON.stringify(bindingTuple(c.binding)) !== JSON.stringify(bindingTuple(current.data))) reject("invalid_proof");
  if (Date.parse(c.expiresAt) - Date.parse(c.issuedAt) !== FIRST_BOOT_ENROLLMENT_TTL_MS) reject("expired");
  return c;
}

function assertVerifier(c: FirstBootChallenge, token: string) {
  if (!timingSafeEqual(digestProof(c, token), Buffer.from(c.verifierSha256, "hex"))) reject("invalid_proof");
}

/** Checks only the scoped bootstrap secret inside its delivery window (staging
 * to the server request). No consumption, identity or provider readiness is
 * implied; those remain separate authority checks. Enrollment itself is
 * checked against firstBootEnrollmentWindow instead.
 */
export function verifyFirstBootChallengeSecret(input: {
  challenge: unknown; currentBinding: FirstBootBinding; token: string; now?: Date;
}): FirstBootChallenge {
  const c = checkedChallenge(input);
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(now) || now < Date.parse(c.issuedAt) || now >= Date.parse(c.expiresAt)) reject("expired");
  assertVerifier(c, input.token);
  return c;
}

/** The interval in which Hivra accepts this challenge's proof. The legacy
 * recipe keeps its 15 minutes from creation. The current recipe has no window
 * at all until Hivra records powering this server on for setup, which opens
 * exactly one; null means "not armed", never "no limit".
 */
export function firstBootEnrollmentWindow(record: {
  challenge: FirstBootChallenge; armedAt: string | null; armedExpiresAt: string | null;
}): { opensAt: number; closesAt: number } | null {
  const { challenge: c, armedAt, armedExpiresAt } = record;
  const issued = Date.parse(c.issuedAt);
  if (!firstBootWindowOpensAtStart(c.binding.recipeVersion)) {
    if (armedAt !== null || armedExpiresAt !== null) reject("invalid_proof");
    return { opensAt: issued, closesAt: Date.parse(c.expiresAt) };
  }
  if (armedAt === null && armedExpiresAt === null) return null;
  if (!DATE.safeParse(armedAt).success || !DATE.safeParse(armedExpiresAt).success) reject("invalid_proof");
  const opensAt = Date.parse(armedAt!), closesAt = Date.parse(armedExpiresAt!);
  if (closesAt - opensAt !== FIRST_BOOT_ARMED_WINDOW_MS || opensAt < issued) reject("invalid_proof");
  return { opensAt, closesAt };
}

/** When enrollment authority ends, or null while a current-recipe challenge
 * waits for Start setup (it cannot enroll at all until then). */
export function firstBootEnrollmentDeadline(record: {
  challenge: FirstBootChallenge; armedAt: string | null; armedExpiresAt: string | null;
}): number | null {
  return firstBootEnrollmentWindow(record)?.closesAt ?? null;
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
  const c = checkedChallenge({ challenge: input.record?.challenge,
    currentBinding: input.currentBinding, token: input.token });
  // Never accept a proof for a challenge Hivra has not armed by powering this
  // server on for setup; the database repeats this decision at consumption.
  const window = firstBootEnrollmentWindow({ challenge: c,
    armedAt: input.record.armedAt ?? null, armedExpiresAt: input.record.armedExpiresAt ?? null });
  if (!window) reject("not_armed");
  const now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(now) || now < window.opensAt || now >= window.closesAt) reject("expired");
  assertVerifier(c, input.token);
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
