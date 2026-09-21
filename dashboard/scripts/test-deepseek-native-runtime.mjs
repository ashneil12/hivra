#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Local, disposable compatibility proof. No published ports, provider keys,
// Docker socket mount, paid resources, or existing guest modifications.
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--image' || !/^sha256:[a-f0-9]{64}$/.test(args[1])
  || args[2] !== '--output' || !path.isAbsolute(args[3])) {
  throw new Error('Usage: test-deepseek-native-runtime.mjs --image sha256:<existing-local-image> --output <new-absolute-directory>');
}
const image = args[1];
const output = args[3];
const adapter = fileURLToPath(new URL('../runtime-adapters/deepseek-harness/', import.meta.url));
const runtimeSource = fileURLToPath(new URL('../provisioner/deepseek-harness/', import.meta.url));
const snapshot = path.join(output, 'source');
const owner = randomUUID();
const name = `hivra-deepseek-audit-${owner}`;
let container;
const receipt = { schema: 1, scope: 'deepseek-native-adapter-local-smoke', owner, image,
  startedAt: new Date().toISOString(), files: {}, verdict: 'FAIL', publicEnablement: false, cleanupVerified: false };

function run(argv, timeout = 30000) {
  const result = spawnSync('docker', argv, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`docker_${argv[0]}_failed`);
  return result.stdout.trim();
}
function inspectOwned() {
  const result = JSON.parse(run(['inspect', container]))[0];
  if (result.Id !== container || result.Config?.Labels?.['io.hivra.audit-owner'] !== owner) throw new Error('audit_container_identity_mismatch');
  return result;
}

fs.mkdirSync(output, { mode: 0o700 }); // Never overwrite a previous receipt.
fs.mkdirSync(snapshot, { mode: 0o755 });
for (const entry of ['README.md', 'package.json', 'package-lock.json', 'native-broker.cjs', 'native-broker.test.cjs',
  'recipe.test.cjs', 'runtime-process.cjs', 'actual-package-smoke.cjs', 'native-tools-smoke.cjs', 'install-native.py', 'package-install-smoke.py'].sort()) {
  const source = ['package.json', 'package-lock.json', 'native-broker.cjs', 'runtime-process.cjs', 'install-native.py'].includes(entry) ? runtimeSource : adapter;
  if (!fs.lstatSync(path.join(source, entry)).isFile()) throw new Error('adapter_source_not_regular_file');
  const bytes = fs.readFileSync(path.join(source, entry));
  receipt.files[entry] = createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(snapshot, entry), bytes, { mode: 0o444 });
}
receipt.runnerSha256 = createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex');
try {
  const base = JSON.parse(run(['image', 'inspect', image]))[0];
  if (base.Id !== image || base.Os !== 'linux' || base.Architecture !== 'amd64') throw new Error('linux_amd64_image_required');
  if (Object.keys(base.Config?.Volumes || {}).length !== 0) throw new Error('image_anonymous_volumes_forbidden');
  container = run(['create', '--init', '--pull', 'never', '--platform', 'linux/amd64', '--name', name,
    '--label', `io.hivra.audit-owner=${owner}`, '--user', '0:0', '--read-only', '--cap-drop', 'ALL',
    // Only for the root-owned package fixture, then one-way drop to uid 1000.
    // No privileged mode, host namespaces, devices or Docker socket mount.
    '--cap-add', 'SETUID', '--cap-add', 'SETGID',
    '--security-opt', 'no-new-privileges', '--memory', '3g', '--cpus', '2', '--pids-limit', '256',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m,mode=1777',
    '--tmpfs', '/opt/hivra:rw,exec,nosuid,nodev,size=2g,mode=0755',
    '--mount', `type=bind,src=${snapshot},dst=/recipe,readonly`, '--entrypoint', '/bin/sh', image, '-c',
    'set -eu; /usr/bin/python3 -I -B /recipe/package-install-smoke.py; exec /usr/bin/setpriv --reuid=1000 --regid=1000 --clear-groups --no-new-privs /usr/bin/env -i PATH=/usr/bin:/bin HOME=/tmp LANG=C.UTF-8 /usr/bin/node /recipe/actual-package-smoke.cjs']);
  if (!/^[a-f0-9]{64}$/.test(container)) throw new Error('audit_container_id_invalid');
  receipt.container = container;
  inspectOwned();
  const attached = spawnSync('docker', ['start', '-a', container], { encoding: 'utf8', timeout: 600000, maxBuffer: 4 * 1024 * 1024 });
  // Keep private diagnostics on failure too. This frozen fixture has no real
  // credentials; native startup auth is consumed privately by the broker.
  const log = attached.stdout || '';
  fs.writeFileSync(path.join(output, 'runtime.log'), `${log}\n${attached.stderr || ''}`, { mode: 0o600 });
  if (attached.error || attached.status !== 0) throw new Error('docker_start_failed');
  const state = inspectOwned().State;
  if (state.Running || state.ExitCode !== 0) throw new Error('native_smoke_failed');
  receipt.runtime = JSON.parse(log.split('\n').findLast(line => line.startsWith('{"version":')));
  receipt.package = JSON.parse(log.split('\n').findLast(line => line.startsWith('{"install":')));
  if (receipt.package.immutableReuseVerified !== true) throw new Error('immutable_package_reuse_unverified');
  for (const field of ['preCancelledLaunchHasNoSideEffects', 'concurrentStartRejected', 'authenticatedNativeHtml', 'nativeCredentialWriteOnly',
    'privateCredentialPermissions', 'restartPersistence', 'nativeWebSocketUpgrade', 'nativeEventStream', 'liveStreamsRevoked', 'publicStaticGate',
    'nativePackageReadOnlyToAgent', 'officialSubprocessShell', 'officialInteractivePty']) {
    if (receipt.runtime[field] !== true) throw new Error(`native_check_missing_${field}`);
  }
  receipt.verdict = 'PASS';
} catch (error) {
  receipt.error = error.message;
} finally {
  try {
    if (container) { inspectOwned(); run(['rm', '-f', container]); }
    // Container deletion proves full namespace teardown, including detached
    // tool children that process-group checks alone cannot account for.
    const survivors = run(['ps', '-aq', '--filter', `label=io.hivra.audit-owner=${owner}`]);
    if (survivors !== '') throw new Error('audit_container_survived');
    receipt.cleanupVerified = true;
  } catch (error) { receipt.cleanupError = error.message; receipt.verdict = 'FAIL'; }
  receipt.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}
process.stdout.write(`${JSON.stringify({ verdict: receipt.verdict, receipt: path.join(output, 'receipt.json'), cleanupVerified: receipt.cleanupVerified })}\n`);
if (receipt.verdict !== 'PASS') process.exitCode = 1;
