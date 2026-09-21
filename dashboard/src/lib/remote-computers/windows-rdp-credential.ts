import "server-only";

import { randomBytes } from "node:crypto";
import { z } from "zod";

import { decryptSecret, encryptSecret } from "@/lib/crypto";

const PROTOCOL = "hivra-windows-rdp-credential-lease-v1";
const MAX_TTL_MS = 5 * 60_000;
const MAX_CLOCK_SKEW_MS = 30_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const USERNAME = /^hivra-[0-9a-f]{14}$/;
const PASSWORD = /^(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])(?=.*!)[A-Za-z0-9_!-]{32,128}$/;

const Binding = z.object({
  userId: z.string().min(1).max(256),
  computerId: z.string().regex(UUID),
  sessionId: z.string().regex(UUID),
  activationId: z.string().regex(UUID),
  capabilityGeneration: z.string().regex(UUID),
  guestBootIdentitySha256: z.string().regex(SHA256),
  streamingMode: z.enum(["hq", "qhd", "uhd", "performance"]),
}).strict();

const Lease = z.object({
  protocol: z.literal(PROTOCOL),
  binding: Binding,
  username: z.string().regex(USERNAME),
  password: z.string().regex(PASSWORD),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export type WindowsRdpCredentialBinding = z.infer<typeof Binding>;
export type WindowsRdpCredential = { username: string; password: string };

type Dependencies = {
  now: () => number;
  randomBytes: (size: number) => Buffer;
  encrypt: (plaintext: string) => string;
  decrypt: (ciphertext: string) => string;
};

const defaults: Dependencies = {
  now: Date.now,
  randomBytes,
  encrypt: encryptSecret,
  decrypt: decryptSecret,
};

function exactBinding(left: WindowsRdpCredentialBinding, right: WindowsRdpCredentialBinding): boolean {
  return left.userId === right.userId
    && left.computerId === right.computerId
    && left.sessionId === right.sessionId
    && left.activationId === right.activationId
    && left.capabilityGeneration === right.capabilityGeneration
    && left.guestBootIdentitySha256 === right.guestBootIdentitySha256
    && left.streamingMode === right.streamingMode;
}

function usernameForSession(sessionId: string): string {
  return `hivra-${sessionId.replaceAll("-", "").slice(0, 14)}`;
}

/**
 * Create a short-lived credential for one already-authorized Windows session.
 * The plaintext result is for immediate guest delivery only; the browser must
 * receive neither it nor the encrypted envelope.
 *
 * This envelope is authenticated and binding-checked, but not one-use by
 * itself. A future durable activation claim must provide replay prevention.
 */
export function createWindowsRdpCredentialLease(params: {
  binding: WindowsRdpCredentialBinding;
  expiresAt: string;
}, injected: Partial<Dependencies> = {}): {
  encryptedLease: string;
  credential: WindowsRdpCredential;
  expiresAt: string;
} | null {
  const dependencies = { ...defaults, ...injected };
  const binding = Binding.safeParse(params.binding);
  const now = dependencies.now();
  const expiresAtMs = Date.parse(params.expiresAt);
  if (!binding.success || !Number.isFinite(now) || !Number.isFinite(expiresAtMs)
    || expiresAtMs <= now || expiresAtMs > now + MAX_TTL_MS) return null;

  try {
    const entropy = dependencies.randomBytes(30);
    if (!Buffer.isBuffer(entropy) || entropy.length !== 30) return null;
    const credential = {
      username: usernameForSession(binding.data.sessionId),
      password: `Aa1!${entropy.toString("base64url")}`,
    };
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(expiresAtMs).toISOString();
    const lease = Lease.parse({
      protocol: PROTOCOL,
      binding: binding.data,
      ...credential,
      issuedAt,
      expiresAt,
    });
    const encryptedLease = dependencies.encrypt(JSON.stringify(lease));
    if (typeof encryptedLease !== "string" || encryptedLease.length < 1 || encryptedLease.length > 16_384) {
      return null;
    }
    return { encryptedLease, credential, expiresAt };
  } catch {
    return null;
  }
}

/** Open an unexpired lease only for the exact expected session and guest boot. */
export function openWindowsRdpCredentialLease(params: {
  encryptedLease: string;
  expectedBinding: WindowsRdpCredentialBinding;
}, injected: Partial<Dependencies> = {}): (WindowsRdpCredential & { expiresAt: string }) | null {
  const dependencies = { ...defaults, ...injected };
  const expected = Binding.safeParse(params.expectedBinding);
  const now = dependencies.now();
  if (!expected.success || !Number.isFinite(now) || typeof params.encryptedLease !== "string"
    || params.encryptedLease.length < 1 || params.encryptedLease.length > 16_384) return null;

  try {
    const parsed = Lease.parse(JSON.parse(dependencies.decrypt(params.encryptedLease)));
    const issuedAtMs = Date.parse(parsed.issuedAt);
    const expiresAtMs = Date.parse(parsed.expiresAt);
    if (!exactBinding(parsed.binding, expected.data)
      || parsed.username !== usernameForSession(parsed.binding.sessionId)
      || issuedAtMs > now + MAX_CLOCK_SKEW_MS
      || expiresAtMs <= now
      || expiresAtMs <= issuedAtMs
      || expiresAtMs > issuedAtMs + MAX_TTL_MS) return null;
    return { username: parsed.username, password: parsed.password, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}
