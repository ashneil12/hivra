import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ignore from 'ignore';
import { LITEPAPER_FILES, stageLitepaper } from './stage-litepaper.mjs';

const FIXTURE_SOURCE = 'LITEPAPER.md\n';
const FIXTURE_SHA256 = createHash('sha256').update(FIXTURE_SOURCE).digest('hex');

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hivra-litepaper-stage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'dashboard/public'), { recursive: true });
  for (const relative of LITEPAPER_FILES) {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), relative === 'LITEPAPER.md' ? FIXTURE_SOURCE : `${relative}\n`);
  }
  return root;
}

test('stages approved bytes only, preserves unrelated public files and checks freshness', (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, '.env'), 'private');
  mkdirSync(path.join(root, 'docs/litepaper/review'), { recursive: true });
  writeFileSync(path.join(root, 'docs/litepaper/review/review.zip'), 'private review');
  writeFileSync(path.join(root, 'dashboard/public/unrelated.txt'), 'keep');
  assert.equal(stageLitepaper({ repoRoot: root, approvedSha256: FIXTURE_SHA256 }).files, LITEPAPER_FILES.length);
  for (const relative of LITEPAPER_FILES) assert.deepEqual(readFileSync(path.join(root, 'dashboard/public', relative)), readFileSync(path.join(root, relative)));
  assert.equal(existsSync(path.join(root, 'dashboard/public/.env')), false);
  assert.equal(existsSync(path.join(root, 'dashboard/public/docs/litepaper/review')), false);
  assert.equal(readFileSync(path.join(root, 'dashboard/public/unrelated.txt'), 'utf8'), 'keep');
  assert.equal(stageLitepaper({ repoRoot: root, approvedSha256: FIXTURE_SHA256 }).updated, 0);
  stageLitepaper({ repoRoot: root, check: true, approvedSha256: FIXTURE_SHA256 });
  writeFileSync(path.join(root, 'dashboard/public/LITEPAPER.md'), 'stale');
  assert.throws(() => stageLitepaper({ repoRoot: root, check: true, approvedSha256: FIXTURE_SHA256 }), /stale/);
});

test('missing inputs or unapproved wording fail before any artifact is staged', (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, 'LITEPAPER.md'), 'edited');
  assert.throws(() => stageLitepaper({ repoRoot: root, approvedSha256: FIXTURE_SHA256 }), /user-approved/);
  writeFileSync(path.join(root, 'LITEPAPER.md'), FIXTURE_SOURCE);
  rmSync(path.join(root, LITEPAPER_FILES.at(-1)));
  assert.throws(() => stageLitepaper({ repoRoot: root, approvedSha256: FIXTURE_SHA256 }), /ENOENT/);
  assert.equal(existsSync(path.join(root, 'dashboard/public/LITEPAPER.md')), false);
});

test('rejects source and destination symlinks without modifying their target', (t) => {
  const root = fixture(t);
  const outside = path.join(root, 'outside.txt');
  writeFileSync(outside, 'keep');
  const source = path.join(root, 'WHY.md');
  rmSync(source);
  symlinkSync(outside, source);
  assert.throws(() => stageLitepaper({ repoRoot: root, approvedSha256: FIXTURE_SHA256 }), /Symlink/);
  rmSync(source);
  writeFileSync(source, 'WHY.md\n');
  symlinkSync(outside, path.join(root, 'dashboard/public/WHY.md'));
  assert.throws(() => stageLitepaper({ repoRoot: root, approvedSha256: FIXTURE_SHA256 }), /Symlink/);
  assert.equal(readFileSync(outside, 'utf8'), 'keep');
});

