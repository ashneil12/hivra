import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { generateAssetProvenanceEvidence } from './asset-provenance-evidence.mjs';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixture(t, { symlinkAsset = false } = {}) {
  const parent = mkdtempSync(path.join(tmpdir(), 'hivra-asset-evidence-test-'));
  const root = path.join(parent, 'repo');
  mkdirSync(root);
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'fixture@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Fixture']);
  const write = (relative, content) => {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  write('README.md', 'fixture\n');
  write('assets/mark.svg', '<svg><path /></svg>\n');
  write('assets/source.txt', 'linked bytes\n');
  if (symlinkAsset) symlinkSync('source.txt', path.join(root, 'assets', 'linked.png'));
  else write('assets/editorial.webp', Buffer.from([1, 2, 3, 4]));
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'assets']);
  const provenanceCommit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const asset = (relative, assetClass, rightsStatus, redistributionDecision) => {
    const bytes = readFileSync(path.join(root, relative));
    return {
      path: relative,
      sha256: sha256(bytes),
      bytes: bytes.length,
      class: assetClass,
      origin: 'Fixture provenance record.',
      provenanceCommit,
      rightsStatus,
      redistributionDecision,
    };
  };
  const assets = [asset('assets/mark.svg', 'brand-asset', 'documented-first-party', 'include')];
  assets.push(symlinkAsset
    ? asset('assets/linked.png', 'linked-asset', 'documented-first-party', 'include')
    : asset('assets/editorial.webp', 'editorial-asset', 'generation-record-attestation-pending', 'hold-for-rights-review'));
  write('docs/release/asset-provenance.json', `${JSON.stringify({
    format: 'hivra-asset-provenance-policy-v1',
    releaseApproved: false,
    assets,
  }, null, 2)}\n`);
  execFileSync('git', ['-C', root, 'add', '-A']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'policy']);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return {
    parent,
    root,
    policy: path.join(root, 'docs/release/asset-provenance.json'),
    write,
    commit(message = 'mutation') {
      execFileSync('git', ['-C', root, 'add', '-A']);
      execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', message]);
    },
  };
}

test('generates deterministic owner-only evidence for every exact tracked asset', (t) => {
  const f = fixture(t);
  const first = path.join(f.parent, 'evidence-a');
  const second = path.join(f.parent, 'evidence-b');
  const a = generateAssetProvenanceEvidence({ root: f.root, output: first });
  const b = generateAssetProvenanceEvidence({ root: f.root, output: second });

  assert.deepEqual(a, b);
  assert.equal(a.status, 'review-required');
  assert.equal(a.releaseApproved, false);
  assert.deepEqual(a.summary, {
    trackedAssets: 2,
    uniqueBlobs: 2,
    includeCount: 1,
    holdCount: 1,
    classes: { 'brand-asset': 1, 'editorial-asset': 1 },
  });
  assert.deepEqual(a.gaps.map((gap) => [gap.code, gap.count]), [
    ['generation-record-attestation-pending', 1],
  ]);
  const name = 'asset-provenance.json';
  assert.deepEqual(readFileSync(path.join(first, name)), readFileSync(path.join(second, name)));
  assert.equal(statSync(first).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(first, name)).mode & 0o777, 0o600);
  assert.throws(() => generateAssetProvenanceEvidence({ root: f.root, output: first }), /already exists/);
});

test('fails closed when the policy misses an asset or retains a deleted asset', (t) => {
  const missing = fixture(t);
  missing.write('assets/new.png', Buffer.from([9, 8, 7]));
  missing.commit('unreviewed asset');
  assert.throws(() => generateAssetProvenanceEvidence({
    root: missing.root,
    output: path.join(missing.parent, 'missing'),
  }), /missing 1, stale 0/);

  const stale = fixture(t);
  execFileSync('git', ['-C', stale.root, 'rm', '--quiet', 'assets/editorial.webp']);
  stale.commit('deleted asset');
  assert.throws(() => generateAssetProvenanceEvidence({
    root: stale.root,
    output: path.join(stale.parent, 'stale'),
  }), /missing 0, stale 1/);
});

