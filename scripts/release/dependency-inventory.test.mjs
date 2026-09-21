import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkLock, generateInventory, normalizeBom, parseInput } from './dependency-inventory.mjs';

function input() {
  const manifest = { name: 'inventory-fixture', version: '1.0.0', dependencies: { example: '1.0.0' } };
  return { manifest, lock: { name: manifest.name, version: manifest.version, lockfileVersion: 3,
    packages: { '': { ...manifest }, 'node_modules/example': { version: '1.0.0',
      resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz', license: 'MIT' } } } };
}

function fixture(t) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'hivra-inventory-test-'));
  const root = path.join(temporary, 'checkout');
  mkdirSync(root);
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root]);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  const write = (relative, value) => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const commit = () => {
    git('add', 'app/package.json', 'app/package-lock.json');
    git('-c', 'user.name=Inventory Fixture', '-c', 'user.email=inventory@example.invalid',
      '-c', 'core.hooksPath=/dev/null', 'commit', '--no-gpg-sign', '--quiet', '-m', 'fixture');
  };
  return { temporary, root, write, git, commit, output: path.join(temporary, 'evidence') };
}

test('input errors do not print source data', () => {
  assert.throws(() => parseInput('{"secret":"private-fixture-value'), (error) => {
    assert.doesNotMatch(error.message, /private-fixture-value/);
    return /valid JSON/.test(error.message);
  });
});

test('root identity and dependency declarations must match the lock', () => {
  const { manifest, lock } = input();
  assert.doesNotThrow(() => checkLock(manifest, lock));
  assert.throws(() => checkLock({ ...manifest, name: 'other' }, lock), /identity disagree/);
  assert.throws(() => checkLock({ ...manifest, dependencies: { example: '2.0.0' } }, lock), /declarations disagree/);
});

test('legacy, workspace and linked dependencies are not silently omitted', () => {
  const { manifest, lock } = input();
  assert.throws(() => checkLock(manifest, { ...lock, lockfileVersion: 1 }), /versions 2 and 3/);
  assert.throws(() => checkLock({ ...manifest, workspaces: ['packages/*'] }, lock), /separate inventory adapter/);
  lock.packages['node_modules/example'].link = true;
  assert.throws(() => checkLock(manifest, lock), /separate inventory adapter/);
});

for (const source of [
  'https://user:private-fixture-value@registry.npmjs.org/example.tgz',
  'https://registry.npmjs.org/example.tgz?token=private-fixture-value',
  'https://registry.npmjs.org/example.tgz#private-fixture-value',
  'http://registry.npmjs.org/example.tgz',
  'https://private.example.invalid/example.tgz',
  'file:../../private-fixture-value',
]) {
  test(`unapproved dependency source is refused (${new URL(source).protocol})`, () => {
    const { manifest, lock } = input();
    lock.packages['node_modules/example'].resolved = source;
    assert.throws(() => checkLock(manifest, lock), (error) => {
      assert.doesNotMatch(error.message, /private-fixture-value|private\.example/);
      return /Unsupported dependency source/.test(error.message);
    });
  });
}

test('normalization removes only volatile fields and preserves the actual dependency graph', () => {
  const original = { bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: 'urn:uuid:temporary',
    metadata: { timestamp: 'today', component: { name: 'app' }, tools: [{ version: '10.9.8' }] },
    components: [{ name: 'example', hashes: [{ content: 'abc' }], licenses: [{ license: { id: 'MIT' } }] }],
    dependencies: [{ ref: 'app', dependsOn: ['example'] }] };
  const bom = normalizeBom(original);
  assert.equal(bom.serialNumber, undefined);
  assert.equal(bom.metadata.timestamp, undefined);
  assert.deepEqual(bom.components, original.components);
  assert.deepEqual(bom.dependencies, original.dependencies);
  assert.deepEqual(bom.metadata.tools, original.metadata.tools);
  assert.equal(original.serialNumber, 'urn:uuid:temporary');
  assert.throws(() => normalizeBom({}), /expected CycloneDX/);
});

