const { strict: assert } = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

function runGuard(t, names) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'dashboard-casing-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd });
  mkdirSync(path.join(cwd, 'scripts'));
  const script = path.join(cwd, 'scripts/check-path-casing.cjs');
  copyFileSync(path.join(__dirname, 'check-path-casing.cjs'), script);
  for (const name of names) {
    const target = path.join(cwd, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, '');
  }
  execFileSync('git', ['add', '--', ...names], { cwd });
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

function assertConflict(result, spellings) {
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Conflicting dashboard paths:/);
  for (const spelling of spellings) assert.ok(result.stderr.includes(spelling), `${result.stderr} includes ${spelling}`);
}

test('accepts distinct modules and matching-case declaration companions', t => {
  const result = runGuard(t, ['PromptOutline.tsx', 'promptOutlineModel.ts', 'PromptOutline.d.ts']);
  assert.equal(result.status, 0, result.stderr);
});

for (const companion of ['.ts', '.d.ts', '.d.mts', '.d.cts']) {
  test(`rejects a differently cased module with extension ${companion}`, t => {
    const result = runGuard(t, ['PromptOutline.tsx', `promptOutline${companion}`]);
    assertConflict(result, ['PromptOutline', 'promptOutline']);
  });
}

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
