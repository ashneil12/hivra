#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
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

const CLOSABLE_BLOCKERS = new Set([
  'complete-self-host-acceptance',
  'fresh-context-export-review',
]);

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function regularFile(requested, label) {
  const absolute = path.resolve(requested);
  if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
    throw new Error(`${label} must be an existing regular file, not a link.`);
  }
  return realpathSync(absolute);
}

function checkedDirectory(requested, label) {
  const absolute = path.resolve(requested);
  if (!existsSync(absolute) || !lstatSync(absolute).isDirectory()) {
    throw new Error(`${label} must be an existing real directory, not a link.`);
  }
  return realpathSync(absolute);
}

function checkedOutput(repositoryRoot, requested) {
  const output = path.resolve(requested);
  const parent = path.dirname(output);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new Error('The approval output parent must already exist.');
  }
  const resolved = path.join(realpathSync(parent), path.basename(output));
  if (isInside(repositoryRoot, resolved)) throw new Error('Write release approval evidence outside the source repository.');
  if (existsSync(resolved)) throw new Error('Approval output already exists; choose a new directory.');
  return resolved;
}

function filesUnder(root, relative = '') {
  const result = [];
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = path.posix.join(relative.replaceAll(path.sep, '/'), entry.name);
    const absolute = path.join(root, child);
    if (entry.isDirectory()) {
      result.push(...filesUnder(root, child));
    } else if (entry.isFile() && lstatSync(absolute).isFile()) {
      result.push(child);
    } else {
      throw new Error('Candidate evidence must contain only regular files and directories.');
    }
  }
  return result.sort();
}

function safeRelative(relative) {
  return typeof relative === 'string' && relative.length > 0 &&
    !path.posix.isAbsolute(relative) && !relative.includes('\\') &&
    !relative.split('/').some((part) => part === '' || part === '.' || part === '..') &&
    !/[\u0000-\u001f\u007f]/.test(relative);
}

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function validateSha256Sums(candidate, files) {
  const sumsFile = path.join(candidate, 'SHA256SUMS');
  const lines = readFileSync(sumsFile, 'utf8').split('\n').filter(Boolean);
  const entries = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || !safeRelative(match[2]) || entries.has(match[2])) {
      throw new Error('Candidate SHA256SUMS contains an invalid or duplicate entry.');
    }
    entries.set(match[2], match[1]);
  }
  const expected = files.filter((relative) => relative !== 'SHA256SUMS').sort();
  if (JSON.stringify([...entries.keys()].sort()) !== JSON.stringify(expected)) {
    throw new Error('Candidate SHA256SUMS must cover every candidate file exactly once.');
  }
  for (const [relative, digest] of entries) {
    if (sha256(readFileSync(path.join(candidate, relative))) !== digest) {
      throw new Error(`Candidate digest mismatch for ${relative}.`);
    }
  }
  return sha256(readFileSync(sumsFile));
}

function validateCandidate(candidate) {
  const files = filesUnder(candidate);
  if (!files.includes('candidate.json') || !files.includes('SHA256SUMS')) {
    throw new Error('Candidate evidence is missing candidate.json or SHA256SUMS.');
  }
  const sumsSha256 = validateSha256Sums(candidate, files);
  const receiptFile = path.join(candidate, 'candidate.json');
  const receiptBytes = readFileSync(receiptFile);
  const receipt = readJson(receiptFile, 'Candidate receipt');
  if (
    receipt?.format !== 'hivra-public-source-candidate-v1' ||
    receipt?.status !== 'review-candidate' ||
    receipt?.releaseApproved !== false ||
    receipt?.artifactClass !== 'source-only-current-tree'
  ) throw new Error('Candidate receipt is not a private source-only review candidate.');
  if (
    !/^[a-f0-9]{40}$/.test(receipt?.source?.commit ?? '') ||
    !/^[a-f0-9]{40}$/.test(receipt?.source?.tree ?? '') ||
    !Number.isSafeInteger(receipt?.source?.trackedFiles) || receipt.source.trackedFiles < 1
  ) throw new Error('Candidate receipt has an invalid source identity.');
  if (
    receipt?.checks?.cleanCommittedTree !== true ||
    receipt?.checks?.currentTreeHygiene !== 'pass' ||
    receipt?.checks?.releaseRegressionTests !== 'pass' ||
    receipt?.checks?.archiveMatchesTrackedTree !== true
  ) throw new Error('Candidate deterministic checks are incomplete.');
  if (
    !Array.isArray(receipt?.blockers) || receipt.blockers.length !== CLOSABLE_BLOCKERS.size ||
    receipt.blockers.some((blocker) => !CLOSABLE_BLOCKERS.has(blocker)) ||
    new Set(receipt.blockers).size !== receipt.blockers.length
  ) throw new Error('Candidate has blockers that self-host acceptance and fresh review cannot close.');
  if (!Array.isArray(receipt?.artifacts) || receipt.artifacts.length < 1) {
    throw new Error('Candidate receipt has no artifact inventory.');
  }
  const actualArtifacts = files.filter((relative) => relative !== 'candidate.json' && relative !== 'SHA256SUMS').sort();
  const recordedArtifacts = receipt.artifacts.map((entry) => entry?.path).sort();
  if (recordedArtifacts.some((relative) => !safeRelative(relative)) ||
      new Set(recordedArtifacts).size !== recordedArtifacts.length ||
      JSON.stringify(recordedArtifacts) !== JSON.stringify(actualArtifacts)) {
    throw new Error('Candidate artifact inventory does not match the exact candidate files.');
  }
  for (const entry of receipt.artifacts) {
    const bytes = readFileSync(path.join(candidate, entry.path));
    if (entry.sha256 !== sha256(bytes) || entry.bytes !== bytes.length) {
      throw new Error(`Candidate artifact metadata mismatch for ${entry.path}.`);
    }
  }
  const archives = receipt.artifacts.filter((entry) => /^hivra-source-[a-f0-9]{12}\.tar\.gz$/.test(entry.path));
  if (archives.length !== 1 || archives[0].path !== `hivra-source-${receipt.source.commit.slice(0, 12)}.tar.gz`) {
    throw new Error('Candidate must contain one source archive bound to its exact commit.');
  }
  return {
    receipt,
    receiptSha256: sha256(receiptBytes),
    sumsSha256,
    archive: archives[0],
  };
}

