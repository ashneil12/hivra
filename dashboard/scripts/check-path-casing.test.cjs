const { strict: assert } = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

function runGuard(t, fixtures) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'dashboard-casing-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd });
  mkdirSync(path.join(cwd, 'scripts'));
  const script = path.join(cwd, 'scripts/check-path-casing.cjs');
  copyFileSync(path.join(__dirname, 'check-path-casing.cjs'), script);

  const added = [];
  const stagedOnly = [];
  for (const fixture of fixtures) {
    const entry = typeof fixture === 'string' ? { name: fixture } : fixture;
    if (entry.stageOnly) {
      stagedOnly.push(entry);
      continue;
    }
    const target = path.join(cwd, entry.name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, entry.contents ?? '');
    added.push(entry.name);
  }
  if (added.length) execFileSync('git', ['add', '--', ...added], { cwd });

  // Case-only duplicates cannot coexist in this Mac checkout, so stage them
  // directly in the index: the guard's input is the index, not the worktree.
  for (const entry of stagedOnly) {
    const object = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd,
      input: entry.contents ?? '',
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${object},${entry.name}`], { cwd });
  }

  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

function assertConflict(result, spellings) {
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Conflicting dashboard paths:/);
  for (const spelling of spellings) assert.ok(result.stderr.includes(spelling), `${result.stderr} includes ${spelling}`);
}

function packageFixture(name, manifest) {
  return { name, contents: `${JSON.stringify(manifest, null, 2)}\n` };
}

test('accepts distinct modules and matching-case declaration companions', t => {
  const result = runGuard(t, ['PromptOutline.tsx', 'promptOutlineModel.ts', 'PromptOutline.d.ts']);
  assert.equal(result.status, 0, result.stderr);
});

for (const companion of ['.ts', '.d.ts', '.d.mts', '.d.cts', '.TS', '.D.TS', '.json', '.wasm']) {
  test(`rejects a differently cased module with extension ${companion}`, t => {
    const result = runGuard(t, ['PromptOutline.tsx', `promptOutline${companion}`]);
    assertConflict(result, ['PromptOutline', 'promptOutline']);
  });
}

test('accepts matching-case module companions across supported extensions', t => {
  const result = runGuard(t, ['payload.js', 'payload.json', 'payload.wasm', 'payload.d.ts']);
  assert.equal(result.status, 0, result.stderr);
});

test('rejects direct non-module casing collisions staged only in the index', t => {
  const result = runGuard(t, [
    { name: 'docs/README.md', stageOnly: true },
    { name: 'docs/readme.md', stageOnly: true },
  ]);
  assertConflict(result, ['docs/README.md', 'docs/readme.md']);
});

test('accepts nested modules in a differently cased directory when it has no index module', t => {
  const result = runGuard(t, ['src/nested/Feature.ts', 'src/nested/feature/helper.ts']);
  assert.equal(result.status, 0, result.stderr);
});

for (const indexFile of ['index.tsx', 'Index.tsx']) {
  test(`accepts matching-case nested file, ${indexFile}, and declaration companions`, t => {
    const stem = indexFile.replace(/\.tsx$/, '');
    const result = runGuard(t, [
      'src/nested/Feature.ts',
      `src/nested/Feature/${indexFile}`,
      `src/nested/Feature/${stem}.d.ts`,
    ]);
    assert.equal(result.status, 0, result.stderr);
  });
}

for (const indexFile of ['index.ts', 'index.d.ts', 'Index.tsx']) {
  test(`rejects a nested file and differently cased directory index ${indexFile}`, t => {
    const result = runGuard(t, ['src/nested/foo.ts', `src/nested/Foo/${indexFile}`]);
    assertConflict(result, ['src/nested/foo', 'src/nested/Foo']);
  });
}

for (const field of ['main', 'types', 'typings', 'module', 'browser']) {
  test(`rejects a nested file and differently cased package directory with ${field}`, t => {
    const declaration = field === 'types' || field === 'typings';
    const entry = declaration ? 'entry.d.ts' : 'entry.ts';
    const result = runGuard(t, [
      'src/nested/foo.ts',
      packageFixture('src/nested/Foo/package.json', { [field]: `./${entry}` }),
      `src/nested/Foo/${entry}`,
    ]);
    assertConflict(result, ['src/nested/foo', 'src/nested/Foo']);
  });
}

test('rejects a differently cased package directory with an extensionless entry', t => {
  const result = runGuard(t, [
    'src/nested/foo.ts',
    packageFixture('src/nested/Foo/package.json', { main: './entry' }),
    'src/nested/Foo/entry.ts',
  ]);
  assertConflict(result, ['src/nested/foo', 'src/nested/Foo']);
});

test('accepts package metadata without a resolvable directory entry', t => {
  const result = runGuard(t, [
    'src/nested/foo.ts',
    packageFixture('src/nested/Foo/package.json', {
      main: './missing.ts',
      types: './missing.d.ts',
    }),
  ]);
  assert.equal(result.status, 0, result.stderr);
});

test('accepts matching-case file and package entry directory companions', t => {
  const result = runGuard(t, [
    'src/nested/Foo.ts',
    packageFixture('src/nested/Foo/package.json', { main: './entry.ts' }),
    'src/nested/Foo/entry.ts',
  ]);
  assert.equal(result.status, 0, result.stderr);
});
