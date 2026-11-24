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
const indexEntries = git(['ls-files', '-z', '--stage', '--', '.'])
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
const PACKAGE_ENTRY_FIELDS = ['types', 'typings', 'main', 'module', 'browser'];

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

function hasExplicitExtension(file) {
  const basename = file.slice(file.lastIndexOf('/') + 1);
  return basename.lastIndexOf('.') > 0;
}

function hasResolvableModuleFile(candidate) {
  const folded = candidate.toLowerCase();
  if (hasExplicitExtension(candidate)) return trackedFilesLower.has(folded);
  if (trackedFilesLower.has(folded)) return true;
  return MODULE_EXTENSIONS.some(extension => trackedFilesLower.has(`${folded}${extension}`));
}

function hasResolvableModuleEntry(candidate) {
  return hasResolvableModuleFile(candidate) || hasResolvableModuleFile(`${candidate}/index`);
}

function normalizePackageEntry(directory, specifier) {
  if (typeof specifier !== 'string' || !specifier.trim()) return null;
  const trimmed = specifier.trim();
  if (trimmed.startsWith('/') || /^[a-z]:[\\/]/i.test(trimmed) || trimmed.includes('\0')) return null;
  const normalized = path.posix.normalize(`${directory}/${trimmed.replace(/\\/g, '/')}`);
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
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
  const stem = moduleStem(file);
  if (stem) {
    check(stem, modules);
    const slash = stem.lastIndexOf('/');
    const basename = stem.slice(slash + 1);
    if (slash !== -1 && basename.toLowerCase() === 'index') check(stem.slice(0, slash), modules);
  }
}

for (const entry of indexEntries) {
  if (!entry.file.toLowerCase().endsWith('/package.json')) continue;
  const slash = entry.file.lastIndexOf('/');
  const directory = entry.file.slice(0, slash);
  const manifest = readPackageManifest(entry);
  if (!manifest) continue;
  const hasEntry = PACKAGE_ENTRY_FIELDS.some(field => {
    const target = normalizePackageEntry(directory, manifest[field]);
    return target !== null && hasResolvableModuleEntry(target);
  });
  if (hasEntry) check(directory, modules);
}

for (const conflict of conflicts) console.error(`Conflicting dashboard paths: ${conflict}`);
if (conflicts.size) process.exitCode = 1;
