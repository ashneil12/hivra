// Runs in an offline, installation-owned storage-volume helper. Framed JSON
// avoids extracting operator-controlled archive paths through a system tar.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const FORMAT = "hivra-storage-files-v1";
const MAX_LINE = 128 * 1024;
const CHUNK = 64 * 1024;
const MAX_ENTRIES = 1_000_000;

function fail(code = "INVALID") { throw new Error(`HIVRA_STORAGE_${code}`); }
function safeFailure(error) {
  return /^HIVRA_STORAGE_[A-Z_]+$/.test(error?.message || "") ? error.message
    : /^[A-Z0-9_]+$/.test(error?.code || "") ? `HIVRA_STORAGE_FILESYSTEM_${error.code}` : "HIVRA_STORAGE_INVALID";
}
function safeRelative(value) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 4096 ||
      value.includes("\0") || value.includes("\\") ||
      value.split("/").some(part => !part || part === "." || part === "..")) fail();
  return value;
}
async function writeRecord(output, record) {
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line) > MAX_LINE) fail();
  await new Promise((resolve, reject) => output.write(line, error => error ? reject(error) : resolve()));
}
async function* records(input) {
  let pending = Buffer.alloc(0);
  for await (const chunk of input) {
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(10)) !== -1) {
      if (end > MAX_LINE) fail();
      const line = pending.subarray(0, end);
      pending = pending.subarray(end + 1);
      yield JSON.parse(line.toString("utf8"));
    }
    if (pending.length > MAX_LINE) fail();
  }
  if (pending.length) fail();
}
async function assertRoot(root) {
  const metadata = await fsp.lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await fsp.realpath(root) !== root) fail();
}
async function pack(root, output) {
  await assertRoot(root);
  await writeRecord(output, { format: FORMAT });
  let entries = 0, files = 0, bytes = 0;
  async function visit(relative) {
    for (const name of (await fsp.readdir(path.join(root, relative))).sort()) {
      const entry = safeRelative(relative ? `${relative}/${name}` : name);
      const absolute = path.join(root, entry);
      const metadata = await fsp.lstat(absolute);
      if (++entries > MAX_ENTRIES) fail();
      if (metadata.isDirectory()) {
        await writeRecord(output, { type: "directory", path: entry });
        await visit(entry);
      } else if (metadata.isFile() && metadata.nlink === 1 && Number.isSafeInteger(metadata.size)) {
        await writeRecord(output, { type: "file", path: entry, bytes: metadata.size });
        const digest = createHash("sha256");
        let observed = 0;
        const stream = fs.createReadStream(absolute, { highWaterMark: CHUNK, flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW });
        for await (const chunk of stream) {
          observed += chunk.length;
          if (observed > metadata.size) fail();
          digest.update(chunk);
          await writeRecord(output, { type: "chunk", data: chunk.toString("base64") });
        }
        if (observed !== metadata.size) fail();
        await writeRecord(output, { type: "file-end", sha256: digest.digest("hex") });
        files += 1; bytes += observed;
        if (!Number.isSafeInteger(bytes)) fail();
      } else fail(); // No symlinks, hardlinks, sockets, devices or FIFOs.
    }
  }
  await visit("");
  await writeRecord(output, { type: "end", entries, files, bytes });
}
async function unpack(root, input) {
  await assertRoot(root);
  // The pinned local storage service creates an empty /mnt/stub at startup.
  // Permit only that verified bootstrap directory, never existing object data.
  const existing = await fsp.readdir(root);
  let bootstrapDirectory = false;
  if (existing.length) {
    if (existing.length !== 1 || existing[0] !== "stub") fail("TARGET_NOT_EMPTY");
    const stub = path.join(root, "stub");
    const metadata = await fsp.lstat(stub);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await fsp.readdir(stub)).length) fail("TARGET_NOT_EMPTY");
    bootstrapDirectory = true;
  }
  let started = false, ended = false, entries = 0, files = 0, bytes = 0, active;
  const seen = new Set();
  try {
    for await (const record of records(input)) {
      if (ended || !record || typeof record !== "object") fail();
      if (!started) { if (record.format !== FORMAT) fail(); started = true; continue; }
      if (record.type === "chunk") {
        if (!active || typeof record.data !== "string" || record.data.length > 87384) fail();
        const chunk = Buffer.from(record.data, "base64");
        if (!chunk.length || chunk.toString("base64") !== record.data || chunk.length > CHUNK) fail();
        active.observed += chunk.length;
        if (active.observed > active.expected) fail();
        active.digest.update(chunk);
        await active.handle.writeFile(chunk);
      } else if (record.type === "file-end") {
        if (!active || active.observed !== active.expected || record.sha256 !== active.digest.digest("hex")) fail();
        await active.handle.close();
        files += 1; bytes += active.observed; active = undefined;
        if (!Number.isSafeInteger(bytes)) fail();
      } else {
        if (active) fail();
        if (record.type === "end") {
          if (record.entries !== entries || record.files !== files || record.bytes !== bytes) fail();
          ended = true; continue;
        }
        if (++entries > MAX_ENTRIES) fail();
        const relative = safeRelative(record.path);
        if (seen.has(relative)) fail();
        seen.add(relative);
        const absolute = path.join(root, relative);
        if (record.type === "directory") {
          if (!(bootstrapDirectory && relative === "stub")) await fsp.mkdir(absolute, { mode: 0o700 });
        } else if (record.type === "file" && Number.isSafeInteger(record.bytes) && record.bytes >= 0) {
          active = { handle: await fsp.open(absolute, "wx", 0o600), expected: record.bytes, observed: 0, digest: createHash("sha256") };
        } else fail();
      }
    }
    if (!started || !ended || active) fail();
  } finally { if (active) await active.handle.close(); }
}
async function main(args) {
  const [operation, root] = args;
  if (args.length !== 2 || !path.isAbsolute(root || "")) fail();
  if (operation === "pack") await pack(root, process.stdout);
  else if (operation === "unpack") await unpack(root, process.stdin);
  else fail();
}
module.exports = { main, pack, unpack };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${safeFailure(error)}\n`);
  process.exitCode = 1;
});
