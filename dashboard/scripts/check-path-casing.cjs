const { execFileSync } = require('node:child_process');
const path = require('node:path');

const dashboardRoot = path.resolve(__dirname, '..');

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: dashboardRoot,
    encoding: 'utf8',
    ...options,
  });
}

// Read the git index so a case-insensitive checkout cannot hide a conflicting entry.
const indexEntries = git(['ls-files', '-z', '--stage', '--', '.'], { maxBuffer: Infinity })
  .split('\0')
  .filter(Boolean)
  .map(record => {
    const separator = record.indexOf('\t');
    const metadata = record.slice(0, separator).split(' ');
    return {
      object: metadata[1],
      file: record.slice(separator + 1),
    };
  });
const files = indexEntries.map(({ file }) => file);
const fileRequests = new Set();
const jestFileRequests = new Set();
const paths = new Map();
const modules = new Map();
const conflicts = new Set();

// Extensions probed by an extensionless request in TypeScript, Next or Jest.
const JEST_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.node']);
const MODULE_EXTENSIONS = ['.d.ts', ...JEST_EXTENSIONS, '.wasm'];
const PACKAGE_ENTRY_FIELDS = ['types', 'typings', 'main', 'module', 'browser', 'edge-light'];

function check(spelling, seen) {
  const folded = spelling.toLowerCase();
  const previous = seen.get(folded);
  if (previous && previous !== spelling) conflicts.add(`${previous} / ${spelling}`);
  else seen.set(folded, spelling);
}

function moduleStem(file) {
  const folded = file.toLowerCase();
  for (const extension of MODULE_EXTENSIONS) {
    if (folded.endsWith(extension)) return file.slice(0, -extension.length);
  }
  return null;
}

const packages = new Map();

function hasResolvableDirectory(directory, visited, root, requests) {
  if (requests.has(path.posix.join(directory, 'index'))) return true;
  if (visited.has(directory)) return false;
  visited.add(directory);
  return (packages.get(directory)?.targets ?? []).some(({ field, target }) => {
    const candidate = target.replace(/\/$/, '');
    // Returning to the original request can only rediscover the competing file.
    if (candidate === root) return false;
    if (requests === jestFileRequests) {
      if (field !== 'main') return false;
      if (requests.has(candidate)) return true;
    } else if (!target.endsWith('/') && requests.has(target)) {
      return true;
    }
    return hasResolvableDirectory(candidate, visited, root, requests);
  });
}

function normalizePackageEntry(directory, specifier) {
  if (typeof specifier !== 'string' || !specifier.trim()) return null;
  const trimmed = specifier.trim();
  if (trimmed.startsWith('/') || /^[a-z]:[\\/]/i.test(trimmed) || trimmed.includes('\0')) return null;
  const relative = trimmed.replace(/\\/g, '/');
  const normalized = path.posix.normalize(`${directory}/${relative}`);
  if (relative === '.' || relative === './' || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

function readPackageManifest(entry) {
  try {
    return JSON.parse(git(['cat-file', 'blob', entry.object]));
  } catch {
    return null;
  }
}

for (const file of files) {
  const parts = file.split('/');
  let prefix = '';
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    check(prefix, paths);
  }
  // Extensionless imports can resolve differently even when the extensions differ.
  // A literal file (even a dotted one) wins the exact-file probe before extension expansion.
  const stem = moduleStem(file) ?? file;
  const foldedFile = file.toLowerCase();
  fileRequests.add(foldedFile);
  // Only the Jest resolver probes a native addon for an extensionless target.
  if (!foldedFile.endsWith('.node')) fileRequests.add(stem.toLowerCase());
  jestFileRequests.add(foldedFile);
  const extension = path.posix.extname(foldedFile);
  if (JEST_EXTENSIONS.has(extension)) jestFileRequests.add(foldedFile.slice(0, -extension.length));
  if (/\.[jt]sx?$/.test(foldedFile)) {
    fileRequests.add(`${stem.toLowerCase()}.js`);
    fileRequests.add(`${stem.toLowerCase()}.jsx`);
  }
  const explicitTypeScriptSuffix = /(?:\.d)?\.([mc])ts$/i.exec(file);
  if (explicitTypeScriptSuffix) {
    const request = `${file.slice(0, explicitTypeScriptSuffix.index)}.${explicitTypeScriptSuffix[1].toLowerCase()}js`;
    fileRequests.add(request.toLowerCase());
    check(request, modules);
  }
  if (stem !== file) check(file, modules);
  check(stem, modules);
  const slash = stem.lastIndexOf('/');
  const basename = stem.slice(slash + 1);
  if (slash !== -1 && basename.toLowerCase() === 'index') check(stem.slice(0, slash), modules);
}

for (const entry of indexEntries) {
  if (path.posix.basename(entry.file).toLowerCase() !== 'package.json') continue;
  const directory = path.posix.dirname(entry.file);
  const manifest = readPackageManifest(entry);
  if (!manifest) continue;
  const targets = [];
  for (const field of PACKAGE_ENTRY_FIELDS) {
    const target = normalizePackageEntry(directory, manifest[field]);
    if (target) targets.push({ field, target: target.toLowerCase() });
  }
  packages.set(directory.toLowerCase(), { directory, targets });
}

for (const [folded, { directory }] of packages) {
  if (directory === '.') continue;
  const resolves = [fileRequests, jestFileRequests].some(requests =>
    hasResolvableDirectory(folded, new Set(), folded, requests));
  if (resolves) check(directory, modules);
}

for (const conflict of conflicts) console.error(`Conflicting dashboard paths: ${conflict}`);
if (conflicts.size) process.exitCode = 1;
