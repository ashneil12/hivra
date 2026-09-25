import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import * as runtime from 'miniflare';
import { createWorkerHarness } from '../../../scripts/release/worker-test-harness.mjs';

const { Response } = runtime;
const base = 'https://control.example.test';
const authorize = `${base}/api/managed-venice/internal/authorize`;
const settle = `${base}/api/managed-venice/internal/settle`;
const bindings = { VERCEL_BASE_URL: base, MANAGED_VENICE_INTERNAL_SECRET: 'test-internal-secret' };
const auth = {
  referenceId: 'reservation-test', upstreamKey: 'test-upstream-key',
  upstreamUrl: 'https://model.example.test/v1/chat/completions', walletType: 'llm',
  userId: 'test-user', proxyKeyId: 'test-proxy', model: 'test-model',
};
const usage = { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 };
const body = { model: 'test-model', messages: [{ role: 'user', content: 'hello' }] };
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'content-type': 'application/json' },
});
const create = (t, handle, env = bindings) => createWorkerHarness(t, import.meta.url, runtime, env, handle);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The Worker chooses each hold's reference (a fresh UUID) before authorizing.
function assertAuthorizeBody(call, expectedBody) {
  const { referenceId, ...rest } = JSON.parse(call.body);
  assert.match(referenceId, UUID);
  assert.deepEqual(rest, { plaintextKey: 'test-client-key', body: expectedBody });
  return referenceId;
}
const chat = (mf, value = body) => mf.dispatchFetch('https://proxy.example.test/v1/chat/completions', {
  method: 'POST', headers: { authorization: 'Bearer test-client-key', 'content-type': 'application/json' },
  body: JSON.stringify(value),
});

test('keeps the Worker toolchain on the reviewed sharp security floor', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.packages['node_modules/sharp']?.version, '0.35.4');
  assert.equal(lock.packages['node_modules/miniflare']?.version, '5.20260918.0-alpha');
  assert.equal(lock.packages['node_modules/wrangler']?.version, '4.135.0');
});

function chatUpstream(upstream, expectedBody = body, { checkReference = true } = {}) {
  return (call) => {
    assert.equal(call.method, 'POST');
    if (call.url === authorize) {
      assert.equal(call.headers['x-managed-venice-internal-secret'], 'test-internal-secret');
      assert.equal(call.headers.authorization, undefined);
      if (checkReference) assertAuthorizeBody(call, expectedBody);
      return json(auth);
    }
    if (call.url === auth.upstreamUrl) {
      assert.equal(call.headers.authorization, 'Bearer test-upstream-key');
      assert.equal(call.headers['x-managed-venice-internal-secret'], undefined);
      const expectedUpstream = expectedBody.stream === true
        ? { ...expectedBody, stream_options: { ...expectedBody.stream_options, include_usage: true } }
        : expectedBody;
      assert.deepEqual(JSON.parse(call.body), expectedUpstream);
      return upstream();
    }
    assert.equal(call.url, settle, 'No unapproved upstream destination');
    assert.equal(call.headers['x-managed-venice-internal-secret'], 'test-internal-secret');
    assert.equal(call.headers.authorization, undefined);
    return json({ ok: true });
  };
}

test('missing configuration fails closed; configured health makes no upstream calls', async (t) => {
  const bad = await create(t, () => assert.fail('No outbound request expected'), {});
  assert.equal((await bad.mf.dispatchFetch('https://proxy.example.test/health')).status, 500);
  const good = await create(t, () => assert.fail('No outbound request expected'));
  assert.equal(await (await good.mf.dispatchFetch('https://proxy.example.test/health')).text(), 'ok');
  assert.equal(bad.calls.length + good.calls.length, 0);
});

