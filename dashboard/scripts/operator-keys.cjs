const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const KEY_NAMES = ["ENCRYPTION_KEY", "CHAT_ENCRYPTION_KEY", "LAUNCH_FINGERPRINT_KEY"];
const ALL_KEY_NAMES = [...KEY_NAMES, "ENCRYPTION_KEY_LEGACY", "CHAT_ENCRYPTION_KEY_LEGACY", "LAUNCH_FINGERPRINT_KEY_LEGACY"];
const MAX_FILE_BYTES = 64 * 1024;

class OperatorKeyError extends Error {}

function assertSupportedPlatform() {
  if (!["linux", "darwin"].includes(process.platform) || typeof process.getuid !== "function") {
    throw new OperatorKeyError("Key-file setup requires Linux or macOS with owner-only POSIX file permissions.");
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid;
}

function assertNoMacAccessGrants(file, expected) {
  if (process.platform !== "darwin") return;
  if (!sameFile(fs.lstatSync(file), expected)) throw new OperatorKeyError("The key-file path changed during its safety check.");
  // fdescfs (/dev/fd/N) does not expose the underlying macOS ACL. Inspect the
  // real path only after checking its owner-controlled ancestor chain.
  const result = spawnSync("/bin/ls", ["-ldeb", file], {
    encoding: "utf8", timeout: 3000, maxBuffer: 64 * 1024,
    env: { LANG: "C", LC_ALL: "C" },
  });
  if (result.status !== 0 || result.error || result.stderr || !sameFile(fs.lstatSync(file), expected)) {
    throw new OperatorKeyError("Cannot safely verify macOS ACLs for this path.");
  }
  const [metadata, ...entries] = result.stdout.trimEnd().split("\n");
  if (!/^[d-][rwxstST-]{9}[+@ ]/.test(metadata) || (metadata[10] === "+" && entries.length === 0)) {
    throw new OperatorKeyError("Cannot safely verify macOS ACLs for this path.");
  }
  // Deny-only ACLs (such as macOS's home-directory delete protection) do not
  // widen access. Refuse every allow entry, including inherited grants.
  if (entries.some((entry) => !/^\s*\d+: .+ deny [a-z_,]+$/.test(entry) || /\ballow\b/.test(entry))) {
    throw new OperatorKeyError("Use an unshared path without macOS ACL access grants. Existing permissions were not changed.");
  }
}

function ownerPath(file) {
  assertSupportedPlatform();
  const resolved = path.resolve(file);
  const parent = fs.realpathSync(path.dirname(resolved));
  const stat = fs.lstatSync(parent);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) {
    throw new OperatorKeyError("Use an existing directory owned by you and not writable by other users.");
  }
  const ancestors = [];
  for (let current = parent; ; current = path.dirname(current)) {
    ancestors.push(current);
    if (current === path.dirname(current)) break;
  }
  // Start at the root: a private parent inside a replaceable ancestor is not
  // safe. Root-owned sticky temporary directories preserve owned children.
  for (const ancestor of ancestors.reverse()) {
    const directory = fs.lstatSync(ancestor);
    const rootSticky = directory.uid === 0 && (directory.mode & 0o1000) !== 0;
    if (!directory.isDirectory() || ![0, process.getuid()].includes(directory.uid) || ((directory.mode & 0o022) !== 0 && !rootSticky)) {
      throw new OperatorKeyError("Use a path whose ancestors are owned by you or root and cannot be replaced by other users.");
    }
    assertNoMacAccessGrants(ancestor, directory);
  }
  return path.join(parent, path.basename(resolved));
}

