import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import { chmod, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { finished, pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("HVRABKP1", "ascii");
const TAG_BYTES = 16;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;
const BACKUP_FORMAT = "hivra-self-host-backup-v1";
const LEGACY_PAYLOAD_FORMAT = "hivra-self-host-backup-payload-v1";
const PAYLOAD_FORMAT = "hivra-self-host-backup-payload-v2";
const BASE_FILES = ["dashboard.env", "database.sql", "receipt.json"];
export const BACKUP_PAYLOAD_FILES = ["backup.json", ...BASE_FILES, "storage.ndjson"];

function payloadFiles(format) {
  if (format === LEGACY_PAYLOAD_FORMAT) return BASE_FILES;
  if (format === PAYLOAD_FORMAT) return [...BASE_FILES, "storage.ndjson"];
  fail("The decrypted backup manifest uses an unsupported format.");
}

function fail(message) {
  throw new Error(message);
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertOwnerOnlyDirectory(directory) {
  if (!["darwin", "linux"].includes(process.platform) || typeof process.getuid !== "function") {
    fail("Encrypted self-host backups require Linux or macOS owner permissions.");
  }
  const real = realpathSync(directory);
  const metadata = lstatSync(real);
  if (!metadata.isDirectory() || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0) {
    fail("Use an existing owner-only backup directory (normally chmod 700).");
  }
  return real;
}

export function resolveNewBackupPath(value, { repositoryRoot, stateDirectory }) {
  if (!value || !path.isAbsolute(value)) fail("--output must be an absolute path in an existing owner-only directory.");
  const parent = assertOwnerOnlyDirectory(path.dirname(value));
  const target = path.join(parent, path.basename(value));
  const stateRoot = existsSync(stateDirectory) ? realpathSync(stateDirectory) : path.resolve(stateDirectory);
  if (isInside(realpathSync(repositoryRoot), target) || isInside(stateRoot, target)) {
    fail("Write the encrypted backup outside the source checkout and installation state directory.");
  }
  if (existsSync(target)) fail("The backup output already exists; nothing was overwritten.");
  return target;
}

export function resolveExistingBackupPath(value) {
  if (!value || !path.isAbsolute(value)) fail("--input must be an absolute encrypted backup path.");
  const target = realpathSync(value);
  const metadata = lstatSync(target);
  if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0) {
    fail("The encrypted backup must be an owner-only regular file without hard links (normally chmod 600).");
  }
  return target;
}

export function createBackupManifest({ sourceRevision, stateReceipt, files, createdAt = new Date().toISOString(), format = PAYLOAD_FORMAT }) {
  if (!Number.isFinite(Date.parse(createdAt))) fail("Backup creation time is invalid.");
  if (typeof stateReceipt?.createdAt !== "string" || !Number.isFinite(Date.parse(stateReceipt.createdAt))) {
    fail("Installation creation time is invalid.");
  }
  const normalized = {};
  for (const name of payloadFiles(format)) {
    const entry = files?.[name];
    if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      fail(`Backup evidence for ${name} is invalid.`);
    }
    normalized[name] = { sha256: entry.sha256, bytes: entry.bytes };
  }
  return {
    format,
    createdAt,
    sourceRevision: typeof sourceRevision === "string" && /^[a-f0-9]{40}$/.test(sourceRevision) ? sourceRevision : null,
    installationCreatedAt: stateReceipt.createdAt,
    databaseSchemas: ["auth", "public", "storage"],
    files: normalized,
  };
}

export function validateBackupManifest(value) {
  if (
    ![PAYLOAD_FORMAT, LEGACY_PAYLOAD_FORMAT].includes(value?.format) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.installationCreatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.installationCreatedAt)) ||
    (value.sourceRevision !== null && !/^[a-f0-9]{40}$/.test(value.sourceRevision || "")) ||
    JSON.stringify(value.databaseSchemas) !== JSON.stringify(["auth", "public", "storage"])
  ) {
    fail("The decrypted backup manifest is invalid.");
  }
  return createBackupManifest({
    sourceRevision: value.sourceRevision,
    stateReceipt: { createdAt: value.installationCreatedAt },
    files: value.files,
    createdAt: value.createdAt,
    format: value.format,
  });
}

