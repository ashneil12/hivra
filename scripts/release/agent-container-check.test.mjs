import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CHECK_PROMPT, changedKinds, replyHasAnswer, seedCodexProvider } from './agent-container-check.mjs';

test('an agent\'s own files select only that agent', () => {
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

test('the reply must carry the answer, not just echo the question or metadata', () => {
  assert.equal(replyHasAnswer('{"type":"result","result":"837"}\n'), true);
  assert.equal(replyHasAnswer('{"type":"assistant","message":{"content":[{"type":"text","text":"837"}]}}\n'), true);
  assert.equal(replyHasAnswer('{"type":"item.completed","item":{"type":"agent_message","text":"837"}}\n'), true);
  assert.equal(replyHasAnswer(`{"type":"user","message":{"content":[{"type":"text","text":"${CHECK_PROMPT}"}]}}\n`), false);
  assert.equal(replyHasAnswer('{"type":"result","result":"18370"}\n'), false);
  assert.equal(replyHasAnswer('{"type":"system","session_id":"a1b2-837-c3","usage":{"input_tokens":837}}\n{"type":"_ping"}\n'), false);
});

test('Codex receives the private provider file consumed by the guest chat', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'codex-provider-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, '.hivra'));
  const env = {
    CHECK_MODEL_KEY: 'hven_fixture',
    CHECK_MODEL_BASE_URL: 'https://canary.example.test/api/managed-venice/v1',
    CHECK_MODEL: 'test-model',
  };
  seedCodexProvider(home, env);
  const file = join(home, '.hivra', 'llm-provider.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    provider: 'venice',
    apiKey: env.CHECK_MODEL_KEY,
    baseUrl: env.CHECK_MODEL_BASE_URL,
    model: env.CHECK_MODEL,
  });
  assert.throws(() => seedCodexProvider(home, env), { code: 'EEXIST' });
});

test('the runner template records a status only for a full, unattended run', async () => {
  const source = readFileSync(new URL('../../ops/agent-container-check/agent-checks.yml', import.meta.url), 'utf8');
  // Kinds picked by hand never stand in for the commit's own check.
  assert.match(source, /if: always\(\) && steps\.pick\.outputs\.run == 'true' && env\.KINDS_INPUT == ''/);
  // Green needs the check step itself to have succeeded.
  assert.match(source, /if \[ "\$OUTCOME" = "success" \] && \[ -z "\$KINDS" \]; then/);
  assert.match(source, /publish --state failure --description "Failed: \$\{FAILED:-the check did not finish\}"/);
  assert.match(source, /--context agent-checks/);
});
