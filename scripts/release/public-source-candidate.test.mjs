import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildPublicSourceCandidate } from './public-source-candidate.mjs';

function fixture(t) {
  const parent = mkdtempSync(path.join(tmpdir(), 'hivra-public-candidate-test-'));
  const root = path.join(parent, 'repo');
  mkdirSync(root);
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Fixture']);
  const write = (relative, content = 'fixture\n') => {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  write('LICENSE', 'Apache License\nVersion 2.0\n');
  write('NOTICE', 'Fixture notice\n');
  write('src/index.js', 'export const fixture = true;\n');
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'fixture']);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return { parent, root, write };
}

function fakeInventory({ root, output }) {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(existsSync(path.dirname(output)), true, 'builder must prepare the evidence parent');
  mkdirSync(output);
  const report = { format: 'fixture-inventory', status: 'inventory-only', releaseApproved: false, gitHead: head, gaps: [] };
  writeFileSync(path.join(output, 'inventory.json'), `${JSON.stringify(report)}\n`);
  return report;
}

function fakeNoticeEvidence({ root, inventoryDirectory, output }) {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(existsSync(path.join(inventoryDirectory, 'inventory.json')), true);
  mkdirSync(output);
  const report = {
    format: 'hivra-notice-source-offer-evidence-v1', status: 'review-plan', releaseApproved: false,
    gitHead: head,
    summary: {
      uniqueNpmComponents: 3,
      unresolvedLicenseCount: 1,
      missingDistributionCount: 0,
      missingIntegrityCount: 0,
      reviewedOverridesWithoutLicenseFileCount: 0,
    },
    gaps: [{ code: 'fixture-review-pending' }],
  };
  writeFileSync(path.join(output, 'notice-source-offer.json'), `${JSON.stringify(report)}\n`);
  writeFileSync(path.join(output, 'NOTICE-INDEX.review.tsv'), 'fixture\n');
  return report;
}

function fakeCompleteNoticeEvidence(options) {
  const report = fakeNoticeEvidence(options);
  report.summary.unresolvedLicenseCount = 0;
  report.gaps = [
    { code: 'package-license-text-and-copyright-collection-pending', count: 3 },
    { code: 'runtime-and-image-notices-outside-npm-scope', count: 1 },
  ];
  writeFileSync(path.join(options.output, 'notice-source-offer.json'), `${JSON.stringify(report)}\n`);
  return report;
}

function fakeSourceThirdParty() {
  return {
    format: 'hivra-source-third-party-provenance-evidence-v1',
    status: 'source-only-notices-complete',
    releaseApproved: false,
    policySha256: 'a'.repeat(64),
    summary: { components: 1, firstPartyFiles: 1, thirdPartyFiles: 2 },
    gaps: [],
  };
}

function fakeRuntimeBoundary() {
  return {
    format: 'hivra-runtime-distribution-boundary-evidence-v1',
    status: 'source-only-runtime-boundary-complete',
    releaseApproved: false,
    sourceOnlyBoundaryApproved: true,
    policySha256: 'b'.repeat(64),
    summary: { externalInputs: 2, embeddedExternalArtifacts: 0, digestPinnedContainerInputs: 3 },
    gaps: [],
  };
}

function fakeCredentialReconciliation() {
  return {
    format: 'hivra-credential-reconciliation-evidence-v1',
    status: 'current-authorization-boundary-reconciled',
    releaseApproved: false,
    policySha256: 'c'.repeat(64),
    activeManagedTargetsChecked: 2,
    currentTargetsAuthorizingHistoricalKey: 0,
    privateHistoryExcluded: true,
    gaps: [],
  };
}

function fakeAssetEvidence({ root, output }) {
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  mkdirSync(output);
  const report = {
    format: 'hivra-asset-provenance-evidence-v1', status: 'review-required', releaseApproved: false,
    gitHead: head, summary: { trackedAssets: 2, holdCount: 1 }, gaps: [{ code: 'fixture-asset-review-pending' }],
  };
  writeFileSync(path.join(output, 'asset-provenance.json'), `${JSON.stringify(report)}\n`);
  return report;
}

function fakeClearAssetEvidence({ root, output }) {
  const report = fakeAssetEvidence({ root, output });
  report.status = 'inventory-complete';
  report.summary.holdCount = 0;
  report.gaps = [];
  writeFileSync(path.join(output, 'asset-provenance.json'), `${JSON.stringify(report)}\n`);
  return report;
}

const noChecks = () => {};