export async function rejectIncompleteLegacyStorage(manifest, sqlFile) {
  if (manifest.format !== LEGACY_PAYLOAD_FORMAT) return;
  const lines = readline.createInterface({ input: createReadStream(sqlFile), crlfDelay: Infinity });
  let inObjects = false;
  try {
    for await (const line of lines) {
      if (line.startsWith('COPY "storage"."objects" (')) { inObjects = true; continue; }
      if (!inObjects) continue;
      if (line === "\\.") { inObjects = false; continue; }
      fail("This legacy backup has uploaded-file metadata but no file bytes. Create a new backup from the original installation; no restore was started.");
    }
  } finally { lines.close(); }
}

export function sha256File(file) {
  const bytes = statSync(file).size;
  const digest = createHash("sha256");
  return new Promise((resolve, reject) => {
    const input = createReadStream(file);
    input.on("data", (chunk) => digest.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve({ sha256: digest.digest("hex"), bytes }));
  });
}

export async function databaseRestorePreamble(sqlFile) {
  const tables = new Set();
  const lines = readline.createInterface({ input: createReadStream(sqlFile), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.startsWith("COPY ")) continue;
      const match = line.match(/^COPY ("(?:auth|public|storage)"\."[A-Za-z0-9_]+") \(.+\) FROM stdin;$/);
      if (!match) fail("The database backup contains an unsupported COPY target.");
      tables.add(match[1]);
      if (tables.size > 2000) fail("The database backup contains too many tables.");
    }
  } finally {
    lines.close();
  }
  if (tables.size === 0) fail("The database backup contains no restorable tables.");
  return [
    "SET session_replication_role = replica;",
    `TRUNCATE TABLE ${[...tables].sort().join(", ")} RESTART IDENTITY CASCADE;`,
    "",
  ].join("\n");
}

export function databaseRestorePsqlArgs(projectId) {
  if (!/^hivra-[a-f0-9]{10}$/.test(projectId)) fail("The restore database identity is invalid.");
  return [
    "exec", "-i", `supabase_db_${projectId}`,
    "psql", "--username", "supabase_admin", "--dbname", "postgres", "--set=ON_ERROR_STOP=on",
  ];
}

function deriveKey(passphrase, salt) {
  if (typeof passphrase !== "string" || passphrase.length < 16 || passphrase.length > 1024) {
    fail("Backup passphrase must contain 16 to 1024 characters.");
  }
  return scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function encodeHeader(header) {
  const bytes = Buffer.from(`${JSON.stringify(header)}\n`, "utf8");
  if (bytes.length > MAX_HEADER_BYTES) fail("Backup encryption header is too large.");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([MAGIC, length, bytes]);
}

async function readHeader(file) {
  const handle = await open(file, "r");
  try {
    const prefix = Buffer.alloc(MAGIC.length + 4);
    const first = await handle.read(prefix, 0, prefix.length, 0);
    if (first.bytesRead !== prefix.length || !prefix.subarray(0, MAGIC.length).equals(MAGIC)) {
      fail("The selected file is not a Hivra encrypted backup.");
    }
    const headerLength = prefix.readUInt32BE(MAGIC.length);
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) fail("The encrypted backup header is invalid.");
    const headerBytes = Buffer.alloc(headerLength);
    const second = await handle.read(headerBytes, 0, headerLength, prefix.length);
    if (second.bytesRead !== headerLength) fail("The encrypted backup header is truncated.");
    let header;
    try {
      header = JSON.parse(headerBytes.toString("utf8"));
    } catch {
      fail("The encrypted backup header is malformed.");
    }
    if (
      header?.format !== BACKUP_FORMAT ||
      header.cipher !== "aes-256-gcm" ||
      header.kdf !== "scrypt-N16384-r8-p1" ||
      !/^[a-f0-9]{32}$/.test(header.salt || "") ||
      !/^[a-f0-9]{24}$/.test(header.iv || "")
    ) {
      fail("The encrypted backup header uses an unsupported format.");
    }
    return { header, dataOffset: prefix.length + headerLength };
  } finally {
    await handle.close();
  }
}

