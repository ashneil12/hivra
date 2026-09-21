'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the entire npm closure is immutable and registry-only', () => {
  const recipeRoot = path.join(__dirname, '../../provisioner/deepseek-harness');
  const recipe = JSON.parse(fs.readFileSync(path.join(recipeRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(recipeRoot, 'package-lock.json'), 'utf8'));
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(recipe.dependencies, { '@deepseek-ai/dsh': '0.1.2-alpha.2' });
  assert.deepEqual(lock.packages[''].dependencies, recipe.dependencies);
  for (const [name, dependency] of Object.entries(lock.packages)) {
    if (!name) continue;
    assert.equal(new URL(dependency.resolved).origin, 'https://registry.npmjs.org', name);
    assert.match(dependency.integrity, /^sha512-[A-Za-z0-9+/]+=*$/, name);
    assert.equal(dependency.link, undefined, name);
  }
  const top = lock.packages['node_modules/@deepseek-ai/dsh'];
  assert.equal(top.version, '0.1.2-alpha.2');
  assert.equal(top.integrity, 'sha512-4TvTC5kRKlgtSU2UTBv+cID9a2Z+6+m6mpvjXWJfVzuTkflCff6s4MsQpFJTCmwFh/k7zNWe7qFXcLYMV/5VvA==');
});
