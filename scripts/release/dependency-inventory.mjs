#!/usr/bin/env node
// Local evidence generation only. This never installs packages or approves a release.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const commandOptions = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, maxBuffer: 16 * 1024 * 1024 };

function git(root, args) {
  try { return execFileSync('git', ['-C', root, ...args], commandOptions); }
  catch { throw new Error('Cannot read the selected Git checkout.'); }
}

function readInput(root, relative) {
  const absolute = path.join(root, relative);
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === '..')
      || !lstatSync(absolute).isFile() || realpathSync(absolute) !== absolute) {
    throw new Error('Inventory inputs must be regular files inside the selected checkout.');
  }
  return readFileSync(absolute, 'utf8');
}

export function parseInput(text) {
  try { return JSON.parse(text); }
  catch { throw new Error('A package input is not valid JSON; no source content is included in this error.'); }
}

export function checkLock(manifest, lock) {
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages?.['']) {
    throw new Error('Only npm lockfile versions 2 and 3 with a root package are supported.');
  }
  if (manifest.workspaces || Object.values(lock.packages).some((entry) => entry.link)) {
    throw new Error('Workspace/link inputs require a separate inventory adapter.');
  }
  const root = lock.packages[''];
  for (const field of ['name', 'version']) {
    if (manifest[field] !== root[field]) throw new Error('Package and lockfile identity disagree.');
  }
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const normalize = (value) => Object.entries(value ?? {}).sort(([a], [b]) => compare(a, b));
    if (JSON.stringify(normalize(manifest[field])) !== JSON.stringify(normalize(root[field]))) {
      throw new Error('Package and lockfile dependency declarations disagree.');
    }
  }
  // Do not echo credential-bearing or private locations through npm's SBOM output.
  // This is a bounded registry-input check, NOT a general-purpose secret scan.
  for (const entry of Object.values(lock.packages)) {
    if (!entry.resolved) continue;
    let url;
    try { url = new URL(entry.resolved); } catch { throw new Error('Unsupported dependency source; review it privately.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org'
        || url.port || url.username || url.password || url.search || url.hash) {
      throw new Error('Unsupported dependency source; review it privately.');
    }
  }
}

export function normalizeBom(bom) {
  if (bom?.bomFormat !== 'CycloneDX' || !Array.isArray(bom.components)
      || !Array.isArray(bom.dependencies) || !bom.metadata?.component) {
    throw new Error('npm did not return the expected CycloneDX dependency graph.');
  }
  const result = structuredClone(bom);
  // These optional fields vary per invocation; retain all package identities,
  // dependency edges, declared licenses, integrity hashes and tool versions.
  delete result.serialNumber;
  delete result.metadata.timestamp;
  return result;
}

function npmEnvironment(stage) {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'TMPDIR', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, npm_config_cache: path.join(stage, 'cache'), npm_config_logs_max: '0',
    npm_config_userconfig: path.join(stage, 'empty-npmrc'),
    npm_config_globalconfig: path.join(stage, 'empty-global-npmrc') };
}

