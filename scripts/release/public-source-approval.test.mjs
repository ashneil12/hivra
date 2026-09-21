import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { approvePublicSourceCandidate } from './public-source-approval.mjs';

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeJson(file, value) {
  writeFileSync(file, json(value));
}

function fixture(t) {
  const parent = mkdtempSync(path.join(tmpdir(), 'hivra-public-approval-test-'));
  const root = path.join(parent, 'repo');
  const candidate = path.join(parent, 'candidate');
  mkdirSync(root);
  mkdirSync(path.join(candidate, 'evidence'), { recursive: true });
  const commit = 'a'.repeat(40);
  const tree = 'b'.repeat(40);
  const archiveName = `hivra-source-${commit.slice(0, 12)}.tar.gz`;
  writeFileSync(path.join(candidate, archiveName), 'source archive bytes\n');
  writeFileSync(path.join(candidate, 'evidence', 'inventory.json'), '{"status":"pass"}\n');
  const artifact = (relative) => {
    const bytes = readFileSync(path.join(candidate, relative));
    return { path: relative, sha256: sha256(bytes), bytes: bytes.length };
  };
  const artifacts = [archiveName, 'evidence/inventory.json'].map(artifact);
  const candidateReceipt = {
    format: 'hivra-public-source-candidate-v1',
    status: 'review-candidate',
    releaseApproved: false,
    artifactClass: 'source-only-current-tree',
    source: { commit, tree, trackedFiles: 25 },
    checks: {
      cleanCommittedTree: true,
      currentTreeHygiene: 'pass',
      releaseRegressionTests: 'pass',
      archiveMatchesTrackedTree: true,
    },
    artifacts,
    blockers: ['complete-self-host-acceptance', 'fresh-context-export-review'],
  };
  writeJson(path.join(candidate, 'candidate.json'), candidateReceipt);
  const candidateFiles = [archiveName, 'candidate.json', 'evidence/inventory.json'];
  writeFileSync(path.join(candidate, 'SHA256SUMS'), `${candidateFiles.map((relative) =>
    `${sha256(readFileSync(path.join(candidate, relative)))}  ${relative}`).sort().join('\n')}\n`);
  const candidateReceiptSha256 = sha256(readFileSync(path.join(candidate, 'candidate.json')));
  const archive = artifacts[0];
  const selfHostReceipt = path.join(parent, 'self-host.json');
  writeJson(selfHostReceipt, {
    format: 'hivra-public-source-bootstrap-e2e-v1',
    status: 'pass',
    releaseApproved: false,
    sourceRevision: commit,
    candidateReceiptSha256,
    sourceArchive: {
      archiveName,
      archiveSha256: archive.sha256,
      archiveBytes: archive.bytes,
    },
    dependencyInstall: 'pass',
    selfHostDoctor: 'pass',
    recoveryReceiptSha256: 'c'.repeat(64),
    recoveryChecks: {
      health: 'pass',
      operatorLogin: 'pass',
      recoveredMarker: 'pass',
      infrastructureRegistry: 'pass',
      hostedBillingGuard: 'pass',
      originalLoopbackBindings: 'pass',
      restoredLoopbackBindings: 'pass',
      recoveredStorageBytes: 'pass',
      masterKeyRotation: {
        secretCiphertextRewrapped: 'pass',
        oldSecretKeyRejected: 'pass',
        launchFingerprintKeyPreserved: 'pass',
      },
    },
    cleanup: {
      candidateRemoved: 'pass',
      exportedSourceRemoved: 'pass',
      nestedRecoveryEvidenceRemoved: 'pass',
      retainedProviderResources: [],
    },
  });
  const reviewReceipt = path.join(parent, 'review.json');
  writeJson(reviewReceipt, {
    format: 'hivra-public-source-review-v1',
    status: 'pass',
    releaseApproved: false,
    decision: 'approve',
    reviewerKind: 'fresh-context',
    reviewer: 'independent-reviewer-fixture',
    candidateReceiptSha256,
    sourceArchiveSha256: archive.sha256,
    source: { commit, tree },
    checks: {
      publicPrivateClassification: 'pass',
      functionalCoreComplete: 'pass',
      secretScan: 'pass',
      noticeAndLicense: 'pass',
      archiveContents: 'pass',
      noFunctionalOperatorMachineryWithheld: true,
      reviewedTrackedFiles: 25,
    },
    gaps: [],
  });
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return { parent, root, candidate, selfHostReceipt, reviewReceipt, candidateReceipt, archiveName };
}