function validateSelfHostAcceptance(file, candidate) {
  const bytes = readFileSync(file);
  const receipt = readJson(file, 'Self-host acceptance receipt');
  if (
    receipt?.format !== 'hivra-public-source-bootstrap-e2e-v1' || receipt?.status !== 'pass' ||
    receipt?.releaseApproved !== false || receipt?.sourceRevision !== candidate.receipt.source.commit ||
    receipt?.candidateReceiptSha256 !== candidate.receiptSha256 ||
    receipt?.sourceArchive?.archiveName !== candidate.archive.path ||
    receipt?.sourceArchive?.archiveSha256 !== candidate.archive.sha256 ||
    receipt?.sourceArchive?.archiveBytes !== candidate.archive.bytes ||
    receipt?.dependencyInstall !== 'pass' || receipt?.selfHostDoctor !== 'pass'
  ) throw new Error('Self-host acceptance is not bound to the exact candidate and source archive.');
  const recovery = receipt.recoveryChecks;
  if (
    !/^[a-f0-9]{64}$/.test(receipt?.recoveryReceiptSha256 ?? '') ||
    recovery?.health !== 'pass' || recovery?.operatorLogin !== 'pass' ||
    recovery?.recoveredMarker !== 'pass' || recovery?.infrastructureRegistry !== 'pass' ||
    recovery?.hostedBillingGuard !== 'pass' || recovery?.originalLoopbackBindings !== 'pass' ||
    recovery?.restoredLoopbackBindings !== 'pass' || recovery?.recoveredStorageBytes !== 'pass' ||
    recovery?.masterKeyRotation?.secretCiphertextRewrapped !== 'pass' ||
    recovery?.masterKeyRotation?.oldSecretKeyRejected !== 'pass' ||
    recovery?.masterKeyRotation?.launchFingerprintKeyPreserved !== 'pass'
  ) throw new Error('Self-host recovery acceptance is incomplete.');
  if (
    receipt?.cleanup?.candidateRemoved !== 'pass' || receipt?.cleanup?.exportedSourceRemoved !== 'pass' ||
    receipt?.cleanup?.nestedRecoveryEvidenceRemoved !== 'pass' ||
    !Array.isArray(receipt?.cleanup?.retainedProviderResources) || receipt.cleanup.retainedProviderResources.length !== 0
  ) throw new Error('Self-host acceptance cleanup is incomplete.');
  return { receipt, sha256: sha256(bytes) };
}

