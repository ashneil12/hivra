'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createGuardedFiles, protectedPath } = require('../../provisioner/hivra-chat/guarded-files.cjs');

test('private native state and credential names are excluded', () => {
  for (const p of ['/home/bux/.hivra/deepseek', '/home/bux/.hivra/deepseek/a', '/home/bux/.dsh/key',
    '/home/bux/project/.credentials.yaml', '/home/bux/project/.credentials.yml', '/home/bux/project/.env',
    '/home/bux/.ssh', '/home/bux/project/.env.local', '/home/bux/.hivra/api-token']) assert.equal(protectedPath(p), true, p);
  assert.equal(protectedPath('/home/bux/projects/deepseek/README.md'), false);
});

test('descriptor guards reject private paths, symlinks, hardlinks, special files and escapes before I/O', { skip: process.platform !== 'linux' }, t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hivra-file-guard-'));
  t.after(() => fs.rmSync(temporary, { recursive: true }));
  const home = path.join(temporary, 'home'); fs.mkdirSync(home);
  fs.mkdirSync(path.join(home, '.hivra/deepseek/.dsh'), { recursive: true });
  const credential = path.join(home, '.hivra/deepseek/.dsh/.credentials.yaml');
  fs.writeFileSync(credential, 'synthetic-private-key');
  fs.writeFileSync(path.join(home, 'work.txt'), 'ordinary file');
  fs.writeFileSync(path.join(temporary, 'outside'), 'outside-home');
  fs.symlinkSync(credential, path.join(home, 'alias.txt'));
  fs.symlinkSync(path.join(home, '.hivra/deepseek'), path.join(home, 'alias-dir'));
  fs.symlinkSync(path.join(temporary, 'outside'), path.join(home, 'escape'));
  fs.linkSync(credential, path.join(home, 'hardlink'));
  fs.symlinkSync('/dev/zero', path.join(home, 'device'));
  const guard = createGuardedFiles(home);
  assert.equal(guard.read('work.txt', 512).content, 'ordinary file');
  assert.deepEqual(guard.write('work.txt', 'short'), { ok: true, path: 'work.txt', size: 5 });
  assert.equal(fs.readFileSync(path.join(home, 'work.txt'), 'utf8'), 'short');
  for (const name of ['.hivra/deepseek/.dsh/.credentials.yaml', 'alias.txt', 'alias-dir/.dsh/.credentials.yaml', 'escape', 'hardlink', 'device', '../outside']) {
    assert.throws(() => guard.read(name, 512), undefined, name);
    assert.throws(() => guard.write(name, 'do-not-write'), undefined, name);
  }
  for (const name of ['alias-dir', '.hivra/deepseek', '../']) assert.throws(() => guard.list(name));
  assert.deepEqual(guard.list('.').entries.map(e => e.name), ['.hivra', 'work.txt']);
  assert.deepEqual(guard.list('.hivra').entries, []);
  assert.equal(fs.readFileSync(credential, 'utf8'), 'synthetic-private-key');
  assert.equal(fs.readFileSync(path.join(temporary, 'outside'), 'utf8'), 'outside-home');
  assert.throws(() => guard.read('work.txt', 2), { code: 'HIVRA_FILE_SIZE' });
  assert.throws(() => guard.write('missing.txt', 'no create'), { code: 'ENOENT' });
  assert.equal(guard.inspectFile('removed/subdir/file.txt', true).exists, false);
  assert.throws(() => guard.inspectFile('alias-dir/removed/file.txt', true));
  assert.throws(() => guard.inspectFile('.hivra/deepseek/removed/file.txt', true));
  assert.throws(() => guard.inspectFile('../missing/file.txt', true));
});

test('a directory swap during traversal cannot redirect a write or read', { skip: process.platform !== 'linux' }, t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hivra-file-race-'));
  t.after(() => fs.rmSync(temporary, { recursive: true }));
  const home = path.join(temporary, 'home'); fs.mkdirSync(home);
  fs.mkdirSync(path.join(home, 'workspace')); fs.writeFileSync(path.join(home, 'workspace/file'), 'keep');
  const open = fs.openSync;
  let moved = false;
  t.mock.method(fs, 'openSync', function(filename, ...args) {
    const fd = open(filename, ...args);
    if (!moved && String(filename).endsWith('/workspace')) {
      moved = true;
      fs.renameSync(path.join(home, 'workspace'), path.join(temporary, 'moved'));
      fs.symlinkSync(path.join(temporary, 'moved'), path.join(home, 'workspace'));
    }
    return fd;
  });
  assert.throws(() => createGuardedFiles(home).write('workspace/file', 'overwrite'), { code: 'HIVRA_FILE_DENIED' });
  assert.equal(fs.readFileSync(path.join(temporary, 'moved/file'), 'utf8'), 'keep');
});
