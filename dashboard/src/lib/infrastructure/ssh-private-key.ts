import "server-only";

import { createPrivateKey, randomBytes } from "node:crypto";
import { utils as ssh2Utils, type ParsedKey } from "ssh2";

export class SshPrivateKeyError extends Error {
  constructor(readonly code: "passphrase_required" | "passphrase_incorrect" | "unsupported_key") {
    super("SSH private key " + code);
    this.name = "SshPrivateKeyError";
  }
}

function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes;
}

/** An unencrypted "openssh-key-v1" private key for an Ed25519 seed, the
 * format ssh2 reads back. (ssh2 can decrypt an OpenSSH Ed25519 key but only
 * exports it as PKCS#8, which it can't read back.) */
export function openSshEd25519PrivateKey(seed: Buffer, publicKey: Buffer, comment = "hivra"): string {
  if (seed.length !== 32 || publicKey.length !== 32) throw new SshPrivateKeyError("unsupported_key");
  const publicBlob = Buffer.concat([sshString("ssh-ed25519"), sshString(publicKey)]);
  const check = randomBytes(4).readUInt32BE();
  let section = Buffer.concat([
    uint32(check), uint32(check), sshString("ssh-ed25519"), sshString(publicKey),
    sshString(Buffer.concat([seed, publicKey])), sshString(comment),
  ]);
  const padding: number[] = [];
  for (let pad = 1; (section.length + padding.length) % 8 !== 0; pad += 1) padding.push(pad);
  section = Buffer.concat([section, Buffer.from(padding)]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "latin1"), sshString("none"), sshString("none"), sshString(""),
    uint32(1), sshString(publicBlob), sshString(section),
  ]);
  const encoded = body.toString("base64").match(/.{1,70}/g)?.join("\n") ?? "";
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${encoded}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function single(parsed: ParsedKey | ParsedKey[] | Error): ParsedKey | Error {
  return Array.isArray(parsed) ? parsed[0] ?? new Error("No key") : parsed;
}

function provesSameKey(original: ParsedKey, candidate: string): boolean {
  const reparsed = single(ssh2Utils.parseKey(candidate));
  if (reparsed instanceof Error || !reparsed.isPrivateKey()
    || !reparsed.getPublicSSH().equals(original.getPublicSSH())) return false;
  const challenge = randomBytes(32);
  const signature = reparsed.sign(challenge);
  return Buffer.isBuffer(signature) && original.verify(challenge, signature) === true;
}

/**
 * The private key to seal for a connection. An unencrypted key is returned
 * as pasted, whatever passphrase came with it. An encrypted key is unlocked
 * once with the passphrase and re-exported unencrypted, and the result must
 * be the same key (it signs what the original verifies). The passphrase is
 * never returned or stored.
 */
export function unlockSshPrivateKey(raw: string, passphrase?: string): string {
  const plain = single(ssh2Utils.parseKey(raw));
  if (!(plain instanceof Error)) {
    if (!plain.isPrivateKey()) throw new SshPrivateKeyError("unsupported_key");
    return raw;
  }
  const encrypted = /encrypted/i.test(plain.message) && /passphrase/i.test(plain.message);
  // A key Hivra can't parse at all is stored as today and fails at sign-in
  // with the usual copy; only a passphrase makes Hivra try to unlock it.
  if (!encrypted && !passphrase) return raw;
  if (!encrypted) throw new SshPrivateKeyError("unsupported_key");
  if (!passphrase) throw new SshPrivateKeyError("passphrase_required");
  const unlocked = single(ssh2Utils.parseKey(raw, passphrase));
  if (unlocked instanceof Error || !unlocked.isPrivateKey()) {
    throw new SshPrivateKeyError("passphrase_incorrect");
  }
  let exported: string;
  if (unlocked.type === "ssh-ed25519") {
    const jwk = createPrivateKey(unlocked.getPrivatePEM()).export({ format: "jwk" });
    if (typeof jwk.d !== "string" || typeof jwk.x !== "string") throw new SshPrivateKeyError("unsupported_key");
    exported = openSshEd25519PrivateKey(Buffer.from(jwk.d, "base64url"), Buffer.from(jwk.x, "base64url"));
  } else {
    exported = unlocked.getPrivatePEM();
  }
  if (!provesSameKey(unlocked, exported)) throw new SshPrivateKeyError("unsupported_key");
  return exported;
}
