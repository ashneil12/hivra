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
const trackedFilesLower = new Set(files.map(file => file.toLowerCase()));
const paths = new Map();
const modules = new Map();
const conflicts = new Set();

// TypeScript declaration suffixes must come before their implementation suffixes.
// The implementation/data list is the union of TypeScript's module files and the
// extensions Next resolves extensionlessly (.js, .mjs, .tsx, .ts, .jsx, .json, .wasm).
const MODULE_EXTENSIONS = [
  '.d.mts',
  '.d.cts',
  '.d.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.ts',
  '.mjs',
  '.cjs',
  '.jsx',
  '.js',
  '.json',
  '.wasm',
];
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

const packageTargets = new Map();

function hasResolvableModuleFile(candidate) {
  const folded = candidate.toLowerCase();
  return trackedFilesLower.has(folded) || MODULE_EXTENSIONS.some(extension => trackedFilesLower.has(`${folded}${extension}`));
}

function hasResolvableDirectory(directory, visited) {
  if (hasResolvableModuleFile(`${directory}/index`)) return true;
  const folded = directory.toLowerCase();
  if (visited.has(folded)) return false;
  visited.add(folded);
  return (packageTargets.get(folded) ?? []).some(target => {
    if (!target.endsWith('/') && hasResolvableModuleFile(target)) return true;
    return hasResolvableDirectory(target.replace(/\/$/, ''), visited);
  });
}

function normalizePackageEntry(directory, specifier) {
  if (typeof specifier !== 'string' || !specifier.trim()) return null;
  const trimmed = specifier.trim();
  if (trimmed.startsWith('/') || /^[a-z]:[\\/]/i.test(trimmed) || trimmed.includes('\0')) return null;
  const relative = trimmed.replace(/\\/g, '/');
  const normalized = path.posix.normalize(`${directory}/${relative}`);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  return /(?:^|\/)\.{1,2}$/.test(relative) ? `${normalized}/` : normalized;
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
  if (stem !== file) check(file, modules);
  check(stem, modules);
  const slash = stem.lastIndexOf('/');
  const basename = stem.slice(slash + 1);
  if (slash !== -1 && basename.toLowerCase() === 'index') check(stem.slice(0, slash), modules);
}

for (const entry of indexEntries) {
  if (!entry.file.toLowerCase().endsWith('/package.json')) continue;
  const slash = entry.file.lastIndexOf('/');
  const directory = entry.file.slice(0, slash);
  const manifest = readPackageManifest(entry);
  if (!manifest) continue;
  const targets = PACKAGE_ENTRY_FIELDS.map(field => normalizePackageEntry(directory, manifest[field])).filter(Boolean);
  packageTargets.set(directory.toLowerCase(), targets);
}

for (const entry of indexEntries) {
  if (!entry.file.toLowerCase().endsWith('/package.json')) continue;
  const directory = path.posix.dirname(entry.file);
  if (hasResolvableDirectory(directory, new Set())) check(directory, modules);
}

for (const conflict of conflicts) console.error(`Conflicting dashboard paths: ${conflict}`);
if (conflicts.size) process.exitCode = 1;