test('builds deterministic private candidate bytes from the exact clean HEAD', (t) => {
  const f = fixture(t);
  const first = path.join(f.parent, 'candidate-a');
  const second = path.join(f.parent, 'candidate-b');
  const options = { root: f.root, inventoryGenerator: fakeInventory, noticeEvidenceGenerator: fakeNoticeEvidence, assetEvidenceGenerator: fakeAssetEvidence, sourceThirdPartyInspector: fakeSourceThirdParty, runtimeBoundaryInspector: fakeRuntimeBoundary, credentialReconciliationInspector: fakeCredentialReconciliation, runReleaseChecks: noChecks };
  const a = buildPublicSourceCandidate({ ...options, output: first });
  const b = buildPublicSourceCandidate({ ...options, output: second });

  assert.equal(a.receipt.status, 'review-candidate');
  assert.equal(a.receipt.releaseApproved, false);
  assert.deepEqual(a.receipt.blockers, b.receipt.blockers);
  assert.deepEqual(readdirSync(first).sort(), ['SHA256SUMS', 'candidate.json', 'evidence', `hivra-source-${a.receipt.source.commit.slice(0, 12)}.tar.gz`].sort());
  for (const relative of [
    'candidate.json', 'SHA256SUMS', `hivra-source-${a.receipt.source.commit.slice(0, 12)}.tar.gz`,
    'evidence/dependency-inventory/inventory.json',
    'evidence/notice-source-offer/notice-source-offer.json',
    'evidence/notice-source-offer/NOTICE-INDEX.review.tsv',
    'evidence/asset-provenance/asset-provenance.json',
  ]) {
    assert.deepEqual(readFileSync(path.join(first, relative)), readFileSync(path.join(second, relative)), relative);
  }
  assert.deepEqual(a.receipt.noticeSourceOfferEvidence, {
    status: 'review-plan', releaseApproved: false, uniqueNpmComponents: 3, gaps: 1,
  });
  assert.deepEqual(a.receipt.assetProvenanceEvidence, {
    status: 'review-required', releaseApproved: false, trackedAssets: 2, heldAssets: 1, gaps: 1,
  });
  assert.ok(a.receipt.blockers.includes('complete-asset-provenance-review'));
  assert.ok(a.receipt.blockers.includes('complete-notice-and-source-offer-review'));
  assert.match(readFileSync(path.join(first, 'SHA256SUMS'), 'utf8'), /candidate\.json/);
  assert.throws(() => buildPublicSourceCandidate({ ...options, output: first }), /already exists/);
});

test('refuses dirty trees, non-HEAD commits, and output inside the repository', (t) => {
  const f = fixture(t);
  const options = { root: f.root, inventoryGenerator: fakeInventory, noticeEvidenceGenerator: fakeNoticeEvidence, assetEvidenceGenerator: fakeAssetEvidence, sourceThirdPartyInspector: fakeSourceThirdParty, runtimeBoundaryInspector: fakeRuntimeBoundary, credentialReconciliationInspector: fakeCredentialReconciliation, runReleaseChecks: noChecks };
  assert.throws(() => buildPublicSourceCandidate({ ...options, output: path.join(f.root, 'candidate') }), /outside/);

  f.write('untracked.txt');
  assert.throws(() => buildPublicSourceCandidate({ ...options, output: path.join(f.parent, 'dirty') }), /clean/);
  execFileSync('git', ['-C', f.root, 'add', 'untracked.txt']);
  execFileSync('git', ['-C', f.root, 'commit', '--quiet', '-m', 'second']);
  assert.throws(() => buildPublicSourceCandidate({ ...options, output: path.join(f.parent, 'old'), commit: 'HEAD^' }), /current committed HEAD/);
});

test('fails closed without publishing a partial directory', (t) => {
  const f = fixture(t);
  const output = path.join(f.parent, 'failed');
  assert.throws(() => buildPublicSourceCandidate({
    root: f.root,
    output,
    runReleaseChecks: noChecks,
    inventoryGenerator() { throw new Error('fixture failure'); },
    noticeEvidenceGenerator: fakeNoticeEvidence,
    assetEvidenceGenerator: fakeAssetEvidence,
    sourceThirdPartyInspector: fakeSourceThirdParty,
    runtimeBoundaryInspector: fakeRuntimeBoundary,
    credentialReconciliationInspector: fakeCredentialReconciliation,
  }), /fixture failure/);
  assert.equal(readdirSync(f.parent).some((entry) => entry === 'failed' || entry.startsWith('.hivra-public-candidate-')), false);
});

