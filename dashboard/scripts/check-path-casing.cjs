const { execFileSync } = require('node:child_process');
const path = require('node:path');

// Read the git index so a case-insensitive checkout cannot hide a conflicting entry.
const files = execFileSync('git', ['ls-files', '-z', '--', '.'], {
  cwd: path.resolve(__dirname, '..'),
  encoding: 'utf8',
}).split('\0').filter(Boolean);
const paths = new Map();
const modules = new Map();
const conflicts = new Set();

function check(spelling, seen) {
  const folded = spelling.toLowerCase();
  const previous = seen.get(folded);
  if (previous && previous !== spelling) conflicts.add(`${previous} / ${spelling}`);
  else seen.set(folded, spelling);
}

for (const file of files) {
  const parts = file.split('/');
  let prefix = '';
  for (const part of parts) {
    prefix = prefix ? `${prefix}/${part}` : part;
    check(prefix, paths);
  }
  // Extensionless imports can resolve differently even when the extensions differ.
  const moduleStem = file.replace(/(?:\.d\.[cm]?ts|\.[cm]?[jt]s|\.[jt]sx)$/, '');
  if (moduleStem !== file) {
    check(moduleStem, modules);
    const slash = moduleStem.lastIndexOf('/');
    const basename = moduleStem.slice(slash + 1);
    if (slash !== -1 && basename.toLowerCase() === 'index') check(moduleStem.slice(0, slash), modules);
  }
}

for (const conflict of conflicts) console.error(`Conflicting dashboard paths: ${conflict}`);
if (conflicts.size) process.exitCode = 1;
