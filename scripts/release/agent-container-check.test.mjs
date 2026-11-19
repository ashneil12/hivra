import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { changedKinds } from './agent-container-check.mjs';

test('an agent’s own files select only that agent', () => {
  assert.deepEqual(changedKinds(['dashboard/provisioner/hivra-openbot.service']), ['openbot']);
  assert.deepEqual(changedKinds(['dashboard/runtime-adapters/agent-zero-native/recipe.cjs']), ['agent-zero']);
  assert.deepEqual(changedKinds(['dashboard/provisioner/hermes-plugins/x/plugin.py']), ['hermes']);
  assert.deepEqual(changedKinds(['dashboard/provisioner/system-prompt-codex.md']), ['codex']);
});

test('shared install code selects the reference agent, not every agent', () => {
  assert.deepEqual(changedKinds(['dashboard/provisioner/provision-claude-code-box.sh']), ['claude']);
  assert.deepEqual(changedKinds(['dashboard/provisioner/hivra-chat/server.js']), ['claude']);
});

test('changes outside agent install code select nothing', () => {
  assert.deepEqual(changedKinds(['dashboard/src/app/page.tsx', 'docs/STATUS.md']), []);
  assert.deepEqual(changedKinds([]), []);
});

test('kinds come back once each, in catalog order', () => {
  assert.deepEqual(changedKinds([
    'dashboard/provisioner/hivra-nuphos.service',
    'dashboard/provisioner/openclaw-config.json',
    'dashboard/provisioner/hivra-nuphos-entry.sh',
  ]), ['openclaw', 'nuphos']);
});

test('changed-agent tooling cannot launch an install or reply job', () => {
  assert.deepEqual(readdirSync(new URL('../../ops/agent-container-check/', import.meta.url)), ['README.md']);
  const script = fileURLToPath(new URL('./agent-container-check.mjs', import.meta.url));
  for (const command of ['ask', 'seed-codex']) {
    const result = spawnSync(process.execPath, [script, command], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: changed/);
  }
});
