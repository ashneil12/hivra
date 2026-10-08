import { createPublicKey, verify } from "node:crypto";

// An agent's identity key. The agent link generates an Ed25519 key pair on the
// agent computer and keeps the private half there. Hivra stores and verifies the
// public half only; no function in this module (or anywhere in the repository)
// accepts, derives or stores an agent's private key.
//
// Joining registers the public key with proof of possession: the link signs a
// message that names the organization, the principal and a one-time nonce the
// control plane issued. The nonce must be single-use and short-lived; issuing and
// consuming it belongs to the join flow (package B3), not to this verifier.

export const AGENT_KEY_PROOF_CONTEXT = "hivra-agent-key-proof:v1";
const RAW_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
// DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32 bytes follow.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export type AgentKeyProofFailure =
  | "malformed_public_key"
  | "malformed_signature"
  | "malformed_input"
  | "signature_invalid";

export interface AgentKeyProofInput {
  /** Raw Ed25519 public key, base64url, 43 characters. */
  publicKey: string;
  orgId: string;
  principalId: string;
  /** One-time value issued by the control plane for this join attempt. */
  nonce: string;
  /** Ed25519 signature over agentKeyProofMessage(), base64url. */
  signature: string;
}

/** The exact bytes the agent link signs. */
export function agentKeyProofMessage(input: Pick<AgentKeyProofInput, "orgId" | "principalId" | "nonce">): Buffer {
  return Buffer.from(
    [AGENT_KEY_PROOF_CONTEXT, input.orgId.toLowerCase(), input.principalId.toLowerCase(), input.nonce].join("\n"),
    "utf8"
  );
}

function decodeBase64Url(value: unknown, bytes: number): Buffer | null {
  if (typeof value !== "string" || !BASE64URL.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  // Reject anything that does not round-trip, so one key has one spelling.
  if (decoded.length !== bytes || decoded.toString("base64url") !== value) return null;
  return decoded;
}

/** True for a raw Ed25519 public key in the one accepted spelling. */
export function isAgentPublicKey(value: unknown): value is string {
  return decodeBase64Url(value, RAW_KEY_BYTES) !== null;
}

export function verifyAgentKeyProof(
  input: AgentKeyProofInput
): { ok: true } | { ok: false; reason: AgentKeyProofFailure } {
  if (
    !input ||
    typeof input.orgId !== "string" ||
    typeof input.principalId !== "string" ||
    typeof input.nonce !== "string" ||
    input.nonce.length < 16 ||
    input.nonce.length > 256 ||
    /[\n\r]/.test(input.nonce)
  ) {
    return { ok: false, reason: "malformed_input" };
  }
  const rawKey = decodeBase64Url(input.publicKey, RAW_KEY_BYTES);
  if (!rawKey) return { ok: false, reason: "malformed_public_key" };
  const signature = decodeBase64Url(input.signature, SIGNATURE_BYTES);
  if (!signature) return { ok: false, reason: "malformed_signature" };
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, rawKey]), format: "der", type: "spki" });
    return verify(null, agentKeyProofMessage(input), key, signature)
      ? { ok: true }
      : { ok: false, reason: "signature_invalid" };
  } catch {
    return { ok: false, reason: "signature_invalid" };
  }
}
