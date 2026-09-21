"use strict";

// Private guest primitive. The authenticated gateway is the single writer;
// the control plane owns operation admission and settlement. This module never
// contacts a model provider or treats configuration as successful inference.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const PROTOCOL = "hivra-llm-apply-v1";
const MAX_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MODEL = /^[A-Za-z0-9._:\/\[\]-]{1,64}$/;
const BASE_URL = /^https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._\/-]*)?$/;
const KEY = /^[\x21-\x7e]{8,256}$/;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).sort().join(",") === keys.slice().sort().join(",");

class LlmApplicationError extends Error {
  constructor(code) {
    super("Model settings operation failed: " + code);
    this.name = "LlmApplicationError";
    this.code = code;
  }
}

function payload(value, legacy = false) {
  if (value === null) return null;
  const keys = ["provider", "baseUrl", "apiKey", "model"];
  if (!record(value) || value.provider !== "venice"
    || !(exact(value, keys) || (legacy && exact(value, keys.filter(key => key !== "model"))))
    || typeof value.baseUrl !== "string" || value.baseUrl.length > 2048 || !BASE_URL.test(value.baseUrl)
    || typeof value.apiKey !== "string" || !KEY.test(value.apiKey)
    || !(value.model === null || (legacy && (value.model === "" || value.model === undefined))
      || (typeof value.model === "string" && MODEL.test(value.model)))) {
    throw new LlmApplicationError("invalid_request");
  }
  const url = new URL(value.baseUrl);
  if (url.hostname.endsWith(".") || url.username || url.password || url.search || url.hash) {
    throw new LlmApplicationError("invalid_request");
  }
  return { provider: "venice", baseUrl: value.baseUrl.replace(/\/+$/, ""), apiKey: value.apiKey, model: value.model || null };
}