function validateFreshContextReview(file, candidate) {
  const bytes = readFileSync(file);
  const receipt = readJson(file, 'Fresh-context review receipt');
  if (
    receipt?.format !== 'hivra-public-source-review-v1' || receipt?.status !== 'pass' ||
    receipt?.releaseApproved !== false || receipt?.decision !== 'approve' ||
    receipt?.reviewerKind !== 'fresh-context' || typeof receipt?.reviewer !== 'string' || !receipt.reviewer.trim() ||
    receipt?.candidateReceiptSha256 !== candidate.receiptSha256 ||
    receipt?.sourceArchiveSha256 !== candidate.archive.sha256 ||
    receipt?.source?.commit !== candidate.receipt.source.commit ||
    receipt?.source?.tree !== candidate.receipt.source.tree
  ) throw new Error('Fresh-context review is not an approval of the exact candidate.');
  if (
    receipt?.checks?.publicPrivateClassification !== 'pass' ||
    receipt?.checks?.functionalCoreComplete !== 'pass' ||
    receipt?.checks?.secretScan !== 'pass' ||
    receipt?.checks?.noticeAndLicense !== 'pass' ||
    receipt?.checks?.archiveContents !== 'pass' ||
    receipt?.checks?.noFunctionalOperatorMachineryWithheld !== true ||
    !Number.isSafeInteger(receipt?.checks?.reviewedTrackedFiles) ||
    receipt.checks.reviewedTrackedFiles !== candidate.receipt.source.trackedFiles ||
    !Array.isArray(receipt?.gaps) || receipt.gaps.length !== 0
  ) throw new Error('Fresh-context review checks or gap closure are incomplete.');
  return { receipt, sha256: sha256(bytes) };
}

export function approvePublicSourceCandidate({ root, candidate, selfHostReceipt, reviewReceipt, output } = {}) {
  const repositoryRoot = realpathSync(root ?? process.cwd());
  candidate = checkedDirectory(candidate, 'Candidate');
  selfHostReceipt = regularFile(selfHostReceipt, 'Self-host acceptance receipt');
  reviewReceipt = regularFile(reviewReceipt, 'Fresh-context review receipt');
  if ([candidate, selfHostReceipt, reviewReceipt].some((item) => isInside(repositoryRoot, item))) {
    throw new Error('Candidate and acceptance evidence must remain outside the source repository.');
  }
  output = checkedOutput(repositoryRoot, output);

  const candidateEvidence = validateCandidate(candidate);
  const selfHostEvidence = validateSelfHostAcceptance(selfHostReceipt, candidateEvidence);
  const reviewEvidence = validateFreshContextReview(reviewReceipt, candidateEvidence);
  const receipt = {
    format: 'hivra-public-source-approval-v1',
    status: 'approved-for-new-repository-publication',
    releaseApproved: true,
    artifactClass: candidateEvidence.receipt.artifactClass,
    source: candidateEvidence.receipt.source,
    candidate: {
      receiptSha256: candidateEvidence.receiptSha256,
      sha256SumsSha256: candidateEvidence.sumsSha256,
    },
    sourceArchive: {
      archiveName: candidateEvidence.archive.path,
      archiveSha256: candidateEvidence.archive.sha256,
      archiveBytes: candidateEvidence.archive.bytes,
    },
    selfHostAcceptance: {
      receiptSha256: selfHostEvidence.sha256,
      recoveryReceiptSha256: selfHostEvidence.receipt.recoveryReceiptSha256,
    },
    freshContextReview: {
      receiptSha256: reviewEvidence.sha256,
      reviewer: reviewEvidence.receipt.reviewer,
    },
    checks: {
      candidateIntegrity: 'pass',
      selfHostBootstrapAndRecovery: 'pass',
      publicPrivateBoundaryReview: 'pass',
      functionalCoreCompletenessReview: 'pass',
      exactArtifactBinding: 'pass',
    },
    blockers: [],
    warning: 'This receipt approves only the exact source archive for a fresh public repository. It does not publish a repository, approve private history, or approve separately distributed runtime or image bytes.',
  };

  const stage = mkdtempSync(path.join(path.dirname(output), '.hivra-public-approval-'));
  chmodSync(stage, 0o700);
  try {
    const receiptBytes = Buffer.from(json(receipt));
    writeFileSync(path.join(stage, 'approval.json'), receiptBytes, { flag: 'wx', mode: 0o600 });
    writeFileSync(path.join(stage, 'SHA256SUMS'), `${sha256(receiptBytes)}  approval.json\n`, { flag: 'wx', mode: 0o600 });
    renameSync(stage, output);
    return { output, receipt };
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function usage() {
  return 'Usage: node scripts/release/public-source-approval.mjs --candidate DIRECTORY --self-host RECEIPT.json --review RECEIPT.json --out NEW_DIRECTORY';
}

function main() {
  const args = process.argv.slice(2);
  const options = {};
  const names = new Map([
    ['--candidate', 'candidate'],
    ['--self-host', 'selfHostReceipt'],
    ['--review', 'reviewReceipt'],
    ['--out', 'output'],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const name = names.get(args[index]);
    if (!name || !args[index + 1]) throw new Error(usage());
    options[name] = args[++index];
  }
  if ([...names.values()].some((name) => !options[name])) throw new Error(usage());
  const result = approvePublicSourceCandidate(options);
  console.log(JSON.stringify({
    status: result.receipt.status,
    releaseApproved: true,
    commit: result.receipt.source.commit,
    archiveSha256: result.receipt.sourceArchive.archiveSha256,
    blockers: 0,
    output: result.output,
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Public source approval failed.');
    process.exitCode = 1;
  }
}
