#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_POLICY = 'docs/release/asset-provenance.json';
const ASSET_EXTENSION = /\.(?:gif|ico|jpe?g|mov|mp4|otf|pdf|png|svg|ttf|wasm|webm|webp|woff2?|zip|gz)$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;
const RIGHTS_STATUSES = new Set([
  'documented-first-party',
  'documented-project-generated',
  'documented-third-party-font',
  'documented-owner-asserted-original-artwork',
  'quiver-creator-plan-attestation-pending',
  'generation-record-attestation-pending',
]);
const INCLUDABLE_RIGHTS_STATUSES = new Set([
  'documented-first-party',
  'documented-project-generated',
  'documented-third-party-font',
  'documented-owner-asserted-original-artwork',
]);
const DECISIONS = new Set(['include', 'hold-for-rights-review']);
const commandOptions = {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 30_000,
  maxBuffer: 32 * 1024 * 1024,
};

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], commandOptions);
  } catch {
    throw new Error('Cannot inspect the selected Git checkout.');
  }
}

function gitBytes(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { ...commandOptions, encoding: null });
  } catch {
    throw new Error('Cannot read the selected Git object.');
  }
}

function safeRelative(value, label = 'Asset path') {
  if (
    typeof value !== 'string' || !value || value.length > 1024 ||
    path.posix.isAbsolute(value) || value.includes('\\') || CONTROL.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) throw new Error(`${label} is unsafe.`);
  return value;
}

function checkedOutput(output) {
  const resolved = path.resolve(output);
  const parent = path.dirname(resolved);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new Error('Evidence output parent must already exist.');
  }
  if (existsSync(resolved)) throw new Error('Evidence output already exists; choose a new directory.');
  return resolved;
}

function safePolicy(file) {
  const info = lstatSync(file);
  if (!info.isFile() || realpathSync(file) !== file || info.size > 4 * 1024 * 1024) {
    throw new Error('Asset provenance policy must be one bounded regular file.');
  }
  const bytes = readFileSync(file);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Asset provenance policy is not valid JSON.');
  }
  if (
    value?.format !== 'hivra-asset-provenance-policy-v1' ||
    value?.releaseApproved !== false ||
    !Array.isArray(value?.assets)
  ) throw new Error('Asset provenance policy has an invalid shape.');
  return { bytes, value };
}

function validateEntry(entry, seen) {
  const relative = safeRelative(entry?.path);
  if (
    seen.has(relative) || !ASSET_EXTENSION.test(relative) ||
    typeof entry?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256) ||
    !Number.isSafeInteger(entry?.bytes) || entry.bytes < 1 ||
    typeof entry?.class !== 'string' || !/^[a-z][a-z0-9-]{2,63}$/.test(entry.class) ||
    typeof entry?.origin !== 'string' || !entry.origin.trim() || entry.origin.length > 1000 || CONTROL.test(entry.origin) ||
    typeof entry?.provenanceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(entry.provenanceCommit) ||
    !RIGHTS_STATUSES.has(entry?.rightsStatus) || !DECISIONS.has(entry?.redistributionDecision) ||
    (entry.redistributionDecision === 'include' && !INCLUDABLE_RIGHTS_STATUSES.has(entry.rightsStatus)) ||
    (entry.redistributionDecision === 'hold-for-rights-review' && INCLUDABLE_RIGHTS_STATUSES.has(entry.rightsStatus))
  ) throw new Error('Asset provenance policy contains an invalid, unsafe, or duplicate entry.');
  seen.add(relative);
  return entry;
}