test('fails closed when notice evidence fails or is bound to another revision', (t) => {
  const f = fixture(t);
  for (const [name, noticeEvidenceGenerator, pattern] of [
    ['notice-failed', () => { throw new Error('notice fixture failure'); }, /notice fixture failure/],
    ['notice-wrong-head', ({ output }) => {
      mkdirSync(output);
      return { status: 'review-plan', releaseApproved: false, gitHead: '0'.repeat(40), summary: {}, gaps: [] };
    }, /not bound/],
  ]) {
    const output = path.join(f.parent, name);
    assert.throws(() => buildPublicSourceCandidate({
      root: f.root,
      output,
      runReleaseChecks: noChecks,
      inventoryGenerator: fakeInventory,
      noticeEvidenceGenerator,
      assetEvidenceGenerator: fakeAssetEvidence,
      sourceThirdPartyInspector: fakeSourceThirdParty,
      runtimeBoundaryInspector: fakeRuntimeBoundary,
      credentialReconciliationInspector: fakeCredentialReconciliation,
    }), pattern);
    assert.equal(existsSync(output), false);
  }
});

test('fails closed when asset evidence fails or is bound to another revision', (t) => {
  const f = fixture(t);
  for (const [name, assetEvidenceGenerator, pattern] of [
    ['asset-failed', () => { throw new Error('asset fixture failure'); }, /asset fixture failure/],
    ['asset-wrong-head', ({ output }) => {
      mkdirSync(output);
      return { status: 'review-required', releaseApproved: false, gitHead: '0'.repeat(40), summary: {}, gaps: [] };
    }, /not bound/],
  ]) {
    const output = path.join(f.parent, name);
    assert.throws(() => buildPublicSourceCandidate({
      root: f.root,
      output,
      runReleaseChecks: noChecks,
      inventoryGenerator: fakeInventory,
      noticeEvidenceGenerator: fakeNoticeEvidence,
      assetEvidenceGenerator,
      sourceThirdPartyInspector: fakeSourceThirdParty,
      runtimeBoundaryInspector: fakeRuntimeBoundary,
      credentialReconciliationInspector: fakeCredentialReconciliation,
    }), pattern);
    assert.equal(existsSync(output), false);
  }
});

test('removes only the asset blocker when exact asset evidence has no gaps', (t) => {
  const f = fixture(t);
  const output = path.join(f.parent, 'asset-clear');
  const result = buildPublicSourceCandidate({
    root: f.root,
    output,
    runReleaseChecks: noChecks,
    inventoryGenerator: fakeInventory,
    noticeEvidenceGenerator: fakeNoticeEvidence,
    assetEvidenceGenerator: fakeClearAssetEvidence,
    sourceThirdPartyInspector: fakeSourceThirdParty,
    runtimeBoundaryInspector: fakeRuntimeBoundary,
    credentialReconciliationInspector: fakeCredentialReconciliation,
  });
  assert.equal(result.receipt.assetProvenanceEvidence.gaps, 0);
  assert.equal(result.receipt.blockers.includes('complete-asset-provenance-review'), false);
  assert.ok(result.receipt.blockers.includes('complete-notice-and-source-offer-review'));
});

test('closes only the source-artifact notice blocker when source provenance and npm identities are complete', (t) => {
  const f = fixture(t);
  const result = buildPublicSourceCandidate({
    root: f.root,
    output: path.join(f.parent, 'source-notices-clear'),
    runReleaseChecks: noChecks,
    inventoryGenerator: fakeInventory,
    noticeEvidenceGenerator: fakeCompleteNoticeEvidence,
    assetEvidenceGenerator: fakeClearAssetEvidence,
    sourceThirdPartyInspector: fakeSourceThirdParty,
    runtimeBoundaryInspector: fakeRuntimeBoundary,
    credentialReconciliationInspector: fakeCredentialReconciliation,
  });
  assert.equal(result.receipt.artifactClass, 'source-only-current-tree');
  assert.equal(result.receipt.blockers.includes('complete-notice-and-source-offer-review'), false);
  assert.equal(result.receipt.runtimeDistributionBoundary.status, 'source-only-runtime-boundary-complete');
  assert.equal(result.receipt.credentialReconciliation.status, 'current-authorization-boundary-reconciled');
  assert.equal(result.receipt.blockers.includes('credential-rotation-reconciliation'), false);
  assert.equal(result.receipt.blockers.includes('exact-runtime-and-image-notices'), false);
  assert.equal(result.receipt.sourceThirdPartyEvidence.status, 'source-only-notices-complete');
});
