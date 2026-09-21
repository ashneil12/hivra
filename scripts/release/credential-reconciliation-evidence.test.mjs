import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectCredentialReconciliation } from './credential-reconciliation-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('accepts the reviewed current authorization boundary', () => {
  const evidence = inspectCredentialReconciliation({ root });
  assert.equal(evidence.status, 'current-authorization-boundary-reconciled');
  assert.equal(evidence.activeManagedTargetsChecked, 4);
  assert.equal(evidence.currentTargetsAuthorizingHistoricalKey, 0);
  assert.equal(evidence.privateHistoryExcluded, true);
  assert.deepEqual(evidence.gaps, []);
});

test('fails closed when an active target is not checked', (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'hivra-credential-reconciliation-'));
  for (const relative of [
    'docs/release/credential-reconciliation.json',
    'docs/release/PUBLIC-REPOSITORY-DECISION.md',
    'docs/release/VERIFICATION-STATUS.md',
  ]) {
    const target = path.join(parent, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(root, relative), target);
  }
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const policyPath = path.join(parent, 'docs/release/credential-reconciliation.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  policy.historicalSshCredential.activeManagedTargetsChecked -= 1;
  writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  assert.throws(() => inspectCredentialReconciliation({ root: parent }), /incomplete/);
});
