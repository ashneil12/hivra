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
  for (const name of names) writeFileSync(path.join(cwd, name), '');
  execFileSync('git', ['add', '--', ...names], { cwd });
  return spawnSync(process.execPath, [script], { cwd, encoding: 'utf8' });
}

test('accepts distinct modules and matching-case declaration companions', t => {
  const result = runGuard(t, ['PromptOutline.tsx', 'promptOutlineModel.ts', 'PromptOutline.d.ts']);
  assert.equal(result.status, 0, result.stderr);
});

for (const companion of ['.ts', '.d.ts', '.d.mts', '.d.cts']) {
  test(`rejects a differently cased module with extension ${companion}`, t => {
    const result = runGuard(t, ['PromptOutline.tsx', `promptOutline${companion}`]);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Conflicting dashboard paths: .*romptOutline/);
  });
}