test('non-chat requests retain method, body, query and client key without leaking the internal secret', async (t) => {
  const { mf, calls } = await create(t, (call) => {
    assert.equal(call.url, `${base}/api/managed-venice/v1/embeddings?format=json`);
    assert.equal(call.method, 'POST');
    assert.equal(call.body, '{"input":"hello"}');
    assert.equal(call.headers.authorization, 'Bearer test-client-key');
    assert.equal(call.headers['x-managed-venice-internal-secret'], undefined);
    return new Response(null, { status: 307, headers: { location: 'https://elsewhere.example.test/' } });
  });
  const response = await mf.dispatchFetch('https://proxy.example.test/api/managed-venice/v1/embeddings?format=json', {
    method: 'POST', headers: { authorization: 'Bearer test-client-key' },
    body: '{"input":"hello"}', redirect: 'manual',
  });
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'), 'https://elsewhere.example.test/');
  assert.equal(calls.length, 1);
});

test('invalid JSON is rejected before authorization', async (t) => {
  const { mf, calls } = await create(t, () => assert.fail('No outbound request expected'));
  const response = await mf.dispatchFetch('https://proxy.example.test/v1/chat/completions', {
    method: 'POST', body: '{',
  });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

for (const status of [401, 402, 403]) {
  test(`authorization ${status} never calls a model or settles a nonexistent reservation`, async (t) => {
    const { mf, calls } = await create(t, (call) => {
      assert.equal(call.url, authorize);
      return json({ error: 'denied' }, status);
    });
    const response = await chat(mf);
    assert.equal(response.status, status === 403 ? 502 : status);
    const payload = await response.json();
    if (status === 403) assert.equal(payload.error.code, 'proxy_misconfigured');
    else assert.deepEqual(payload, { error: 'denied' });
    assert.equal(calls.length, 1);
  });
}

test('non-stream chat returns model output and sends exact usage and reservation identity once', async (t) => {
  const completion = { choices: [{ message: { content: 'hello' } }], usage };
  const harness = await create(t, chatUpstream(() => json(completion)));
  assert.deepEqual(await (await chat(harness.mf)).json(), completion);
  const settlement = await harness.waitForCall((call) => call.url === settle);
  assert.deepEqual(JSON.parse(settlement.body), {
    outcome: 'settle', userId: auth.userId, proxyKeyId: auth.proxyKeyId,
    walletType: auth.walletType, referenceId: auth.referenceId, model: auth.model,
    upstreamStatus: 200, usage, cause: 'completed',
  });
  assert.deepEqual(harness.calls.map((call) => call.url), [authorize, auth.upstreamUrl, settle]);
});

test('stream chat preserves SSE bytes, requests usage and settles the final usage frame', async (t) => {
  const streamBody = { ...body, stream: true, stream_options: { include_usage: false, custom: true } };
  const sse = `data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: ${JSON.stringify({ usage })}\n\ndata: [DONE]\n\n`;
  const harness = await create(t, chatUpstream(() => new Response(sse, {
    headers: { 'content-type': 'text/event-stream' },
  }), streamBody));
  const response = await chat(harness.mf, streamBody);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(await response.text(), sse);
  const settlement = JSON.parse((await harness.waitForCall((call) => call.url === settle)).body);
  assert.equal(settlement.outcome, 'settle');
  assert.equal(settlement.referenceId, auth.referenceId);
  assert.deepEqual(settlement.usage, usage);
  assert.equal(harness.calls.filter((call) => call.url === settle).length, 1);
});

for (const streaming of [false, true]) {
  test(`upstream error releases the exact reservation before relaying (${streaming ? 'stream' : 'JSON'})`, async (t) => {
    const requestBody = { ...body, stream: streaming };
    const harness = await create(t, chatUpstream(() => json({ error: 'unavailable' }, 503), requestBody));
    const response = await chat(harness.mf, requestBody);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'unavailable' });
    const release = await harness.waitForCall((call) => call.url === settle);
    assert.deepEqual(JSON.parse(release.body), {
      outcome: 'release', userId: auth.userId, proxyKeyId: auth.proxyKeyId, referenceId: auth.referenceId,
      cause: 'upstream_non_2xx', upstreamStatus: 503,
    });
    assert.equal(harness.calls.filter((call) => call.url === settle).length, 1);
  });
}

const sseFrame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const contentFrame = (text) => sseFrame({ choices: [{ delta: { content: text } }] });

