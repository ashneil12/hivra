import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkerHarness } from './worker-test-harness.mjs';

async function fixture(t, handle) {
  const root = mkdtempSync(join(tmpdir(), 'hivra-harness-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'test'));
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'wrangler.toml'), 'compatibility_date = "2024-11-06"\n');
  writeFileSync(join(root, 'dist/index.js'), 'export default {};');
  let teardown;
  let disposed = false;
  const runtime = {
    Miniflare: class {
      constructor(options) { this.options = options; this.ready = Promise.resolve(); }
      async dispose() { disposed = true; }
    },
    convertV4MiniflareOptions: (options) => options,
    Log: class {}, LogLevel: { NONE: 0 }, Response,
  };
  const harness = await createWorkerHarness(
    { after(callback) { teardown = callback; } },
    pathToFileURL(join(root, 'test/index.test.mjs')), runtime, {}, handle,
  );
  return {
    ...harness,
    teardown: () => teardown(),
    disposed: () => disposed,
    request: () => harness.mf.options.outboundService(new Request('https://upstream.example.test/settle')),
  };
}

test('teardown drains delayed upstream assertions instead of reporting a false green', async (t) => {
  let finished = false;
  const harness = await fixture(t, async () => {
    await delay(30);
    finished = true;
    assert.fail('Deliberate delayed upstream assertion');
  });
  const pending = harness.request();
  await assert.rejects(harness.teardown(), (error) =>
    error instanceof AggregateError && error.errors.some((cause) => /Deliberate delayed/.test(cause.message)));
  assert.equal(finished, true);
  assert.equal(harness.disposed(), true);
  assert.equal((await pending).status, 599);
});

test('waitForCall resolves after the handler assertions, not just request arrival', async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const harness = await fixture(t, async () => {
    started.resolve();
    await release.promise;
    return new Response('ok');
  });
  const pending = harness.request();
  await started.promise;
  const observed = harness.waitForCall(() => true);
  try {
    assert.equal(await Promise.race([observed.then(() => 'early'), delay(10).then(() => 'pending')]), 'pending');
  } finally {
    release.resolve();
    await pending;
    await harness.teardown();
  }
  assert.equal((await observed).url, 'https://upstream.example.test/settle');
});

test('successful pending handlers are drained and runtime disposal always runs', async (t) => {
  let finished = false;
  const harness = await fixture(t, async () => {
    await delay(10);
    finished = true;
    return new Response('ok');
  });
  const pending = harness.request();
  await harness.teardown();
  assert.equal(finished, true);
  assert.equal(harness.disposed(), true);
  await pending;
});

test('a stuck upstream fails with a bounded deadline and still disposes the runtime', async (t) => {
  const release = Promise.withResolvers();
  const harness = await fixture(t, () => release.promise);
  const pending = harness.request();
  try {
    await assert.rejects(harness.teardown(), (error) =>
      error instanceof AggregateError && error.errors.some((cause) => /within 5 seconds/.test(cause.message)));
    assert.equal(harness.disposed(), true);
  } finally {
    release.resolve(new Response('ok'));
    await pending;
  }
});
