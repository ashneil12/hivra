#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const POLICY = 'docs/release/runtime-distribution-boundary.json';
const EXTERNAL_ARTIFACT = /\.(?:deb|rpm|img|qcow2?|ova|vmdk|tar\.gz|tgz|whl|nupkg|apk|msi|dmg|pkg)$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    throw new Error('Cannot inspect the selected Git checkout.');
  }
}

function safeRelative(value) {
  if (
    typeof value !== 'string' || !value || path.posix.isAbsolute(value) || value.includes('\\') || CONTROL.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) throw new Error('Runtime distribution policy contains an unsafe path.');
  return value;
}

function regular(root, relative) {
  const safe = safeRelative(relative);
  const file = path.resolve(root, ...safe.split('/'));
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error('Runtime distribution evidence escaped the repository.');
  const info = lstatSync(file);
  if (!info.isFile() || realpathSync(file) !== file || info.size > 4 * 1024 * 1024) {
    throw new Error('Runtime distribution evidence must be one bounded regular file.');
  }
  return readFileSync(file);
}

export function inspectRuntimeDistributionBoundary({ root } = {}) {
  root = realpathSync(root);
  const policyBytes = regular(root, POLICY);
  let policy;
  try {
    policy = JSON.parse(policyBytes.toString('utf8'));
  } catch {
    throw new Error('Runtime distribution policy is not valid JSON.');
  }
  if (
    policy?.format !== 'hivra-runtime-distribution-boundary-v1' ||
    policy?.artifactClass !== 'source-only-current-tree' ||
    policy?.releaseApproved !== false || policy?.sourceOnlyBoundaryApproved !== true ||
    !Array.isArray(policy?.externalInputs) || policy.externalInputs.length < 1 ||
    typeof policy?.installedEvidence?.receipt !== 'string' ||
    typeof policy?.installedEvidence?.sbom !== 'string' ||
    typeof policy?.installedEvidence?.noticeReview !== 'string'
  ) throw new Error('Runtime distribution policy has an invalid shape.');

  const seen = new Set();
  for (const input of policy.externalInputs) {
    if (
      typeof input?.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(input.id) || seen.has(input.id) ||
      !['download', 'operator-opt-in-download', 'operator-selected-download', 'build-time-download'].includes(input?.decision) ||
      typeof input?.identity !== 'string' || input.identity.length < 8 || input.identity.length > 256 || CONTROL.test(input.identity)
    ) throw new Error('Runtime distribution policy contains an invalid or duplicate input.');
    const evidence = regular(root, input.evidencePath).toString('utf8');
    if (!evidence.includes(input.identity)) {
      throw new Error(`Runtime distribution identity drifted for ${input.id}.`);
    }
    seen.add(input.id);
  }

  const tracked = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  const embeddedExternalArtifacts = tracked.filter((file) => EXTERNAL_ARTIFACT.test(file));
  if (embeddedExternalArtifacts.length > 0) {
    throw new Error('The source-only tree embeds a third-party runtime or release-image artifact.');
  }

  const dockerfile = regular(root, 'services/browser-sidecar/Dockerfile').toString('utf8');
  const fromLines = dockerfile.split(/\r?\n/).filter((line) => line.startsWith('FROM '));
  if (fromLines.length !== 3 || fromLines.some((line) => !/@sha256:[0-9a-f]{64}(?:\s+AS\s+\w+)?$/.test(line))) {
    throw new Error('Every browser-sidecar base image must retain an immutable digest.');
  }

  return {
    format: 'hivra-runtime-distribution-boundary-evidence-v1',
    status: 'source-only-runtime-boundary-complete',
    releaseApproved: false,
    sourceOnlyBoundaryApproved: true,
    policySha256: sha256(policyBytes),
    summary: {
      externalInputs: policy.externalInputs.length,
      embeddedExternalArtifacts: 0,
      digestPinnedContainerInputs: fromLines.length,
      installedEvidenceGeneratedOnComputer: true,
    },
    gaps: [],
  };
}

function main() {
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  process.stdout.write(`${JSON.stringify(inspectRuntimeDistributionBoundary({ root }))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Runtime distribution boundary inspection failed.');
    process.exitCode = 1;
  }
}