function createLlmApplicationStore({ directory, apiToken, runtime, io = fs }) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)
    || typeof apiToken !== "string" || !DIGEST.test(apiToken)) throw new LlmApplicationError("invalid_configuration");
  const file = path.join(directory, "llm-provider.json");
  const mac = (domain, value) => crypto.createHmac("sha256", apiToken).update(PROTOCOL + "\0" + domain + "\0" + value).digest("hex");
  const digestPayload = (operationId, previousStateDigest, value) => mac("payload", JSON.stringify({ operationId, previousStateDigest, payload: value }));

  function checkDirectory() {
    try { io.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = io.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
      || (stat.mode & 0o022) || io.realpathSync(directory) !== path.resolve(directory)) throw new Error();
    // Also flush an existing directory left by a previous process that crashed
    // after mkdir but before syncing its parent.
    syncPath(path.dirname(directory));
  }

  function syncPath(target) {
    const fd = io.openSync(target, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
  }
  const syncDirectory = () => syncPath(directory);

  function cleanupPending() {
    checkDirectory();
    const pending = [], entries = io.opendirSync(directory);
    let scanned = 0;
    try {
      let entry;
      while ((entry = entries.readSync()) !== null) {
        if (++scanned > 1024) throw new Error();
        const prefix = ".llm-provider.json.pending-", name = entry.name;
        if (!name.startsWith(prefix) || !UUID.test(name.slice(prefix.length))) continue;
        if (pending.length >= 128) throw new Error();
        const temporary = path.join(directory, name), stat = io.lstatSync(temporary);
        // This exact private namespace belongs to the gateway's single writer.
        // Do not follow links or remove an unexpected file on recovery.
        if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()
          || stat.nlink !== 1 || (stat.mode & 0o077)) throw new Error();
        pending.push(temporary);
      }
    } finally { entries.closeSync(); }
    for (const temporary of pending) {
      io.unlinkSync(temporary);
    }
    if (pending.length) syncDirectory();
  }

  function readState() {
    checkDirectory();
    let raw = null, fd;
    try {
      fd = io.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = io.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1
        || (stat.mode & 0o077) || stat.size > MAX_BYTES) throw new Error();
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = io.readSync(fd, buffer, length, buffer.length - length, length);
        if (count === 0) break;
        length += count;
      }
      const after = io.fstatSync(fd);
      if (length > MAX_BYTES || length !== stat.size || after.size !== stat.size
        || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error();
      raw = buffer.subarray(0, length).toString("utf8");
      // A recovered receipt is durable only after its file and parent directory
      // have been flushed, even if the original writer lost its acknowledgement.
      io.fsyncSync(fd);
    } catch (error) {
      if (fd !== undefined || error.code !== "ENOENT") throw error;
    } finally { if (fd !== undefined) io.closeSync(fd); }
    syncDirectory();
    if (raw === null) return { raw, payload: null, application: null };
    const stored = JSON.parse(raw);
    if (!record(stored)) throw new Error();
    const application = stored._hivraApplication;
    const value = { ...stored };
    delete value._hivraApplication;
    const currentPayload = exact(value, ["provider"]) && value.provider === null
      ? null : payload(value, true);
    if (application !== undefined) {
      if (!exact(application, ["protocol", "operationId", "previousStateDigest", "payloadDigest"])
        || application.protocol !== PROTOCOL || typeof application.operationId !== "string" || !UUID.test(application.operationId)
        || typeof application.previousStateDigest !== "string" || !DIGEST.test(application.previousStateDigest)
        || application.payloadDigest !== digestPayload(application.operationId, application.previousStateDigest, currentPayload)) throw new Error();
    }
    return { raw, payload: currentPayload, application: application || null };
  }

  function receipt(state) {
    return { protocol: PROTOCOL, stateDigest: mac("state", state.raw === null ? "absent" : "record:" + state.raw),
      operationId: state.application?.operationId || null, payloadDigest: state.application?.payloadDigest || null,
      provider: state.payload?.provider || null, model: state.payload?.model || null };
  }

  function inspect() {
    return receipt(checkedRead());
  }

  function publish(stored, previous) {
    let temporary, fd, created = false, renameAttempted = false;
    try {
      const bytes = Buffer.from(JSON.stringify(stored) + "\n");
      if (bytes.length > MAX_BYTES) throw new LlmApplicationError("invalid_request");
      // Keep temporary credentials behind the existing file-browser secret
      // filter too, including an interrupted write that needs later cleanup.
      temporary = path.join(directory, ".llm-provider.json.pending-" + crypto.randomUUID());
      fd = io.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      created = true;
      io.writeFileSync(fd, bytes);
      io.fsyncSync(fd);
      io.closeSync(fd); fd = undefined;
      // Catch edits observed during preparation. This is not a filesystem CAS
      // against arbitrary external writers; the gateway remains single-writer.
      if (readState().raw !== previous.raw) throw new LlmApplicationError("state_conflict");
      renameAttempted = true;
      io.renameSync(temporary, file);
      created = false;
      syncDirectory();
      cleanupPending();
      const observed = readState();
      if (observed.raw !== bytes.toString("utf8")) throw new Error();
      return receipt(observed);
    } catch (error) {
      if (renameAttempted) throw new LlmApplicationError("outcome_unknown");
      if (error instanceof LlmApplicationError && ["state_conflict", "operation_conflict", "invalid_request"].includes(error.code)) throw error;
      throw new LlmApplicationError("storage_unavailable");
    } finally {
      if (fd !== undefined) { try { io.closeSync(fd); } catch {} }
      if (created) { try { io.unlinkSync(temporary); } catch {} }
    }
  }

  function checkedRead() {
    if (runtime !== "codex") throw new LlmApplicationError("unsupported_runtime");
    try { cleanupPending(); return readState(); }
    catch { throw new LlmApplicationError("storage_unavailable"); }
  }

  function apply(input) {
    if (runtime !== "codex") throw new LlmApplicationError("unsupported_runtime");
    if (!exact(input, ["protocol", "operationId", "expectedStateDigest", "payload"])
      || input.protocol !== PROTOCOL || typeof input.operationId !== "string" || !UUID.test(input.operationId)
      || typeof input.expectedStateDigest !== "string" || !DIGEST.test(input.expectedStateDigest)) {
      throw new LlmApplicationError("invalid_request");
    }
    let value;
    try { value = payload(input.payload); }
    catch { throw new LlmApplicationError("invalid_request"); }
    const payloadDigest = digestPayload(input.operationId, input.expectedStateDigest, value);
    const previous = checkedRead();
    if (previous.application?.operationId === input.operationId) {
      if (previous.application.payloadDigest !== payloadDigest
        || previous.application.previousStateDigest !== input.expectedStateDigest) throw new LlmApplicationError("operation_conflict");
      return receipt(previous); // No new write on an identical replay.
    }
    if (receipt(previous).stateDigest !== input.expectedStateDigest) throw new LlmApplicationError("state_conflict");
    return publish({ ...(value || { provider: null }), _hivraApplication: {
      protocol: PROTOCOL, operationId: input.operationId, previousStateDigest: input.expectedStateDigest, payloadDigest,
    } }, previous);
  }

  // Compatibility for explicit legacy settings actions only. Once the control
  // plane adopts v1, its receipt cannot be erased by the old browser write path.
  // There is no exactly-once/reconciliation claim for legacy calls.
  function applyLegacy(input) {
    if (runtime !== "codex") throw new LlmApplicationError("unsupported_runtime");
    let value;
    try { value = payload(input, true); }
    catch { throw new LlmApplicationError("invalid_request"); }
    const previous = checkedRead();
    if (previous.application) throw new LlmApplicationError("application_protocol_required");
    return publish(value || { provider: null }, previous);
  }

  // Internal runtime accessor, never an HTTP response. Invalid storage must not
  // silently switch a turn back to a different model credential/provider.
  const readProvider = () => checkedRead().payload;
  return { inspect, apply, applyLegacy, readProvider };
}

module.exports = { PROTOCOL, createLlmApplicationStore, LlmApplicationError };
