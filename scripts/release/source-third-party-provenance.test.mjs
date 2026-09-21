import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectSourceThirdPartyProvenance } from './source-third-party-provenance.mjs';
import { APPLE_ROOT_CERTIFICATES } from '../../dashboard/scripts/fetch-apple-root-certificates.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the source-only artifact has exhaustive exact provenance for vendored skills', () => {
  const report = inspectSourceThirdPartyProvenance({ root });
  assert.equal(report.status, 'source-only-notices-complete');
  assert.equal(report.releaseApproved, false);
  assert.equal(report.summary.components, 1);
  assert.equal(report.summary.thirdPartyFiles, 124);
  assert.equal(report.summary.acquiredArtifacts, 4);
  assert.equal(report.summary.redistributedArtifacts, 0);
  assert.equal(report.summary.firstPartyFiles, 2);
  assert.deepEqual(report.gaps, []);
});

test('source provenance fails closed when Apple acquisition metadata drifts', (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'hivra-source-provenance-cert-metadata-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  cpSync(path.join(root, '.agents'), path.join(fixture, '.agents'), { recursive: true });
  cpSync(path.join(root, 'dashboard', 'src', 'lib', 'billing', 'apple-certs'), path.join(fixture, 'dashboard', 'src', 'lib', 'billing', 'apple-certs'), { recursive: true });
  cpSync(path.join(root, 'docs'), path.join(fixture, 'docs'), { recursive: true });
  const policyPath = path.join(fixture, 'docs', 'release', 'source-third-party-provenance.json');
  const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
  policy.acquiredArtifacts[0].sha256 = '0'.repeat(63);
  writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  assert.throws(() => inspectSourceThirdPartyProvenance({ root: fixture }), /metadata drifted/);
});

test('the build acquisition manifest exactly matches reviewed provenance', () => {
  const policy = JSON.parse(readFileSync(path.join(root, 'docs', 'release', 'source-third-party-provenance.json'), 'utf8'));
  const reviewed = policy.acquiredArtifacts.map((entry) => ({
    name: path.basename(entry.targetPath),
    sourceUrl: entry.sourceUrl,
    sha256: entry.sha256,
    bytes: entry.bytes,
  }));
  assert.deepEqual(APPLE_ROOT_CERTIFICATES, reviewed);
});

test('source provenance fails closed when a covered file drifts', (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'hivra-source-provenance-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  cpSync(path.join(root, '.agents'), path.join(fixture, '.agents'), { recursive: true });
  cpSync(path.join(root, 'docs'), path.join(fixture, 'docs'), { recursive: true });
  const target = path.join(fixture, '.agents', 'skills', 'copywriting', 'SKILL.md');
  writeFileSync(target, `${readFileSync(target, 'utf8')}\nfixture drift\n`);
  assert.throws(() => inspectSourceThirdPartyProvenance({ root: fixture }), /file evidence drifted/);
});