function safeHttps(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is invalid.`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function boundRecord(root, policy, { pathField, shaField, format, label }) {
  const relative = safeRelative(policy?.rightsReview?.[pathField], `${label} path`);
  const expectedSha256 = policy?.rightsReview?.[shaField];
  if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error(`${label} identity is missing or invalid.`);
  }
  const absolute = path.resolve(root, ...relative.split('/'));
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error(`${label} path escaped the repository.`);
  const info = lstatSync(absolute);
  if (!info.isFile() || realpathSync(absolute) !== absolute || info.size > 4 * 1024 * 1024) {
    throw new Error(`${label} must be one bounded regular file.`);
  }
  const bytes = readFileSync(absolute);
  if (sha256(bytes) !== expectedSha256) throw new Error(`${label} identity changed without review.`);
  let committedBytes;
  try {
    committedBytes = gitBytes(root, ['show', `HEAD:${relative}`]);
  } catch {
    throw new Error(`${label} is not available in the committed source revision.`);
  }
  if (sha256(committedBytes) !== expectedSha256) {
    throw new Error(`${label} is not bound to the committed source revision.`);
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (value?.format !== format) throw new Error(`${label} has an invalid shape.`);
  return { relative, expectedSha256, value };
}

function committedFileHash(root, relative, label) {
  const absolute = path.resolve(root, ...relative.split('/'));
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error(`${label} path escaped the repository.`);
  const info = lstatSync(absolute);
  if (!info.isFile() || realpathSync(absolute) !== absolute || info.size > 4 * 1024 * 1024) {
    throw new Error(`${label} must be one bounded regular file.`);
  }
  const bytes = readFileSync(absolute);
  let committedBytes;
  try {
    committedBytes = gitBytes(root, ['show', `HEAD:${relative}`]);
  } catch {
    throw new Error(`${label} is not available in the committed source revision.`);
  }
  const workingSha256 = sha256(bytes);
  if (sha256(committedBytes) !== workingSha256) throw new Error(`${label} is not bound to the committed source revision.`);
  return workingSha256;
}

function validateFontEvidence(root, policy, assets) {
  const fonts = assets.filter((asset) => asset.rightsStatus === 'documented-third-party-font');
  if (fonts.length === 0) return null;
  const evidence = boundRecord(root, policy, {
    pathField: 'fontLicenseEvidence',
    shaField: 'fontLicenseEvidenceSha256',
    format: 'hivra-font-license-evidence-v1',
    label: 'Font license evidence',
  });
  if (!Array.isArray(evidence.value?.fonts)) throw new Error('Font license evidence has an invalid shape.');
  const byPath = new Map(evidence.value.fonts.map((record) => [record?.path, record]));
  const fontPaths = fonts.map((asset) => asset.path).sort();
  const recordedPaths = [...byPath.keys()].sort();
  if (byPath.size !== evidence.value.fonts.length || JSON.stringify(recordedPaths) !== JSON.stringify(fontPaths)) {
    throw new Error('Font license evidence is not exhaustive for third-party fonts.');
  }
  for (const asset of fonts) {
    const record = byPath.get(asset.path);
    const licensePath = safeRelative(record?.licensePath, 'Font license path');
    if (
      record?.sha256 !== asset.sha256 || record?.upstreamDownloadedSha256 !== asset.sha256 ||
      typeof record?.family !== 'string' || !record.family.trim() ||
      !['ttf', 'woff2'].includes(record?.format) || !asset.path.endsWith(`.${record.format}`) ||
      typeof record?.upstreamPublisher !== 'string' || !record.upstreamPublisher.trim() ||
      record?.licenseSpdx !== 'OFL-1.1' ||
      typeof record?.licenseSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.licenseSha256) ||
      path.posix.dirname(licensePath) !== path.posix.dirname(asset.path)
    ) throw new Error(`Font license evidence is missing or incomplete: ${asset.path}`);
    safeHttps(record.upstreamArtifactUrl, 'Font upstream artifact URL');
    safeHttps(record.upstreamLicenseUrl, 'Font upstream license URL');
    if (committedFileHash(root, licensePath, 'Font license') !== record.licenseSha256) {
      throw new Error(`Font license identity changed without review: ${licensePath}`);
    }
  }
  return {
    path: evidence.relative,
    sha256: evidence.expectedSha256,
    recordedAssets: fonts.length,
    uniqueBlobs: new Set(fonts.map((asset) => asset.sha256)).size,
    license: 'OFL-1.1',
  };
}

function validateOwnerAssertions(root, policy, assets) {
  const asserted = assets.filter((asset) => asset.rightsStatus === 'documented-owner-asserted-original-artwork');
  if (asserted.length === 0) return null;
  const evidence = boundRecord(root, policy, {
    pathField: 'ownerAssertions',
    shaField: 'ownerAssertionsSha256',
    format: 'hivra-asset-owner-assertions-v1',
    label: 'Asset owner assertions',
  });
  if (!Array.isArray(evidence.value?.assertions) || typeof evidence.value?.boundary !== 'string' || !evidence.value.boundary.trim()) {
    throw new Error('Asset owner assertions have an invalid shape.');
  }
  const byPath = new Map(evidence.value.assertions.map((record) => [record?.path, record]));
  const assertedPaths = asserted.map((asset) => asset.path).sort();
  const recordedPaths = [...byPath.keys()].sort();
  if (byPath.size !== evidence.value.assertions.length || JSON.stringify(recordedPaths) !== JSON.stringify(assertedPaths)) {
    throw new Error('Asset owner assertions are not exhaustive for owner-asserted artwork.');
  }
  for (const asset of asserted) {
    const record = byPath.get(asset.path);
    if (
      record?.sha256 !== asset.sha256 || record?.assertedBy !== 'repository-owner' ||
      record?.redistributionBasis !== 'owner-originality-assertion' ||
      !['repository-history-only', 'owner-supplied-original-byte-match'].includes(record?.independentEvidenceLevel) ||
      typeof record?.assertion !== 'string' || !record.assertion.trim() ||
      typeof record?.independentEvidence !== 'string' || !record.independentEvidence.trim()
    ) throw new Error(`Asset owner assertion is missing or incomplete: ${asset.path}`);
  }
  return {
    path: evidence.relative,
    sha256: evidence.expectedSha256,
    recordedAssets: asserted.length,
    independentByteMatches: evidence.value.assertions.filter(
      (record) => record.independentEvidenceLevel === 'owner-supplied-original-byte-match',
    ).length,
  };
}

function validateGenerationRecords(root, policy, assets) {
  const generated = assets.filter((asset) => asset.rightsStatus === 'documented-project-generated');
  if (generated.length === 0) return null;
  const relative = safeRelative(policy?.rightsReview?.generationRecords, 'Generation records path');
  const expectedSha256 = policy?.rightsReview?.generationRecordsSha256;
  if (typeof expectedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error('Generation records identity is missing or invalid.');
  }
  const absolute = path.resolve(root, ...relative.split('/'));
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error('Generation records path escaped the repository.');
  const info = lstatSync(absolute);
  if (!info.isFile() || realpathSync(absolute) !== absolute || info.size > 4 * 1024 * 1024) {
    throw new Error('Generation records must be one bounded regular file.');
  }
  const bytes = readFileSync(absolute);
  if (sha256(bytes) !== expectedSha256) throw new Error('Generation records identity changed without review.');
  let committedBytes;
  try {
    committedBytes = gitBytes(root, ['show', `HEAD:${relative}`]);
  } catch {
    throw new Error('Generation records are not available in the committed source revision.');
  }
  if (sha256(committedBytes) !== expectedSha256) {
    throw new Error('Generation records are not bound to the committed source revision.');
  }
  let records;
  try {
    records = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Generation records are not valid JSON.');
  }
  if (records?.format !== 'hivra-asset-generation-records-v1' || !Array.isArray(records?.generatedAssets)) {
    throw new Error('Generation records have an invalid shape.');
  }
  const byPath = new Map(records.generatedAssets.map((record) => [record?.path, record]));
  const generatedPaths = generated.map((asset) => asset.path).sort();
  const recordedPaths = [...byPath.keys()].sort();
  if (byPath.size !== records.generatedAssets.length || JSON.stringify(recordedPaths) !== JSON.stringify(generatedPaths)) {
    throw new Error('Generation records are not exhaustive for project-generated assets.');
  }
  for (const asset of generated) {
    const record = byPath.get(asset.path);
    if (
      record?.sha256 !== asset.sha256 || typeof record?.tool !== 'string' || !record.tool.trim() ||
      typeof record?.outputReceipt !== 'string' || !record.outputReceipt.trim() ||
      typeof record?.review !== 'string' || !record.review.trim() ||
      !(typeof record?.prompt === 'string' || (
        typeof record?.basePrompt === 'string' && typeof record?.finalEditPrompt === 'string'
      ))
    ) throw new Error(`Generation record is missing or incomplete: ${asset.path}`);
  }
  return { path: relative, sha256: expectedSha256, recordedAssets: generated.length };
}

function trackedAssetPaths(root, head) {
  return git(root, ['ls-tree', '-r', '-z', '--name-only', head])
    .split('\0')
    .filter(Boolean)
    .map((relative) => safeRelative(relative, 'Tracked path'))
    .filter((relative) => ASSET_EXTENSION.test(relative))
    .sort();
}

function readAsset(root, relative) {
  const absolute = path.resolve(root, ...relative.split('/'));
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error('Asset path escaped the repository.');
  const info = lstatSync(absolute);
  if (!info.isFile() || realpathSync(absolute) !== absolute || info.size > 128 * 1024 * 1024) {
    throw new Error(`Tracked asset is not one bounded regular file: ${relative}`);
  }
  return readFileSync(absolute);
}

export function generateAssetProvenanceEvidence({ root, output, policyPath } = {}) {
  root = realpathSync(root ?? git(process.cwd(), ['rev-parse', '--show-toplevel']).trim());
  const repositoryRoot = realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim());
  if (root !== repositoryRoot) throw new Error('The selected checkout must be the Git repository root.');
  output = checkedOutput(output);
  if (git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).length !== 0) {
    throw new Error('The source checkout must be clean before generating asset evidence.');
  }

  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const policyFile = realpathSync(path.resolve(root, policyPath ?? DEFAULT_POLICY));
  if (!policyFile.startsWith(`${root}${path.sep}`)) throw new Error('Asset provenance policy must be inside the repository.');
  const policy = safePolicy(policyFile);
  const seen = new Set();
  const policyEntries = policy.value.assets.map((entry) => validateEntry(entry, seen));
  const tracked = trackedAssetPaths(root, head);
  const declared = policyEntries.map((entry) => entry.path).sort();
  if (JSON.stringify(tracked) !== JSON.stringify(declared)) {
    const trackedSet = new Set(tracked);
    const declaredSet = new Set(declared);
    const missing = tracked.filter((relative) => !declaredSet.has(relative));
    const stale = declared.filter((relative) => !trackedSet.has(relative));
    throw new Error(`Asset provenance policy is not exhaustive (missing ${missing.length}, stale ${stale.length}).`);
  }

  const assets = policyEntries
    .map((entry) => {
      const bytes = readAsset(root, entry.path);
      if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) {
        throw new Error(`Asset provenance identity changed without review: ${entry.path}`);
      }
      let provenanceBytes;
      try {
        provenanceBytes = gitBytes(root, ['show', `${entry.provenanceCommit}:${entry.path}`]);
      } catch {
        throw new Error(`Asset provenance commit does not contain the reviewed path: ${entry.path}`);
      }
      if (provenanceBytes.length !== entry.bytes || sha256(provenanceBytes) !== entry.sha256) {
        throw new Error(`Asset provenance bytes do not match the recorded commit: ${entry.path}`);
      }
      return { ...entry };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const generationRecords = validateGenerationRecords(root, policy.value, assets);
  const fontLicenseEvidence = validateFontEvidence(root, policy.value, assets);
  const ownerAssertions = validateOwnerAssertions(root, policy.value, assets);

  const groups = new Map();
  for (const asset of assets.filter((entry) => entry.redistributionDecision === 'hold-for-rights-review')) {
    const group = groups.get(asset.rightsStatus) ?? [];
    group.push(asset.path);
    groups.set(asset.rightsStatus, group);
  }
  const gaps = [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, paths]) => ({ code, count: paths.length, assets: paths.sort() }));
  const classes = Object.fromEntries([...new Set(assets.map((asset) => asset.class))]
    .sort()
    .map((assetClass) => [assetClass, assets.filter((asset) => asset.class === assetClass).length]));
  const report = {
    format: 'hivra-asset-provenance-evidence-v1',
    status: gaps.length === 0 ? 'inventory-complete' : 'review-required',
    releaseApproved: false,
    gitHead: head,
    policySha256: sha256(policy.bytes),
    generationRecords,
    fontLicenseEvidence,
    ownerAssertions,
    scope: 'Tracked binary, image, vector, font, archive, media and PDF assets in the exact committed source tree.',
    summary: {
      trackedAssets: assets.length,
      uniqueBlobs: new Set(assets.map((asset) => asset.sha256)).size,
      includeCount: assets.filter((asset) => asset.redistributionDecision === 'include').length,
      holdCount: assets.filter((asset) => asset.redistributionDecision === 'hold-for-rights-review').length,
      classes,
    },
    gaps,
    assets,
    warning: 'This is deterministic provenance review evidence, not legal advice or approval to publish. Held assets must be attested, relicensed, or replaced before release.',
  };

  const stage = `${output}.tmp-${process.pid}`;
  if (existsSync(stage)) throw new Error('Temporary evidence output already exists.');
  try {
    mkdirSync(stage, { mode: 0o700 });
    writeFileSync(path.join(stage, 'asset-provenance.json'), json(report), { flag: 'wx', mode: 0o600 });
    chmodSync(stage, 0o700);
    renameSync(stage, output);
    return report;
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function main() {
  const args = process.argv.slice(2);
  let output;
  let policyPath;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--out' && args[index + 1]) output = args[++index];
    else if (args[index] === '--policy' && args[index + 1]) policyPath = args[++index];
    else throw new Error('Usage: node scripts/release/asset-provenance-evidence.mjs --out NEW_DIRECTORY [--policy RELATIVE_PATH]');
  }
  if (!output) throw new Error('Usage: node scripts/release/asset-provenance-evidence.mjs --out NEW_DIRECTORY [--policy RELATIVE_PATH]');
  const report = generateAssetProvenanceEvidence({ output, policyPath });
  console.log(JSON.stringify({
    status: report.status,
    releaseApproved: false,
    gitHead: report.gitHead,
    trackedAssets: report.summary.trackedAssets,
    heldAssets: report.summary.holdCount,
    gaps: report.gaps.length,
    output: path.resolve(output),
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Asset provenance evidence generation failed.');
    process.exitCode = 1;
  }
}
