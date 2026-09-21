import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

// SCRIPTURE_ANCHOR: sealed-trust | Song of Solomon 8:6 | Verse: Set me as a seal on your heart, as a seal on your arm.

const ALG = "aes-256-gcm";

export type ApiKeySource = "primary" | "legacy";

export type ConfiguredSecretKey = {
  key: Buffer;
  keyHex: string;
  source: ApiKeySource;
};

export type ConfiguredLaunchFingerprintKey = ConfiguredSecretKey & {
  version: 1 | 2;
};

function parseKey(raw: string | undefined, envName: string, source: ApiKeySource): ConfiguredSecretKey {
  if (!raw) throw new Error(`${envName} env var not set`);
  // Buffer.from(hex) silently discards an invalid suffix or an odd nibble.
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${envName} must be 32 bytes (64 hex chars)`);
  }
  const buf = Buffer.from(raw, "hex");
  if (buf.length !== 32) throw new Error(`${envName} must be 32 bytes (64 hex chars)`);
  return {
    key: buf,
    keyHex: raw,
    source,
  };
}

// Caches keyed by the raw env-var values so a deliberate rotation (or test
// `delete process.env.ENCRYPTION_KEY`) is detected without a process restart.
// The expensive bit was Buffer.from(raw, "hex") + Buffer length check on every
// decrypt — these run per-row on the instance-list endpoint and per chat send.
let primaryCache: { rawHex: string; key: ConfiguredSecretKey } | null = null;
let candidatesCache: {
  rawHex: string;
  legacyRawHex: string | null;
  keys: ConfiguredSecretKey[];
} | null = null;

export function getSecretPrimaryKey(): ConfiguredSecretKey {
  const raw = process.env.ENCRYPTION_KEY;
  if (primaryCache && primaryCache.rawHex === raw) {
    return primaryCache.key;
  }
  const key = parseKey(raw, "ENCRYPTION_KEY", "primary");
  primaryCache = { rawHex: raw ?? "", key };
  return key;
}

export function getSecretDecryptKeyCandidates(): ConfiguredSecretKey[] {
  const primaryRaw = process.env.ENCRYPTION_KEY ?? "";
  const legacyRaw = process.env.ENCRYPTION_KEY_LEGACY ?? null;
  if (
    candidatesCache &&
    candidatesCache.rawHex === primaryRaw &&
    candidatesCache.legacyRawHex === legacyRaw
  ) {
    return candidatesCache.keys;
  }

  const primary = getSecretPrimaryKey();
  const keys = [primary];

  if (legacyRaw) {
    const legacy = parseKey(legacyRaw, "ENCRYPTION_KEY_LEGACY", "legacy");
    if (legacy.keyHex !== primary.keyHex) {
      keys.push(legacy);
    }
  }

  candidatesCache = { rawHex: primaryRaw, legacyRawHex: legacyRaw, keys };
  return keys;
}

/**
 * Launch request identity has a longer lifetime than any one encryption-key
 * epoch. New installations use a dedicated v2 HMAC key so rotating encrypted
 * database custody cannot invalidate idempotent launch replays. Deployments
 * without that key retain the existing v1 behavior until deliberately
 * migrated; mixing v1 and v2 candidates would make new reservations ambiguous.
 */
export function getLaunchFingerprintKeyCandidates(): ConfiguredLaunchFingerprintKey[] {
  const primaryRaw = process.env.LAUNCH_FINGERPRINT_KEY;
  if (!primaryRaw) {
    return getSecretDecryptKeyCandidates().map((candidate) => ({ ...candidate, version: 1 as const }));
  }

  const primary = parseKey(primaryRaw, "LAUNCH_FINGERPRINT_KEY", "primary");
  const keys: ConfiguredLaunchFingerprintKey[] = [{ ...primary, version: 2 }];
  const legacyRaw = process.env.LAUNCH_FINGERPRINT_KEY_LEGACY;
  if (legacyRaw) {
    const legacy = parseKey(legacyRaw, "LAUNCH_FINGERPRINT_KEY_LEGACY", "legacy");
    if (legacy.keyHex.toLowerCase() !== primary.keyHex.toLowerCase()) {
      keys.push({ ...legacy, version: 2 });
    }
  }
  return keys;
}

function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptWithKey(ciphertext: string, key: Buffer): string {
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

/** Encrypt any server-side secret with the configured primary AES-GCM key. */
export function encryptSecret(plaintext: string): string {
  return encryptWithKey(plaintext, getSecretPrimaryKey().key);
}

/** Decrypt a server-side secret, accepting the configured legacy key during rotation. */
export function decryptSecretWithSource(ciphertext: string): {
  plaintext: string;
  keySource: ApiKeySource;
} {
  let lastError: unknown;

  for (const candidate of getSecretDecryptKeyCandidates()) {
    try {
      return {
        plaintext: decryptWithKey(ciphertext, candidate.key),
        keySource: candidate.source,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to decrypt secret");
}

export function decryptSecret(ciphertext: string): string {
  return decryptSecretWithSource(ciphertext).plaintext;
}

export function reencryptSecret(ciphertext: string): {
  value: string;
  keySource: ApiKeySource;
  changed: boolean;
} {
  const decrypted = decryptSecretWithSource(ciphertext);
  if (decrypted.keySource === "primary") {
    return {
      value: ciphertext,
      keySource: decrypted.keySource,
      changed: false,
    };
  }

  return {
    value: encryptSecret(decrypted.plaintext),
    keySource: decrypted.keySource,
    changed: true,
  };
}

// Backwards-compatible API-key names. The underlying envelope is deliberately
// generic so infrastructure credentials can share the same rotation controls.
export const encryptApiKey = encryptSecret;
export const decryptApiKeyWithSource = decryptSecretWithSource;
export const decryptApiKey = decryptSecret;
export const reencryptApiKey = reencryptSecret;

export function formatKeyPreview(key: string): string {
  if (key.length <= 8) return key.slice(0, 4) + "...";
  return key.slice(0, 6) + "..." + key.slice(-4);
}
