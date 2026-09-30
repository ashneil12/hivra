"use strict";
// Detached chat runs.
//
// Each chat turn runs under its own runner process: this file, executed as
// `node chat-runs.cjs --run <dir>`. The runner is a session leader. It owns the
// agent CLI, appends the exact NDJSON stream the gateway used to write straight
// to the HTTP response to <dir>/events.ndjson, and records the outcome in
// <dir>/status.json. The gateway only tails that log. A browser that goes away
// (tab closed, laptop asleep, network drop) therefore no longer ends the turn;
// only an explicit stop does, and a reconnecting client replays the log.
//
// The gateway unit runs with KillMode=process so a gateway restart (runtime
// update, crash) leaves in-flight runners alone. The restarted gateway reads
// their state from disk; a runner that died without recording an outcome is
// closed out as interrupted the next time anyone looks at it.
//
// Files in a run directory (0700, owned by the agent user):
//   spec.json      what to execute (binary, argv, cwd, stream shape). No secrets:
//                  credentials reach the CLI only through the inherited env.
//   prompt         the prompt for stdin-driven CLIs, removed once read
//   meta.json      who started it (client reference, resume id, title)
//   status.json    starting | running | finished, pids, exit code, stop reason
//   events.ndjson  the stream, ending with {"type":"_done",...}
//   stop           present once a stop was requested
//   runner.log     the runner's own stderr, for diagnosis

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { StringDecoder } = require("string_decoder");

const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CLIENT_REF_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const RESUME_ID_RE = /^[0-9a-f-]{8,}$/i;
const STOP_REASONS = new Set(["user", "disconnect"]);
// A SIGTERM without a stop marker comes from the OS or service manager
// (shutdown, a unit still on KillMode=control-group), not from a person.
const SHUTDOWN = "shutdown";
// SIGTERM first so the CLI can flush its transcript; SIGKILL the whole process
// group if it has not exited by then.
const STOP_GRACE_MS = 5000;
// A CLI that exited but whose stdout is still held open by a background child
// it spawned would otherwise keep the run "running" forever.
const EXIT_DRAIN_MS = 10000;
// A runner that has not reported in by then never started.
const START_DEADLINE_MS = 60000;

class ChatRunError extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function writeJsonAtomic(file, value) {
  const tmp = file + ".tmp-" + process.pid + "-" + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(tmp, JSON.stringify(value) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function signalGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch {} }
}

// ---- runner (a separate, detached process per run) --------------------------

