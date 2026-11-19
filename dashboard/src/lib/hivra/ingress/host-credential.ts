// The host credential: how a host's wake proxy proves to Hivra which host it
// is, for wake-report and wake-request. Pure parts (derivation, signing,
// verification) take their database reads as functions, so they test without
// a database; the database-backed versions are at the bottom.
//
// The credential is the hex HMAC-SHA256, keyed by HIVRA_INGRESS_SECRET, of "hivra-ingress-host-v1" NUL
// hostId NUL generation. Hivra stores no credential, only the generation
// it currently honours (proxmox_hosts.ingress_credential_generation, 0 = none
// issued). The host keeps the credential in a root-only file, written over SSH
// stdin by the wake proxy install step, never in argv or a log. Moving the
// generation on revokes it at once.
//
// A request is signed, never sent with the credential itself:
//   signature = HMAC-SHA256(hex-decoded credential, the lines
//     "hivra-ingress-host-request-v1", path, hostId, generation, timestamp,
//     nonce, sha256(body) hex, joined by "\n"), hex
// in the headers x-hivra-host, x-hivra-generation, x-hivra-timestamp (epoch
// seconds), x-hivra-nonce and x-hivra-signature. A timestamp more than 60 s
// away is refused, and a nonce is accepted once (hivra_ingress_host_nonces).
// provisioner/hivra-wake-proxy.py signs the same way.
//
// HIVRA_INGRESS_HOST_CREDENTIAL off: no credential is issued and both routes
// answer 404 as if they did not exist.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { ingressHostCredentialEnabled } from "@/lib/hivra/ingress/config";
import { resolveIngressSecret } from "@/lib/hivra/ingress/route-file";

type Env = Record<string, string | undefined>;

/** Where the host keeps its credential (root only, 0600). */
export const HOST_CREDENTIAL_PATH = "/etc/hivra/ingress/host-credential.json";
export const HOST_CREDENTIAL_VERSION = 1;
export const HOST_REQUEST_MAX_SKEW_S = 60;
export const HOST_REQUEST_MAX_BODY_BYTES = 4096;
export const WAKE_REPORT_PATH = "/api/hivra/ingress/wake-report";
export const WAKE_REQUEST_PATH = "/api/hivra/ingress/wake-request";

export const HOST_HEADERS = {
  host: "x-hivra-host",
  generation: "x-hivra-generation",
  timestamp: "x-hivra-timestamp",
  nonce: "x-hivra-nonce",
  signature: "x-hivra-signature",
} as const;

const MIN_SECRET_LENGTH = 32;
const MAX_GENERATION = 1_000_000_000;
const HOST_ID = /^[a-z][a-z0-9_]{0,62}$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DIGITS = /^[0-9]{1,12}$/;

export function isHostCredentialHostId(value: unknown): value is string {
  return typeof value === "string" && HOST_ID.test(value);
}

function validGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_GENERATION;
}

/** The host's credential for one generation: 64 hex characters. */
export function deriveHostCredential(input: { secret: string; hostId: string; generation: number }): string {
  if (typeof input.secret !== "string" || input.secret.length < MIN_SECRET_LENGTH) throw new Error("Ingress secret is too short.");
  if (!isHostCredentialHostId(input.hostId)) throw new Error("Invalid host id.");
  if (!validGeneration(input.generation)) throw new Error("Invalid generation.");
  const message = ["hivra-ingress-host-v1", input.hostId, String(input.generation)].join("\u0000");
  return createHmac("sha256", input.secret).update(message, "utf8").digest("hex");
}

export interface HostRequestParts {
  path: string;
  hostId: string;
  generation: number;
  timestamp: number;
  nonce: string;
  body: string | Buffer;
}

function bodySha256(body: string | Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

/** The signature a host sends for one request. */
export function signHostRequest(credential: string, parts: HostRequestParts): string {
  if (!HEX64.test(credential)) throw new Error("Invalid host credential.");
  const message = [
    "hivra-ingress-host-request-v1",
    parts.path,
    parts.hostId,
    String(parts.generation),
    String(parts.timestamp),
    parts.nonce,
    bodySha256(parts.body),
  ].join("\n");
  return createHmac("sha256", Buffer.from(credential, "hex")).update(message, "utf8").digest("hex");
}

/** What the install step writes to HOST_CREDENTIAL_PATH. */
export interface HostCredentialDocument {
  version: typeof HOST_CREDENTIAL_VERSION;
  host_id: string;
  generation: number;
  credential: string;
  /** Hivra's own public origin, where the proxy sends its calls. */
  origin: string;
}

export function buildHostCredentialDocument(input: {
  secret: string;
  hostId: string;
  generation: number;
  origin: string;
}): HostCredentialDocument {
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(input.origin)) throw new Error("Invalid Hivra origin.");
  return {
    version: HOST_CREDENTIAL_VERSION,
    host_id: input.hostId,
    generation: input.generation,
    credential: deriveHostCredential(input),
    origin: input.origin,
  };
}