test('approves only the exact candidate, self-host acceptance, and fresh-context review tuple', (t) => {
  const f = fixture(t);
  const output = path.join(f.parent, 'approval');
  const result = approvePublicSourceCandidate({ ...f, output });
  assert.equal(result.receipt.status, 'approved-for-new-repository-publication');
  assert.equal(result.receipt.releaseApproved, true);
  assert.deepEqual(result.receipt.blockers, []);
  assert.equal(result.receipt.source.commit, f.candidateReceipt.source.commit);
  assert.equal(result.receipt.sourceArchive.archiveName, f.archiveName);
  assert.match(readFileSync(path.join(output, 'SHA256SUMS'), 'utf8'), /^[a-f0-9]{64}  approval\.json\n$/);
  assert.throws(() => approvePublicSourceCandidate({ ...f, output }), /already exists/);
});

test('rejects candidate byte tampering and incomplete candidate blockers', (t) => {
  const tampered = fixture(t);
  writeFileSync(path.join(tampered.candidate, tampered.archiveName), 'tampered\n');
  assert.throws(() => approvePublicSourceCandidate({ ...tampered, output: path.join(tampered.parent, 'tampered-out') }), /digest mismatch/);

  const blocked = fixture(t);
  const receiptFile = path.join(blocked.candidate, 'candidate.json');
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'));
  receipt.blockers.push('complete-asset-provenance-review');
  writeJson(receiptFile, receipt);
  const files = [blocked.archiveName, 'candidate.json', 'evidence/inventory.json'];
  writeFileSync(path.join(blocked.candidate, 'SHA256SUMS'), `${files.map((relative) =>
    `${sha256(readFileSync(path.join(blocked.candidate, relative)))}  ${relative}`).sort().join('\n')}\n`);
  assert.throws(() => approvePublicSourceCandidate({ ...blocked, output: path.join(blocked.parent, 'blocked-out') }), /blockers/);
});

test('rejects stale or incomplete self-host acceptance', (t) => {
  const stale = fixture(t);
  const staleReceipt = JSON.parse(readFileSync(stale.selfHostReceipt, 'utf8'));
  staleReceipt.sourceRevision = 'd'.repeat(40);
  writeJson(stale.selfHostReceipt, staleReceipt);
  assert.throws(() => approvePublicSourceCandidate({ ...stale, output: path.join(stale.parent, 'stale-out') }), /not bound/);

  const retained = fixture(t);
  const retainedReceipt = JSON.parse(readFileSync(retained.selfHostReceipt, 'utf8'));
  retainedReceipt.cleanup.retainedProviderResources = ['fixture-vm'];
  writeJson(retained.selfHostReceipt, retainedReceipt);
  assert.throws(() => approvePublicSourceCandidate({ ...retained, output: path.join(retained.parent, 'retained-out') }), /cleanup/);
});

test('rejects stale review identities, review gaps, and incomplete functional review', (t) => {
  const stale = fixture(t);
  const staleReceipt = JSON.parse(readFileSync(stale.reviewReceipt, 'utf8'));
  staleReceipt.candidateReceiptSha256 = 'e'.repeat(64);
  writeJson(stale.reviewReceipt, staleReceipt);
  assert.throws(() => approvePublicSourceCandidate({ ...stale, output: path.join(stale.parent, 'stale-review-out') }), /not an approval/);

  const gap = fixture(t);
  const gapReceipt = JSON.parse(readFileSync(gap.reviewReceipt, 'utf8'));
  gapReceipt.gaps = [{ code: 'fixture-gap' }];
  writeJson(gap.reviewReceipt, gapReceipt);
  assert.throws(() => approvePublicSourceCandidate({ ...gap, output: path.join(gap.parent, 'gap-out') }), /incomplete/);

  const withheld = fixture(t);
  const withheldReceipt = JSON.parse(readFileSync(withheld.reviewReceipt, 'utf8'));
  withheldReceipt.checks.noFunctionalOperatorMachineryWithheld = false;
  writeJson(withheld.reviewReceipt, withheldReceipt);
  assert.throws(() => approvePublicSourceCandidate({ ...withheld, output: path.join(withheld.parent, 'withheld-out') }), /incomplete/);
});

test('rejects linked candidate content and approval output inside the repository', (t) => {
  const linked = fixture(t);
  const external = path.join(linked.parent, 'external.txt');
  writeFileSync(external, 'external\n');
  symlinkSync(external, path.join(linked.candidate, 'evidence', 'linked.txt'));
  assert.throws(() => approvePublicSourceCandidate({ ...linked, output: path.join(linked.parent, 'link-out') }), /regular files|linked directories/);

  const inside = fixture(t);
  assert.throws(() => approvePublicSourceCandidate({ ...inside, output: path.join(inside.root, 'approval') }), /outside/);
});
