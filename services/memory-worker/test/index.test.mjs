import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

const SECRET = 'test-memory-secret-with-at-least-32-characters';
const BASE = 'https://memory.example.test';
const sha = (text) => createHash('sha256').update(text).digest('hex');

function signed(account, method, path, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', SECRET)
    .update(`memory|v1|${method}|${path}|${account}|${timestamp}|${sha(text)}`)
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

/** A stand-in embedder: each word lights up a few fixed dimensions, so shared words mean closer vectors. */
function fakeVector(text) {
  const vector = new Array(64).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    const digest = createHash('sha256').update(word).digest();
    vector[digest[0] % 64] += 1;
    vector[digest[1] % 64] += 0.5;
  }
  return vector;
}

async function worker(t, { embeddings = true, bindings = {} } = {}) {
  const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const compatibilityDate = config.match(/^compatibility_date\s*=\s*"([\d-]+)"/m)[1];
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: 'memory',
      modules: true,
      script: readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8'),
      compatibilityDate,
      cf: false,
      bindings: {
        MEMORY_SECRET: SECRET,
        MEMORY_MAX_ITEMS: '5',
        MEMORY_MAX_TEXT: '300',
        MEMORY_RATE_PER_MINUTE: '1000',
        MEMORY_REPLACE_ABOVE: '0.97',
        ...(embeddings ? { MEMORY_EMBED_URL: 'https://embed.example.test/v1/embeddings' } : {}),
        ...bindings,
      },
      durableObjects: { MEMORY: { className: 'MemoryStore', useSQLite: true } },
      outboundService: async (request) => {
        const { input } = await request.json();
        return Response.json({ data: input.map((text) => ({ embedding: fakeVector(text) })) });
      },
      log: new Log(LogLevel.NONE),
    }),
  );
  t.after(() => mf.dispose());
  const admin = (account, method, path, body) => mf.dispatchFetch(`${BASE}${path}`, signed(account, method, path, body));
  const newKey = async (account, options = {}) => (await (await admin(account, 'POST', '/admin/keys', { label: 'tester', ...options })).json()).key;
  const call = (key, method, path, body) =>
    mf.dispatchFetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const rpc = async (key, method, params, id = 1) =>
    (await call(key, 'POST', '/mcp', { jsonrpc: '2.0', id, method, params })).json();
  return { mf, admin, newKey, call, rpc };
}

test('a memory saved by one agent is found by another, by meaning or keyword', async (t) => {
  const { newKey, call } = await worker(t);
  const claude = await newKey('ash', { label: 'claude-code' });
  const hermes = await newKey('ash', { label: 'hermes' });
  const saved = await (await call(claude, 'POST', '/v1/remember', { text: 'Ash prefers pnpm over npm for every JavaScript project', kind: 'preference' })).json();
  assert.equal(saved.ok, true);
  assert.equal(saved.meaningSearch, true);
  await call(claude, 'POST', '/v1/remember', { text: 'The staging database lives in Frankfurt', kind: 'fact' });

  const found = await (await call(hermes, 'POST', '/v1/recall', { query: 'which package manager for javascript' })).json();
  assert.match(found.results[0].text, /pnpm/);
  assert.equal(found.results[0].savedBy, 'claude-code');
});

test('search still works on keywords when embeddings are unavailable', async (t) => {
  const { newKey, call } = await worker(t, { embeddings: false });
  const key = await newKey('ash');
  const saved = await (await call(key, 'POST', '/v1/remember', { text: 'Deploys go out on Thursdays after the standup' })).json();
  assert.equal(saved.meaningSearch, false);
  const found = await (await call(key, 'POST', '/v1/recall', { query: 'when do deploys happen' })).json();
  assert.match(found.results[0].text, /Thursdays/);
});

test('one person never sees another person\'s memory', async (t) => {
  const { newKey, call } = await worker(t);
  const ash = await newKey('ash');
  const sam = await newKey('sam');
  await call(ash, 'POST', '/v1/remember', { text: 'Ash keeps the launch plan in the drawer' });
  const found = await (await call(sam, 'POST', '/v1/recall', { query: 'launch plan drawer' })).json();
  assert.deepEqual(found.results, []);
});

