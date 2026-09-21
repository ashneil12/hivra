'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const VERSION = '0.1.2-alpha.2';
const brokerOwners = new WeakMap();
const portOwners = new Map();
const homeOwners = new Map();

function privateHome(directory) {
  if (!path.isAbsolute(directory)) throw new Error('deepseek_home_invalid');
  fs.mkdirSync(directory, { mode: 0o700, recursive: false });
}

function assertPrivateHome(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o077) !== 0 || fs.realpathSync(directory) !== directory) {
    throw new Error('deepseek_home_not_private');
  }
}

async function portOpen(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => {
      if (error.code === 'ECONNREFUSED') resolve(false);
      else reject(new Error('deepseek_socket_probe_inconclusive'));
    });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('deepseek_socket_probe_inconclusive')); });
  });
}

function groupExists(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw new Error('deepseek_group_probe_inconclusive'); }
}

async function waitForGroup(pid, milliseconds) {
  const end = performance.now() + milliseconds;
  while (groupExists(pid)) {
    if (performance.now() >= end) return false;
    await delay(50);
  }
  return true;
}

/**
 * Non-root Linux guest owner for the pinned upstream process. Raw stdout and
 * stderr are intentionally never logged or returned: startup stdout contains
 * bearer-equivalent native login material. A systemd cgroup/VM still supplies
 * the outer security boundary; this helper is not a sandbox.
 */
