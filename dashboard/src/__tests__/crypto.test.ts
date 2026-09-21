/**
 * Tests for src/lib/crypto.ts
 *
 * These exercise the AES-256-GCM encrypt/decrypt round-trip and the
 * key-preview formatter.  The ENCRYPTION_KEY env var is set to a deterministic
 * 32-byte hex value before each test so the module can initialise without the
 * real secret.
 */

// Set the test encryption key before importing the module
const TEST_ENCRYPTION_KEY = "a".repeat(64); // 32 bytes → 64 hex chars
const NEXT_ENCRYPTION_KEY = "b".repeat(64);
process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

import {
  encryptApiKey,
  decryptApiKey,
  decryptApiKeyWithSource,
  reencryptApiKey,
  encryptSecret,
  decryptSecret,
  getLaunchFingerprintKeyCandidates,
  formatKeyPreview,
} from "@/lib/crypto";

describe("crypto — encryptApiKey / decryptApiKey", () => {
  afterEach(() => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY_LEGACY;
    delete process.env.LAUNCH_FINGERPRINT_KEY;
    delete process.env.LAUNCH_FINGERPRINT_KEY_LEGACY;
  });

  it("round-trips a typical API key", () => {
    const original = "sk-1234567890abcdef";
    const encrypted = encryptApiKey(original);
    expect(decryptApiKey(encrypted)).toBe(original);
  });

  it.each(["z", "0", " ", "\n", "#comment", " 00"])(
    "rejects a key with a valid 32-byte prefix followed by %j",
    (suffix) => {
      process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY + suffix;
      expect(() => encryptSecret("not-persisted")).toThrow(
        "ENCRYPTION_KEY must be 32 bytes (64 hex chars)",
      );
    },
  );

  it("rejects malformed legacy keys instead of silently truncating them", () => {
    const encrypted = encryptSecret("legacy-value");
    process.env.ENCRYPTION_KEY = NEXT_ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY_LEGACY = TEST_ENCRYPTION_KEY + "z";

    expect(() => decryptSecret(encrypted)).toThrow(
      "ENCRYPTION_KEY_LEGACY must be 32 bytes (64 hex chars)",
    );
  });

  it("continues to accept exactly 64 uppercase hex characters", () => {
    process.env.ENCRYPTION_KEY = "ABCDEF01".repeat(8);
    expect(decryptSecret(encryptSecret("uppercase-key"))).toBe("uppercase-key");
  });

  it("round-trips an empty string", () => {
    const encrypted = encryptApiKey("");
    expect(decryptApiKey(encrypted)).toBe("");
  });

  it("round-trips a long value", () => {
    const original = "x".repeat(1000);
    const encrypted = encryptApiKey(original);
    expect(decryptApiKey(encrypted)).toBe(original);
  });

  it("uses the same rotation-aware envelope for non-API-key secrets", () => {
    const privateKey = "-----BEGIN OPENSSH PRIVATE KEY-----\nexample\n-----END OPENSSH PRIVATE KEY-----";
    const encrypted = encryptSecret(privateKey);

    expect(decryptSecret(encrypted)).toBe(privateKey);
    expect(encrypted).not.toContain("OPENSSH");
  });

  it("produces a different ciphertext each call (random IV)", () => {
    const key = "my-secret-api-key";
    expect(encryptApiKey(key)).not.toBe(encryptApiKey(key));
  });

  it("throws when decrypting with the wrong key", () => {
    const encrypted = encryptApiKey("some-value");
    // Tamper with the key
    process.env.ENCRYPTION_KEY = "b".repeat(64);
    expect(() => decryptApiKey(encrypted)).toThrow();
    // Restore
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  });

  it("throws when ciphertext is corrupted", () => {
    const encrypted = encryptApiKey("hello");
    const corrupted = encrypted.slice(0, -4) + "XXXX";
    expect(() => decryptApiKey(corrupted)).toThrow();
  });

  it("decrypts with the legacy key when the primary key no longer matches", () => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    const encrypted = encryptApiKey("legacy-value");

    process.env.ENCRYPTION_KEY = NEXT_ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY_LEGACY = TEST_ENCRYPTION_KEY;

    expect(decryptApiKey(encrypted)).toBe("legacy-value");
    expect(decryptApiKeyWithSource(encrypted)).toEqual({
      plaintext: "legacy-value",
      keySource: "legacy",
    });
  });

  it("encrypts with the primary key even when a legacy key is configured", () => {
    process.env.ENCRYPTION_KEY = NEXT_ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY_LEGACY = TEST_ENCRYPTION_KEY;

    const encrypted = encryptApiKey("fresh-value");

    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY_LEGACY;

    expect(() => decryptApiKey(encrypted)).toThrow();
  });

  it("re-encrypts legacy ciphertext once and then becomes idempotent", () => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    const encrypted = encryptApiKey("rotate-me");

    process.env.ENCRYPTION_KEY = NEXT_ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY_LEGACY = TEST_ENCRYPTION_KEY;

    const firstPass = reencryptApiKey(encrypted);
    expect(firstPass.changed).toBe(true);
    expect(firstPass.keySource).toBe("legacy");
    expect(firstPass.value).not.toBe(encrypted);
    expect(decryptApiKey(firstPass.value)).toBe("rotate-me");

    const secondPass = reencryptApiKey(firstPass.value);
    expect(secondPass.changed).toBe(false);
    expect(secondPass.keySource).toBe("primary");
    expect(secondPass.value).toBe(firstPass.value);
  });

  it("separates v2 launch fingerprints from encryption-key rotation", () => {
    process.env.LAUNCH_FINGERPRINT_KEY = "c".repeat(64);
    const before = getLaunchFingerprintKeyCandidates();
    process.env.ENCRYPTION_KEY = NEXT_ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY_LEGACY = TEST_ENCRYPTION_KEY;
    const after = getLaunchFingerprintKeyCandidates();
    expect(before.map(({keyHex,version}) => ({keyHex,version})))
      .toEqual(after.map(({keyHex,version}) => ({keyHex,version})));
    expect(after).toHaveLength(1);
    expect(after[0].version).toBe(2);
  });
});

describe("crypto — formatKeyPreview", () => {
  it("shows first 6 and last 4 chars for a long key", () => {
    expect(formatKeyPreview("sk-1234567890abcdef")).toBe("sk-123...cdef");
  });

  it("truncates a very short key", () => {
    expect(formatKeyPreview("abc")).toBe("abc...");
  });

  it("handles exactly 8-char key", () => {
    // Length <= 8 triggers the short-key path
    const result = formatKeyPreview("12345678");
    expect(result).toContain("...");
  });
});