test('a forged, edited or revoked key is refused', async (t) => {
  const { admin, newKey, call } = await worker(t);
  const key = await newKey('ash');
  assert.equal((await call('hm_bogus', 'GET', '/v1/profile')).status, 401);
  // Same signature, another account name.
  const [, id, scope, signature] = key.split('.');
  const forged = `hm_${Buffer.from('sam').toString('base64url')}.${id}.${scope}.${signature}`;
  assert.equal((await call(forged, 'GET', '/v1/profile')).status, 401);
  assert.equal((await call(key.replace('.rw.', '.ro.'), 'GET', '/v1/profile')).status, 401);

  assert.equal((await call(key, 'GET', '/v1/profile')).status, 200);
  await admin('ash', 'DELETE', '/admin/keys', { keyId: id });
  assert.equal((await call(key, 'GET', '/v1/profile')).status, 401);
  assert.equal((await (await admin('ash', 'GET', '/admin/keys')).json()).keys.length, 0);
});

test('admin routes need Hivra\'s signature', async (t) => {
  const { mf } = await worker(t);
  const request = signed('ash', 'POST', '/admin/keys', { label: 'x' });
  request.headers['x-hivra-signature'] = '0'.repeat(64);
  assert.equal((await mf.dispatchFetch(`${BASE}/admin/keys`, request)).status, 401);
});

test('a read-only key can search but not save, edit or forget', async (t) => {
  const { newKey, call } = await worker(t);
  const writer = await newKey('ash');
  const reader = await newKey('ash', { scope: 'ro' });
  await call(writer, 'POST', '/v1/remember', { text: 'The office wifi is called Hive' });
  assert.equal((await call(reader, 'POST', '/v1/recall', { query: 'wifi' })).status, 200);
  assert.equal((await call(reader, 'POST', '/v1/remember', { text: 'nope' })).status, 403);
  assert.equal((await call(reader, 'PUT', '/v1/profile', { profile: 'nope' })).status, 403);
  assert.equal((await call(reader, 'POST', '/v1/forget', { project: 'x' })).status, 403);
});

test('a key tied to a project only writes, reads and forgets that project', async (t) => {
  const { newKey, call } = await worker(t);
  const all = await newKey('ash');
  const scoped = await newKey('ash', { project: 'shop' });
  await call(all, 'POST', '/v1/remember', { text: 'The blog uses Astro and deploys to Pages', project: 'blog' });
  await call(scoped, 'POST', '/v1/remember', { text: 'The shop uses Stripe checkout', project: 'elsewhere' });

  const found = await (await call(scoped, 'POST', '/v1/recall', { query: 'what does it use to deploy astro stripe', project: 'blog' })).json();
  assert.deepEqual(found.results.map((row) => row.project), ['shop']);
  assert.equal((await call(scoped, 'POST', '/v1/forget', { project: 'blog' })).status, 403);
  const exported = await (await call(scoped, 'GET', '/v1/export')).text();
  assert.doesNotMatch(exported, /Astro/);
});