function parseOperatorKeyFile(content) {
  // Deliberately smaller than either Node's or Next.js's dotenv grammar.
  // Reject ambiguity instead of certifying a general application .env file.
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(content)) {
    throw new OperatorKeyError("Use an ASCII key-only file without control characters.");
  }
  const parsed = {};
  for (const line of content.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^[\t ]*(?:#.*)?$/.test(line)) continue;
    if (/^[\t ]*(?:export[\t ]+)?NEXT_PUBLIC_/.test(line)) {
      throw new OperatorKeyError("Encryption keys must never use NEXT_PUBLIC_ variable names.");
    }
    const match = /^[\t ]*(?:export[\t ]+)?((?:(?:CHAT_)?ENCRYPTION_KEY|LAUNCH_FINGERPRINT_KEY)(?:_LEGACY)?)[\t ]*=[\t ]*(?:([0-9a-fA-F]{64})|'([0-9a-fA-F]{64})'|"([0-9a-fA-F]{64})")[\t ]*(?:#.*)?$/.exec(line);
    if (!match) {
      throw new OperatorKeyError("Use a dedicated key-only file: one NAME=64_HEX_CHARACTERS assignment per line, with optional quotes or comments.");
    }
    if (Object.hasOwn(parsed, match[1])) {
      throw new OperatorKeyError("Encryption key variables must be declared exactly once.");
    }
    parsed[match[1]] = match[2] || match[3] || match[4];
  }
  for (const name of ALL_KEY_NAMES) {
    if (!KEY_NAMES.includes(name) && parsed[name] === undefined) continue;
    if (typeof parsed[name] !== "string" || !/^[0-9a-fA-F]{64}$/.test(parsed[name])) {
      throw new OperatorKeyError(`${name} must contain exactly 64 hexadecimal characters.`);
    }
  }
  if (new Set(KEY_NAMES.map((name) => parsed[name].toLowerCase())).size !== KEY_NAMES.length) {
    throw new OperatorKeyError("Fresh installations require separate secret, chat, and launch-fingerprint keys.");
  }
  return parsed;
}

function bootstrapOperatorKeys(file) {
  if (ALL_KEY_NAMES.some((name) => process.env[name] !== undefined)) {
    throw new OperatorKeyError("Encryption keys are already present in this shell. This command is for a fresh installation, not rotation.");
  }
  const destination = ownerPath(file);
  const secretKey = randomBytes(32).toString("hex");
  const chatKey = randomBytes(32).toString("hex");
  const launchFingerprintKey = randomBytes(32).toString("hex");
  const content = [
    "# Hivra operator encryption keys. Fresh installation only.",
    "# Never replace keys used by an existing database with newly generated keys.",
    "# Keep an encrypted operator-owned backup separate from database backups.",
    `ENCRYPTION_KEY=${secretKey}`,
    `CHAT_ENCRYPTION_KEY=${chatKey}`,
    `LAUNCH_FINGERPRINT_KEY=${launchFingerprintKey}`,
    "",
  ].join("\n");
  parseOperatorKeyFile(content);
  let fd;
  try {
    fd = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.fchmodSync(fd, 0o600);
    assertNoMacAccessGrants(destination, fs.fstatSync(fd));
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new OperatorKeyError("The output already exists. Nothing was overwritten; do not replace an existing installation's keys.");
    }
    if (error instanceof OperatorKeyError) throw error;
    throw new OperatorKeyError("Key-file creation failed. An empty or partial file may remain; inspect it before retrying. No existing file was overwritten.");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return { status: "created", file: destination, variables: KEY_NAMES, scope: "fresh-install encryption keys only" };
}

function readPrivateKeyFile(file) {
  const source = ownerPath(file);
  const fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
      throw new OperatorKeyError("The key file must be an owner-only regular file without hard links (normally chmod 600).");
    }
    assertNoMacAccessGrants(source, stat);
    if (stat.size > MAX_FILE_BYTES) throw new OperatorKeyError("The key file exceeds the 64 KiB limit.");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    try {
      let length = 0;
      while (length < buffer.length) {
        const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
        if (count === 0) break;
        length += count;
      }
      if (length > MAX_FILE_BYTES) throw new OperatorKeyError("The key file exceeds the 64 KiB limit.");
      return { source, content: buffer.toString("utf8", 0, length) };
    } finally {
      buffer.fill(0);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function checkOperatorKeyFile(file) {
  const { source, content } = readPrivateKeyFile(file);
  const parsed = parseOperatorKeyFile(content);
  return {
    status: "valid",
    file: source,
    variables: ALL_KEY_NAMES.filter((name) => parsed[name] !== undefined),
    scope: "key-only file format and local permission checks only; not runtime configuration, database recovery, or rotation acceptance",
  };
}

function main(argv) {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log("Usage: node scripts/operator-keys.cjs init --output PATH\n       node scripts/operator-keys.cjs check --file PATH\nFresh installation only. No overwrite, network access, database mutation, or automatic rotation.");
    return;
  }
  const [command, option, file] = argv;
  if (argv.length !== 3 || !file || !((command === "init" && option === "--output") || (command === "check" && option === "--file"))) {
    throw new OperatorKeyError("Use init --output PATH or check --file PATH. No force/overwrite option exists.");
  }
  const result = command === "init" ? bootstrapOperatorKeys(file) : checkOperatorKeyFile(file);
  console.log(JSON.stringify(result));
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof OperatorKeyError ? error.message : "Cannot safely access the requested key file. Check its path, ownership, and permissions.");
    process.exitCode = 1;
  }
}

module.exports = { bootstrapOperatorKeys, checkOperatorKeyFile, parseOperatorKeyFile };
