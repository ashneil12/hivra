import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ignore from 'ignore';
import { FORBIDDEN_PUBLIC_PATHS, GEO_DOCUMENTS, GEO_DOCUMENTS_DIRECTORY, LITEPAPER_FILES, RESTRICTED_COPIES, stageLitepaper } from './stage-litepaper.mjs';

// Each source the staging script reads, beside the path under dashboard/ it is staged at.
const PUBLIC_PAIRS = [...LITEPAPER_FILES.map((relative) => [relative, relative]), ...RESTRICTED_COPIES]
  .map(([source, published]) => [source, `public/${published}`]);
const GEO_PAIRS = GEO_DOCUMENTS.flatMap((document) => ['full', 'restricted'].map((variant) => [
  document[variant], `${GEO_DOCUMENTS_DIRECTORY}/${variant}/${document.name}`,
]));
const PAIRS = [...PUBLIC_PAIRS, ...GEO_PAIRS];
// Distinct sources: a restricted document is staged twice (public and private).
const SOURCES = [...new Set(PAIRS.map(([source]) => source))];

const FIXTURE_SOURCE = 'LITEPAPER.md\n';
const FIXTURE_SHA256 = createHash('sha256').update(FIXTURE_SOURCE).digest('hex');

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hivra-litepaper-stage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'dashboard/public'), { recursive: true });
  for (const relative of SOURCES) {
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
  assert.equal(stageLitepaper({ repoRoot: root, approvedSha256: FIXTURE_SHA256 }).files, PAIRS.length);
  for (const [source, staged] of PAIRS) assert.deepEqual(readFileSync(path.join(root, 'dashboard', staged)), readFileSync(path.join(root, source)));
  assert.equal(existsSync(path.join(root, 'dashboard/public/.env')), false);
  assert.equal(existsSync(path.join(root, 'dashboard/public/docs/litepaper/review')), false);
  assert.equal(readFileSync(path.join(root, 'dashboard/public/unrelated.txt'), 'utf8'), 'keep');
  assert.equal(stageLitepaper({ repoRoot: root, approvedSha256: FIXTURE_SHA256 }).updated, 0);
  stageLitepaper({ repoRoot: root, check: true, approvedSha256: FIXTURE_SHA256 });
  writeFileSync(path.join(root, 'dashboard/public/THOUGHTS.md'), 'stale');
  assert.throws(() => stageLitepaper({ repoRoot: root, check: true, approvedSha256: FIXTURE_SHA256 }), /stale/);
  stageLitepaper({ repoRoot: root, approvedSha256: FIXTURE_SHA256 });
  writeFileSync(path.join(root, `dashboard/${GEO_DOCUMENTS_DIRECTORY}/full/LITEPAPER.md`), 'stale');
  assert.throws(() => stageLitepaper({ repoRoot: root, check: true, approvedSha256: FIXTURE_SHA256 }), /stale/);
});

