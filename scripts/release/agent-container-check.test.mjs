import assert from 'node:assert/strict';
import test from 'node:test';
import { CHECK_PROMPT, changedKinds, replyHasAnswer } from './agent-container-check.mjs';

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

test('the reply must carry the answer, not just echo the question', () => {
  assert.equal(replyHasAnswer('{"type":"assistant","text":"837"}\n{"type":"_done","code":0}\n'), true);
  assert.equal(replyHasAnswer(`{"type":"user","text":"${CHECK_PROMPT}"}\n{"type":"_done","code":1}\n`), false);
  assert.equal(replyHasAnswer('{"type":"assistant","text":"18370"}\n'), false);
  assert.equal(replyHasAnswer('{"type":"_ping"}\n'), false);
});

test('the runner template records a status only for a full, unattended run', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../ops/agent-container-check/agent-checks.yml', import.meta.url), 'utf8');
  // Kinds picked by hand never stand in for the commit's own check.
  assert.match(source, /if: always\(\) && steps\.pick\.outputs\.run == 'true' && env\.KINDS_INPUT == ''/);
  // Green needs the check step itself to have succeeded.
  assert.match(source, /if \[ "\$OUTCOME" = "success" \] && \[ -z "\$KINDS" \]; then/);
  assert.match(source, /publish --state failure --description "Failed: \$\{FAILED:-the check did not finish\}"/);
  assert.match(source, /--context agent-checks/);
});