// Venice sends one frame every `everyMs`, then ends.
function pacedSse(frames, everyMs = 20) {
  let sent = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, everyMs));
      if (sent < frames.length) controller.enqueue(new TextEncoder().encode(frames[sent++]));
      else controller.close();
    },
  });
  return { response: new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), sent: () => sent };
}

// A box on a raw socket (a fetch client may keep reading the body to reuse its
// connection), which disconnects once `leave(seen)` says so.
function boxThatLeaves(url, streamBody, leave) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: 'POST', headers: { authorization: 'Bearer test-client-key', 'content-type': 'application/json' },
    }, (response) => {
      let seen = '';
      response.on('data', (chunk) => {
        seen += chunk.toString();
        if (leave(seen)) {
          request.destroy();
          resolve();
        }
      });
      response.on('error', () => undefined);
    });
    request.on('error', (error) => (error.code === 'ECONNRESET' ? undefined : reject(error)));
    request.end(JSON.stringify(streamBody));
  });
}

// Security review 2026-09 (#167 second review, HIGH): the Worker stopped
// reading Venice when the box disconnected and charged the output it had
// forwarded, so a reasoning model's hidden thinking was never paid for. It now
// keeps reading Venice, without forwarding, to the usage frame.
test('a box that disconnects mid-stream: the Worker reads Venice to its usage frame and settles the exact usage', async (t) => {
  const streamBody = { ...body, stream: true };
  const finalUsage = { prompt_tokens: 12, completion_tokens: 20_003, total_tokens: 20_015 };
  const upstream = pacedSse([
    ...Array.from({ length: 20 }, () => contentFrame('abcd')),
    sseFrame({ choices: [], usage: finalUsage }),
    'data: [DONE]\n\n',
  ]);
  const harness = await create(t, chatUpstream(() => upstream.response, streamBody, { checkReference: false }));
  const url = new URL('/v1/chat/completions', await harness.mf.ready);
  await boxThatLeaves(url, streamBody, (seen) => (seen.match(/"content"/g) ?? []).length >= 3);
  const settlement = JSON.parse((await harness.waitForCall((call) => call.url === settle)).body);
  assert.equal(settlement.outcome, 'settle');
  assert.equal(settlement.referenceId, auth.referenceId);
  assert.deepEqual(settlement.usage, finalUsage);
  assert.equal(settlement.cause, 'client_cancelled');
  assert.equal(settlement.observedOutputTokens, undefined);
  assert.ok(upstream.sent() >= 21, `Venice sent ${upstream.sent()} frames`);
  assert.equal(harness.calls.filter((call) => call.url === settle).length, 1);
});

test('a box that disconnects from a stream Venice ends without usage is settled with every token read', async (t) => {
  const streamBody = { ...body, stream: true };
  const upstream = pacedSse(Array.from({ length: 30 }, () => contentFrame('abcd')), 10);
  const harness = await create(t, chatUpstream(() => upstream.response, streamBody, { checkReference: false }));
  const url = new URL('/v1/chat/completions', await harness.mf.ready);
  await boxThatLeaves(url, streamBody, (seen) => (seen.match(/"content"/g) ?? []).length >= 3);
  const settlement = JSON.parse((await harness.waitForCall((call) => call.url === settle)).body);
  assert.equal(settlement.usage, null);
  assert.equal(settlement.cause, 'client_cancelled');
  assert.equal(settlement.observedOutputTokens, 30);
  assert.equal(harness.calls.filter((call) => call.url === settle).length, 1);
});

