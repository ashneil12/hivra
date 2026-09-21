import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import * as runtime from 'miniflare';
import { createWorkerHarness } from '../../../scripts/release/worker-test-harness.mjs';

const { Response } = runtime;
const bindings = { POSTHOG_API_HOST: 'ingest.example.test', POSTHOG_ASSET_HOST: 'assets.example.test' };
const create = (t, handle, env = bindings) => createWorkerHarness(t, import.meta.url, runtime, env, handle);

test('keeps the Worker toolchain on the reviewed sharp security floor', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.packages['node_modules/sharp']?.version, '0.35.4');
  assert.equal(lock.packages['node_modules/miniflare']?.version, '5.20260918.0-alpha');
  assert.equal(lock.packages['node_modules/wrangler']?.version, '4.135.0');
});

test('ingestion preserves method, body and query while removing first-party cookies', async (t) => {
  const { mf, calls } = await create(t, (call) => {
    assert.equal(call.url, 'https://ingest.example.test/i/v0/e/?v=3');
    assert.equal(call.method, 'POST');
    assert.equal(call.body, '{"event":"smoke"}');
    assert.equal(call.headers.cookie, undefined);
    assert.equal(call.headers.host, 'ingest.example.test');
    assert.equal(call.headers['content-type'], 'application/json');
    return new Response('accepted', { status: 202 });
  });
  const response = await mf.dispatchFetch('https://proxy.example.test/i/v0/e/?v=3', {
    method: 'POST',
    headers: { cookie: 'session=fake-test-cookie', 'content-type': 'application/json' },
    body: '{"event":"smoke"}',
  });
  assert.equal(response.status, 202);
  assert.equal(await response.text(), 'accepted');
  assert.equal(calls.length, 1);
});

test('unset hosts use PostHog defaults, still intercepted without external requests', async (t) => {
  const { mf, calls } = await create(t, () => new Response('ok'), {});
  await (await mf.dispatchFetch('https://proxy.example.test/decide/?v=3')).text();
  await (await mf.dispatchFetch('https://proxy.example.test/static/array.js')).text();
  assert.deepEqual(calls.map((call) => new URL(call.url).hostname), [
    'us.i.posthog.com', 'us-assets.i.posthog.com',
  ]);
});

test('static assets use the asset host, populate the edge cache and reuse it', async (t) => {
  const { mf, calls } = await create(t, (call) => {
    assert.equal(call.url, 'https://assets.example.test/static/array.js?v=42');
    assert.equal(call.headers.cookie, undefined);
    return new Response('asset', { headers: { 'cache-control': 'public, max-age=3600' } });
  });
  const url = 'https://proxy.example.test/static/array.js?v=42';
  assert.equal(await (await mf.dispatchFetch(url, { headers: { cookie: 'fake=value' } })).text(), 'asset');
  const cache = (await mf.getCaches()).default;
  const deadline = Date.now() + 2000;
  let cached;
  do {
    cached = await cache.match(url);
    if (cached) break;
    await delay(20);
  } while (Date.now() < deadline);
  assert.ok(cached, 'Background cache.put must finish within 2 seconds');
  assert.equal(await cached.text(), 'asset');
  assert.equal(await (await mf.dispatchFetch(url)).text(), 'asset');
  assert.equal(calls.length, 1);
});

test('asset failures are relayed and not cached', async (t) => {
  const { mf, calls } = await create(t, () => new Response('unavailable', { status: 503 }));
  const url = 'https://proxy.example.test/static/missing.js';
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await mf.dispatchFetch(url);
    assert.equal(response.status, 503);
    assert.equal(await response.text(), 'unavailable');
  }
  assert.equal(calls.length, 2);
});