test('a restatement replaces the old memory; a changed fact is offered to the agent to replace', async (t) => {
  const { newKey, call, admin } = await worker(t, { bindings: { MEMORY_MAX_ITEMS: '50' } });
  const key = await newKey('ash');
  const first = await (await call(key, 'POST', '/v1/remember', { text: 'Ash works from the Lisbon office on Mondays', kind: 'fact' })).json();
  const again = await (await call(key, 'POST', '/v1/remember', { text: 'Ash works from the Lisbon office on Mondays', kind: 'fact' })).json();
  assert.equal(again.saved[0].duplicate, true);
  // The stand-in embedder ignores word order, so this reads as a word-for-word restatement.
  const restated = await (await call(key, 'POST', '/v1/remember', { text: 'On Mondays Ash works from the Lisbon office', kind: 'fact' })).json();
  assert.deepEqual(restated.saved[0].replaced, [first.saved[0].id]);

  // A changed fact is close but not the same: nothing is replaced until the agent says so.
  const changed = await (await call(key, 'POST', '/v1/remember', { text: 'Ash works from the Lisbon office on Fridays and Mondays now, mostly', kind: 'fact' })).json();
  assert.equal(changed.saved[0].replaced, undefined);
  assert.equal(changed.saved[0].similar[0].id, restated.saved[0].id);
  assert.match(changed.hint, /replaces/);
  const confirmed = await (
    await call(key, 'POST', '/v1/remember', { text: 'Ash works from the Lisbon office on Fridays and Mondays now, mostly', replaces: [restated.saved[0].id, 'no-such-id'] })
  ).json();
  assert.deepEqual(confirmed.saved[0].replaced, [restated.saved[0].id]);

  const found = await (await call(key, 'POST', '/v1/recall', { query: 'Lisbon office Mondays' })).json();
  assert.equal(found.results.length, 1);
  assert.match(found.results[0].text, /Fridays/);
  const stats = await (await admin('ash', 'GET', '/admin/stats')).json();
  assert.equal(stats.active, 1);
  assert.equal(stats.replaced, 2);
  // History is kept in the export, marked as replaced.
  assert.match(await (await call(key, 'GET', '/v1/export')).text(), /replaced \d{4}-/);
});

test('credentials are masked before they are stored', async (t) => {
  const { newKey, call } = await worker(t);
  const key = await newKey('ash');
  // Built at run time so the repository's own scanner does not take the sample for a real one.
  const sample = `${'gh'}p_${'ab12'.repeat(9)}`;
  await call(key, 'POST', '/v1/remember', { text: `The deploy value is ${sample} and password: hunter2hunter2` });
  const exported = await (await call(key, 'GET', '/v1/export')).text();
  assert.doesNotMatch(exported, /ab12ab12|hunter2/);
  assert.match(exported, /\[key removed\]/);
});

test('limits: memory size, text length and request rate', async (t) => {
  const { newKey, call } = await worker(t, { bindings: { MEMORY_RATE_PER_MINUTE: '8' } });
  const key = await newKey('ash');
  assert.equal((await call(key, 'POST', '/v1/remember', { text: 'x'.repeat(301) })).status, 400);
  const items = ['alpha apples', 'bravo bananas', 'charlie cherries', 'delta dates', 'echo elderberries'].map((text) => ({ text }));
  assert.equal((await call(key, 'POST', '/v1/remember', { items })).status, 200);
  const full = await call(key, 'POST', '/v1/remember', { text: 'foxtrot figs' });
  assert.equal(full.status, 403);
  assert.equal((await full.json()).code, 'memory_full');
  let last;
  for (let i = 0; i < 8; i += 1) last = await call(key, 'GET', '/v1/profile');
  assert.equal(last.status, 429);
});

test('forget removes the words for good, and deleting the account empties it', async (t) => {
  const { newKey, call, admin } = await worker(t);
  const key = await newKey('ash');
  const saved = await (await call(key, 'POST', '/v1/remember', { text: 'The safe code is under the blue plant pot' })).json();
  assert.equal((await (await call(key, 'POST', '/v1/forget', { id: saved.saved[0].id })).json()).forgotten, 1);
  assert.deepEqual((await (await call(key, 'POST', '/v1/recall', { query: 'safe code plant pot' })).json()).results, []);
  assert.doesNotMatch(await (await call(key, 'GET', '/v1/export')).text(), /plant pot/);

  await call(key, 'PUT', '/v1/profile', { profile: 'Ash, founder' });
  await admin('ash', 'DELETE', '/admin/account');
  assert.equal((await call(key, 'GET', '/v1/profile')).status, 401);
});