/** The host row fields verification needs. */
export interface HostCredentialRow {
  id: string;
  ingress_credential_generation?: unknown;
}

export type NonceClaim = "ok" | "replayed" | "error";

export interface HostRequestDeps {
  env?: Env;
  nowMs?: () => number;
  loadHost: (hostId: string) => Promise<HostCredentialRow | null>;
  claimNonce: (hostId: string, nonce: string, expiresAtMs: number) => Promise<NonceClaim>;
}

export type HostRequestVerdict =
  | { ok: true; hostId: string; generation: number }
  | { ok: false; status: 401 | 404 | 409 | 503; reason: string };

/** Reads a header from a Headers object or a plain record (case-insensitive). */
type HeaderSource = { get(name: string): string | null } | Record<string, string | undefined>;

function header(headers: HeaderSource, name: string): string {
  const value = typeof (headers as { get?: unknown }).get === "function"
    ? (headers as { get(name: string): string | null }).get(name)
    : (headers as Record<string, string | undefined>)[name];
  return typeof value === "string" ? value.trim() : "";
}

function sameHex(a: string, b: string): boolean {
  if (!HEX64.test(a) || !HEX64.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** The stored generation, or 0 when the column is missing or odd (no credential honoured). */
export function storedHostCredentialGeneration(row: HostCredentialRow | null | undefined): number {
  const value = row?.ingress_credential_generation;
  const number = typeof value === "string" && /^[0-9]{1,10}$/.test(value) ? Number(value) : value;
  return validGeneration(number) ? (number as number) : 0;
}

/**
 * Checks one signed host request. In order: the flag (off is 404), the secret,
 * the headers, the clock, the host's current generation, the signature, and
 * last the nonce, so a forged request never writes to the database.
 */
export async function verifyHostRequest(
  input: { path: string; headers: HeaderSource; body: string | Buffer },
  deps: HostRequestDeps,
): Promise<HostRequestVerdict> {
  const env = deps.env ?? process.env;
  if (!ingressHostCredentialEnabled(env)) return { ok: false, status: 404, reason: "disabled" };
  const secret = resolveIngressSecret(env);
  if (!secret) return { ok: false, status: 503, reason: "not_configured" };

  const hostId = header(input.headers, HOST_HEADERS.host);
  const generationText = header(input.headers, HOST_HEADERS.generation);
  const timestampText = header(input.headers, HOST_HEADERS.timestamp);
  const nonce = header(input.headers, HOST_HEADERS.nonce);
  const signature = header(input.headers, HOST_HEADERS.signature).toLowerCase();
  if (!isHostCredentialHostId(hostId) || !DIGITS.test(generationText) || !DIGITS.test(timestampText)
    || !NONCE.test(nonce) || !HEX64.test(signature)) {
    return { ok: false, status: 401, reason: "malformed" };
  }
  const generation = Number(generationText);
  const timestamp = Number(timestampText);
  if (!validGeneration(generation)) return { ok: false, status: 401, reason: "malformed" };
  const nowMs = (deps.nowMs ?? Date.now)();
  if (Math.abs(nowMs / 1000 - timestamp) > HOST_REQUEST_MAX_SKEW_S) return { ok: false, status: 401, reason: "stale" };

  let row: HostCredentialRow | null;
  try {
    row = await deps.loadHost(hostId);
  } catch {
    return { ok: false, status: 503, reason: "host_unreadable" };
  }
  const current = storedHostCredentialGeneration(row);
  // An unknown host and a revoked generation look the same from outside.
  if (!row || current === 0 || current !== generation) return { ok: false, status: 401, reason: "revoked" };

  const expected = signHostRequest(deriveHostCredential({ secret, hostId, generation }), {
    path: input.path, hostId, generation, timestamp, nonce, body: input.body,
  });
  if (!sameHex(expected, signature)) return { ok: false, status: 401, reason: "bad_signature" };

  const claim = await deps.claimNonce(hostId, nonce, (timestamp + 2 * HOST_REQUEST_MAX_SKEW_S) * 1000).catch(() => "error" as const);
  if (claim === "replayed") return { ok: false, status: 409, reason: "replayed" };
  if (claim !== "ok") return { ok: false, status: 503, reason: "nonce_unavailable" };
  return { ok: true, hostId, generation };
}