export function generateInventory({ root, output }) {
  root = realpathSync(root);
  output = path.resolve(output);
  if (existsSync(output)) throw new Error('Output already exists; choose a new evidence directory.');
  const files = git(root, ['ls-files', '-z']).split('\0').filter(Boolean).sort(compare);
  const manifests = files.filter((file) => /(^|\/)package\.json$/.test(file));
  if (!manifests.length) throw new Error('No tracked npm package manifests found.');
  const stage = mkdtempSync(path.join(tmpdir(), 'hivra-dependency-inventory-'));
  try {
    writeFileSync(path.join(stage, 'empty-npmrc'), '', { flag: 'wx', mode: 0o600 });
    writeFileSync(path.join(stage, 'empty-global-npmrc'), '', { flag: 'wx', mode: 0o600 });
    const env = npmEnvironment(stage);
    let npmVersion;
    try { npmVersion = execFileSync('npm', ['--version'], { ...commandOptions, env }).trim(); }
    catch { throw new Error('npm with the sbom command is required.'); }
    if (!/^\d+\.\d+\.\d+$/.test(npmVersion) || Number(npmVersion.split('.')[0]) < 10) {
      throw new Error('Use npm 10 or newer with the sbom command.');
    }
    const report = {
      format: 'hivra-dependency-inventory-v1',
      status: 'inventory-only', releaseApproved: false,
      gitHead: git(root, ['rev-parse', 'HEAD']).trim(),
      generatorSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
      nodeVersion: process.version, npmVersion,
      scope: 'Tracked working-tree npm manifests and their lockfiles, including development, optional and peer dependencies.',
      limitations: [
        'Declared lockfile licenses are not verified redistribution rights or complete third-party notices.',
        'Runtime downloads, OCI/base images, OS packages, Python dependencies and external assets require separate inventories.',
        'This is not a vulnerability scan, secret scan, history audit, deployed-image SBOM or public-release approval.',
      ],
      components: [], gaps: [],
    };
    if (!files.some((file) => /^(LICENSE|COPYING)(\.[^/]+)?$/.test(file))) {
      report.gaps.push({ code: 'root-license-missing' });
    }
    const artifacts = new Map();
    for (const manifestPath of manifests) {
      const text = readInput(root, manifestPath);
      const manifest = parseInput(text);
      const directory = path.posix.dirname(manifestPath);
      const lockPath = path.posix.join(directory, 'package-lock.json');
      const component = { path: directory, name: manifest.name ?? null, version: manifest.version ?? null,
        declaredLicense: manifest.license ?? null, manifestSha256: sha256(text), lockfileSha256: null,
        coverage: 'missing-lockfile', bom: null };
      if (!manifest.license) report.gaps.push({ code: 'manifest-license-missing', path: manifestPath });
      if (!files.includes(lockPath)) {
        report.gaps.push({ code: 'lockfile-missing', path: manifestPath });
        report.components.push(component);
        continue;
      }
      const lockText = readInput(root, lockPath);
      const lock = parseInput(lockText);
      checkLock(manifest, lock);
      const packageStage = path.join(stage, 'packages', directory === '.' ? path.basename(root) : directory);
      mkdirSync(packageStage, { recursive: true });
      writeFileSync(path.join(packageStage, 'package.json'), text, { flag: 'wx', mode: 0o600 });
      writeFileSync(path.join(packageStage, 'package-lock.json'), lockText, { flag: 'wx', mode: 0o600 });
      let bom;
      try {
        bom = normalizeBom(JSON.parse(execFileSync('npm', ['sbom', '--package-lock-only', '--offline',
          '--ignore-scripts', '--sbom-format=cyclonedx', '--sbom-type=application',
          '--include=dev', '--include=optional', '--include=peer'], { ...commandOptions, cwd: packageStage, env })));
      } catch { throw new Error('Offline npm SBOM generation failed; no npm output or source values were printed.'); }
      const bomPath = path.posix.join(directory === '.' ? 'root' : directory, 'sbom.cdx.json');
      const bomText = json(bom);
      artifacts.set(bomPath, bomText);
      const licenseCounts = new Map();
      const missingLicenses = [];
      for (const dependency of bom.components) {
        const declared = dependency.licenses?.map((item) => item.expression ?? item.license?.id ?? item.license?.name)
          .filter(Boolean).sort(compare).join(' | ') || 'UNDECLARED';
        licenseCounts.set(declared, (licenseCounts.get(declared) ?? 0) + 1);
        if (declared === 'UNDECLARED') missingLicenses.push({ name: dependency.name, version: dependency.version });
      }
      Object.assign(component, { lockfileSha256: sha256(lockText), coverage: 'npm-lockfile',
        bom: { path: bomPath, sha256: sha256(bomText), specVersion: bom.specVersion },
        dependencyComponents: bom.components.length, dependencyGraphEntries: bom.dependencies.length,
        declaredLicenseCounts: Object.fromEntries([...licenseCounts].sort(([a], [b]) => compare(a, b))),
        missingLicenses: missingLicenses.sort((a, b) => compare(`${a.name}@${a.version}`, `${b.name}@${b.version}`)) });
      if (missingLicenses.length) report.gaps.push({ code: 'dependency-license-metadata-missing', path: lockPath, count: missingLicenses.length });
      report.components.push(component);
    }
    // Publish only after all components succeeded; never overwrite an earlier receipt.
    mkdirSync(output, { mode: 0o700 });
    for (const [relative, content] of artifacts) {
      const target = path.join(output, relative);
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
    }
    writeFileSync(path.join(output, 'inventory.json'), json(report), { flag: 'wx', mode: 0o600 });
    return report;
  } finally {
    // Only the exact private directory created by this invocation is removed.
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--out') {
      throw new Error('Usage: node scripts/release/dependency-inventory.mjs --out NEW_DIRECTORY');
    }
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
    const report = generateInventory({ root, output: process.argv[3] });
    console.log(JSON.stringify({ status: report.status, releaseApproved: false, components: report.components.length,
      sboms: report.components.filter((item) => item.bom).length, gaps: report.gaps.length,
      output: path.resolve(process.argv[3]) }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Inventory failed.');
    process.exitCode = 1;
  }
}