// #167 second review: the wait for Venice's headers ran in the request
// context, so a box that left before Venice answered could leave the hold for
// the sweep's day-late estimate.
test('a box that disconnects before Venice answers still has its hold settled with the exact usage', async (t) => {
  const streamBody = { ...body, stream: true };
  const finalUsage = { prompt_tokens: 12, completion_tokens: 40, total_tokens: 52 };
  const upstream = chatUpstream(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return new Response(`${contentFrame('late')}${sseFrame({ choices: [], usage: finalUsage })}data: [DONE]\n\n`, {
      headers: { 'content-type': 'text/event-stream' },
    });
  }, streamBody, { checkReference: false });
  let upstreamCalled;
  const reached = new Promise((resolve) => (upstreamCalled = resolve));
  const harness = await create(t, (call) => {
    if (call.url === auth.upstreamUrl) upstreamCalled();
    return upstream(call);
  });
  const url = new URL('/v1/chat/completions', await harness.mf.ready);
  const request = http.request(url, {
    method: 'POST', headers: { authorization: 'Bearer test-client-key', 'content-type': 'application/json' },
  });
  request.on('error', () => undefined);
  request.end(JSON.stringify(streamBody));
  await reached;
  request.destroy();
  const settlement = JSON.parse((await harness.waitForCall((call) => call.url === settle)).body);
  assert.equal(settlement.outcome, 'settle');
  assert.deepEqual(settlement.usage, finalUsage);
});

test('a stream that ends without a usage frame is settled with the output it forwarded', async (t) => {
  const streamBody = { ...body, stream: true };
  const sse = `data: {"choices":[{"delta":{"content":"abcdabcd"}}]}\n\ndata: [DONE]\n\n`;
  const harness = await create(t, chatUpstream(() => new Response(sse, {
    headers: { 'content-type': 'text/event-stream' },
  }), streamBody, { checkReference: false }));
  assert.equal(await (await chat(harness.mf, streamBody)).text(), sse);
  const settlement = JSON.parse((await harness.waitForCall((call) => call.url === settle)).body);
  assert.equal(settlement.usage, null);
  assert.equal(settlement.cause, 'completed');
  assert.equal(settlement.observedOutputTokens, 2);
});

// #167 second review: UTF-8 size / 4 counted batched CJK at 0.75 of a token.
test('a usage-less stream counts every non-ASCII character as a token', async (t) => {
  const streamBody = { ...body, stream: true };
  const sse = `${contentFrame('日本語の文章です')}${contentFrame('abcdabcd')}data: [DONE]\n\n`;
  const harness = await create(t, chatUpstream(() => new Response(sse, {
    headers: { 'content-type': 'text/event-stream' },
  }), streamBody, { checkReference: false }));
  assert.equal(await (await chat(harness.mf, streamBody)).text(), sse);
  const settlement = JSON.parse((await harness.waitForCall((call) => call.url === settle)).body);
  assert.equal(settlement.usage, null);
  assert.equal(settlement.observedOutputTokens, 10);
});

// #167 review: callSettle ignored a non-2xx settle and never retried, so the
// hold waited a day for the sweep.
test('a settle Vercel fails is retried until it lands', async (t) => {
  const completion = { choices: [{ message: { content: 'hello' } }], usage };
  let settles = 0;
  const upstream = chatUpstream(() => json(completion), body, { checkReference: false });
  const harness = await create(t, (call) => {
    if (call.url !== settle) return upstream(call);
    settles += 1;
    return settles === 1 ? json({ error: 'busy' }, 503) : json({ ok: true });
  });
  assert.deepEqual(await (await chat(harness.mf)).json(), completion);
  await harness.waitForCall((call) => call.url === settle && settles === 2);
  const attempts = harness.calls.filter((call) => call.url === settle).map((call) => JSON.parse(call.body));
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
});

// #167 review: a Worker that lost the authorize response left a hold for a
// request it never sent, and the sweep charged it once the hold expired.
for (const [label, respond] of [
  ['a 5xx', () => json({ error: 'function timed out' }, 504)],
  ['an unreadable body', () => new Response('not json', { status: 200 })],
]) {
  test(`authorize answering ${label} releases the hold by the Worker's own reference`, async (t) => {
    let chosen;
    const harness = await create(t, (call) => {
      if (call.url === authorize) {
        chosen = assertAuthorizeBody(call, body);
        return respond();
      }
      assert.equal(call.url, settle, 'No model call after a failed authorize');
      return json({ ok: true, released: true });
    });
    const response = await chat(harness.mf);
    assert.equal(response.status, 502);
    const release = JSON.parse((await harness.waitForCall((call) => call.url === settle)).body);
    assert.equal(release.outcome, 'release');
    assert.equal(release.referenceId, chosen);
    assert.equal(release.userId, undefined);
  });
}
