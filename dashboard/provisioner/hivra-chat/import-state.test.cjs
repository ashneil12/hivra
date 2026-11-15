'use strict';
// node --test import-state.test.cjs
// The restore half of move-an-agent: bundle-name validation, the staging
// sweep, per-kind targets and the merge/replace copy. No gateway needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileP = promisify(execFile);
const {
  specFor, isDeniedHome, validateMemberNames, sanitizeExtracted, syncTree, runImport,
} = require('./import-state.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hivra-import-test-'));
const put = (root, rel, text) => {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};

test('specFor: home kinds get their roots, agent-zero gets the volume, aeon nothing', () => {
  const home = tmp();
  assert.equal(specFor('claude', home, {}).mode, 'home');
  assert.deepEqual(specFor('claude', home, {}).roots.slice(0, 3), ['.claude', '.claude.json', '.agents']);
  assert.deepEqual(specFor('codex', home, {}).roots.slice(0, 2), ['.codex', '.agents']);
  assert.deepEqual(specFor('agent-zero', home, {}), { mode: 'a0-usr', usr: '/opt/a0/usr' });
  assert.equal(specFor('aeon', home, {}), null);
  assert.equal(specFor('linux-desktop', home, {}), null);
});

test('specFor: ~/.hivra/import-roots extends the allowlist', () => {
  const home = tmp();
  put(home, '.hivra/import-roots', '.myagent\n# a comment\n\n');
  const spec = specFor('generic', home, {});
  assert.ok(spec.roots.includes('.myagent'));
});

test('validateMemberNames: accepts plain trees, rejects traversal and absolute paths', () => {
  const good = validateMemberNames('.claude/\n.claude/settings.json\nwork/proj/a.ts\n./MEMORY.md\n');
  assert.equal(good.ok, true);
  assert.ok(good.cleaned.includes('.claude/settings.json'));
  assert.ok(good.cleaned.includes('MEMORY.md')); // ./ prefix normalized

  for (const bad of ['../etc/passwd', 'x/../../y', '/etc/passwd', '.claude/../.ssh/key']) {
    assert.equal(validateMemberNames(bad + '\n.claude/x').ok, false, bad);
  }
  assert.equal(validateMemberNames('.\n./\n').ok, false); // nothing real inside
});

test('isDeniedHome: protects the gate and autostart paths', () => {
  for (const denied of ['.hivra', '.hivra/api-token', '.ssh/id_rsa', '.bashrc', '.config/systemd/user/x.service', 'system-prompt.md']) {
    assert.equal(isDeniedHome(denied), true, denied);
  }
  for (const ok of ['.claude', '.claude/settings.json', 'proj/.ssh/config', 'CLAUDE.md', 'myapp']) {
    assert.equal(isDeniedHome(ok), false, ok);
  }
});

test('sanitizeExtracted: removes escaping links and non-file entries, keeps inner links', () => {
  const root = tmp();
  put(root, 'keep/real.txt', 'x');
  fs.symlinkSync('real.txt', path.join(root, 'keep', 'inner-link'));     // stays inside -> kept
  fs.symlinkSync('/etc/passwd', path.join(root, 'escape-link'));         // absolute out -> removed
  fs.mkdirSync(path.join(root, 'sub'));
  fs.symlinkSync('../../outside-file', path.join(root, 'sub', 'dotdot-link')); // resolves above root -> removed
  fs.symlinkSync('nosuchtarget', path.join(root, 'dangling'));           // dangling but inside -> kept
  const removed = sanitizeExtracted(root);
  assert.equal(removed, 2);
  assert.ok(fs.existsSync(path.join(root, 'keep', 'inner-link')));
  assert.ok(!fs.existsSync(path.join(root, 'escape-link')));
  assert.ok(!fs.existsSync(path.join(root, 'sub', 'dotdot-link')));
});

