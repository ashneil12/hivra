#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateAssetProvenanceEvidence } from './asset-provenance-evidence.mjs';
import { generateInventory } from './dependency-inventory.mjs';
import { generateNoticeSourceOfferEvidence } from './notice-source-offer-evidence.mjs';
import { inspectPublicTree } from './public-tree-hygiene.mjs';
import { inspectSourceThirdPartyProvenance } from './source-third-party-provenance.mjs';
import { inspectRuntimeDistributionBoundary } from './runtime-distribution-boundary.mjs';
import { inspectCredentialReconciliation } from './credential-reconciliation-evidence.mjs';

const commandOptions = {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: 120_000,
  maxBuffer: 64 * 1024 * 1024,
};

const BLOCKERS = [
  'credential-rotation-reconciliation',
  'complete-notice-and-source-offer-review',
  'complete-self-host-acceptance',
  'fresh-context-export-review',
];

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

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function checkedOutput(root, requested) {
  const output = path.resolve(requested);
  const parent = path.dirname(output);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new Error('The candidate output parent must already exist.');
  }
  const realParent = realpathSync(parent);
  const resolved = path.join(realParent, path.basename(output));
  if (isInside(root, resolved)) throw new Error('Write release evidence outside the source repository.');
  if (existsSync(resolved)) throw new Error('Candidate output already exists; choose a new directory.');
  return resolved;
}

function trackedFiles(root, commit) {
  const files = git(root, ['ls-tree', '-r', '-z', '--name-only', commit]).split('\0').filter(Boolean);
  for (const file of files) {
    if (
      path.posix.isAbsolute(file) ||
      file.includes('\\') ||
      file.split('/').some((part) => part === '..' || part === '') ||
      /[\u0000-\u001f\u007f]/.test(file)
    ) {
      throw new Error('The tracked tree contains a filename that is unsafe for a public archive.');
    }
  }
  return files.sort();
}

function archiveFiles(archive) {
  try {
    return execFileSync('tar', ['-tzf', archive], commandOptions)
      .split('\n')
      .filter((entry) => entry && !entry.endsWith('/'))
      .sort();
  } catch {
    throw new Error('The generated public source archive could not be inspected.');
  }
}

function releaseChecks(root) {
  try {
    execFileSync(process.execPath, [
      '--test',
      'scripts/release/asset-provenance-evidence.test.mjs',
      'scripts/release/check-dashboard-public-artifact.test.mjs',
      'scripts/release/credential-reconciliation-evidence.test.mjs',
      'scripts/release/notice-source-offer-evidence.test.mjs',
      'scripts/release/public-source-approval.test.mjs',
      'scripts/release/public-release-metadata.test.mjs',
      'scripts/release/runtime-distribution-boundary.test.mjs',
      'scripts/release/source-third-party-provenance.test.mjs',
      'scripts/release/public-tree-hygiene.test.mjs',
      'dashboard/scripts/hivra-self-host-backup.test.mjs',
      'dashboard/scripts/hivra-self-host.test.mjs',
      'dashboard/scripts/hivra-self-host-docker.test.mjs',
      'dashboard/scripts/hivra-self-host-storage.test.mjs',
      'dashboard/scripts/test-public-source-bootstrap-e2e.test.mjs',
      'dashboard/scripts/test-self-host-recovery-e2e.test.mjs',
    ], { ...commandOptions, cwd: root });
  } catch {
    throw new Error('Public-release regression checks failed.');
  }
}

function filesUnder(root, relative = '') {
  const directory = path.join(root, relative);
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.posix.join(relative.replaceAll(path.sep, '/'), entry.name);
    const absolute = path.join(root, child);
    if (entry.isDirectory()) result.push(...filesUnder(root, child));
    else if (entry.isFile() && lstatSync(absolute).isFile() && realpathSync(absolute) === absolute) result.push(child);
    else throw new Error('Candidate evidence must contain only regular files and directories.');
  }
  return result.sort();
}

function artifact(root, relative) {
  const bytes = readFileSync(path.join(root, relative));
  return { path: relative, sha256: sha256(bytes), bytes: bytes.length };
}

