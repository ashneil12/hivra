import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdirSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectSourceThirdPartyProvenance } from './source-third-party-provenance.mjs';
import { APPLE_ROOT_CERTIFICATES } from '../../dashboard/scripts/fetch-apple-root-certificates.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the source-only artifact has no internal skills bundle and retains acquired-artifact provenance', () => {
  const report = inspectSourceThirdPartyProvenance({ root });
  assert.equal(report.status, 'source-only-notices-complete');
  assert.equal(report.releaseApproved, false);
  assert.equal(report.summary.components, 0);
  assert.equal(report.summary.thirdPartyFiles, 0);
  assert.equal(report.summary.acquiredArtifacts, 4);
  assert.equal(report.summary.redistributedArtifacts, 0);
  assert.equal(report.summary.firstPartyFiles, 0);
  assert.deepEqual(report.gaps, []);
});

test('source provenance fails closed when Apple acquisition metadata drifts', (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'hivra-source-provenance-cert-metadata-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
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

test('source provenance rejects an unrecorded skills bundle', (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'hivra-source-provenance-unrecorded-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  cpSync(path.join(root, 'docs'), path.join(fixture, 'docs'), { recursive: true });
  cpSync(path.join(root, 'dashboard/src/lib/billing/apple-certs'), path.join(fixture, 'dashboard/src/lib/billing/apple-certs'), { recursive: true });
  mkdirSync(path.join(fixture, '.agents/skills'), { recursive: true });
  writeFileSync(path.join(fixture, '.agents/skills/unreviewed.md'), 'unreviewed fixture');
  assert.throws(() => inspectSourceThirdPartyProvenance({ root: fixture }), /not exhaustive/);
});

test('recorded component hashes still reject byte drift', (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), 'hivra-source-provenance-hash-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  cpSync(path.join(root, 'docs'), path.join(fixture, 'docs'), { recursive: true });
  cpSync(path.join(root, 'dashboard/src/lib/billing/apple-certs'), path.join(fixture, 'dashboard/src/lib/billing/apple-certs'), { recursive: true });
  mkdirSync(path.join(fixture, '.agents/skills'), { recursive: true });
  const license = Buffer.from('fixture license');
  const source = Buffer.from('reviewed fixture');
  writeFileSync(path.join(fixture, '.agents/skills/LICENSE'), license);
  writeFileSync(path.join(fixture, '.agents/skills/source.md'), source);
  const policyPath = path.join(fixture, 'docs/release/source-third-party-provenance.json');
  const policy = JSON.parse(readFileSync(policyPath));
  policy.components = [{ id: 'fixture', upstreamRepository: 'https://github.com/example/fixture',
    licenseExpression: 'MIT', licenseFile: { path: '.agents/skills/LICENSE', bytes: license.length,
      sha256: createHash('sha256').update(license).digest('hex') },
    files: [{ path: '.agents/skills/source.md', upstreamCommit: '1'.repeat(40),
      gitBlob: createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex') }] }];
  writeFileSync(policyPath, JSON.stringify(policy));
  assert.equal(inspectSourceThirdPartyProvenance({ root: fixture }).summary.thirdPartyFiles, 1);
  writeFileSync(path.join(fixture, '.agents/skills/source.md'), 'unreviewed change');
  assert.throws(() => inspectSourceThirdPartyProvenance({ root: fixture }), /file evidence drifted/);
});
