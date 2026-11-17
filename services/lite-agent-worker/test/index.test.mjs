import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

const SECRET = 'test-lite-secret-with-at-least-32-characters';
const BASE = 'https://lite.example.test';
const MODELS = JSON.stringify([
  { id: 'primary', baseUrl: 'https://primary.example.test/v1', model: 'fast-model', keySecret: 'KEY_PRIMARY' },
  { id: 'fallback', baseUrl: 'https://fallback.example.test/v1', model: 'backup-model', keySecret: 'KEY_FALLBACK' },
]);

// Restated with node:crypto on purpose: the dashboard signs these the same way.
const sha = (text) => createHash('sha256').update(text).digest('hex');
const now = () => String(Math.floor(Date.now() / 1000));

function signed(account, method, path, body, { secret = SECRET, timestamp = now() } = {}) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const signature = createHmac('sha256', secret)
    .update(`lite|v1|${method}|${path}|${account}|${timestamp}|${sha(text)}`)
    .digest('hex');
  return {
    method,
    headers: {
      'content-type': 'application/json',
      'x-hivra-account': account,
      'x-hivra-timestamp': timestamp,
      'x-hivra-signature': signature,
    },
    ...(body === undefined ? {} : { body: text }),
  };
}

/** A fake OpenAI-compatible provider. `script(host, body)` returns {status, body}. */
async function worker(t, { script, bindings = {} } = {}) {
  const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const compatibilityDate = config.match(/^compatibility_date\s*=\s*"([\d-]+)"/m)[1];
  const calls = [];
  const options = convertV4MiniflareOptions({
    name: 'lite-agent',
    modules: true,
    script: readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8'),
    compatibilityDate,
    cf: false,
    bindings: {
      LITE_AGENT_SECRET: SECRET,
      LITE_MODELS: MODELS,
      KEY_PRIMARY: 'pk',
      KEY_FALLBACK: 'fk',
      LITE_MAX_AGENTS: '1',
      LITE_MAX_SESSIONS: '2',
      LITE_DAILY_MESSAGES: '2',
      ...bindings,
    },
    durableObjects: {
      LITE_AGENT: { className: 'LiteAgent', useSQLite: true },
      LITE_ACCOUNT: { className: 'LiteAccount', useSQLite: true },
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      const body = await request.json();
      calls.push({ host: url.host, auth: request.headers.get('authorization'), body });
      const result = script ? script(url.host, body, calls) : reply('Hello!');
      return new Response(JSON.stringify(result.body), { status: result.status ?? 200, headers: { 'content-type': 'application/json' } });
    },
    log: new Log(LogLevel.NONE),
  });
  const mf = new Miniflare({ ...options, telemetry: { enabled: false } });
  t.after(() => mf.dispose());
  await mf.ready;
  const call = async (account, method, path, body, opts) => {
    const response = await mf.dispatchFetch(`${BASE}${path}`, signed(account, method, path, body, opts));
    return { status: response.status, body: await response.json() };
  };
  return { mf, call, calls };
}

const reply = (content) => ({ body: { choices: [{ message: { role: 'assistant', content } }] } });

