import { createHash } from "node:crypto";

/** The 19-byte SSH wire prefix of every Ed25519 public key blob:
 * string "ssh-ed25519", then the length of a 32-byte key. */
const ED25519_BLOB_PREFIX = Buffer.from("0000000b7373682d6564323535313900000020", "hex");

export class SshHostKeyError extends Error {
  constructor() {
    super("Invalid Ed25519 SSH public key");
    this.name = "SshHostKeyError";
  }
}

export type CanonicalEd25519HostKey = {
  /** `ssh-ed25519 <68 base64 characters>`, without any comment. */
  publicKey: string;
  /** OpenSSH display form: `SHA256:<43 unpadded base64 characters>`. */
  fingerprintSha256: string;
};

/** Strip the non-authoritative comment and validate exact SSH wire framing.
 * Shared by Hetzner first boot and the server enrollment command. A valid
 * string proves nothing about who holds the private key; pinned SSH does. */
export function canonicalEd25519HostKey(raw: string): CanonicalEd25519HostKey {
  if (typeof raw !== "string" || raw.length > 256) throw new SshHostKeyError();
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]{68})(?: [\x21-\x7e]{1,128})?$/.exec(raw);
  if (!match) throw new SshHostKeyError();
  const blob = Buffer.from(match[1], "base64");
  if (blob.length !== 51 || blob.toString("base64") !== match[1]
    || !blob.subarray(0, 19).equals(ED25519_BLOB_PREFIX)
    || blob.subarray(19).every(byte => byte === 0)) throw new SshHostKeyError();
  return {
    publicKey: "ssh-ed25519 " + match[1],
    fingerprintSha256: sshFingerprintSha256(blob),
  };
}

/** `SHA256:<unpadded base64>` of an SSH public key blob. */
export function sshFingerprintSha256(blob: Buffer): string {
  return "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
}

/** Lowercase hex of the SHA-256 digest behind an OpenSSH `SHA256:` fingerprint,
 * the form infrastructure connections store. Null when it isn't one. */
export function sha256FingerprintHex(fingerprint: string): string | null {
  const match = /^SHA256:([A-Za-z0-9+/]{43})$/.exec(fingerprint);
  if (!match) return null;
  const digest = Buffer.from(match[1] + "=", "base64");
  if (digest.length !== 32 || digest.toString("base64").replace(/=+$/, "") !== match[1]) return null;
  return digest.toString("hex");
}

/** OpenSSH display form of a stored lowercase-hex SHA-256 fingerprint. */
export function sha256FingerprintDisplay(hex: string): string | null {
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  return "SHA256:" + Buffer.from(hex, "hex").toString("base64").replace(/=+$/, "");
}