test('actual offline npm creates stable evidence without installed packages, lifecycle scripts or user config', (t) => {
  const f = fixture(t);
  const { manifest, lock } = input();
  manifest.scripts = { preinstall: 'touch SCRIPT_MUST_NOT_RUN', prepare: 'touch SCRIPT_MUST_NOT_RUN' };
  lock.packages['node_modules/example'].hasInstallScript = true;
  f.write('app/package.json', manifest);
  f.write('app/package-lock.json', lock);
  f.write('app/.npmrc', 'registry=https://private-fixture-value.invalid\n');
  f.write('app/node_modules/example/package.json', { name: 'must-not-be-read', version: '99.0.0' });
  f.write('ignored/package.json', { name: 'untracked-secret', version: '1.0.0' });
  f.commit();
  const first = generateInventory({ root: f.root, output: f.output });
  const secondOutput = path.join(f.temporary, 'second');
  const second = generateInventory({ root: f.root, output: secondOutput });
  assert.deepEqual(first, second);
  assert.equal(first.status, 'inventory-only');
  assert.equal(first.releaseApproved, false);
  assert.equal(first.components.length, 1);
  assert.equal(first.components[0].dependencyComponents, 1);
  assert.deepEqual(first.components[0].declaredLicenseCounts, { MIT: 1 });
  assert.ok(first.gaps.some((gap) => gap.code === 'root-license-missing'));
  const artifact = first.components[0].bom.path;
  const bytes = readFileSync(path.join(f.output, artifact));
  assert.deepEqual(bytes, readFileSync(path.join(secondOutput, artifact)));
  assert.doesNotMatch(bytes.toString(), /private-fixture-value|must-not-be-read|untracked-secret/);
  assert.equal(existsSync(path.join(f.root, 'app', 'SCRIPT_MUST_NOT_RUN')), false);
  assert.equal(f.git('status', '--porcelain', '--untracked-files=no').toString(), '');
  assert.throws(() => generateInventory({ root: f.root, output: f.output }), /already exists/);
  assert.deepEqual(bytes, readFileSync(path.join(f.output, artifact)));
});

test('missing tracked lockfiles and undeclared dependency licenses remain explicit gaps', (t) => {
  const f = fixture(t);
  const { manifest, lock } = input();
  delete lock.packages['node_modules/example'].license;
  f.write('app/package.json', manifest);
  f.write('app/package-lock.json', lock);
  f.write('worker/package.json', { name: 'worker', version: '1.0.0', devDependencies: { wrangler: '^3' } });
  f.write('worker/package-lock.json', lock); // Untracked lock cannot silently supply release evidence.
  f.git('add', 'worker/package.json');
  f.commit();
  const report = generateInventory({ root: f.root, output: f.output });
  assert.equal(report.components[1].coverage, 'missing-lockfile');
  assert.equal(report.components[1].bom, null);
  assert.ok(report.gaps.some((gap) => gap.code === 'lockfile-missing' && gap.path === 'worker/package.json'));
  assert.deepEqual(report.components[0].missingLicenses, [{ name: 'example', version: '1.0.0' }]);
  assert.equal(report.releaseApproved, false);
});

test('an npm graph failure publishes no partial evidence or raw tool output', (t) => {
  const f = fixture(t);
  const { manifest, lock } = input();
  delete lock.packages['node_modules/example'];
  f.write('app/package.json', manifest);
  f.write('app/package-lock.json', lock);
  f.commit();
  assert.throws(() => generateInventory({ root: f.root, output: f.output }), /Offline npm SBOM generation failed/);
  assert.equal(existsSync(f.output), false);
});

test('symlinked package inputs cannot read outside the selected checkout', (t) => {
  const f = fixture(t);
  const { manifest, lock } = input();
  writeFileSync(path.join(f.temporary, 'external.json'), JSON.stringify(manifest));
  f.write('app/package-lock.json', lock);
  symlinkSync(path.join(f.temporary, 'external.json'), path.join(f.root, 'app/package.json'));
  f.commit();
  assert.throws(() => generateInventory({ root: f.root, output: f.output }), /regular files inside/);
  assert.equal(existsSync(f.output), false);
  assert.ok(readdirSync(f.temporary).includes('external.json'));
});
