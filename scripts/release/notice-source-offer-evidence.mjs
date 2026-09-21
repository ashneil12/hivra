#!/usr/bin/env node

import { createHash } from 'node:crypto';
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

const DEFAULT_OVERRIDES = 'docs/release/npm-license-overrides.json';
const RECIPROCAL = /(?:^|[^A-Z])(?:A?GPL|LGPL|MPL|EUPL|CDDL)-/i;
const CONTROL = /[\u0000-\u001f\u007f]/;

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeJsonFile(file, label) {
  const info = lstatSync(file);
  if (!info.isFile() || realpathSync(file) !== file || info.size > 64 * 1024 * 1024) {
    throw new Error(`${label} must be one bounded regular file.`);
  }
  const bytes = readFileSync(file);
  try {
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function resolveEvidenceFile(root, relative) {
  if (typeof relative !== 'string' || !relative || path.posix.isAbsolute(relative) || relative.includes('\\')) {
    throw new Error('Dependency inventory contains an unsafe evidence path.');
  }
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Dependency inventory contains an unsafe evidence path.');
  }
  const candidate = path.resolve(root, ...parts);
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error('Dependency evidence escaped its directory.');
  return candidate;
}

function licenseExpression(component) {
  const values = [];
  for (const entry of Array.isArray(component?.licenses) ? component.licenses : []) {
    if (typeof entry?.expression === 'string' && entry.expression.trim()) values.push(entry.expression.trim());
    else if (typeof entry?.license?.id === 'string' && entry.license.id.trim()) values.push(entry.license.id.trim());
    else if (typeof entry?.license?.name === 'string' && entry.license.name.trim()) values.push(entry.license.name.trim());
  }
  return [...new Set(values)].sort().join(' AND ') || null;
}

function distributionIdentity(component) {
  const urls = (Array.isArray(component?.externalReferences) ? component.externalReferences : [])
    .filter((entry) => entry?.type === 'distribution' && typeof entry.url === 'string')
    .map((entry) => entry.url.trim())
    .filter(Boolean);
  const hashes = (Array.isArray(component?.hashes) ? component.hashes : [])
    .filter((entry) => String(entry?.alg).toUpperCase() === 'SHA-512' && typeof entry.content === 'string')
    .map((entry) => entry.content.toLowerCase());
  return {
    distributionUrl: [...new Set(urls)].length === 1 ? urls[0] : null,
    distributionSha512: [...new Set(hashes)].length === 1 && /^[0-9a-f]{128}$/.test(hashes[0]) ? hashes[0] : null,
  };
}

function safeInventoryRoot(value) {
  if (value === '.') return value;
  if (
    typeof value !== 'string' || !value || path.posix.isAbsolute(value) || value.includes('\\') || CONTROL.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) throw new Error('Dependency inventory contains an unsafe package root.');
  return value;
}

function exactRegistryDistribution(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'registry.npmjs.org' && !url.port &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function developmentOnly(component) {
  const properties = Array.isArray(component?.properties) ? component.properties : [];
  return properties.some((entry) => entry?.name === 'cdx:npm:package:development' && entry?.value === 'true');
}

function bundled(component) {
  const properties = Array.isArray(component?.properties) ? component.properties : [];
  return properties.some((entry) => entry?.name === 'cdx:npm:package:bundled' && entry?.value === 'true');
}

function packagePath(component) {
  const values = (Array.isArray(component?.properties) ? component.properties : [])
    .filter((entry) => entry?.name === 'cdx:npm:package:path' && typeof entry?.value === 'string')
    .map((entry) => entry.value);
  if (values.length !== 1 || !values[0] || values[0].includes('\\') || CONTROL.test(values[0])) return null;
  return values[0];
}

function bundledWithIdentity(component, bom) {
  if (!bundled(component)) return null;
  const childPath = packagePath(component);
  if (!childPath) throw new Error('Bundled npm component is missing a safe package path.');
  const componentsByPath = new Map();
  for (const candidate of bom.components) {
    const candidatePath = packagePath(candidate);
    if (!candidatePath) continue;
    const matches = componentsByPath.get(candidatePath) ?? [];
    matches.push(candidate);
    componentsByPath.set(candidatePath, matches);
  }

  let currentPath = childPath;
  while (currentPath.includes('/node_modules/')) {
    currentPath = currentPath.slice(0, currentPath.lastIndexOf('/node_modules/'));
    const candidates = new Map();
    for (const parent of componentsByPath.get(currentPath) ?? []) {
      const identity = distributionIdentity(parent);
      if (Boolean(identity.distributionUrl) !== Boolean(identity.distributionSha512)) {
        throw new Error('Bundled npm parent has incomplete distribution identity.');
      }
      if (identity.distributionUrl) {
        if (typeof parent.purl !== 'string' || !parent.purl.startsWith('pkg:npm/') || CONTROL.test(parent.purl)) {
          throw new Error('Bundled npm parent has incomplete package identity.');
        }
        const key = `${parent.purl}\n${identity.distributionUrl}\n${identity.distributionSha512}`;
        candidates.set(key, {
          purl: parent.purl,
          distributionUrl: identity.distributionUrl,
          distributionSha512: identity.distributionSha512,
        });
      }
    }
    if (candidates.size === 1) return [...candidates.values()][0];
    if (candidates.size > 1) {
      throw new Error(`Bundled npm component ${component.purl ?? childPath} resolved to multiple containing package artifacts.`);
    }
  }
  throw new Error(`Bundled npm component ${component.purl ?? childPath} must resolve to exactly one containing package artifact; found 0.`);
}

function obligation(expression) {
  if (!expression) return 'unresolved-license';
  if (RECIPROCAL.test(expression) && /\bOR\b/.test(expression)) return 'manual-license-choice-review';
  if (RECIPROCAL.test(expression)) return 'source-correspondence-review';
  if (/CC-BY-/i.test(expression)) return 'attribution-review';
  return 'notice-review';
}

function validateOverrides(value) {
  if (
    !value || value.format !== 'hivra-npm-license-overrides-v1' || value.releaseApproved !== false ||
    !Array.isArray(value.packages)
  ) throw new Error('Npm license overrides have an invalid shape.');
  const seen = new Set();
  for (const entry of value.packages) {
    const key = `${entry?.name}@${entry?.version}`;
    if (
      typeof entry?.name !== 'string' || !entry.name || CONTROL.test(entry.name) ||
      typeof entry?.version !== 'string' || !entry.version || CONTROL.test(entry.version) ||
      typeof entry?.licenseExpression !== 'string' || !entry.licenseExpression ||
      entry.licenseExpression.length > 256 || CONTROL.test(entry.licenseExpression) ||
      typeof entry?.distributionUrl !== 'string' || !exactRegistryDistribution(entry.distributionUrl) ||
      typeof entry?.distributionSha512 !== 'string' || !/^[0-9a-f]{128}$/.test(entry.distributionSha512) ||
      !Array.isArray(entry.licenseFiles) || seen.has(key)
    ) throw new Error('Npm license overrides contain an invalid or duplicate package.');
    for (const file of entry.licenseFiles) {
      if (
        typeof file?.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(file.name) ||
        typeof file?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file?.bytes) || file.bytes < 1
      ) throw new Error('Npm license override file evidence is invalid.');
    }
    seen.add(key);
  }
  return new Map(value.packages.map((entry) => [`${entry.name}@${entry.version}`, entry]));
}

function checkedOutput(output) {
  const resolved = path.resolve(output);
  const parent = path.dirname(resolved);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) throw new Error('Evidence output parent must exist.');
  if (existsSync(resolved)) throw new Error('Evidence output already exists; choose a new directory.');
  return resolved;
}