test('refuses accidental extra files within the generated directory', (t) => {
  const root = fixture(t);
  stageLitepaper({ repoRoot: root, approvedSha256: FIXTURE_SHA256 });
  writeFileSync(path.join(root, 'dashboard/public/docs/litepaper/private.zip'), 'review-only');
  assert.throws(() => stageLitepaper({ repoRoot: root, check: true, approvedSha256: FIXTURE_SHA256 }), /Unexpected file/);
  assert.throws(() => stageLitepaper({ repoRoot: root, approvedSha256: FIXTURE_SHA256 }), /Unexpected file/);
});

test('Vercel-filtered source package stages successfully without private documentation', (t) => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'hivra-vercel-litepaper-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const input = path.join(temporary, 'input');
  const uploaded = path.join(temporary, 'uploaded');
  const stageScript = 'dashboard/scripts/stage-litepaper.mjs';
  const required = [...LITEPAPER_FILES, stageScript];
  const privatePaths = [
    'docs/PRODUCT-ARCHITECTURE.md', 'docs/internal/operations.md',
    'docs/litepaper/build.py', 'docs/litepaper/INTEGRATION.md',
    'docs/litepaper/review/01-original-website-source.zip',
    'docs/litepaper/review/21-final-copy-verification.md',
    'docs/litepaper/review/internal/founder-notes.md',
    'docs/litepaper/assets/unreviewed.png',
    'docs/litepaper/assets/fonts/unreviewed.ttf',
    'docs/litepaper/vendor/unreviewed.js',
    '.codex/private.md', '.agents/private.md', '.env.local',
    'services/private.ts', 'scripts/private.sh',
    '.gitignore', 'dashboard/node_modules/private.js',
    'docs/litepaper/assets/.DS_Store', 'dashboard/.venv/private.py',
  ];
  for (const relative of [...required, ...privatePaths]) {
    const target = path.join(input, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, required.includes(relative) ? readFileSync(path.join(repo, relative)) : 'private sentinel');
  }

  // Vercel CLI 54.1.0 getVercelIgnore adds defaults before project rules.
  // buildFileTree calls ignores(path.relative(root, absPath)) for directories
  // too: no trailing slash. A slash-only negation incorrectly passes a test
  // that appends '/', while the actual walker prunes the required parent.
  const defaultExclusions = [
    '.hg', '.git', '.gitmodules', '.svn', '.cache', '.next', '.vercel', '.now',
    '.npmignore', '.dockerignore', '.gitignore', '.*.swp', '.DS_Store',
    '.wafpicke-*', '.lock-wscript', '.env.local', '.env.*.local', '.venv',
    '.yarn/cache', '.pnp*', 'npm-debug.log', 'config.gypi', 'node_modules',
    '__pycache__', 'venv', 'CVS',
  ];
  const filter = ignore().add(defaultExclusions).add(readFileSync(path.join(repo, '.vercelignore'), 'utf8'));
  for (const parent of ['docs', 'docs/litepaper', 'docs/litepaper/assets', 'docs/litepaper/assets/fonts', 'docs/litepaper/vendor']) {
    assert.equal(filter.ignores(parent), false, `CLI must traverse ${parent}`);
  }
  const transferred = [];
  function transfer(directory = '') {
    for (const entry of readdirSync(path.join(input, directory), { withFileTypes: true })) {
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      if (filter.ignores(relative)) continue;
      if (entry.isDirectory()) transfer(relative);
      else {
        const target = path.join(uploaded, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(path.join(input, relative)));
        transferred.push(relative);
      }
    }
  }
  transfer();
  assert.deepEqual(transferred.sort(), [...required].sort());
  for (const relative of privatePaths) assert.equal(existsSync(path.join(uploaded, relative)), false, relative);

  const result = spawnSync(process.execPath, [realpathSync(path.join(uploaded, stageScript))], { cwd: path.join(uploaded, 'dashboard'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  stageLitepaper({ repoRoot: uploaded, check: true });
  for (const relative of LITEPAPER_FILES) {
    assert.deepEqual(readFileSync(path.join(uploaded, 'dashboard/public', relative)), readFileSync(path.join(repo, relative)));
  }
});
