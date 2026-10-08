import "server-only";

import { utils as ssh2Utils } from "ssh2";

import { canonicalEd25519HostKey, sshFingerprintSha256 } from "./ssh-host-key";

export const ED25519_KEY_GENERATION_MAX_ATTEMPTS = 16;

export class Ed25519KeyGenerationError extends Error {
  constructor(readonly code: "generator_failed" | "exhausted" | "invalid_comment") {
    super("Ed25519 key generation failed: " + code);
    this.name = "Ed25519KeyGenerationError";
  }
}

export type VerifiedEd25519SshKeyPair = {
  privateKeyOpenSsh: string;
  /** `ssh-ed25519 <base64> <comment>`, exactly as ssh2 wrote it. */
  publicKeyOpenSsh: string;
  /** `ssh-ed25519 <68 base64 characters>`, without the comment. */
  publicKey: string;
  fingerprintSha256: string;
};

/**
 * ssh2 1.17's Ed25519 DER conversion removes all leading zero bytes from the
 * ASN.1 BitString. When the actual 32-byte public key begins with 0x00, that
 * produces a malformed 31-byte OpenSSH key. Treat key generation as rejection
 * sampling: accept only a pair that independently parses, matches, and has the
 * exact public form. Bounded, so a persistent generator fault fails closed
 * instead of looping. A generator that throws is not retried.
 */
export function generateVerifiedEd25519SshKeyPair(
  comment: string,
  maxAttempts = ED25519_KEY_GENERATION_MAX_ATTEMPTS,
): VerifiedEd25519SshKeyPair {
  if (!/^[a-z0-9-]{1,32}$/.test(comment)) throw new Ed25519KeyGenerationError("invalid_comment");
  const publicForm = new RegExp(`^ssh-ed25519 [A-Za-z0-9+/]+={0,2} ${comment}$`);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let keyPair: ReturnType<typeof ssh2Utils.generateKeyPairSync>;
    try {
      keyPair = ssh2Utils.generateKeyPairSync("ed25519", { comment });
    } catch {
      throw new Ed25519KeyGenerationError("generator_failed");
    }
    const parsedPrivateKey = ssh2Utils.parseKey(keyPair.private);
    const parsedPublicKey = ssh2Utils.parseKey(keyPair.public);
    if (
      parsedPrivateKey instanceof Error
      || parsedPublicKey instanceof Error
      || !parsedPrivateKey.isPrivateKey()
      || parsedPublicKey.isPrivateKey()
    ) {
      continue;
    }
    const privatePublicBlob = parsedPrivateKey.getPublicSSH();
    const publicBlob = parsedPublicKey.getPublicSSH();
    if (!privatePublicBlob.equals(publicBlob)) continue;
    const publicKeyOpenSsh = keyPair.public.trim();
    if (!publicForm.test(publicKeyOpenSsh)) continue;
    let canonical: ReturnType<typeof canonicalEd25519HostKey>;
    try {
      canonical = canonicalEd25519HostKey(publicKeyOpenSsh);
    } catch {
      continue;
    }
    if (!Buffer.from(canonical.publicKey.split(" ")[1], "base64").equals(publicBlob)) continue;
    return {
      privateKeyOpenSsh: keyPair.private,
      publicKeyOpenSsh,
      publicKey: canonical.publicKey,
      fingerprintSha256: sshFingerprintSha256(publicBlob),
    };
  }
  throw new Ed25519KeyGenerationError("exhausted");
}