export function generateNoticeSourceOfferEvidence({ root, inventoryDirectory, output, overridesPath } = {}) {
  root = realpathSync(root);
  inventoryDirectory = realpathSync(inventoryDirectory);
  output = checkedOutput(output);
  overridesPath = realpathSync(path.resolve(root, overridesPath ?? DEFAULT_OVERRIDES));

  const inventoryFile = safeJsonFile(path.join(inventoryDirectory, 'inventory.json'), 'Dependency inventory');
  const inventory = inventoryFile.value;
  if (
    inventory?.format !== 'hivra-dependency-inventory-v1' || inventory?.releaseApproved !== false ||
    typeof inventory?.gitHead !== 'string' || !/^[0-9a-f]{40}$/.test(inventory.gitHead) ||
    !Array.isArray(inventory?.components)
  ) throw new Error('Dependency inventory is not a revision-bound private inventory.');

  const overrideFile = safeJsonFile(overridesPath, 'Npm license overrides');
  const overrides = validateOverrides(overrideFile.value);
  const usedOverrides = new Set();
  const byPurl = new Map();
  let occurrences = 0;

  for (const inventoryComponent of inventory.components) {
    const inventoryRoot = safeInventoryRoot(inventoryComponent?.path);
    const relative = inventoryComponent?.bom?.path;
    const expectedSha = inventoryComponent?.bom?.sha256;
    const bomFile = resolveEvidenceFile(inventoryDirectory, relative);
    const loaded = safeJsonFile(bomFile, 'Dependency SBOM');
    if (typeof expectedSha !== 'string' || sha256(loaded.bytes) !== expectedSha) {
      throw new Error('Dependency SBOM checksum does not match its inventory.');
    }
    const bom = loaded.value;
    if (bom?.bomFormat !== 'CycloneDX' || !Array.isArray(bom?.components)) {
      throw new Error('Dependency evidence contains an invalid CycloneDX SBOM.');
    }
    for (const component of bom.components) {
      occurrences += 1;
      if (
        typeof component?.name !== 'string' || !component.name ||
        typeof component?.version !== 'string' || !component.version ||
        typeof component?.purl !== 'string' || !component.purl.startsWith('pkg:npm/') ||
        CONTROL.test(component.name) || CONTROL.test(component.version) || CONTROL.test(component.purl)
      ) throw new Error('Dependency SBOM component identity is incomplete.');
      const identity = distributionIdentity(component);
      const bundledWith = bundledWithIdentity(component, bom);
      let expression = licenseExpression(component);
      if (expression && (expression.length > 1024 || CONTROL.test(expression))) {
        throw new Error('Dependency SBOM contains an unsafe license expression.');
      }
      let source = 'sbom-declared';
      let reviewedLicenseFiles = [];
      const overrideKey = `${component.name}@${component.version}`;
      const override = overrides.get(overrideKey);
      if (!expression && override) {
        if (
          identity.distributionUrl !== override.distributionUrl ||
          identity.distributionSha512 !== override.distributionSha512
        ) throw new Error('Reviewed npm license override no longer matches the exact package artifact.');
        expression = override.licenseExpression;
        source = 'reviewed-exact-artifact-override';
        reviewedLicenseFiles = override.licenseFiles;
        usedOverrides.add(overrideKey);
      } else if (expression && override) {
        throw new Error('Reviewed npm license override is stale because registry metadata is now declared.');
      }

      const record = {
        name: component.name,
        version: component.version,
        purl: component.purl,
        distributionUrl: identity.distributionUrl,
        distributionSha512: identity.distributionSha512,
        bundledWith,
        licenseExpression: expression,
        licenseSource: source,
        reviewedLicenseFiles,
        obligation: obligation(expression),
        developmentOnly: developmentOnly(component),
        inventoryRoots: [inventoryRoot],
      };
      const prior = byPurl.get(record.purl);
      if (prior) {
        for (const key of ['name', 'version', 'licenseExpression', 'licenseSource', 'obligation']) {
          if (prior[key] !== record[key]) throw new Error('The same npm purl has conflicting evidence across SBOMs.');
        }
        for (const key of ['distributionUrl', 'distributionSha512']) {
          if (prior[key] && record[key] && prior[key] !== record[key]) {
            throw new Error('The same npm purl has conflicting evidence across SBOMs.');
          }
          prior[key] ||= record[key];
        }
        if (prior.bundledWith && record.bundledWith && JSON.stringify(prior.bundledWith) !== JSON.stringify(record.bundledWith)) {
          throw new Error('The same npm purl has conflicting containing-artifact evidence across SBOMs.');
        }
        prior.bundledWith ||= record.bundledWith;
        if (JSON.stringify(prior.reviewedLicenseFiles) !== JSON.stringify(record.reviewedLicenseFiles)) {
          throw new Error('The same npm purl has conflicting reviewed license-file evidence.');
        }
        prior.developmentOnly = prior.developmentOnly && record.developmentOnly;
        prior.inventoryRoots = [...new Set([...prior.inventoryRoots, ...record.inventoryRoots])].sort();
      } else {
        byPurl.set(record.purl, record);
      }
    }
  }

  if (usedOverrides.size !== overrides.size) {
    throw new Error('One or more reviewed npm license overrides did not match an undeclared SBOM component.');
  }
  const components = [...byPurl.values()].sort((a, b) => a.purl.localeCompare(b.purl));
  const count = (value) => components.filter((component) => component.obligation === value).length;
  const unresolvedLicenseCount = count('unresolved-license');
  const missingDistributionCount = components.filter((component) => !component.distributionUrl && !component.bundledWith?.distributionUrl).length;
  const missingIntegrityCount = components.filter((component) => !component.distributionSha512 && !component.bundledWith?.distributionSha512).length;
  const overrideWithoutLicenseFileCount = overrideFile.value.packages.filter((entry) => entry.licenseFiles.length === 0).length;
  const gaps = [
    ...(unresolvedLicenseCount ? [{ code: 'npm-license-unresolved', count: unresolvedLicenseCount }] : []),
    ...(missingDistributionCount ? [{ code: 'npm-distribution-url-missing', count: missingDistributionCount }] : []),
    ...(missingIntegrityCount ? [{ code: 'npm-distribution-integrity-missing', count: missingIntegrityCount }] : []),
    ...(overrideWithoutLicenseFileCount ? [{ code: 'reviewed-override-license-file-absent', count: overrideWithoutLicenseFileCount }] : []),
    { code: 'package-license-text-and-copyright-collection-pending', count: components.length },
    { code: 'runtime-and-image-notices-outside-npm-scope', count: 1 },
  ];
  const report = {
    format: 'hivra-notice-source-offer-evidence-v1',
    status: 'review-plan',
    releaseApproved: false,
    gitHead: inventory.gitHead,
    inputs: {
      dependencyInventorySha256: sha256(inventoryFile.bytes),
      npmLicenseOverridesSha256: sha256(overrideFile.bytes),
      npmSbomCount: inventory.components.length,
    },
    scope: 'Exact npm lockfile artifacts only. Runtime downloads, OCI/base images, OS packages, Python dependencies and external assets remain separate.',
    summary: {
      componentOccurrences: occurrences,
      uniqueNpmComponents: components.length,
      reviewedMetadataOverrides: usedOverrides.size,
      unresolvedLicenseCount,
      noticeReviewCount: count('notice-review'),
      attributionReviewCount: count('attribution-review'),
      sourceCorrespondenceReviewCount: count('source-correspondence-review'),
      manualLicenseChoiceReviewCount: count('manual-license-choice-review'),
      developmentOnlyCount: components.filter((component) => component.developmentOnly).length,
      missingDistributionCount,
      missingIntegrityCount,
      reviewedOverridesWithoutLicenseFileCount: overrideWithoutLicenseFileCount,
    },
    components,
    gaps,
    warning: 'This is deterministic review evidence, not legal advice, a complete notice bundle, a source offer, or public-release approval.',
  };
  const lines = [
    '# Hivra npm notice and source-offer review index',
    '# Review evidence only; not a complete notice bundle or release approval.',
    'purl\tlicense\tobligation\tdevelopment_only\tdistribution_sha512',
    ...components.map((component) => [
      component.purl,
      component.licenseExpression ?? 'UNRESOLVED',
      component.obligation,
      String(component.developmentOnly),
      component.distributionSha512 ?? component.bundledWith?.distributionSha512 ?? 'MISSING',
    ].join('\t')),
  ];
  const stage = `${output}.pending-${process.pid}`;
  if (existsSync(stage)) throw new Error('Evidence staging directory already exists.');
  mkdirSync(stage, { mode: 0o700 });
  try {
    writeFileSync(path.join(stage, 'notice-source-offer.json'), json(report), { flag: 'wx', mode: 0o600 });
    writeFileSync(path.join(stage, 'NOTICE-INDEX.review.tsv'), `${lines.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(stage, output);
    chmodSync(output, 0o700);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  return report;
}

function main() {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : null;
  };
  const inventoryDirectory = value('--inventory');
  const output = value('--out');
  if (!inventoryDirectory || !output || args.length !== 4) {
    throw new Error('Usage: node scripts/release/notice-source-offer-evidence.mjs --inventory DIRECTORY --out NEW_DIRECTORY');
  }
  const report = generateNoticeSourceOfferEvidence({ root: process.cwd(), inventoryDirectory, output });
  console.log(JSON.stringify({
    status: report.status,
    releaseApproved: false,
    gitHead: report.gitHead,
    uniqueNpmComponents: report.summary.uniqueNpmComponents,
    reviewedMetadataOverrides: report.summary.reviewedMetadataOverrides,
    gaps: report.gaps.length,
    output: path.resolve(output),
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Notice/source-offer evidence generation failed.');
    process.exitCode = 1;
  }
}
