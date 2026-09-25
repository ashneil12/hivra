/** @jest-environment node */

jest.mock("server-only", () => ({}));

import { utils as ssh2Utils } from "ssh2";

import { generateVerifiedEd25519SshKeyPair } from "../ed25519-ssh-key";
import { SshPrivateKeyError, unlockSshPrivateKey } from "../ssh-private-key";

// INF-14: the advanced wizard's key passphrase. The key is unlocked once and
// the unlocked key is what gets sealed; the passphrase is never kept.
function encryptedKey(type: "ed25519" | "rsa") {
  for (;;) {
    const pair = ssh2Utils.generateKeyPairSync(type, {
      ...(type === "rsa" ? { bits: 2048 } : {}), passphrase: "correct horse", cipher: "aes256-ctr", rounds: 4,
    });
    const unlocked = ssh2Utils.parseKey(pair.private, "correct horse");
    // Skip ssh2's leading-zero Ed25519 case (see ed25519-ssh-key.ts).
    if (!(unlocked instanceof Error) && !Array.isArray(unlocked)) return pair;
  }
}

function publicBlob(key: string, passphrase?: string): Buffer {
  const parsed = ssh2Utils.parseKey(key, passphrase);
  if (parsed instanceof Error || Array.isArray(parsed)) throw parsed;
  return parsed.getPublicSSH();
}

describe("unlockSshPrivateKey", () => {
  it.each(["ed25519", "rsa"] as const)("unlocks a passphrase-protected %s key into the same key, unencrypted", (type) => {
    const pair = encryptedKey(type);
    const unlocked = unlockSshPrivateKey(pair.private, "correct horse");
    expect(unlocked).not.toContain("correct horse");
    expect(ssh2Utils.parseKey(unlocked)).not.toBeInstanceOf(Error);
    expect(publicBlob(unlocked).equals(publicBlob(pair.private, "correct horse"))).toBe(true);
  });

  it("asks for the passphrase when the key has one, and refuses a wrong one", () => {
    const pair = encryptedKey("ed25519");
    expect(() => unlockSshPrivateKey(pair.private)).toThrow(new SshPrivateKeyError("passphrase_required"));
    expect(() => unlockSshPrivateKey(pair.private, "wrong")).toThrow(new SshPrivateKeyError("passphrase_incorrect"));
  });

  it("keeps an unencrypted key exactly as pasted, whatever passphrase came with it", () => {
    const { privateKeyOpenSsh } = generateVerifiedEd25519SshKeyPair("ssh-private-key-test");
    expect(unlockSshPrivateKey(privateKeyOpenSsh)).toBe(privateKeyOpenSsh);
    expect(unlockSshPrivateKey(privateKeyOpenSsh, "not needed")).toBe(privateKeyOpenSsh);
  });

  it("stores a key it can't read as today, but refuses to guess with a passphrase", () => {
    expect(unlockSshPrivateKey("not a key")).toBe("not a key");
    expect(() => unlockSshPrivateKey("not a key", "x")).toThrow(new SshPrivateKeyError("unsupported_key"));
  });
});