test('the four token documents are staged beside the app, never into public/', (t) => {
  const root = fixture(t);
  stageLitepaper({ repoRoot: root, approvedSha256: FIXTURE_SHA256 });
  assert.deepEqual([...FORBIDDEN_PUBLIC_PATHS].sort(), ['LITEPAPER.md', 'TOKENOMICS.md', 'WHITEPAPER.md', 'docs/litepaper/index.html']);
  for (const document of GEO_DOCUMENTS) {
    assert.equal(existsSync(path.join(root, 'dashboard/public', document.full)), false, `${document.full} must not be a public file`);
    assert.deepEqual(readFileSync(path.join(root, 'dashboard', GEO_DOCUMENTS_DIRECTORY, 'full', document.name)), readFileSync(path.join(root, document.full)));
    assert.deepEqual(readFileSync(path.join(root, 'dashboard', GEO_DOCUMENTS_DIRECTORY, 'restricted', document.name)), readFileSync(path.join(root, document.restricted)));
  }
  // Nothing in public/ carries the bytes of a full document under any name.
  const fullBytes = GEO_DOCUMENTS.map(({ full }) => readFileSync(path.join(root, full)));
  const published = readdirSync(path.join(root, 'dashboard/public'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(path.join(entry.parentPath, entry.name)));
  for (const bytes of published) assert.equal(fullBytes.some((full) => full.equals(bytes)), false);
  // The restricted copies are still public.
  for (const [source, published] of RESTRICTED_COPIES) assert.deepEqual(readFileSync(path.join(root, 'dashboard/public', published)), readFileSync(path.join(root, source)));
});

test('a full document left in public/ by an earlier release is removed, and --check refuses it', (t) => {
  const root = fixture(t);
  stageLitepaper({ repoRoot: root, approvedSha256: FIXTURE_SHA256 });
  for (const relative of FORBIDDEN_PUBLIC_PATHS) {
    mkdirSync(path.dirname(path.join(root, 'dashboard/public', relative)), { recursive: true });
    writeFileSync(path.join(root, 'dashboard/public', relative), 'full token document');
  }
  assert.throws(() => stageLitepaper({ repoRoot: root, check: true, approvedSha256: FIXTURE_SHA256 }), /full token document is published/);
  const result = stageLitepaper({ repoRoot: root, approvedSha256: FIXTURE_SHA256 });
  assert.equal(result.updated, FORBIDDEN_PUBLIC_PATHS.length);
  for (const relative of FORBIDDEN_PUBLIC_PATHS) assert.equal(existsSync(path.join(root, 'dashboard/public', relative)), false, relative);
  stageLitepaper({ repoRoot: root, check: true, approvedSha256: FIXTURE_SHA256 });
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
  const source = path.join(root, 'THOUGHTS.md');
  rmSync(source);
  symlinkSync(outside, source);
  assert.throws(() => stageLitepaper({ repoRoot: root, approvedSha256: FIXTURE_SHA256 }), /Symlink/);
  rmSync(source);
  writeFileSync(source, 'THOUGHTS.md\n');
  symlinkSync(outside, path.join(root, 'dashboard/public/THOUGHTS.md'));
  assert.throws(() => stageLitepaper({ repoRoot: root, approvedSha256: FIXTURE_SHA256 }), /Symlink/);
  assert.equal(readFileSync(outside, 'utf8'), 'keep');
});

test('refuses accidental extra files within the generated directory', (t) => {
  const root = fixture(t);
  stageLitepaper({ repoRoot: root, approvedSha256: FIXTURE_SHA256 });
  writeFileSync(path.join(root, 'dashboard/public/docs/litepaper/private.zip'), 'review-only');
  assert.throws(() => stageLitepaper({ repoRoot: root, check: true, approvedSha256: FIXTURE_SHA256 }), /Unexpected file/);
  assert.throws(() => stageLitepaper({ repoRoot: root, approvedSha256: FIXTURE_SHA256 }), /Unexpected file/);
  rmSync(path.join(root, 'dashboard/public/docs/litepaper/private.zip'));
  writeFileSync(path.join(root, `dashboard/${GEO_DOCUMENTS_DIRECTORY}/full/extra.md`), 'review-only');
  assert.throws(() => stageLitepaper({ repoRoot: root, check: true, approvedSha256: FIXTURE_SHA256 }), /Unexpected file/);
});

test('Vercel-filtered source package stages successfully without private documentation', (t) => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'hivra-vercel-litepaper-'));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const input = path.join(temporary, 'input');
  const uploaded = path.join(temporary, 'uploaded');
  const stageScript = 'dashboard/scripts/stage-litepaper.mjs';
  const required = [...SOURCES, stageScript];
  const privatePaths = [
    'docs/PRODUCT-ARCHITECTURE.md', 'docs/internal/operations.md',
    'docs/litepaper/build.py', 'docs/litepaper/INTEGRATION.md',
    'docs/litepaper/review/01-original-website-source.zip',
    'docs/litepaper/review/21-final-copy-verification.md',
    'docs/litepaper/review/internal/founder-notes.md',
    'docs/litepaper/assets/unreviewed.png',
    'docs/litepaper/assets/unreviewed-768.webp',
    'docs/litepaper/export-litepaper-images.py',
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
  for (const [source, staged] of PAIRS) {
    assert.deepEqual(readFileSync(path.join(uploaded, 'dashboard', staged)), readFileSync(path.join(repo, source)));
  }
  for (const relative of FORBIDDEN_PUBLIC_PATHS) assert.equal(existsSync(path.join(uploaded, 'dashboard/public', relative)), false, relative);
});
