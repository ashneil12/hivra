import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { generateNoticeSourceOfferEvidence } from './notice-source-offer-evidence.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha512 = (value) => createHash('sha512').update(value).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function component(name, license, { version = '1.0.0', identity = true, development = false, bundled = false, packagePath = null } = {}) {
  const result = {
    type: 'library',
    name,
    version,
    purl: `pkg:npm/${encodeURIComponent(name).replace('%40', '%40').replace('%2F', '%2F')}@${version}`,
    properties: [
      ...(development ? [{ name: 'cdx:npm:package:development', value: 'true' }] : []),
      ...(bundled ? [{ name: 'cdx:npm:package:bundled', value: 'true' }] : []),
      ...(packagePath ? [{ name: 'cdx:npm:package:path', value: packagePath }] : []),
    ],
  };
  if (license) result.licenses = [{ license: { id: license } }];
  if (identity) {
    result.externalReferences = [{ type: 'distribution', url: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` }];
    result.hashes = [{ alg: 'SHA-512', content: sha512(`${name}@${version}`) }];
  }
  return result;
}

function fixture(t, { tamperChecksum = false, overrides } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'hivra-notice-root-'));
  const inventoryDirectory = path.join(root, 'inventory');
  mkdirSync(path.join(root, 'docs', 'release'), { recursive: true });
  mkdirSync(path.join(inventoryDirectory, 'app'), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const undeclared = component('missing-license', null);
  const duplicateWithoutIdentity = component('duplicate', 'MIT', { identity: false, development: true });
  const duplicateWithIdentity = component('duplicate', 'MIT');
  const bom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    components: [
      component('plain', 'MIT'),
      component('reciprocal', 'LGPL-3.0-only'),
      component('choice', 'GPL-2.0-only OR MIT'),
      component('attribution', 'CC-BY-4.0'),
      undeclared,
      duplicateWithoutIdentity,
      duplicateWithIdentity,
    ],
  };
  const bomBytes = Buffer.from(json(bom));
  writeFileSync(path.join(inventoryDirectory, 'app', 'sbom.cdx.json'), bomBytes);
  const inventory = {
    format: 'hivra-dependency-inventory-v1',
    status: 'inventory-only',
    releaseApproved: false,
    gitHead: 'a'.repeat(40),
    components: [{ path: 'app', bom: { path: 'app/sbom.cdx.json', sha256: tamperChecksum ? '0'.repeat(64) : sha256(bomBytes) } }],
  };
  writeFileSync(path.join(inventoryDirectory, 'inventory.json'), json(inventory));
  const policy = overrides ?? {
    format: 'hivra-npm-license-overrides-v1',
    releaseApproved: false,
    packages: [{
      name: 'missing-license', version: '1.0.0', licenseExpression: 'BSD-3-Clause',
      distributionUrl: undeclared.externalReferences[0].url,
      distributionSha512: undeclared.hashes[0].content,
      licenseFiles: [],
    }],
  };
  writeFileSync(path.join(root, 'docs', 'release', 'npm-license-overrides.json'), json(policy));
  return { root, inventoryDirectory, output: path.join(root, 'evidence'), policy };
}

test('generates stable fail-closed review evidence and merges incomplete duplicate identities', (t) => {
  const f = fixture(t);
  const report = generateNoticeSourceOfferEvidence(f);
  assert.equal(report.releaseApproved, false);
  assert.equal(report.status, 'review-plan');
  assert.equal(report.summary.componentOccurrences, 7);
  assert.equal(report.summary.uniqueNpmComponents, 6);
  assert.equal(report.summary.reviewedMetadataOverrides, 1);
  assert.equal(report.summary.unresolvedLicenseCount, 0);
  assert.equal(report.summary.noticeReviewCount, 3);
  assert.equal(report.summary.attributionReviewCount, 1);
  assert.equal(report.summary.sourceCorrespondenceReviewCount, 1);
  assert.equal(report.summary.manualLicenseChoiceReviewCount, 1);
  assert.equal(report.summary.reviewedOverridesWithoutLicenseFileCount, 1);
  const duplicate = report.components.find((entry) => entry.name === 'duplicate');
  assert.ok(duplicate.distributionUrl);
  assert.equal(duplicate.developmentOnly, false);
  assert.deepEqual(duplicate.inventoryRoots, ['app']);
  assert.ok(report.gaps.some((gap) => gap.code === 'package-license-text-and-copyright-collection-pending'));
  assert.ok(report.gaps.some((gap) => gap.code === 'runtime-and-image-notices-outside-npm-scope'));
  assert.equal(statSync(f.output).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(f.output, 'notice-source-offer.json')).mode & 0o777, 0o600);
  assert.equal(statSync(path.join(f.output, 'NOTICE-INDEX.review.tsv')).mode & 0o777, 0o600);

  const second = path.join(f.root, 'evidence-second');
  generateNoticeSourceOfferEvidence({ ...f, output: second });
  for (const name of ['notice-source-offer.json', 'NOTICE-INDEX.review.tsv']) {
    assert.deepEqual(readFileSync(path.join(f.output, name)), readFileSync(path.join(second, name)), name);
  }
  assert.throws(() => generateNoticeSourceOfferEvidence(f), /already exists/);
});

test('refuses tampered SBOM checksums without publishing partial evidence', (t) => {
  const f = fixture(t, { tamperChecksum: true });
  assert.throws(() => generateNoticeSourceOfferEvidence(f), /checksum/);
  assert.throws(() => statSync(f.output), /ENOENT/);
});

test('review overrides are exact, complete and fail closed when stale', (t) => {
  const stale = fixture(t);
  stale.policy.packages.push({ ...stale.policy.packages[0], name: 'unused' });
  writeFileSync(path.join(stale.root, 'docs', 'release', 'npm-license-overrides.json'), json(stale.policy));
  assert.throws(() => generateNoticeSourceOfferEvidence(stale), /did not match/);

  const mismatch = fixture(t);
  mismatch.policy.packages[0].distributionSha512 = 'f'.repeat(128);
  writeFileSync(path.join(mismatch.root, 'docs', 'release', 'npm-license-overrides.json'), json(mismatch.policy));
  assert.throws(() => generateNoticeSourceOfferEvidence(mismatch), /exact package artifact/);
});

test('unsafe evidence fields cannot enter JSON or tab-separated output', (t) => {
  const f = fixture(t);
  const inventoryPath = path.join(f.inventoryDirectory, 'inventory.json');
  const inventory = JSON.parse(readFileSync(inventoryPath));
  inventory.components[0].path = 'app\tforged';
  writeFileSync(inventoryPath, json(inventory));
  assert.throws(() => generateNoticeSourceOfferEvidence(f), /unsafe package root/);

  const injected = fixture(t);
  const bomPath = path.join(injected.inventoryDirectory, 'app', 'sbom.cdx.json');
  const bom = JSON.parse(readFileSync(bomPath));
  bom.components[0].purl = 'pkg:npm/plain@1.0.0\tforged';
  const bomBytes = Buffer.from(json(bom));
  writeFileSync(bomPath, bomBytes);
  const injectedInventoryPath = path.join(injected.inventoryDirectory, 'inventory.json');
  const injectedInventory = JSON.parse(readFileSync(injectedInventoryPath));
  injectedInventory.components[0].bom.sha256 = sha256(bomBytes);
  writeFileSync(injectedInventoryPath, json(injectedInventory));
  assert.throws(() => generateNoticeSourceOfferEvidence(injected), /identity is incomplete/);
});

test('binds bundled npm components to the exact containing package artifact', (t) => {
  const f = fixture(t);
  const bomPath = path.join(f.inventoryDirectory, 'app', 'sbom.cdx.json');
  const bom = JSON.parse(readFileSync(bomPath));
  const parent = component('bundle-parent', 'MIT', { packagePath: 'node_modules/bundle-parent' });
  const child = component('bundle-child', 'MIT', {
    identity: false,
    bundled: true,
    packagePath: 'node_modules/bundle-parent/node_modules/bundle-child',
  });
  bom.components.push(parent, child);
  bom.dependencies = [{ ref: parent['bom-ref'] ?? 'bundle-parent@1.0.0', dependsOn: [child['bom-ref'] ?? 'bundle-child@1.0.0'] }];
  parent['bom-ref'] = 'bundle-parent@1.0.0';
  child['bom-ref'] = 'bundle-child@1.0.0';
  bom.dependencies[0] = { ref: parent['bom-ref'], dependsOn: [child['bom-ref']] };
  const bomBytes = Buffer.from(json(bom));
  writeFileSync(bomPath, bomBytes);
  const inventoryPath = path.join(f.inventoryDirectory, 'inventory.json');
  const inventory = JSON.parse(readFileSync(inventoryPath));
  inventory.components[0].bom.sha256 = sha256(bomBytes);
  writeFileSync(inventoryPath, json(inventory));

  const report = generateNoticeSourceOfferEvidence(f);
  const record = report.components.find((entry) => entry.name === 'bundle-child');
  assert.equal(record.distributionUrl, null);
  assert.equal(record.distributionSha512, null);
  assert.deepEqual(record.bundledWith, {
    purl: parent.purl,
    distributionUrl: parent.externalReferences[0].url,
    distributionSha512: parent.hashes[0].content,
  });
  assert.equal(report.summary.missingDistributionCount, 0);
  assert.equal(report.summary.missingIntegrityCount, 0);
});

test('fails closed when a bundled npm component has no containing artifact', (t) => {
  const f = fixture(t);
  const bomPath = path.join(f.inventoryDirectory, 'app', 'sbom.cdx.json');
  const bom = JSON.parse(readFileSync(bomPath));
  const child = component('orphan-bundle', 'MIT', {
    identity: false,
    bundled: true,
    packagePath: 'node_modules/missing-parent/node_modules/orphan-bundle',
  });
  child['bom-ref'] = 'orphan-bundle@1.0.0';
  bom.components.push(child);
  const bomBytes = Buffer.from(json(bom));
  writeFileSync(bomPath, bomBytes);
  const inventoryPath = path.join(f.inventoryDirectory, 'inventory.json');
  const inventory = JSON.parse(readFileSync(inventoryPath));
  inventory.components[0].bom.sha256 = sha256(bomBytes);
  writeFileSync(inventoryPath, json(inventory));

  assert.throws(() => generateNoticeSourceOfferEvidence(f), /exactly one containing package artifact/);
});