test('fails closed when reviewed bytes change or provenance is malformed', (t) => {
  const changed = fixture(t);
  changed.write('assets/editorial.webp', Buffer.from([4, 3, 2, 1]));
  changed.commit('changed asset');
  assert.throws(() => generateAssetProvenanceEvidence({
    root: changed.root,
    output: path.join(changed.parent, 'changed'),
  }), /identity changed/);

  const invalid = fixture(t);
  const policy = JSON.parse(readFileSync(invalid.policy, 'utf8'));
  policy.assets[0].redistributionDecision = 'include';
  policy.assets[0].rightsStatus = 'generation-record-attestation-pending';
  invalid.write('docs/release/asset-provenance.json', `${JSON.stringify(policy, null, 2)}\n`);
  invalid.commit('invalid policy');
  assert.throws(() => generateAssetProvenanceEvidence({
    root: invalid.root,
    output: path.join(invalid.parent, 'invalid'),
  }), /invalid, unsafe, or duplicate/);

  const wrongOrigin = fixture(t);
  const reviewedPolicy = JSON.parse(readFileSync(wrongOrigin.policy, 'utf8'));
  wrongOrigin.write('assets/mark.svg', '<svg><circle /></svg>\n');
  wrongOrigin.commit('different historical asset bytes');
  const wrongOriginCommit = execFileSync('git', ['-C', wrongOrigin.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  wrongOrigin.write('assets/mark.svg', '<svg><path /></svg>\n');
  wrongOrigin.commit('restore reviewed bytes');
  reviewedPolicy.assets[0].provenanceCommit = wrongOriginCommit;
  wrongOrigin.write('docs/release/asset-provenance.json', `${JSON.stringify(reviewedPolicy, null, 2)}\n`);
  wrongOrigin.commit('record mismatched origin');
  assert.throws(() => generateAssetProvenanceEvidence({
    root: wrongOrigin.root,
    output: path.join(wrongOrigin.parent, 'wrong-origin'),
  }), /bytes do not match the recorded commit/);
});

test('rejects symlink assets, dirty trees, and partial output', (t) => {
  const linked = fixture(t, { symlinkAsset: true });
  const output = path.join(linked.parent, 'linked');
  assert.throws(() => generateAssetProvenanceEvidence({ root: linked.root, output }), /regular file/);
  assert.equal(existsSync(output), false);

  const dirty = fixture(t);
  dirty.write('untracked.txt', 'dirty\n');
  assert.throws(() => generateAssetProvenanceEvidence({
    root: dirty.root,
    output: path.join(dirty.parent, 'dirty'),
  }), /must be clean/);
});

test('accepts exact project-generated records and rejects record drift', (t) => {
  const f = fixture(t);
  const policy = JSON.parse(readFileSync(f.policy, 'utf8'));
  const generated = policy.assets.find((asset) => asset.path === 'assets/editorial.webp');
  generated.rightsStatus = 'documented-project-generated';
  generated.redistributionDecision = 'include';
  const records = {
    format: 'hivra-asset-generation-records-v1',
    generatedAssets: [{
      path: generated.path,
      sha256: generated.sha256,
      tool: 'Fixture image tool',
      outputReceipt: 'fixture-output.webp',
      prompt: 'Create the fixture editorial image without text or logos.',
      review: 'Fixture output reviewed for the declared constraints.',
    }],
  };
  const recordBytes = Buffer.from(`${JSON.stringify(records, null, 2)}\n`);
  f.write('docs/release/asset-generation-records.json', recordBytes);
  policy.rightsReview = {
    generationRecords: 'docs/release/asset-generation-records.json',
    generationRecordsSha256: sha256(recordBytes),
  };
  f.write('docs/release/asset-provenance.json', `${JSON.stringify(policy, null, 2)}\n`);
  f.commit('document generated asset');

  const output = path.join(f.parent, 'generated-records');
  const report = generateAssetProvenanceEvidence({ root: f.root, output });
  assert.equal(report.status, 'inventory-complete');
  assert.equal(report.summary.holdCount, 0);
  assert.deepEqual(report.gaps, []);
  assert.deepEqual(report.generationRecords, {
    path: 'docs/release/asset-generation-records.json',
    sha256: sha256(recordBytes),
    recordedAssets: 1,
  });

  records.generatedAssets[0].review = 'Tampered after policy review.';
  f.write('docs/release/asset-generation-records.json', `${JSON.stringify(records, null, 2)}\n`);
  f.commit('tamper generation record');
  assert.throws(() => generateAssetProvenanceEvidence({
    root: f.root,
    output: path.join(f.parent, 'tampered-records'),
  }), /identity changed without review/);
});

test('accepts byte-matched OFL fonts and separate owner assertions', (t) => {
  const f = fixture(t);
  f.write('assets/typeface.woff2', Buffer.from([8, 6, 7, 5, 3, 0, 9]));
  f.write('assets/typeface-OFL.txt', 'SIL Open Font License 1.1 fixture\n');
  f.commit('add licensed font fixture');
  const fontProvenanceCommit = execFileSync(
    'git', ['-C', f.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' },
  ).trim();

  const policy = JSON.parse(readFileSync(f.policy, 'utf8'));
  const artwork = policy.assets.find((asset) => asset.path === 'assets/editorial.webp');
  artwork.rightsStatus = 'documented-owner-asserted-original-artwork';
  artwork.redistributionDecision = 'include';
  const fontBytes = readFileSync(path.join(f.root, 'assets/typeface.woff2'));
  const licenseBytes = readFileSync(path.join(f.root, 'assets/typeface-OFL.txt'));
  policy.assets.push({
    path: 'assets/typeface.woff2',
    sha256: sha256(fontBytes),
    bytes: fontBytes.length,
    class: 'third-party-font',
    origin: 'Fixture official upstream byte match and adjacent OFL evidence.',
    provenanceCommit: fontProvenanceCommit,
    rightsStatus: 'documented-third-party-font',
    redistributionDecision: 'include',
  });

  const fonts = {
    format: 'hivra-font-license-evidence-v1',
    fonts: [{
      path: 'assets/typeface.woff2',
      sha256: sha256(fontBytes),
      family: 'Fixture Sans',
      format: 'woff2',
      upstreamPublisher: 'Fixture Fonts',
      upstreamArtifactUrl: 'https://example.invalid/fonts/typeface.woff2',
      upstreamDownloadedSha256: sha256(fontBytes),
      licenseSpdx: 'OFL-1.1',
      licensePath: 'assets/typeface-OFL.txt',
      licenseSha256: sha256(licenseBytes),
      upstreamLicenseUrl: 'https://example.invalid/fonts/OFL.txt',
    }],
  };
  const ownerAssertions = {
    format: 'hivra-asset-owner-assertions-v1',
    assertions: [{
      path: artwork.path,
      sha256: artwork.sha256,
      assertedBy: 'repository-owner',
      assertion: 'The artwork was not taken from anybody.',
      redistributionBasis: 'owner-originality-assertion',
      independentEvidenceLevel: 'repository-history-only',
      independentEvidence: 'The exact fixture bytes are present in the recorded repository commit.',
    }],
    boundary: 'Owner assertion and repository history are recorded separately.',
  };
  const fontRecordBytes = Buffer.from(`${JSON.stringify(fonts, null, 2)}\n`);
  const ownerRecordBytes = Buffer.from(`${JSON.stringify(ownerAssertions, null, 2)}\n`);
  f.write('docs/release/font-license-evidence.json', fontRecordBytes);
  f.write('docs/release/asset-owner-assertions.json', ownerRecordBytes);
  policy.rightsReview = {
    fontLicenseEvidence: 'docs/release/font-license-evidence.json',
    fontLicenseEvidenceSha256: sha256(fontRecordBytes),
    ownerAssertions: 'docs/release/asset-owner-assertions.json',
    ownerAssertionsSha256: sha256(ownerRecordBytes),
  };
  f.write('docs/release/asset-provenance.json', `${JSON.stringify(policy, null, 2)}\n`);
  f.commit('record licensed font and owner assertion');

  const report = generateAssetProvenanceEvidence({
    root: f.root,
    output: path.join(f.parent, 'licensed-and-asserted'),
  });
  assert.equal(report.status, 'inventory-complete');
  assert.deepEqual(report.fontLicenseEvidence, {
    path: 'docs/release/font-license-evidence.json',
    sha256: sha256(fontRecordBytes),
    recordedAssets: 1,
    uniqueBlobs: 1,
    license: 'OFL-1.1',
  });
  assert.deepEqual(report.ownerAssertions, {
    path: 'docs/release/asset-owner-assertions.json',
    sha256: sha256(ownerRecordBytes),
    recordedAssets: 1,
    independentByteMatches: 0,
  });

  f.write('assets/typeface-OFL.txt', 'changed license text\n');
  f.commit('change adjacent license');
  assert.throws(() => generateAssetProvenanceEvidence({
    root: f.root,
    output: path.join(f.parent, 'changed-license'),
  }), /Font license identity changed without review/);
});

test('fails closed when owner assertions do not cover every asserted artwork asset', (t) => {
  const f = fixture(t);
  const policy = JSON.parse(readFileSync(f.policy, 'utf8'));
  const artwork = policy.assets.find((asset) => asset.path === 'assets/editorial.webp');
  artwork.rightsStatus = 'documented-owner-asserted-original-artwork';
  artwork.redistributionDecision = 'include';
  const assertions = {
    format: 'hivra-asset-owner-assertions-v1',
    assertions: [],
    boundary: 'Fixture boundary.',
  };
  const assertionBytes = Buffer.from(`${JSON.stringify(assertions, null, 2)}\n`);
  f.write('docs/release/asset-owner-assertions.json', assertionBytes);
  policy.rightsReview = {
    ownerAssertions: 'docs/release/asset-owner-assertions.json',
    ownerAssertionsSha256: sha256(assertionBytes),
  };
  f.write('docs/release/asset-provenance.json', `${JSON.stringify(policy, null, 2)}\n`);
  f.commit('record incomplete owner assertions');
  assert.throws(() => generateAssetProvenanceEvidence({
    root: f.root,
    output: path.join(f.parent, 'incomplete-owner-assertions'),
  }), /not exhaustive for owner-asserted artwork/);
});

function derivedFixture(t) {
  const f = fixture(t);
  f.write('assets/editorial-small.webp', Buffer.from([5, 6, 7, 8]));
  f.write('scripts/export.py', 'print("export")\n');
  f.commit('add derived export and its script');
  const derivedCommit = execFileSync('git', ['-C', f.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const policy = JSON.parse(readFileSync(f.policy, 'utf8'));
  const source = policy.assets.find((asset) => asset.path === 'assets/editorial.webp');
  source.rightsStatus = 'documented-owner-asserted-original-artwork';
  source.redistributionDecision = 'include';
  const ownerRecords = {
    format: 'hivra-asset-owner-assertions-v1',
    boundary: 'Fixture boundary.',
    assertions: [{
      path: source.path,
      sha256: source.sha256,
      assertedBy: 'repository-owner',
      redistributionBasis: 'owner-originality-assertion',
      independentEvidenceLevel: 'repository-history-only',
      assertion: 'Fixture assertion.',
      independentEvidence: 'Fixture evidence.',
    }],
  };
  const ownerBytes = Buffer.from(`${JSON.stringify(ownerRecords, null, 2)}\n`);
  f.write('docs/release/asset-owner-assertions.json', ownerBytes);
  const derivedBytes = readFileSync(path.join(f.root, 'assets/editorial-small.webp'));
  policy.assets.push({
    path: 'assets/editorial-small.webp',
    sha256: sha256(derivedBytes),
    bytes: derivedBytes.length,
    class: 'derived-export',
    origin: 'Fixture resized export.',
    provenanceCommit: derivedCommit,
    rightsStatus: 'documented-derived-export',
    redistributionDecision: 'include',
  });
  const records = {
    format: 'hivra-asset-derived-exports-v1',
    derivedAssets: [{
      path: 'assets/editorial-small.webp',
      sha256: sha256(derivedBytes),
      sourcePath: source.path,
      sourceSha256: source.sha256,
      method: 'Lanczos resize to 256px wide, then WebP.',
      script: 'scripts/export.py',
      command: 'python3 scripts/export.py',
      parameters: { width: 256, quality: 78 },
      toolVersions: { pillow: '11.3.0' },
      reproduction: 'Rerunning the script reproduces these bytes.',
    }],
  };
  const write = (value = records) => {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    f.write('docs/release/asset-derived-exports.json', bytes);
    policy.rightsReview = {
      ownerAssertions: 'docs/release/asset-owner-assertions.json',
      ownerAssertionsSha256: sha256(ownerBytes),
      derivedExports: 'docs/release/asset-derived-exports.json',
      derivedExportsSha256: sha256(bytes),
    };
    f.write('docs/release/asset-provenance.json', `${JSON.stringify(policy, null, 2)}\n`);
    f.commit('record derived export');
  };
  return { f, policy, records, write, ownerBytes };
}

test('accepts a derived export whose recorded source is includable and unchanged', (t) => {
  const { f, records, write } = derivedFixture(t);
  write();
  const report = generateAssetProvenanceEvidence({ root: f.root, output: path.join(f.parent, 'derived') });
  assert.equal(report.status, 'inventory-complete');
  assert.deepEqual(report.derivedExports, {
    path: 'docs/release/asset-derived-exports.json',
    sha256: sha256(Buffer.from(`${JSON.stringify(records, null, 2)}\n`)),
    recordedAssets: 1,
    sources: 1,
  });
  assert.equal(report.generationRecords, null);
});

test('rejects a derived export with a missing, held, derived or changed source', (t) => {
  const missing = derivedFixture(t);
  missing.records.derivedAssets[0].sourcePath = 'assets/not-an-asset.webp';
  missing.write();
  assert.throws(() => generateAssetProvenanceEvidence({
    root: missing.f.root, output: path.join(missing.f.parent, 'missing'),
  }), /source is missing, derived, held, or changed/);

  const changed = derivedFixture(t);
  changed.records.derivedAssets[0].sourceSha256 = 'f'.repeat(64);
  changed.write();
  assert.throws(() => generateAssetProvenanceEvidence({
    root: changed.f.root, output: path.join(changed.f.parent, 'changed'),
  }), /source is missing, derived, held, or changed/);

  const held = derivedFixture(t);
  const heldSource = held.policy.assets.find((asset) => asset.path === 'assets/editorial.webp');
  heldSource.rightsStatus = 'generation-record-attestation-pending';
  heldSource.redistributionDecision = 'hold-for-rights-review';
  held.write();
  assert.throws(() => generateAssetProvenanceEvidence({
    root: held.f.root, output: path.join(held.f.parent, 'held'),
  }), /source is missing, derived, held, or changed/);

  // A derived export cannot be the source of another, so every chain ends in a recorded asset.
  const chained = derivedFixture(t);
  chained.records.derivedAssets[0].sourcePath = 'assets/editorial-small.webp';
  chained.records.derivedAssets[0].sourceSha256 = chained.records.derivedAssets[0].sha256;
  chained.write();
  assert.throws(() => generateAssetProvenanceEvidence({
    root: chained.f.root, output: path.join(chained.f.parent, 'chained'),
  }), /source is missing, derived, held, or changed/);
});

test('rejects derived export records that are not exhaustive, described or reproducible', (t) => {
  const unrecorded = derivedFixture(t);
  unrecorded.records.derivedAssets = [];
  unrecorded.write();
  assert.throws(() => generateAssetProvenanceEvidence({
    root: unrecorded.f.root, output: path.join(unrecorded.f.parent, 'unrecorded'),
  }), /not exhaustive for derived exports/);

  const undescribed = derivedFixture(t);
  undescribed.records.derivedAssets[0].method = ' ';
  undescribed.write();
  assert.throws(() => generateAssetProvenanceEvidence({
    root: undescribed.f.root, output: path.join(undescribed.f.parent, 'undescribed'),
  }), /derivation is missing or incomplete/);

  const noScript = derivedFixture(t);
  noScript.records.derivedAssets[0].script = 'scripts/absent.py';
  noScript.records.derivedAssets[0].command = 'python3 scripts/absent.py';
  noScript.write();
  assert.throws(() => generateAssetProvenanceEvidence({
    root: noScript.f.root, output: path.join(noScript.f.parent, 'no-script'),
  }), /Derived export script is missing/);

  const wrongBytes = derivedFixture(t);
  wrongBytes.records.derivedAssets[0].sha256 = 'a'.repeat(64);
  wrongBytes.write();
  assert.throws(() => generateAssetProvenanceEvidence({
    root: wrongBytes.f.root, output: path.join(wrongBytes.f.parent, 'wrong-bytes'),
  }), /source is missing, derived, held, or changed/);

  const tampered = derivedFixture(t);
  tampered.write();
  tampered.records.derivedAssets[0].method = 'Tampered after policy review.';
  tampered.f.write('docs/release/asset-derived-exports.json', `${JSON.stringify(tampered.records, null, 2)}\n`);
  tampered.f.commit('tamper derived export record');
  assert.throws(() => generateAssetProvenanceEvidence({
    root: tampered.f.root, output: path.join(tampered.f.parent, 'tampered'),
  }), /identity changed without review/);
});
