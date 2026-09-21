import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectRuntimeDistributionBoundary } from './runtime-distribution-boundary.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('accepts the exact source-only runtime boundary', () => {
  const evidence = inspectRuntimeDistributionBoundary({ root });
  assert.equal(evidence.status, 'source-only-runtime-boundary-complete');
  assert.equal(evidence.sourceOnlyBoundaryApproved, true);
  assert.equal(evidence.releaseApproved, false);
  assert.deepEqual(evidence.gaps, []);
  assert.equal(evidence.summary.externalInputs, 12);
  assert.equal(evidence.summary.digestPinnedContainerInputs, 3);
  assert.equal(evidence.summary.embeddedExternalArtifacts, 0);
});

test('fails closed on a mutable image or embedded runtime artifact', (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'hivra-runtime-boundary-'));
  const fixture = path.join(parent, 'repo');
  mkdirSync(fixture);
  execFileSync('git', ['init', '--quiet', fixture]);
  execFileSync('git', ['-C', fixture, 'config', 'user.email', 'fixture@example.invalid']);
  execFileSync('git', ['-C', fixture, 'config', 'user.name', 'Fixture']);
  for (const relative of [
    'docs/release/runtime-distribution-boundary.json',
    'dashboard/provisioner/PROVENANCE.md',
    'services/browser-sidecar/Dockerfile',
  ]) {
    const target = path.join(fixture, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(root, relative), target);
  }
  execFileSync('git', ['-C', fixture, 'add', '-A']);
  execFileSync('git', ['-C', fixture, 'commit', '--quiet', '-m', 'fixture']);
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const dockerfile = path.join(fixture, 'services/browser-sidecar/Dockerfile');
  writeFileSync(dockerfile, readFileSync(dockerfile, 'utf8').replace(/@sha256:[0-9a-f]{64}/, ''));
  assert.throws(() => inspectRuntimeDistributionBoundary({ root: fixture }), /identity drifted|immutable digest/);

  cpSync(path.join(root, 'services/browser-sidecar/Dockerfile'), dockerfile);
  writeFileSync(path.join(fixture, 'runtime.img'), 'not a real image\n');
  execFileSync('git', ['-C', fixture, 'add', 'runtime.img']);
  assert.throws(() => inspectRuntimeDistributionBoundary({ root: fixture }), /embeds a third-party runtime/);
});
