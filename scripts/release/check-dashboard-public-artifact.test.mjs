import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { inspectDashboardArtifact } from './check-dashboard-public-artifact.mjs';

async function fixture() {
  return mkdtemp(join(tmpdir(), 'hivra-dashboard-artifact-'));
}

test('accepts a clean dashboard artifact and ignores build cache', async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, 'static'), { recursive: true });
    await mkdir(join(root, 'cache'), { recursive: true });
    await writeFile(join(root, 'static', 'app.js'), 'hosted opt-in loader');
    await writeFile(join(root, 'cache', 'stale.js'), '@fingerprintjs/fingerprintjs-pro');

    assert.deepEqual(await inspectDashboardArtifact([root]), {
      rootsChecked: 1,
      filesChecked: 1,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects a proprietary package payload without echoing its contents', async () => {
  const root = await fixture();
  try {
    await writeFile(
      join(root, 'chunk.js'),
      'prefix Fingerprint v3.12.9 - Copyright (c) FingerprintJS, Inc, 2026 (https://fingerprint.com) suffix',
    );
    await assert.rejects(
      inspectDashboardArtifact([root]),
      (error) => {
        assert.match(error.message, /Proprietary Fingerprint Pro package payload found/);
        assert.doesNotMatch(error.message, /prefix|suffix/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('does not let a nested directory named cache bypass artifact inspection', async () => {
  const root = await fixture();
  try {
    await mkdir(join(root, 'server', 'cache'), { recursive: true });
    await writeFile(
      join(root, 'server', 'cache', 'chunk.js'),
      'Fingerprint v3.12.9 - Copyright (c) FingerprintJS, Inc, 2026 (https://fingerprint.com)',
    );
    await assert.rejects(
      inspectDashboardArtifact([root]),
      /Proprietary Fingerprint Pro package payload found/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed when no build artifact exists', async () => {
  const root = await fixture();
  await rm(root, { recursive: true, force: true });
  await assert.rejects(inspectDashboardArtifact([root]), /No dashboard build artifact found/);
});