async function agentWithSession(call, account = 'user_alice') {
  const created = await call(account, 'POST', '/v1/agents', { name: 'Pip', persona: 'Cheerful.' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const agentId = created.body.agent.id;
  const session = await call(account, 'POST', `/v1/agents/${agentId}/sessions`, {});
  assert.equal(session.status, 201);
  return { agentId, sessionId: session.body.session.id };
}

test('refuses unsigned, wrongly signed and stale requests', async (t) => {
  const { mf, call } = await worker(t);
  const bare = await mf.dispatchFetch(`${BASE}/v1/me`);
  assert.equal(bare.status, 401);
  assert.equal((await call('user_alice', 'GET', '/v1/me', undefined, { secret: 'x'.repeat(40) })).status, 401);
  assert.equal((await call('user_alice', 'GET', '/v1/me', undefined, { timestamp: String(Math.floor(Date.now() / 1000) - 3600) })).status, 401);
  const ok = await call('user_alice', 'GET', '/v1/me');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.agents, []);
  assert.equal(ok.body.allowance.limit, 2);
  assert.equal(ok.body.modelsConfigured, true);
});

test('a body signed for one path cannot be replayed on another', async (t) => {
  const { mf } = await worker(t);
  const init = signed('user_alice', 'POST', '/v1/agents', { name: 'Pip' });
  const response = await mf.dispatchFetch(`${BASE}/v1/agents/x/sessions`, init);
  assert.equal(response.status, 401);
});

test('an account gets one agent, and only its owner can see it', async (t) => {
  const { call } = await worker(t);
  const { agentId } = await agentWithSession(call);
  const second = await call('user_alice', 'POST', '/v1/agents', { name: 'Two' });
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'agent_limit');
  assert.equal(second.body.limit, 1);

  const stranger = await call('user_mallory', 'GET', `/v1/agents/${agentId}`);
  assert.equal(stranger.status, 404);
  assert.equal(stranger.body.error, 'agent_not_found');
  const strangerDelete = await call('user_mallory', 'DELETE', `/v1/agents/${agentId}`);
  assert.equal(strangerDelete.status, 404);

  const mine = await call('user_alice', 'GET', `/v1/agents/${agentId}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.body.agent.name, 'Pip');
  assert.equal(mine.body.agent.persona, 'Cheerful.');
  assert.equal(mine.body.agent.sessions.length, 1);
});

test('a message gets a reply, keeps history and spends the free allowance', async (t) => {
  const { call, calls } = await worker(t);
  const { agentId, sessionId } = await agentWithSession(call);
  const sent = await call('user_alice', 'POST', `/v1/agents/${agentId}/sessions/${sessionId}/messages`, { content: 'Plan my week' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.reply.content, 'Hello!');
  assert.equal(sent.body.model, 'primary');
  assert.deepEqual({ used: sent.body.allowance.used, limit: sent.body.allowance.limit }, { used: 1, limit: 2 });
  assert.equal(calls[0].auth, 'Bearer pk');
  assert.match(calls[0].body.messages[0].content, /You are Pip/);
  assert.match(calls[0].body.messages[0].content, /Cheerful\./);

  const history = await call('user_alice', 'GET', `/v1/agents/${agentId}/sessions/${sessionId}`);
  assert.deepEqual(history.body.messages.map((m) => [m.role, m.content]), [['user', 'Plan my week'], ['assistant', 'Hello!']]);
  const view = await call('user_alice', 'GET', `/v1/agents/${agentId}`);
  assert.equal(view.body.agent.sessions[0].title, 'Plan my week');

  await call('user_alice', 'POST', `/v1/agents/${agentId}/sessions/${sessionId}/messages`, { content: 'Again' });
  const third = await call('user_alice', 'POST', `/v1/agents/${agentId}/sessions/${sessionId}/messages`, { content: 'Once more' });
  assert.equal(third.status, 429);
  assert.equal(third.body.error, 'daily_limit');
  assert.equal(third.body.allowance.used, 2);
});

test('the agent saves memory notes through the remember tool and sees them next time', async (t) => {
  const { call, calls } = await worker(t, {
    script: (_host, body) => {
      const last = body.messages.at(-1);
      if (last.role === 'user' && /name is/.test(last.content)) {
        return { body: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'remember', arguments: '{"note":"Their name is Ash."}' } }] } }] } };
      }
      return reply('Noted.');
    },
  });
  const { agentId, sessionId } = await agentWithSession(call);
  const sent = await call('user_alice', 'POST', `/v1/agents/${agentId}/sessions/${sessionId}/messages`, { content: 'My name is Ash' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.reply.content, 'Noted.');
  assert.equal(calls.length, 2, 'one call for the tool, one for the reply');
  assert.equal(calls[1].body.messages.at(-1).role, 'tool');

  const view = await call('user_alice', 'GET', `/v1/agents/${agentId}`);
  assert.deepEqual(view.body.agent.notes.map((n) => n.text), ['Their name is Ash.']);
  await call('user_alice', 'POST', `/v1/agents/${agentId}/sessions/${sessionId}/messages`, { content: 'hi' });
  assert.match(calls.at(-1).body.messages[0].content, /1\. Their name is Ash\./);

  const removed = await call('user_alice', 'PATCH', `/v1/agents/${agentId}`, { deleteNote: view.body.agent.notes[0].id });
  assert.deepEqual(removed.body.agent.notes, []);
});

test('falls back to the next model, and refunds the message when none answers', async (t) => {
  let primaryDown = true;
  let allDown = false;
  const { call } = await worker(t, {
    script: (host) => {
      if (allDown) return { status: 503, body: { error: 'down' } };
      if (host === 'primary.example.test' && primaryDown) return { status: 500, body: { error: 'boom' } };
      return reply(`from ${host}`);
    },
  });
  const { agentId, sessionId } = await agentWithSession(call);
  const sent = await call('user_alice', 'POST', `/v1/agents/${agentId}/sessions/${sessionId}/messages`, { content: 'hi' });
  assert.equal(sent.body.model, 'fallback');
  assert.equal(sent.body.reply.content, 'from fallback.example.test');

  allDown = true;
  const failed = await call('user_alice', 'POST', `/v1/agents/${agentId}/sessions/${sessionId}/messages`, { content: 'lost' });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error, 'model_unavailable');
  const me = await call('user_alice', 'GET', '/v1/me');
  assert.equal(me.body.allowance.used, 1, 'the failed message was given back');
  const history = await call('user_alice', 'GET', `/v1/agents/${agentId}/sessions/${sessionId}`);
  assert.equal(history.body.messages.length, 2, 'the failed message was not kept');
});

test("the owner's own key is used instead of the allowance and is never shown back", async (t) => {
  const { call, calls } = await worker(t, { bindings: { LITE_DAILY_MESSAGES: '0' } });
  const { agentId, sessionId } = await agentWithSession(call);
  const blocked = await call('user_alice', 'POST', `/v1/agents/${agentId}/sessions/${sessionId}/messages`, { content: 'hi' });
  assert.equal(blocked.status, 429);

  const badKey = await call('user_alice', 'PATCH', `/v1/agents/${agentId}`, { ownKey: { baseUrl: 'http://insecure.test/v1', model: 'm', apiKey: 'k' } });
  assert.equal(badKey.status, 400);
  const set = await call('user_alice', 'PATCH', `/v1/agents/${agentId}`, { ownKey: { baseUrl: 'https://own.example.test/v1/', model: 'my-model', apiKey: 'secret-own' } });
  assert.equal(set.status, 200);
  assert.equal(set.body.agent.usesOwnKey, true);
  assert.equal(set.body.agent.ownKeyModel, 'my-model');
  assert.ok(!JSON.stringify(set.body).includes('secret-own'));

  const sent = await call('user_alice', 'POST', `/v1/agents/${agentId}/sessions/${sessionId}/messages`, { content: 'hi' });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.allowance, null);
  assert.equal(calls.at(-1).host, 'own.example.test');
  assert.equal(calls.at(-1).auth, 'Bearer secret-own');
  assert.equal(calls.at(-1).body.model, 'my-model');
});

test('session limit, and deleting an agent frees the slot and its data', async (t) => {
  const { call } = await worker(t);
  const { agentId } = await agentWithSession(call);
  assert.equal((await call('user_alice', 'POST', `/v1/agents/${agentId}/sessions`, {})).status, 201);
  const third = await call('user_alice', 'POST', `/v1/agents/${agentId}/sessions`, {});
  assert.equal(third.status, 409);
  assert.equal(third.body.error, 'session_limit');

  assert.equal((await call('user_alice', 'DELETE', `/v1/agents/${agentId}`)).status, 200);
  assert.equal((await call('user_alice', 'GET', `/v1/agents/${agentId}`)).status, 404);
  const again = await call('user_alice', 'POST', '/v1/agents', { name: 'New' });
  assert.equal(again.status, 201);
});

test('validates input', async (t) => {
  const { call } = await worker(t);
  assert.equal((await call('user_alice', 'POST', '/v1/agents', { name: '' })).body.error, 'name_required');
  assert.equal((await call('user_alice', 'POST', '/v1/agents', { name: 'x'.repeat(61) })).body.error, 'name_too_long');
  const { agentId, sessionId } = await agentWithSession(call);
  const long = await call('user_alice', 'POST', `/v1/agents/${agentId}/sessions/${sessionId}/messages`, { content: 'x'.repeat(8001) });
  assert.equal(long.body.error, 'content_too_long');
  assert.equal((await call('user_alice', 'GET', '/v1/agents/not-an-id')).status, 404);
});