test('syncTree: merges into an existing home, replaces collisions, honors deny', () => {
  const src = tmp(), dst = tmp();
  put(src, '.claude/settings.json', 'new');
  put(src, '.claude/skills/x/SKILL.md', 'skill');
  put(src, '.hivra/api-token', 'should-not-land');
  put(dst, '.claude/old-session.json', 'kept');
  put(dst, '.claude/settings.json', 'old');
  put(dst, 'unrelated.txt', 'kept too');

  const r = syncTree(path.join(src, '.claude'), path.join(dst, '.claude'), { deny: isDeniedHome });
  assert.equal(fs.readFileSync(path.join(dst, '.claude/settings.json'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(dst, '.claude/old-session.json'), 'utf8'), 'kept');
  assert.equal(fs.readFileSync(path.join(dst, 'unrelated.txt'), 'utf8'), 'kept too');
  assert.ok(fs.existsSync(path.join(dst, '.claude/skills/x/SKILL.md')));
  assert.ok(r.files >= 2);

  // deny sees paths relative to the synced root; runImport gates root names
  // itself. A .ssh child inside a restored folder is still refused.
  put(src, 'proj/.ssh/key', 'nope');
  const denied = syncTree(path.join(src, 'proj'), path.join(dst, 'proj'), { deny: isDeniedHome });
  assert.equal(denied.files, 0);
  assert.ok(denied.skipped[0].includes('protected'));
  assert.ok(!fs.existsSync(path.join(dst, 'proj/.ssh/key')));
});

test('syncTree: prune makes the destination exactly the bundle', () => {
  const src = tmp(), dst = tmp();
  put(src, 'a/b.txt', 'new');
  put(dst, 'a/old.txt', 'stale');
  put(dst, 'gone.txt', 'stale');
  const r = syncTree(src, dst, { prune: true });
  assert.equal(r.files, 1);
  assert.ok(!fs.existsSync(path.join(dst, 'gone.txt')));
  assert.ok(!fs.existsSync(path.join(dst, 'a/old.txt')));
  assert.equal(fs.readFileSync(path.join(dst, 'a/b.txt'), 'utf8'), 'new');
});

test('syncTree: a single-file source lands as a file', () => {
  const src = tmp(), dst = tmp();
  const f = put(src, '.claude.json', '{"mcp":{}}');
  const r = syncTree(f, path.join(dst, '.claude.json'), {});
  assert.equal(r.files, 1);
  assert.equal(fs.readFileSync(path.join(dst, '.claude.json'), 'utf8'), '{"mcp":{}}');
});

test('runImport: a real bundle restores home paths, work/ lands at HOME, protected roots are refused', async () => {
  const src = tmp(), home = tmp(), stagingParent = tmp(), out = tmp();
  put(src, '.claude/settings.json', 'new');
  put(src, '.claude.json', '{"mcp":{}}');
  put(src, 'work/proj/main.py', 'print(1)');
  put(src, 'work/.ssh/key', 'nope');            // maps to HOME/.ssh -> refused
  put(src, '.hivra/api-token', 'nope');         // the gateway's own state -> refused
  put(src, 'random-junk.txt', 'x');             // not agent state -> skipped
  const archive = path.join(out, 'bundle.tar.gz');
  await execFileP('tar', ['-czf', archive, '-C', src, '.claude', '.claude.json', 'work', '.hivra', 'random-junk.txt']);

  const phases = [];
  const result = await runImport({
    archive, spec: specFor('claude', home, {}), stagingParent,
    onPhase: (name) => phases.push(name),
  });

  assert.equal(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'), '{"mcp":{}}');
  assert.equal(fs.readFileSync(path.join(home, 'proj/main.py'), 'utf8'), 'print(1)'); // work/proj -> HOME/proj
  assert.ok(!fs.existsSync(path.join(home, '.ssh')));
  assert.ok(!fs.existsSync(path.join(home, '.hivra/api-token')));
  assert.ok(!fs.existsSync(path.join(home, 'random-junk.txt')));
  assert.ok(!fs.existsSync(archive)); // the upload is consumed
  assert.ok(result.restored.includes('.claude') && result.restored.includes('proj'));
  assert.ok(result.skipped.some((s) => s.startsWith('.hivra')));
  assert.ok(result.skipped.some((s) => s.startsWith('random-junk.txt')));
  assert.deepEqual(phases.slice(0, 2), ['unpacking', 'restoring']);
});

test('runImport: refuses a non-archive upload cleanly', async () => {
  const home = tmp(), stagingParent = tmp(), out = tmp();
  const archive = path.join(out, 'not-a-tar.tar.gz');
  fs.writeFileSync(archive, 'definitely not gzip');
  await assert.rejects(
    runImport({ archive, spec: specFor('claude', home, {}), stagingParent }),
    /not a readable .tar.gz/,
  );
});
