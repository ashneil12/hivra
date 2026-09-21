import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bundleContract, verifyBundle, workingBundle } from './portable-bundle-immutability.mjs';

test('every deployed asset, including documentation, matches its immutable release manifest', () => {
  const input = workingBundle();
  assert.equal(verifyBundle(input).version, input.manifest.version);
});

test('a same-version provenance edit cannot invalidate already prepared computers silently', () => {
  const input = workingBundle();
  assert.throws(() => verifyBundle({ ...input, readAsset: name => name === 'PROVENANCE.md'
    ? Buffer.concat([input.readAsset(name), Buffer.from('\nStaged development note\n')]) : input.readAsset(name) }), /bytes changed/);
});

test('a code edit, missing asset or changed allowlist requires a new release manifest', () => {
  const input = workingBundle();
  assert.throws(() => verifyBundle({ ...input, readAsset: name => name === 'hivra-chat/server.js'
    ? Buffer.from('changed code') : input.readAsset(name) }), /bytes changed/);
  assert.throws(() => verifyBundle({ ...input, contractSource: input.contractSource.replace('  "PROVENANCE.md",\n', '') }), /bytes changed/);
  assert.throws(() => verifyBundle({ ...input, manifest: { ...input.manifest, version: '2099.01.01.1' } }), /bytes changed/);
});

test('contract parsing is declarative and does not evaluate code or allow path traversal', () => {
  const { contractSource } = workingBundle();
  for (const invalid of ['"../private"', '"/private"', 'process.env.SECRET', '"x//y"']) {
    assert.throws(() => bundleContract(contractSource.replace('"PROVENANCE.md"', invalid)), /Unsafe portable bundle path/);
  }
});
