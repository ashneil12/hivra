import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./test-deepseek-native-runtime.mjs', import.meta.url));
const adapter = fileURLToPath(new URL('../runtime-adapters/deepseek-harness/', import.meta.url));
const runtimeSource = fileURLToPath(new URL('../provisioner/deepseek-harness/', import.meta.url));

// This fixture tests runner ownership/error paths only. It never invokes Docker
// or claims native compatibility; the separate actual-package run supplies that.
function fakeDocker() {
  const fs = require('node:fs');
  const path = require('node:path');
  const directory = process.env.HIVRA_TEST_DOCKER_DIR;
  const args = process.argv.slice(2);
  const stateFile = path.join(directory, 'state.json');
  fs.appendFileSync(path.join(directory, 'calls.jsonl'), `${JSON.stringify(args)}\n`);
  const id = 'a'.repeat(64);
  if (args[0] === 'image') {
    process.stdout.write(JSON.stringify([{ Id: args[2], Os: 'linux', Architecture: 'amd64',
      Config: { Volumes: process.env.HIVRA_TEST_DOCKER_MODE === 'volumes' ? { '/data': {} } : null } }]));
  } else if (args[0] === 'create') {
    const label = args[args.indexOf('--label') + 1].split('=');
    const mount = args[args.indexOf('--mount') + 1];
    const snapshot = mount.match(/src=([^,]+)/)[1];
    if (!snapshot.endsWith('/source')) process.exit(19);
    // Simulate a simultaneous edit AFTER capture. The mounted snapshot must
    // retain its original source, independently of this working-tree edit.
    fs.writeFileSync(path.join(directory, 'provisioner/deepseek-harness/native-broker.cjs'), 'concurrent edit\n');
    fs.writeFileSync(stateFile, JSON.stringify({ Id: id, Config: { Labels: { [label[0]]: label[1] } }, State: { Running: false, ExitCode: 0 } }));
    process.stdout.write(id);
  } else if (args[0] === 'inspect') {
    process.stdout.write(`[${fs.readFileSync(stateFile, 'utf8')}]`);
  } else if (args[0] === 'start') {
    if (process.env.HIVRA_TEST_DOCKER_MODE === 'failure') process.exit(1);
    process.stdout.write(JSON.stringify({ install: { fixture: true }, immutableReuseVerified: true }) + '\n');
    process.stdout.write(JSON.stringify({ version: 'fixture-only', preCancelledLaunchHasNoSideEffects: true,
      concurrentStartRejected: true, authenticatedNativeHtml: true, nativeCredentialWriteOnly: true,
      privateCredentialPermissions: true, restartPersistence: true, nativeWebSocketUpgrade: true,
      nativeEventStream: true, liveStreamsRevoked: true, publicStaticGate: true,
      nativePackageReadOnlyToAgent: true, officialSubprocessShell: true, officialInteractivePty: true }));
  } else if (args[0] === 'rm') {
    if (args[2] !== id) process.exit(20);
    fs.unlinkSync(stateFile);
  } else if (args[0] === 'ps') {
    if (fs.existsSync(stateFile)) process.stdout.write(id);
  } else process.exit(21);
}

function exercise(t, mode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hivra-deepseek-runner-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'scripts'));
  fs.mkdirSync(path.join(directory, 'runtime-adapters/deepseek-harness'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'provisioner/deepseek-harness'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'bin'));
  fs.copyFileSync(runner, path.join(directory, 'scripts/test-deepseek-native-runtime.mjs'));
  for (const entry of fs.readdirSync(adapter)) {
    if (fs.lstatSync(path.join(adapter, entry)).isFile()) fs.copyFileSync(path.join(adapter, entry), path.join(directory, 'runtime-adapters/deepseek-harness', entry));
  }
  for (const entry of fs.readdirSync(runtimeSource)) {
    if (fs.lstatSync(path.join(runtimeSource, entry)).isFile()) fs.copyFileSync(path.join(runtimeSource, entry), path.join(directory, 'provisioner/deepseek-harness', entry));
  }
  fs.writeFileSync(path.join(directory, 'bin/docker'), `#!/usr/bin/env node\n(${fakeDocker.toString()})();\n`, { mode: 0o755 });
  const output = path.join(directory, 'evidence');
  const result = spawnSync(process.execPath, [path.join(directory, 'scripts/test-deepseek-native-runtime.mjs'),
    '--image', `sha256:${'b'.repeat(64)}`, '--output', output], { encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PATH: `${path.join(directory, 'bin')}${path.delimiter}${process.env.PATH}`,
      HIVRA_TEST_DOCKER_DIR: directory, HIVRA_TEST_DOCKER_MODE: mode } });
  const receipt = JSON.parse(fs.readFileSync(path.join(output, 'receipt.json'), 'utf8'));
  const calls = fs.readFileSync(path.join(directory, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { directory, output, result, receipt, calls };
}

test('runner rejects images that would implicitly create anonymous volumes', t => {
  const f = exercise(t, 'volumes');
  assert.equal(f.result.status, 1);
  assert.equal(f.receipt.error, 'image_anonymous_volumes_forbidden');
  assert.equal(f.calls.some(args => args[0] === 'create'), false);
  assert.equal(f.receipt.cleanupVerified, true);
});

test('runner executes a frozen snapshot and binds the receipt to its bytes', t => {
  const f = exercise(t, 'success');
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.equal(f.receipt.verdict, 'PASS');
  const snapshot = fs.readFileSync(path.join(f.output, 'source/native-broker.cjs'));
  assert.equal(f.receipt.files['native-broker.cjs'], createHash('sha256').update(snapshot).digest('hex'));
  assert.notEqual(snapshot.toString(), fs.readFileSync(path.join(f.directory, 'provisioner/deepseek-harness/native-broker.cjs'), 'utf8'));
  assert.equal(f.receipt.cleanupVerified, true);
  const create = f.calls.find(args => args[0] === 'create');
  assert.equal(create[create.indexOf('--user') + 1], '0:0');
  assert.ok(create.includes('SETUID') && create.includes('SETGID'));
  assert.ok(create.at(-1).includes('--reuid=1000 --regid=1000 --clear-groups --no-new-privs'));
  assert.ok(create.at(-1).includes('env -i PATH=/usr/bin:/bin'));
});

test('runner removes only its identity-verified container after execution failure', t => {
  const f = exercise(t, 'failure');
  assert.equal(f.result.status, 1);
  assert.equal(f.receipt.verdict, 'FAIL');
  assert.equal(f.receipt.cleanupVerified, true);
  assert.deepEqual(f.calls.filter(args => args[0] === 'rm'), [['rm', '-f', 'a'.repeat(64)]]);
});