export function buildPublicSourceCandidate({
  root,
  output,
  commit = 'HEAD',
  inventoryGenerator = generateInventory,
  noticeEvidenceGenerator = generateNoticeSourceOfferEvidence,
  assetEvidenceGenerator = generateAssetProvenanceEvidence,
  sourceThirdPartyInspector = inspectSourceThirdPartyProvenance,
  runtimeBoundaryInspector = inspectRuntimeDistributionBoundary,
  credentialReconciliationInspector = inspectCredentialReconciliation,
  runReleaseChecks = releaseChecks,
} = {}) {
  root = realpathSync(root ?? git(process.cwd(), ['rev-parse', '--show-toplevel']).trim());
  const repositoryRoot = realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim());
  if (root !== repositoryRoot) throw new Error('The selected checkout must be the Git repository root.');
  output = checkedOutput(root, output);

  const head = git(root, ['rev-parse', 'HEAD']).trim();
  const selected = git(root, ['rev-parse', `${commit}^{commit}`]).trim();
  if (selected !== head) throw new Error('Build the candidate from the current committed HEAD only.');
  if (git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).length !== 0) {
    throw new Error('The source checkout must be clean before building a public candidate.');
  }
  const findings = inspectPublicTree(root);
  if (findings.length !== 0) throw new Error('The committed tree failed public-tree hygiene checks.');
  runReleaseChecks(root);
  const sourceThirdPartyEvidence = sourceThirdPartyInspector({ root });
  if (
    sourceThirdPartyEvidence?.status !== 'source-only-notices-complete' ||
    sourceThirdPartyEvidence?.releaseApproved !== false ||
    !Array.isArray(sourceThirdPartyEvidence?.gaps) || sourceThirdPartyEvidence.gaps.length !== 0
  ) throw new Error('Source-only third-party notice evidence is incomplete.');
  const runtimeDistributionBoundary = runtimeBoundaryInspector({ root });
  if (
    runtimeDistributionBoundary?.status !== 'source-only-runtime-boundary-complete' ||
    runtimeDistributionBoundary?.releaseApproved !== false ||
    runtimeDistributionBoundary?.sourceOnlyBoundaryApproved !== true ||
    !Array.isArray(runtimeDistributionBoundary?.gaps) || runtimeDistributionBoundary.gaps.length !== 0
  ) throw new Error('Source-only runtime distribution boundary is incomplete.');
  const credentialReconciliation = credentialReconciliationInspector({ root });
  if (
    credentialReconciliation?.status !== 'current-authorization-boundary-reconciled' ||
    credentialReconciliation?.releaseApproved !== false ||
    credentialReconciliation?.privateHistoryExcluded !== true ||
    credentialReconciliation?.currentTargetsAuthorizingHistoricalKey !== 0 ||
    !Array.isArray(credentialReconciliation?.gaps) || credentialReconciliation.gaps.length !== 0
  ) throw new Error('Credential reconciliation evidence is incomplete.');

  const files = trackedFiles(root, selected);
  if (!files.includes('LICENSE') || !files.includes('NOTICE')) {
    throw new Error('The committed public candidate requires root LICENSE and NOTICE files.');
  }
  const tree = git(root, ['rev-parse', `${selected}^{tree}`]).trim();
  const parent = path.dirname(output);
  const stage = mkdtempSync(path.join(parent, '.hivra-public-candidate-'));
  chmodSync(stage, 0o700);
  try {
    const short = selected.slice(0, 12);
    const archiveName = `hivra-source-${short}.tar.gz`;
    const archivePath = path.join(stage, archiveName);
    git(root, ['archive', '--format=tar.gz', `--output=${archivePath}`, selected]);
    chmodSync(archivePath, 0o600);
    const archived = archiveFiles(archivePath);
    if (JSON.stringify(archived) !== JSON.stringify(files)) {
      throw new Error('The generated archive does not exactly match the committed tracked tree.');
    }

    const inventoryDirectory = path.join(stage, 'evidence', 'dependency-inventory');
    mkdirSync(path.dirname(inventoryDirectory), { recursive: true, mode: 0o700 });
    const inventory = inventoryGenerator({ root, output: inventoryDirectory });
    if (inventory?.gitHead !== selected || inventory?.releaseApproved !== false) {
      throw new Error('Dependency evidence is not bound to the selected source revision.');
    }

    const noticeEvidenceDirectory = path.join(stage, 'evidence', 'notice-source-offer');
    const noticeEvidence = noticeEvidenceGenerator({
      root,
      inventoryDirectory,
      output: noticeEvidenceDirectory,
    });
    if (noticeEvidence?.gitHead !== selected || noticeEvidence?.releaseApproved !== false) {
      throw new Error('Notice/source-offer evidence is not bound to the selected source revision.');
    }

    const assetEvidenceDirectory = path.join(stage, 'evidence', 'asset-provenance');
    const assetEvidence = assetEvidenceGenerator({ root, output: assetEvidenceDirectory });
    if (
      assetEvidence?.gitHead !== selected || assetEvidence?.releaseApproved !== false ||
      !Array.isArray(assetEvidence?.gaps)
    ) {
      throw new Error('Asset provenance evidence is not bound to the selected source revision.');
    }
    const sourceNoticeComplete = [
      noticeEvidence?.summary?.unresolvedLicenseCount,
      noticeEvidence?.summary?.missingDistributionCount,
      noticeEvidence?.summary?.missingIntegrityCount,
      noticeEvidence?.summary?.reviewedOverridesWithoutLicenseFileCount,
    ].every((value) => value === 0);
    const blockers = BLOCKERS.filter((blocker) =>
      blocker !== 'credential-rotation-reconciliation' &&
      (blocker !== 'complete-notice-and-source-offer-review' || !sourceNoticeComplete));
    if (assetEvidence.gaps.length > 0) blockers.splice(1, 0, 'complete-asset-provenance-review');

    const evidenceFiles = filesUnder(stage).filter((relative) => relative !== 'candidate.json' && relative !== 'SHA256SUMS');
    const artifacts = evidenceFiles.map((relative) => artifact(stage, relative));
    const receipt = {
      format: 'hivra-public-source-candidate-v1',
      status: 'review-candidate',
      releaseApproved: false,
      artifactClass: 'source-only-current-tree',
      source: { commit: selected, tree, trackedFiles: files.length },
      checks: {
        cleanCommittedTree: true,
        currentTreeHygiene: 'pass',
        releaseRegressionTests: 'pass',
        archiveMatchesTrackedTree: true,
      },
      dependencyInventory: {
        status: inventory.status,
        releaseApproved: false,
        gaps: Array.isArray(inventory.gaps) ? inventory.gaps.length : null,
      },
      noticeSourceOfferEvidence: {
        status: noticeEvidence.status,
        releaseApproved: false,
        uniqueNpmComponents: noticeEvidence?.summary?.uniqueNpmComponents ?? null,
        gaps: Array.isArray(noticeEvidence.gaps) ? noticeEvidence.gaps.length : null,
      },
      sourceThirdPartyEvidence,
      runtimeDistributionBoundary,
      credentialReconciliation,
      assetProvenanceEvidence: {
        status: assetEvidence.status,
        releaseApproved: false,
        trackedAssets: assetEvidence?.summary?.trackedAssets ?? null,
        heldAssets: assetEvidence?.summary?.holdCount ?? null,
        gaps: Array.isArray(assetEvidence.gaps) ? assetEvidence.gaps.length : null,
      },
      artifacts,
      blockers,
      warning: 'This private review candidate is not an approved public release. Resolve every recorded blocker and independently review the exact bytes before publication.',
    };
    writeFileSync(path.join(stage, 'candidate.json'), json(receipt), { flag: 'wx', mode: 0o600 });
    const sums = filesUnder(stage)
      .filter((relative) => relative !== 'SHA256SUMS')
      .map((relative) => `${artifact(stage, relative).sha256}  ${relative}`)
      .sort()
      .join('\n');
    writeFileSync(path.join(stage, 'SHA256SUMS'), `${sums}\n`, { flag: 'wx', mode: 0o600 });

    renameSync(stage, output);
    return { output, receipt };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function main() {
  const args = process.argv.slice(2);
  let output;
  let commit = 'HEAD';
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--out' && args[index + 1]) output = args[++index];
    else if (args[index] === '--commit' && args[index + 1]) commit = args[++index];
    else throw new Error('Usage: node scripts/release/public-source-candidate.mjs --out NEW_DIRECTORY [--commit HEAD]');
  }
  if (!output) throw new Error('Usage: node scripts/release/public-source-candidate.mjs --out NEW_DIRECTORY [--commit HEAD]');
  const result = buildPublicSourceCandidate({ output, commit });
  console.log(JSON.stringify({
    status: result.receipt.status,
    releaseApproved: false,
    commit: result.receipt.source.commit,
    trackedFiles: result.receipt.source.trackedFiles,
    artifacts: result.receipt.artifacts.length,
    blockers: result.receipt.blockers.length,
    output: result.output,
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Public source candidate generation failed.');
    process.exitCode = 1;
  }
}