export async function encryptBackupArchive({ archive, output, passphrase }) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  key.fill(0);
  const header = encodeHeader({
    format: BACKUP_FORMAT,
    cipher: "aes-256-gcm",
    kdf: "scrypt-N16384-r8-p1",
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
  });
  const target = createWriteStream(output, { flags: "wx", mode: 0o600 });
  try {
    target.write(header);
    await pipeline(createReadStream(archive), cipher, target, { end: false });
    target.end(cipher.getAuthTag());
    await finished(target);
    await chmod(output, 0o600);
    return { format: BACKUP_FORMAT, bytes: statSync(output).size };
  } catch (error) {
    target.destroy();
    await rm(output, { force: true });
    throw error;
  }
}

export async function decryptBackupArchive({ input, output, passphrase }) {
  const { header, dataOffset } = await readHeader(input);
  const totalBytes = statSync(input).size;
  if (totalBytes <= dataOffset + TAG_BYTES) fail("The encrypted backup payload is truncated.");
  const handle = await open(input, "r");
  let tag;
  try {
    tag = Buffer.alloc(TAG_BYTES);
    const read = await handle.read(tag, 0, TAG_BYTES, totalBytes - TAG_BYTES);
    if (read.bytesRead !== TAG_BYTES) fail("The encrypted backup authentication tag is truncated.");
  } finally {
    await handle.close();
  }
  const key = deriveKey(passphrase, Buffer.from(header.salt, "hex"));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.iv, "hex"));
  key.fill(0);
  decipher.setAuthTag(tag);
  try {
    await pipeline(
      createReadStream(input, { start: dataOffset, end: totalBytes - TAG_BYTES - 1 }),
      decipher,
      createWriteStream(output, { flags: "wx", mode: 0o600 }),
    );
    await chmod(output, 0o600);
    return { format: BACKUP_FORMAT, bytes: statSync(output).size };
  } catch {
    await rm(output, { force: true });
    fail("Backup authentication failed. The passphrase is wrong or the file was modified.");
  }
}

export async function writeBackupManifest(file, manifest) {
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

export async function inspectExtractedBackup(directory) {
  const names = (await readdir(directory)).sort();
  const legacyNames = ["backup.json", ...BASE_FILES];
  if (![legacyNames, BACKUP_PAYLOAD_FILES].some(expected => JSON.stringify(names) === JSON.stringify(expected))) fail("The decrypted backup contains unexpected files.");
  for (const name of names) {
    const target = path.join(directory, name);
    const metadata = lstatSync(target);
    if (!metadata.isFile() || metadata.nlink !== 1 || realpathSync(target) !== target) {
      fail("The decrypted backup must contain only regular files.");
    }
    if (!["database.sql", "storage.ndjson"].includes(name) && metadata.size > MAX_METADATA_BYTES) fail("Backup metadata exceeds the safety limit.");
  }
  let manifest;
  try {
    manifest = validateBackupManifest(JSON.parse(await readFile(path.join(directory, "backup.json"), "utf8")));
  } catch (error) {
    if (error instanceof Error && /backup manifest/i.test(error.message)) throw error;
    fail("The decrypted backup manifest is malformed.");
  }
  if (JSON.stringify(names) !== JSON.stringify(["backup.json", ...payloadFiles(manifest.format)])) fail("The decrypted backup payload does not match its manifest format.");
  for (const name of payloadFiles(manifest.format)) {
    const observed = await sha256File(path.join(directory, name));
    if (JSON.stringify(observed) !== JSON.stringify(manifest.files[name])) {
      fail(`The decrypted ${name} does not match its authenticated manifest.`);
    }
  }
  return manifest;
}
