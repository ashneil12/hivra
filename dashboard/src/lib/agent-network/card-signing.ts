import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

// Agent card signing: a key class of its own.
//
// Agent cards are signed by a Hivra key (JWS, EdDSA, over the RFC 8785 canonical
// form of the card) so a peer or a tool can verify a card against Hivra's
// published keys. That key is NOT ENCRYPTION_KEY and is never derived from it:
//   * ENCRYPTION_KEY seals stored secrets (symmetric, rotated by re-encrypting
//     rows). The card key signs short-lived public statements (asymmetric,
//     rotated by publishing a new public key and revoking the old).
//   * A leak of one must not become a leak of the other.
// The private key is deployment configuration (HIVRA_CARD_SIGNING_KEY, PKCS#8 DER,
// base64url) and is not stored in the database. The database holds the public
// keys and the revocation list (hivra_card_signing_keys). Hivra never holds an
// agent's key; this module signs cards, not messages.

export const CARD_SIGNING_KEY_ENV = "HIVRA_CARD_SIGNING_KEY";
export const CARD_SIGNING_KID_ENV = "HIVRA_CARD_SIGNING_KID";
export const CARD_JWS_TYPE = "hivra-agent-card+jws";
/** Cards are short-lived (B1 decision): at most one hour between iat and exp. */
export const MAX_CARD_LIFETIME_SECONDS = 3600;
const CLOCK_SKEW_SECONDS = 30;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const KID_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;

export interface CardKeyRecord {
  kid: string;
  /** Raw Ed25519 public key, base64url. */
  publicKey: string;
  status: "active" | "retired" | "revoked";
  retiredAt: Date | null;
  revokedAt: Date | null;
}

export interface CardSigner {
  kid: string;
  privateKey: KeyObject;
  /** Raw public key, base64url, to register in the registry. */
  publicKey: string;
}

export type CardVerificationFailure =
  | "malformed"
  | "bad_header"
  | "unknown_key"
  | "key_revoked"
  | "key_retired_before_issue"
  | "signature_invalid"
  | "not_canonical"
  | "bad_claims"
  | "not_yet_valid"
  | "expired"
  | "lifetime_too_long"
  | "tenant_mismatch"
  | "principal_mismatch";

export type CardVerification =
  | { ok: true; card: Record<string, unknown>; kid: string }
  | { ok: false; reason: CardVerificationFailure };

/** RFC 8785 canonical JSON for the value types a card uses. */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("cannot canonicalize a non-finite number");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.some(([, v]) => v === undefined)) throw new Error("cannot canonicalize undefined");
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
    }
    default:
      throw new Error(`cannot canonicalize a ${typeof value}`);
  }
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function rawPublicKey(privateKey: KeyObject): string {
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer;
  return spki.subarray(ED25519_SPKI_PREFIX.length).toString("base64url");
}

function publicKeyObject(raw: string): KeyObject | null {
  if (!BASE64URL.test(raw)) return null;
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== raw) return null;
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]), format: "der", type: "spki" });
}

/**
 * Loads the deployment's card signer from its own environment variables. It reads
 * HIVRA_CARD_SIGNING_KEY and HIVRA_CARD_SIGNING_KID and nothing else: not
 * ENCRYPTION_KEY, not ENCRYPTION_KEY_LEGACY. Returns null when unset or invalid, and
 * refuses a value that equals either encryption key, so the two classes cannot be
 * the same secret.
 */
export function loadCardSigner(env: Record<string, string | undefined> = process.env): CardSigner | null {
  const raw = env[CARD_SIGNING_KEY_ENV]?.trim();
  const kid = env[CARD_SIGNING_KID_ENV]?.trim();
  if (!raw || !kid || !KID_PATTERN.test(kid) || !BASE64URL.test(raw)) return null;
  for (const forbidden of [env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_LEGACY]) {
    if (forbidden && forbidden.trim() === raw) return null;
  }
  try {
    const privateKey = createPrivateKey({ key: Buffer.from(raw, "base64url"), format: "der", type: "pkcs8" });
    if (privateKey.asymmetricKeyType !== "ed25519") return null;
    return { kid, privateKey, publicKey: rawPublicKey(privateKey) };
  } catch {
    return null;
  }
}

export interface SignCardOptions {
  /** Seconds the card is valid for, 1 to MAX_CARD_LIFETIME_SECONDS. */
  lifetimeSeconds?: number;
  now?: Date;
}

/**
 * Signs a card. The claims iat, exp, iss, tenant and principal are set here; a card
 * body that already has them is rejected, so a caller cannot choose its own lifetime.
 */
