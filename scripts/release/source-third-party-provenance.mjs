#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const POLICY = 'docs/release/source-third-party-provenance.json';
const CONTROL = /[\u0000-\u001f\u007f]/;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function gitBlob(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function safeRelative(value) {
  if (
    typeof value !== 'string' || !value || path.posix.isAbsolute(value) || value.includes('\\') || CONTROL.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) throw new Error('Source provenance contains an unsafe path.');
  return value;
}

function regular(root, relative) {
  const safe = safeRelative(relative);
  const file = path.resolve(root, ...safe.split('/'));
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error('Source provenance path escaped the repository.');
  const info = lstatSync(file);
  if (!info.isFile() || realpathSync(file) !== file || info.size > 16 * 1024 * 1024) {
    throw new Error('Source provenance must reference one bounded regular file.');
  }
  return readFileSync(file);
}

function filesUnder(root, relative) {
  const directory = path.join(root, relative);
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name);
    const absolute = path.join(root, child);
    if (entry.isDirectory()) result.push(...filesUnder(root, child));
    else if (entry.isFile() && realpathSync(absolute) === absolute) result.push(child);
    else throw new Error('Source provenance boundary contains a non-regular entry.');
  }
  return result.sort();
}

function policy(root) {
  const raw = regular(root, POLICY);
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('Source provenance policy is not valid JSON.');
  }
  return { raw, value };
}

export function inspectSourceThirdPartyProvenance({ root } = {}) {
  root = realpathSync(root);
  const loaded = policy(root);
  const value = loaded.value;
  if (
    value?.format !== 'hivra-source-third-party-provenance-v1' || value?.releaseApproved !== false ||
    value?.artifactClass !== 'source-only-current-tree' || !Array.isArray(value?.components) ||
    !Array.isArray(value?.acquiredArtifacts) || !Array.isArray(value?.firstPartyFiles)
  ) throw new Error('Source provenance policy has an invalid shape.');

  const expected = new Set();
  const thirdParty = new Set();
  let componentFileCount = 0;
  for (const component of value.components) {
    if (
      typeof component?.id !== 'string' || !component.id || CONTROL.test(component.id) ||
      typeof component?.upstreamRepository !== 'string' || !component.upstreamRepository.startsWith('https://github.com/') ||
      component?.licenseExpression !== 'MIT' || !Array.isArray(component?.files)
    ) throw new Error('Source provenance component is invalid.');
    const licensePath = safeRelative(component?.licenseFile?.path);
    const licenseBytes = regular(root, licensePath);
    if (
      typeof component?.licenseFile?.sha256 !== 'string' || sha256(licenseBytes) !== component.licenseFile.sha256 ||
      component.licenseFile.bytes !== licenseBytes.length
    ) throw new Error('Source provenance license evidence drifted.');
    expected.add(licensePath);
    for (const file of component.files) {
      const relative = safeRelative(file?.path);
      const bytes = regular(root, relative);
      if (
        !relative.startsWith('.agents/skills/') || thirdParty.has(relative) ||
        typeof file?.gitBlob !== 'string' || !/^[0-9a-f]{40}$/.test(file.gitBlob) || gitBlob(bytes) !== file.gitBlob ||
        typeof file?.upstreamCommit !== 'string' || !/^[0-9a-f]{40}$/.test(file.upstreamCommit)
      ) throw new Error('Source provenance file evidence drifted.');
      thirdParty.add(relative);
      expected.add(relative);
      componentFileCount += 1;
    }
  }
  for (const entry of value.firstPartyFiles) {
    const relative = safeRelative(entry);
    regular(root, relative);
    if (!relative.startsWith('.agents/skills/') || expected.has(relative)) {
      throw new Error('Source provenance first-party exception is invalid.');
    }
    expected.add(relative);
  }

  const acquiredArtifacts = new Set();
  for (const artifact of value.acquiredArtifacts) {
    const relative = safeRelative(artifact?.targetPath);
    if (
      !relative.startsWith('dashboard/.generated/apple-certs/') || !relative.endsWith('.cer') ||
      acquiredArtifacts.has(relative) || artifact?.licenseExpression !== 'NOASSERTION' ||
      artifact?.acquisitionDecision !== 'download-at-build-hash-verified' ||
      typeof artifact?.sourceUrl !== 'string' || !artifact.sourceUrl.startsWith('https://www.apple.com/') ||
      artifact?.copyrightHolder !== 'Apple Inc.' ||
      typeof artifact?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
      !Number.isInteger(artifact?.bytes) || artifact.bytes <= 0
    ) throw new Error('Acquired source artifact metadata drifted.');
    acquiredArtifacts.add(relative);
  }

  const redistributedCertificates = filesUnder(root, 'dashboard/src/lib/billing/apple-certs')
    .filter((relative) => relative.endsWith('.cer'));
  if (redistributedCertificates.length > 0) {
    throw new Error('Source tree unexpectedly redistributes Apple certificate bytes.');
  }

  const actual = filesUnder(root, '.agents/skills');
  if (JSON.stringify([...expected].sort()) !== JSON.stringify(actual)) {
    throw new Error('Source provenance policy is not exhaustive for the tracked skills boundary.');
  }
  return {
    format: 'hivra-source-third-party-provenance-evidence-v1',
    status: 'source-only-notices-complete',
    releaseApproved: false,
    policySha256: sha256(loaded.raw),
    summary: {
      components: value.components.length,
      firstPartyFiles: value.firstPartyFiles.length,
      thirdPartyFiles: componentFileCount,
      acquiredArtifacts: acquiredArtifacts.size,
      redistributedArtifacts: 0,
    },
    gaps: [],
  };
}

function main() {
  const report = inspectSourceThirdPartyProvenance({ root: process.cwd() });
  console.log(JSON.stringify(report));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Source provenance inspection failed.');
    process.exitCode = 1;
  }
}