function runMain(dir) {
  const spec = readJson(path.join(dir, "spec.json"));
  if (!spec || spec.version !== 1 || typeof spec.bin !== "string" || !Array.isArray(spec.args)) {
    throw new Error("chat run spec is missing or invalid: " + dir);
  }
  const eventsFd = fs.openSync(path.join(dir, "events.ndjson"), "a", 0o600);
  const append = (line) => { fs.writeSync(eventsFd, line + "\n"); };
  const emit = (event) => append(JSON.stringify(event));
  const statusFile = path.join(dir, "status.json");
  const startedAt = new Date().toISOString();
  let prompt = null;
  if (spec.stdin) {
    const promptFile = path.join(dir, "prompt");
    prompt = fs.readFileSync(promptFile);
    fs.rmSync(promptFile, { force: true });
  }

  let child = null;
  let stopReason = null;
  let finished = false;
  let killTimer = null;
  let drainTimer = null;
  let exitCode = null;
  let exitSignal = null;
  let obuf = "";

  function finish(outcome) {
    if (finished) return;
    finished = true;
    clearTimeout(killTimer);
    clearTimeout(drainTimer);
    if (!spec.textMode && obuf.trim()) append(obuf);
    const done = { type: "_done", code: outcome.code };
    if (outcome.signal) done.signal = outcome.signal;
    if (stopReason === SHUTDOWN) done.interrupted = true;
    else if (stopReason) done.stopped = stopReason;
    emit(done);
    fs.closeSync(eventsFd);
    writeJsonAtomic(statusFile, {
      state: "finished", runnerPid: process.pid, cliPid: child && child.pid ? child.pid : null,
      startedAt, finishedAt: new Date().toISOString(),
      code: outcome.code, signal: outcome.signal || null,
      stopped: stopReason === SHUTDOWN ? null : stopReason, interrupted: stopReason === SHUTDOWN, error: outcome.error || null,
    });
    process.exit(0);
  }
  function requestStop(reason) {
    if (finished) return;
    if (!stopReason) stopReason = reason;
    if (!child || !child.pid) return;
    signalGroup(child.pid, "SIGTERM");
    if (!killTimer) killTimer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), STOP_GRACE_MS);
  }
  const stopFromMarker = () => {
    const marker = readJson(path.join(dir, "stop"));
    requestStop(!marker ? SHUTDOWN : STOP_REASONS.has(marker.reason) ? marker.reason : "user");
  };
  process.on("SIGTERM", stopFromMarker);
  process.on("SIGINT", stopFromMarker);
  // The runner has no controlling terminal; a stray hangup must not end a run.
  process.on("SIGHUP", () => {});

  // Publish our pid BEFORE looking for a stop marker. The gateway writes the
  // marker BEFORE reading our pid, so a stop is always seen by one side.
  writeJsonAtomic(statusFile, { state: "running", runnerPid: process.pid, cliPid: null, startedAt });
  if (fs.existsSync(path.join(dir, "stop"))) {
    const marker = readJson(path.join(dir, "stop"));
    stopReason = STOP_REASONS.has(marker && marker.reason) ? marker.reason : "user";
    return finish({ code: null });
  }

  // Own process group: a stop reaches the CLI and every tool process it
  // started in that group, while this runner survives to record the outcome.
  child = spawn(spec.bin, spec.args, { cwd: spec.cwd, env: process.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  writeJsonAtomic(statusFile, { state: "running", runnerPid: process.pid, cliPid: child.pid || null, startedAt });
  // A fast-exiting CLI can close stdin before the prompt write lands.
  child.stdin.on("error", () => {});
  if (prompt) child.stdin.write(prompt);
  child.stdin.end();

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text) => {
    if (spec.textMode) {
      // Generic agent: no structured output. Each stdout chunk becomes one
      // {type:"_text"} line so the browser renders it as live text.
      emit({ type: "_text", text });
      return;
    }
    obuf += text;
    let idx;
    while ((idx = obuf.indexOf("\n")) >= 0) {
      const line = obuf.slice(0, idx); obuf = obuf.slice(idx + 1);
      if (line.trim()) append(line);
    }
  });
  child.stderr.on("data", (text) => emit({ type: "_stderr", text }));
  child.on("exit", (code, signal) => {
    exitCode = code; exitSignal = signal;
    drainTimer = setTimeout(() => finish({ code: exitCode, signal: exitSignal }), EXIT_DRAIN_MS);
  });
  child.on("close", (code, signal) => finish({ code: code === null ? exitCode : code, signal: signal || exitSignal }));
  child.on("error", (error) => {
    emit({ type: "_stderr", text: "spawn error: " + error.message });
    finish({ code: null, error: error.message });
  });
}

// ---- store (inside the gateway) --------------------------------------------

function defaultRunnerAlive(pid, dir) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); } catch (error) { return Boolean(error && error.code === "EPERM"); }
  // Guard against pid reuse: the live process must be this run's runner.
  try {
    const cmdline = fs.readFileSync("/proc/" + pid + "/cmdline", "utf8");
    return cmdline.includes("--run") && cmdline.includes(dir);
  } catch {
    return true; // no procfs (tests on a non-Linux host): trust the signal probe
  }
}