export function signCard(
  signer: CardSigner,
  card: { tenant: string; principal: string } & Record<string, unknown>,
  options: SignCardOptions = {}
): string {
  const lifetime = options.lifetimeSeconds ?? MAX_CARD_LIFETIME_SECONDS;
  if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > MAX_CARD_LIFETIME_SECONDS) {
    throw new Error("card lifetime must be between 1 second and one hour");
  }
  for (const reserved of ["iat", "exp", "iss"]) {
    if (reserved in card) throw new Error(`card cannot set ${reserved}`);
  }
  const iat = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const payload = canonicalize({ ...card, iss: "hivra", iat, exp: iat + lifetime });
  const header = canonicalize({ alg: "EdDSA", kid: signer.kid, typ: CARD_JWS_TYPE });
  const signingInput = `${Buffer.from(header).toString("base64url")}.${Buffer.from(payload).toString("base64url")}`;
  const signature = sign(null, Buffer.from(signingInput, "ascii"), signer.privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

export interface VerifyCardOptions {
  now?: Date;
  /** When set, the card's tenant must be this organization id. */
  expectedTenant?: string;
  expectedPrincipal?: string;
}

function parseCanonical(segment: string): { value: Record<string, unknown>; canonical: boolean } | null {
  if (!BASE64URL.test(segment)) return null;
  const bytes = Buffer.from(segment, "base64url");
  if (bytes.toString("base64url") !== segment) return null;
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return { value, canonical: canonicalize(value) === bytes.toString("utf8") };
  } catch {
    return null;
  }
}

/**
 * Verifies a card against the key registry. A card fails when its key is unknown or
 * revoked, was retired before the card was issued, the signature or the canonical
 * form is wrong, or it is expired, not yet valid or longer-lived than allowed.
 * Revoking a key invalidates every card it signed, at once.
 */
export function verifyCard(token: string, registry: readonly CardKeyRecord[], options: VerifyCardOptions = {}): CardVerification {
  if (typeof token !== "string") return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  const header = parseCanonical(headerSegment);
  const payload = parseCanonical(payloadSegment);
  if (!header || !payload || !BASE64URL.test(signatureSegment)) return { ok: false, reason: "malformed" };
  if (!header.canonical || !payload.canonical) return { ok: false, reason: "not_canonical" };

  const h = header.value;
  if (h.alg !== "EdDSA" || h.typ !== CARD_JWS_TYPE || typeof h.kid !== "string" || Object.keys(h).length !== 3) {
    return { ok: false, reason: "bad_header" };
  }
  const key = registry.find((record) => record.kid === h.kid);
  if (!key) return { ok: false, reason: "unknown_key" };
  if (key.status === "revoked" || key.revokedAt) return { ok: false, reason: "key_revoked" };

  const publicKey = publicKeyObject(key.publicKey);
  const signature = Buffer.from(signatureSegment, "base64url");
  if (!publicKey || signature.length !== 64 || signature.toString("base64url") !== signatureSegment) {
    return { ok: false, reason: "signature_invalid" };
  }
  let valid = false;
  try {
    valid = verify(null, Buffer.from(`${headerSegment}.${payloadSegment}`, "ascii"), publicKey, signature);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "signature_invalid" };

  const card = payload.value;
  const { iat, exp } = card;
  if (
    card.iss !== "hivra" ||
    typeof card.tenant !== "string" ||
    typeof card.principal !== "string" ||
    typeof iat !== "number" ||
    typeof exp !== "number" ||
    !Number.isInteger(iat) ||
    !Number.isInteger(exp)
  ) {
    return { ok: false, reason: "bad_claims" };
  }
  if (exp - iat < 1 || exp - iat > MAX_CARD_LIFETIME_SECONDS) return { ok: false, reason: "lifetime_too_long" };
  if (key.status === "retired" && key.retiredAt && iat * 1000 >= key.retiredAt.getTime()) {
    return { ok: false, reason: "key_retired_before_issue" };
  }
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (iat > nowSeconds + CLOCK_SKEW_SECONDS) return { ok: false, reason: "not_yet_valid" };
  // No leeway on expiry: a card's short life is part of how a stolen one stops working.
  if (exp <= nowSeconds) return { ok: false, reason: "expired" };
  if (options.expectedTenant !== undefined && card.tenant.toLowerCase() !== options.expectedTenant.toLowerCase()) {
    return { ok: false, reason: "tenant_mismatch" };
  }
  if (options.expectedPrincipal !== undefined && card.principal.toLowerCase() !== options.expectedPrincipal.toLowerCase()) {
    return { ok: false, reason: "principal_mismatch" };
  }
  return { ok: true, card, kid: key.kid };
}