test('MCP: an agent can initialise, list tools, save, recall and read the profile', async (t) => {
  const { newKey, call, rpc } = await worker(t);
  const key = await newKey('ash', { label: 'codex' });
  const hello = await rpc(key, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(hello.result.serverInfo.name, 'hivra-memory');
  assert.match(hello.result.instructions, /wake/);
  assert.equal((await call(key, 'POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const listed = await rpc(key, 'tools/list', {});
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['remember', 'wake', 'zoom', 'summarize', 'recall', 'profile', 'forget', 'export']);

  await rpc(key, 'tools/call', { name: 'profile', arguments: { set: 'Ash builds Hivra. Prefers short answers.' } });
  await rpc(key, 'tools/call', { name: 'remember', arguments: { text: 'Tests run with node --test, never jest', kind: 'decision', project: 'hivra' } });
  const found = await rpc(key, 'tools/call', { name: 'recall', arguments: { query: 'how are tests run' } });
  assert.equal(found.result.isError, false);
  assert.match(found.result.content[0].text, /node --test/);
  const profile = await rpc(key, 'tools/call', { name: 'profile', arguments: {} });
  assert.match(profile.result.content[0].text, /short answers/);
  const exported = await rpc(key, 'tools/call', { name: 'export', arguments: {} });
  assert.match(exported.result.content[0].text, /# hivra/);
  const bad = await rpc(key, 'tools/call', { name: 'remember', arguments: { text: '' } });
  assert.equal(bad.result.isError, true);
  assert.equal((await rpc(key, 'nope', {})).error.code, -32601);
});

test('the meter counts what Cloudflare bills on', async (t) => {
  const { newKey, call, admin } = await worker(t);
  const key = await newKey('ash');
  await call(key, 'POST', '/v1/remember', { text: 'Invoices are sent on the first of the month' });
  await call(key, 'POST', '/v1/recall', { query: 'invoices' });
  const stats = await (await admin('ash', 'GET', '/admin/stats')).json();
  assert.equal(stats.saves, 1);
  assert.equal(stats.recalls, 1);
  assert.ok(stats.rows_read > 0 && stats.rows_written > 0 && stats.embed_tokens > 0 && stats.storedBytes > 0);
});

test('the memory view: agents write the summaries, old memories fade into them, zoom opens them', async (t) => {
  const { newKey, call, rpc, admin } = await worker(t, { embeddings: false, bindings: { MEMORY_MAX_ITEMS: '100' } });
  const key = await newKey('ash', { label: 'claude-code' });
  const facts = ['pnpm not npm', 'staging in Frankfurt', 'production in Dublin', 'queue on Postgres', 'tests use node test', 'deploys on Thursdays', 'office wifi is Hive', 'logo is orange'];
  const ids = [];
  // Answer every merge the way an agent would: one line for the two it was shown.
  const upkeep = async (reply) => {
    let merges = reply.merges ?? [];
    let asked = 0;
    while (merges.length) {
      const [merge] = merges;
      asked += 1;
      assert.match(reply.upkeep ?? 'x', /./);
      const done = await (await call(key, 'POST', '/v1/summarize', { range: merge.range, text: `sum(${merge.range})` })).json();
      assert.equal(done.ok, true);
      merges = [...merges.slice(1).filter((m) => m.range !== merge.range), ...(done.merges ?? [])].filter(
        (m, i, all) => all.findIndex((o) => o.range === m.range) === i,
      );
    }
    return asked;
  };
  let asked = 0;
  for (const text of facts) {
    const reply = await (await call(key, 'POST', '/v1/remember', { text, kind: 'fact' })).json();
    ids.push(reply.saved[0].id);
    asked += await upkeep(reply);
  }
  // Eight memories make seven summaries: 0-1, 2-3, 4-5, 6-7, 0-3, 4-7, 0-7.
  assert.equal(asked, 7);

  const whole = await (await call(key, 'GET', '/v1/wake?lines=96')).json();
  assert.equal(whole.memories, 8);
  assert.deepEqual(whole.view.map((line) => line.split(' ')[0]), ['#0', '#1', '#2', '#3', '#4', '#5', '#6', '#7']);
  // On a tight budget the old half stays one line and the newest memories stay whole.
  const tight = await (await call(key, 'GET', '/v1/wake?lines=8')).json();
  assert.equal(tight.view.length, 8);
  const small = await (await call(key, 'POST', '/v1/zoom', { range: '0-7' })).json();
  assert.deepEqual(small.halves.map((half) => half.line), ['sum(0-3)', 'sum(4-7)']);
  const leaves = await (await call(key, 'POST', '/v1/zoom', { range: '2-3' })).json();
  assert.deepEqual(leaves.memories.map((memory) => memory.text), ['production in Dublin', 'queue on Postgres']);
  assert.equal((await call(key, 'POST', '/v1/zoom', { range: '1-2' })).status, 400);

  // An agent can name what a new memory replaces by its number in the view.
  const moved = await (await call(key, 'POST', '/v1/remember', { text: 'logo is teal', replaces: ['#7'] })).json();
  assert.deepEqual(moved.saved[0].replaced, [ids[7]]);
  assert.ok(!(await (await call(key, 'GET', '/v1/wake')).json()).view.some((line) => /orange/.test(line)));

  // Forgetting a memory drops every summary that covered it; they come due again without the forgotten words.
  await call(key, 'POST', '/v1/forget', { id: ids[1] });
  const after = await (await call(key, 'GET', '/v1/wake')).json();
  assert.ok(!after.view.some((line) => /Frankfurt|sum\(0-/.test(line)));
  // With one half gone, 0-1 needs no agent: the remaining memory stands for the pair. 0-3 comes due.
  assert.deepEqual(after.merges.map((merge) => merge.range).sort(), ['0-3', '4-7']);
  after.merges.sort((x, y) => x.range.localeCompare(y.range));
  assert.match(after.merges[0].a, /pnpm/);
  assert.equal((await call(key, 'POST', '/v1/summarize', { range: '8-9', text: 'again' })).status, 409);

  // Over MCP the view reads as plain lines.
  const text = (await rpc(key, 'tools/call', { name: 'wake', arguments: {} })).result.content[0].text;
  assert.match(text, /# About the person/);
  assert.match(text, /#0 \[fact\] pnpm not npm/);

  // A key tied to one project searches, but never reads the whole memory.
  const scoped = await newKey('ash', { project: 'shop' });
  assert.equal((await call(scoped, 'GET', '/v1/wake')).status, 403);
  assert.equal((await (await admin('ash', 'GET', '/admin/stats')).json()).summaries, 7);
});

test('a long memory fades: 40 memories read in 12 lines, newest in full', async (t) => {
  const { newKey, call } = await worker(t, { embeddings: false, bindings: { MEMORY_MAX_ITEMS: '100' } });
  const key = await newKey('ash');
  for (let i = 0; i < 40; i += 1) {
    let reply = await (await call(key, 'POST', '/v1/remember', { text: `memory number ${i} about topic ${i % 7}` })).json();
    let merges = reply.merges ?? [];
    while (merges.length) {
      reply = await (await call(key, 'POST', '/v1/summarize', { range: merges[0].range, text: `sum ${merges[0].range}` })).json();
      merges = [...merges.slice(1), ...(reply.merges ?? [])].filter((m, n, all) => all.findIndex((o) => o.range === m.range) === n);
    }
  }
  const { view } = await (await call(key, 'GET', '/v1/wake?lines=12')).json();
  assert.ok(view.length <= 13 && view.length >= 10, `got ${view.length} lines`);
  assert.match(view[0], /^#0-(7|15|31) sum/);
  assert.match(view.at(-1), /^#39 \[note\] memory number 39/);
  // Every memory is covered exactly once, in order.
  let next = 0;
  for (const line of view) {
    const [, lo, hi] = /^#(\d+)(?:-(\d+))?/.exec(line);
    assert.equal(Number(lo), next);
    next = Number(hi ?? lo) + 1;
  }
  assert.equal(next, 40);
});
