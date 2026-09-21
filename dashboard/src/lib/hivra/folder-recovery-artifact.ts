import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";

// Deliberately not a whole-computer backup or the controller's .hivra format.
export const FOLDER_RECOVERY_FORMAT = "hivra-ubuntu-folder-v1";
export const FOLDER_RECOVERY_MAX_BYTES = 2 * 1024 * 1024;
const FOLDER_RECOVERY_MAX_FILES = 512;
export const FOLDER_RECOVERY_MAX_ARTIFACT_BYTES = 3 * 1024 * 1024;
const MAGIC = Buffer.from("HIVRA-FOLDER-1\n");
const deriveKey = promisify(scrypt);
const HASH = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class FolderRecoveryError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "FolderRecoveryError";
  }
}

export type FolderRecoveryEntry =
  | { path: string; kind: "directory" }
  | { path: string; kind: "file"; content: string; sha256: string; executable: boolean };
export interface FolderRecoveryPayload {
  format: typeof FOLDER_RECOVERY_FORMAT;
  scope: "/home/bux/Hivra";
  source: { agentId: string; bindingHash: string };
  exportedAt: string;
  entries: FolderRecoveryEntry[];
}

export function sha256FolderBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateFolderRecoveryPayload(value: unknown): FolderRecoveryPayload {
  const fail = () => { throw new FolderRecoveryError("Invalid or unsupported Hivra-folder archive."); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const payload = value as FolderRecoveryPayload;
  if (payload.format !== FOLDER_RECOVERY_FORMAT || payload.scope !== "/home/bux/Hivra"
    || !UUID.test(payload.source?.agentId ?? "") || !HASH.test(payload.source?.bindingHash ?? "")
    || typeof payload.exportedAt !== "string" || !Number.isFinite(Date.parse(payload.exportedAt))
    || !Array.isArray(payload.entries) || payload.entries.length > FOLDER_RECOVERY_MAX_FILES) return fail();
  const seen = new Map<string, string>();
  let total = 0;
  for (const entry of payload.entries) {
    if (!entry || typeof entry.path !== "string" || Buffer.byteLength(entry.path) > 1024
      || !entry.path || entry.path.includes("\\") || /[\u0000-\u001f\u007f]/.test(entry.path)
      || entry.path.split("/").some((part) => !part || part === "." || part === "..")
      || seen.has(entry.path)) return fail();
    if (entry.kind === "file") {
      if (typeof entry.content !== "string" || typeof entry.executable !== "boolean"
        || !HASH.test(entry.sha256 ?? "") || entry.content.length > Math.ceil(FOLDER_RECOVERY_MAX_BYTES / 3) * 4
        || /[^A-Za-z0-9+/=]/.test(entry.content)) return fail();
      const bytes = Buffer.from(entry.content, "base64");
      if (bytes.toString("base64") !== entry.content || sha256FolderBytes(bytes) !== entry.sha256) return fail();
      total += bytes.length;
      if (total > FOLDER_RECOVERY_MAX_BYTES) throw new FolderRecoveryError("Hivra-folder recovery is limited to 2 MiB of files.");
    } else if (entry.kind !== "directory") return fail();
    seen.set(entry.path, entry.kind);
  }
  for (const path of seen.keys()) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (seen.get(parts.slice(0, i).join("/")) !== "directory") return fail();
    }
  }
  return payload;
}

function validatePassphrase(passphrase: unknown): asserts passphrase is string {
  if (typeof passphrase !== "string" || passphrase.length < 12 || Buffer.byteLength(passphrase) > 1024) {
    throw new FolderRecoveryError("Use a recovery passphrase between 12 and 1024 bytes; keep it somewhere safe.");
  }
}

export async function encryptFolderRecovery(payload: FolderRecoveryPayload, passphrase: string): Promise<Buffer> {
  validatePassphrase(passphrase);
  validateFolderRecoveryPayload(payload);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt, 32) as Buffer;
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const header = Buffer.concat([MAGIC, salt, iv]);
    cipher.setAAD(header);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    const artifact = Buffer.concat([header, cipher.getAuthTag(), ciphertext]);
    if (artifact.length > FOLDER_RECOVERY_MAX_ARTIFACT_BYTES) throw new FolderRecoveryError("Archive metadata exceeds the 3 MiB encrypted-file limit.");
    return artifact;
  } finally { key.fill(0); }
}

export async function decryptFolderRecovery(artifact: Buffer, passphrase: string): Promise<FolderRecoveryPayload> {
  validatePassphrase(passphrase);
  if (artifact.length > FOLDER_RECOVERY_MAX_ARTIFACT_BYTES || artifact.length < MAGIC.length + 45
    || !artifact.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new FolderRecoveryError("Select a Hivra-folder archive, no larger than 3 MiB.");
  }
  const offset = MAGIC.length;
  const key = await deriveKey(passphrase, artifact.subarray(offset, offset + 16), 32) as Buffer;
  try {
    const cipher = createDecipheriv("aes-256-gcm", key, artifact.subarray(offset + 16, offset + 28));
    cipher.setAAD(artifact.subarray(0, offset + 28));
    cipher.setAuthTag(artifact.subarray(offset + 28, offset + 44));
    const plaintext = Buffer.concat([cipher.update(artifact.subarray(offset + 44)), cipher.final()]);
    try { return validateFolderRecoveryPayload(JSON.parse(plaintext.toString("utf8"))); }
    finally { plaintext.fill(0); }
  } catch (error) {
    if (error instanceof FolderRecoveryError) throw error;
    throw new FolderRecoveryError("The passphrase is incorrect or the archive is damaged.");
  } finally { key.fill(0); }
}