function createChatRunStore(options) {
  const root = path.resolve(options.root);
  const nodeBin = options.nodeBin || process.execPath;
  const runnerPath = options.runnerPath || __filename;
  const spawnImpl = options.spawn || spawn;
  const runnerAlive = options.runnerAlive || defaultRunnerAlive;
  const maxActive = options.maxActive || 8;
  const retainMs = options.retainMs || 7 * 24 * 60 * 60 * 1000;
  const retainCount = options.retainCount || 100;
  const pollMs = options.pollMs || 250;
  const heartbeatMs = options.heartbeatMs || 15000;
  const now = options.now || (() => Date.now());
  const sessionIdCache = new Map();

  // Created lazily so merely loading the gateway never touches the disk.
  function ensureRoot() {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  function dirFor(runId) {
    if (!RUN_ID_RE.test(String(runId))) return null;
    return path.join(root, runId);
  }
  function readRecord(runId) {
    const dir = dirFor(runId);
    if (!dir) return null;
    const meta = readJson(path.join(dir, "meta.json"));
    if (!meta) return null;
    const status = readJson(path.join(dir, "status.json")) || { state: "starting" };
    return { dir, meta, status };
  }
  function isActive(record) {
    return record.status.state !== "finished";
  }
  // Close out a run whose runner is gone without an outcome (killed with the
  // whole service before KillMode=process was installed, OOM, reboot).
  function reconcile(record) {
    if (!isActive(record)) return record;
    const { status, meta, dir } = record;
    let alive;
    if (status.state === "running") alive = runnerAlive(status.runnerPid, dir);
    else alive = now() - Date.parse(meta.createdAt) < START_DEADLINE_MS;
    if (alive) return record;
    const latest = readJson(path.join(dir, "status.json")) || status;
    if (latest.state === "finished") return { ...record, status: latest };
    const lines = JSON.stringify({ type: "_stderr", text: "The agent run ended without reporting a result (the computer or its chat service restarted while it was working)." })
      + "\n" + JSON.stringify({ type: "_done", code: null, interrupted: true }) + "\n";
    fs.appendFileSync(path.join(dir, "events.ndjson"), lines, { mode: 0o600 });
    const finishedStatus = { ...latest, state: "finished", finishedAt: new Date(now()).toISOString(), code: null, interrupted: true };
    writeJsonAtomic(path.join(dir, "status.json"), finishedStatus);
    return { ...record, status: finishedStatus };
  }
  function allRecords() {
    let names = [];
    try { names = fs.readdirSync(root); } catch { return []; }
    const records = [];
    for (const name of names) {
      if (!RUN_ID_RE.test(name)) continue;
      const record = readRecord(name);
      if (record) records.push(reconcile(record));
    }
    return records.sort((a, b) => Date.parse(b.meta.createdAt) - Date.parse(a.meta.createdAt));
  }
  function prune(records) {
    const finished = records.filter((record) => !isActive(record));
    finished.forEach((record, index) => {
      const endedAt = Date.parse(record.status.finishedAt || record.meta.createdAt);
      if (index >= retainCount || now() - endedAt > retainMs) {
        fs.rmSync(record.dir, { recursive: true, force: true });
        sessionIdCache.delete(record.meta.runId);
      }
    });
  }
  // The agent's own conversation id (claude session_id / codex thread_id) is
  // the first thing each CLI prints. Exposing it lets another device match a
  // running turn to the conversation it already lists from the box history.
  function agentSessionId(record) {
    const cached = sessionIdCache.get(record.meta.runId);
    if (cached) return cached;
    let head = "";
    try {
      const fd = fs.openSync(path.join(record.dir, "events.ndjson"), "r");
      try {
        const buffer = Buffer.alloc(16 * 1024);
        head = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
      } finally { fs.closeSync(fd); }
    } catch {}
    const match = head.match(/"(?:session_id|thread_id)"\s*:\s*"([0-9a-f-]{8,})"/i);
    const id = match ? match[1] : record.meta.resumeSessionId || null;
    if (match) sessionIdCache.set(record.meta.runId, id);
    return id;
  }
  function summary(record) {
    const { meta, status } = record;
    return {
      runId: meta.runId,
      clientRef: meta.clientRef || null,
      agentKind: meta.agentKind || null,
      title: meta.title || "",
      detached: meta.detached === true,
      state: status.state === "finished" ? "finished" : "running",
      createdAt: meta.createdAt,
      startedAt: status.startedAt || null,
      finishedAt: status.finishedAt || null,
      code: status.state === "finished" ? status.code : null,
      stopped: status.stopped || null,
      interrupted: status.interrupted === true,
      resumeSessionId: meta.resumeSessionId || null,
      agentSessionId: agentSessionId(record),
    };
  }

  function start(input) {
    ensureRoot();
    const runId = input.runId === undefined || input.runId === null || input.runId === ""
      ? crypto.randomUUID() : String(input.runId).toLowerCase();
    if (!RUN_ID_RE.test(runId)) throw new ChatRunError("invalid_run_id", 400, "runId must be a UUID");
    if (input.clientRef != null && !CLIENT_REF_RE.test(String(input.clientRef))) {
      throw new ChatRunError("invalid_client_ref", 400, "clientRef is not valid");
    }
    // Idempotent: repeating a start (a retried request) attaches to the run.
    const existing = readRecord(runId);
    if (existing) return { record: reconcile(existing), created: false };
    // The caller may hold new runs back (for example while the agent CLI is
    // being swapped for a new version); re-attaching above is never refused.
    const refusal = typeof input.admit === "function" ? input.admit() : null;
    if (refusal) throw new ChatRunError(refusal.code, refusal.status, refusal.message);
    const records = allRecords();
    prune(records);
    const active = records.filter(isActive);
    if (active.length >= maxActive) {
      throw new ChatRunError("too_many_runs", 429, "The agent is already working on " + active.length + " conversations. Stop one or wait for it to finish.");
    }
    const resumeSessionId = input.resumeSessionId && RESUME_ID_RE.test(input.resumeSessionId) ? input.resumeSessionId : null;
    if (resumeSessionId && active.some((record) => record.meta.resumeSessionId === resumeSessionId || agentSessionId(record) === resumeSessionId)) {
      throw new ChatRunError("conversation_busy", 409, "This conversation is still working on the previous message.");
    }
    const dir = path.join(root, runId);
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) {
      if (error && error.code === "EEXIST") return { record: reconcile(readRecord(runId)), created: false };
      throw error;
    }
    const meta = {
      version: 1, runId, clientRef: input.clientRef == null ? null : String(input.clientRef), resumeSessionId,
      agentKind: input.agentKind || null, title: String(input.title || "").slice(0, 120),
      detached: input.detached === true, createdAt: new Date(now()).toISOString(),
    };
    const stdinText = typeof input.stdinText === "string" ? input.stdinText : null;
    writeJsonAtomic(path.join(dir, "spec.json"), {
      version: 1, bin: input.bin, args: input.args, cwd: input.cwd, textMode: input.textMode === true, stdin: stdinText !== null,
    });
    if (stdinText !== null) fs.writeFileSync(path.join(dir, "prompt"), stdinText, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "events.ndjson"), "", { mode: 0o600 });
    writeJsonAtomic(path.join(dir, "meta.json"), meta);
    writeJsonAtomic(path.join(dir, "status.json"), { state: "starting" });
    const logFd = fs.openSync(path.join(dir, "runner.log"), "a", 0o600);
    let runner;
    try {
      runner = spawnImpl(nodeBin, [runnerPath, "--run", dir], {
        cwd: input.cwd, env: input.env, detached: true, stdio: ["ignore", "ignore", logFd],
      });
    } finally { fs.closeSync(logFd); }
    runner.on("error", (error) => {
      const status = readJson(path.join(dir, "status.json"));
      if (status && status.state !== "starting") return;
      fs.appendFileSync(path.join(dir, "events.ndjson"),
        JSON.stringify({ type: "_stderr", text: "spawn error: " + error.message }) + "\n"
        + JSON.stringify({ type: "_done", code: null }) + "\n");
      writeJsonAtomic(path.join(dir, "status.json"), { state: "finished", finishedAt: new Date(now()).toISOString(), code: null, error: error.message });
    });
    if (typeof runner.unref === "function") runner.unref();
    return { record: readRecord(runId), created: true };
  }

  function get(runId) {
    const record = readRecord(runId);
    return record ? summary(reconcile(record)) : null;
  }
  function list() {
    ensureRoot();
    return allRecords().slice(0, 50).map(summary);
  }
  function stop(runId, reason) {
    const record = readRecord(runId);
    if (!record) return null;
    const current = reconcile(record);
    if (!isActive(current)) return summary(current);
    // Marker first, then read the pid (see runMain for the ordering argument).
    writeJsonAtomic(path.join(current.dir, "stop"), { reason: STOP_REASONS.has(reason) ? reason : "user", at: new Date(now()).toISOString() });
    const status = readJson(path.join(current.dir, "status.json")) || current.status;
    if (status.state === "running" && runnerAlive(status.runnerPid, current.dir)) {
      // The runner may exit between the probe and the signal; it then records its own outcome.
      try { process.kill(status.runnerPid, "SIGTERM"); } catch {}
    }
    return summary(readRecord(runId));
  }

  // Stream a run's events to an HTTP response from `offset` until the run
  // finishes. Writes only whole lines, honours back-pressure, and sends a
  // `_ping` line when idle so proxies do not time the stream out. Closing the
  // response only stops the tail; `onClientClose` decides what that means.
  function stream(runId, res, opts) {
    const options2 = opts || {};
    const record = readRecord(runId);
    if (!record) return false;
    const file = path.join(record.dir, "events.ndjson");
    const fd = fs.openSync(file, "r");
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.alloc(64 * 1024);
    let position = Math.max(0, Number(options2.offset) || 0);
    let pending = "";
    let closed = false;
    let ended = false;
    let waiting = false;
    let timer = null;
    let watcher = null;
    let lastWrite = now();
    const cleanup = () => {
      closed = true;
      clearTimeout(timer);
      if (watcher) { try { watcher.close(); } catch {} }
      try { fs.closeSync(fd); } catch {}
    };
    const drain = () => {
      let read;
      while (!closed && (read = fs.readSync(fd, buffer, 0, buffer.length, position)) > 0) {
        position += read;
        pending += decoder.write(buffer.subarray(0, read));
        const cut = pending.lastIndexOf("\n");
        if (cut < 0) continue;
        const chunk = pending.slice(0, cut + 1);
        pending = pending.slice(cut + 1);
        lastWrite = now();
        if (!res.write(chunk)) return false; // resume on 'drain'
      }
      return true;
    };
    const schedule = (ms) => {
      if (closed || ended) return;
      clearTimeout(timer);
      timer = setTimeout(pump, ms);
    };
    function pump() {
      try { pumpOnce(); } catch (error) {
        // A read failure ends this viewer only; the run itself is unaffected.
        if (options2.onError) options2.onError(error);
        if (!closed) { cleanup(); res.end(); }
      }
    }
    function pumpOnce() {
      if (closed || ended || waiting) return;
      if (!drain()) { waiting = true; return; }
      const current = reconcile(readRecord(runId) || record);
      if (!isActive(current)) {
        // The runner writes _done before its final status, so one more read
        // after seeing "finished" collects everything.
        if (!drain()) { waiting = true; return; }
        ended = true;
        cleanup();
        res.end(pending ? pending + "\n" : undefined);
        if (options2.onEnd) options2.onEnd(summary(current));
        return;
      }
      if (now() - lastWrite >= heartbeatMs) { lastWrite = now(); res.write(JSON.stringify({ type: "_ping" }) + "\n"); }
      schedule(pollMs);
    }
    res.on("drain", () => { if (waiting) { waiting = false; schedule(0); } });
    res.on("close", () => {
      if (ended) return;
      cleanup();
      if (options2.onClientClose) options2.onClientClose();
    });
    try { watcher = fs.watch(file, { persistent: false }, () => schedule(0)); } catch {}
    if (options2.preface) res.write(JSON.stringify(options2.preface) + "\n");
    schedule(0);
    return true;
  }

  return { start, get, list, stop, stream };
}

module.exports = { createChatRunStore, ChatRunError, RUN_ID_RE, runMain };

if (require.main === module && process.argv[2] === "--run" && process.argv[3]) {
  runMain(path.resolve(process.argv[3]));
}