async function startRuntime({ runtimeDirectory, home, broker, port = 3080, startupTimeoutMs = 90000, signal, onUnexpectedExit = () => {} }) {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() === 0) {
    throw new Error('deepseek_requires_nonroot_linux_guest');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1) {
    throw new Error('deepseek_start_options_invalid');
  }
  if (signal?.aborted) throw new Error('deepseek_start_cancelled');
  const directory = path.resolve(runtimeDirectory);
  const packageDirectory = path.join(directory, 'node_modules/@deepseek-ai/dsh');
  const upstreamPackage = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
  if (upstreamPackage.name !== '@deepseek-ai/dsh' || upstreamPackage.version !== VERSION) throw new Error('deepseek_package_pin_mismatch');
  if (!path.isAbsolute(home)) throw new Error('deepseek_home_invalid');
  try { privateHome(home); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  assertPrivateHome(home);
  const dshHome = path.join(home, '.dsh');
  try { privateHome(dshHome); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  assertPrivateHome(dshHome);
  // Single supervisor process owns one guest; the service/cgroup owner must
  // additionally serialize across processes. A port probe alone is not a lock.
  if (brokerOwners.has(broker) || portOwners.has(port) || homeOwners.has(home)) throw new Error('deepseek_runtime_already_owned');
  const owner = Symbol('deepseek-runtime');
  brokerOwners.set(broker, owner); portOwners.set(port, owner); homeOwners.set(home, owner);
  function releaseOwner() {
    if (brokerOwners.get(broker) === owner) brokerOwners.delete(broker);
    if (portOwners.get(port) === owner) portOwners.delete(port);
    if (homeOwners.get(home) === owner) homeOwners.delete(home);
  }
  try {
    if (await portOpen(port)) throw new Error('deepseek_port_already_owned');
    if (signal?.aborted) throw new Error('deepseek_start_cancelled');
  }
  catch (error) { releaseOwner(); throw error; }
  broker.reset();
  // The pinned loader's native internal-module fallback fails on the tested
  // Node 24 build; explicitly expose internals for its HMR service. This is a
  // launcher compatibility flag, not an upstream source modification or a
  // sandbox boundary (the runtime already executes arbitrary guest code).
  const child = spawn(process.execPath, ['--expose-internals', path.join(packageDirectory, 'lib/bin.js'), '--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)], {
    cwd: home, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    // Inherited API keys would override native-editable credentials. Never pass
    // launcher secrets, host tokens or an operator's complete environment.
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, DSH_HOME: dshHome,
      LANG: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1', DSH_TELEMETRY_DISABLED: '1' },
  });
  let stopPromise;
  let stopping = false;
  async function stopOwned() {
    broker.reset();
    if (!child.pid) {
      if (await portOpen(port)) throw new Error('deepseek_loopback_survived');
      return { processGroupAbsent: true, loopbackClosed: true, descendantCleanupVerified: false };
    }
    if (groupExists(child.pid)) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      if (!(await waitForGroup(child.pid, 7000))) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        if (!(await waitForGroup(child.pid, 3000))) throw new Error('deepseek_process_group_survived');
      }
    }
    if (await portOpen(port)) throw new Error('deepseek_loopback_survived');
    // Upstream tools can detach into new groups. Only the outer systemd cgroup
    // or disposable computer owner can prove their absence. Do not relabel
    // this process-group/socket check as complete descendant cleanup.
    return { processGroupAbsent: true, loopbackClosed: true, descendantCleanupVerified: false };
  }
  function stop() {
    stopping = true;
    signal?.removeEventListener('abort', abort);
    stopPromise ??= stopOwned().then(receipt => { releaseOwner(); return receipt; });
    return stopPromise;
  }

  let rejectStartup;
  function abort() {
    rejectStartup(new Error('deepseek_start_cancelled'));
    void stop().catch(() => {}); // Caller observes stop()'s verified/failed result.
  }
  const started = new Promise((resolve, reject) => {
    rejectStartup = reject;
    let line = '';
    let discard = false;
    const diagnosticCodes = new Set();
    let diagnosticTail = '';
    function classifyOutput(chunk) {
      diagnosticTail = (diagnosticTail + chunk.toString('utf8')).slice(-8192);
      for (const code of ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_DLOPEN_FAILED', 'EACCES', 'ENOENT', 'EADDRINUSE', 'SyntaxError']) {
        if (diagnosticTail.includes(code)) diagnosticCodes.add(code);
      }
      for (const dependency of ['node-pty', 'koffi', 'spawn-helper', 'bubblewrap']) {
        if (diagnosticTail.includes(dependency)) diagnosticCodes.add(dependency);
      }
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      classifyOutput(chunk);
      // Stream-safe framing: discard overlong lines until their newline rather
      // than retaining unbounded logs or interpreting a truncated suffix.
      for (const character of chunk) {
        if (character === '\n') {
          if (!discard && !stopping && brokerOwners.get(broker) === owner) {
            void broker.acceptLaunchLine(line.replace(/\r$/, '')).then(ok => {
              if (ok && !stopping && brokerOwners.get(broker) === owner) resolve();
            }, () => reject(new Error('deepseek_private_auth_failed')));
          }
          line = ''; discard = false;
        } else if (!discard) {
          line += character;
          if (line.length > 8192) { line = ''; discard = true; }
        }
      }
    });
    child.stderr.on('data', classifyOutput);
    child.once('error', () => reject(new Error('deepseek_process_start_failed')));
    child.once('exit', () => {
      const unexpected = !stopping;
      broker.reset();
      reject(new Error(`deepseek_process_exited${diagnosticCodes.size ? `:${[...diagnosticCodes].sort().join(',')}` : ''}`));
      // A successful upstream exit is not descendant-cleanup evidence.
      void stop().catch(() => {}); // The lifecycle owner observes the same stop promise.
      if (unexpected) onUnexpectedExit();
    });
  });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const deadline = setTimeout(() => rejectStartup(new Error('deepseek_startup_deadline')), startupTimeoutMs);
  try {
    await started;
    if (!broker.ready()) throw new Error('deepseek_not_ready');
    return Object.freeze({ stop, pid: child.pid, version: VERSION });
  } catch (error) {
    try { await stop(); }
    catch { throw new Error('deepseek_start_failed_cleanup_unverified'); }
    throw error;
  } finally { clearTimeout(deadline); }
}

module.exports = { startRuntime, VERSION };
