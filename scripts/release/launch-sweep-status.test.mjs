import assert from 'node:assert/strict';
import test from 'node:test';
import { CANARY_ENVIRONMENT, STATUS_CONTEXT, describeVerdict, evaluateGate, main, publishStatus, servedCanarySha } from './launch-sweep-status.mjs';

// A fake GitHub: commits with trees, Canary deployments and commit statuses.
function fakeGithub({ commits = {}, deployments = [], statuses = {} } = {}) {
  const calls = [];
  const request = async (path, init = {}) => {
    calls.push({ path, init });
    let m;
    if ((m = path.match(/\/deployments\?environment=([^&]+)/))) {
      assert.equal(decodeURIComponent(m[1]), CANARY_ENVIRONMENT);
      return deployments.map((d, i) => ({ id: i + 1, sha: d.sha, created_at: `2026-11-1${i}` }));
    }
    if ((m = path.match(/\/deployments\/(\d+)\/statuses/))) return [{ state: deployments[Number(m[1]) - 1].state }];
    if ((m = path.match(/\/commits\/([0-9a-f]+)\/status/))) {
      const sha = Object.keys(commits).find((full) => full.startsWith(m[1]));
      return { sha, statuses: statuses[sha] ?? [] };
    }
    if ((m = path.match(/\/commits\/([0-9a-f]+)$/))) {
      const sha = Object.keys(commits).find((full) => full.startsWith(m[1]));
      if (!sha) throw new Error('HTTP 404');
      return { sha, commit: { tree: { sha: commits[sha].tree } } };
    }
    if ((m = path.match(/\/git\/trees\/(\w+)/))) {
      const entry = Object.values(commits).find((c) => c.tree === m[1]);
      return { tree: [{ path: 'dashboard', type: 'tree', sha: entry.dashboard }, { path: 'docs', type: 'tree', sha: 'd0c5' }] };
    }
    if ((m = path.match(/\/statuses\/(\w+)$/)) && init.method === 'POST') return { ok: true };
    throw new Error(`unexpected ${path}`);
  };
  return { request, calls };
}

const green = [{ context: STATUS_CONTEXT, state: 'success', description: '8/12 passed, 4 known broken', target_url: 'https://runs/1' }];
const red = [{ context: STATUS_CONTEXT, state: 'failure', description: '1 broken' }];
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const M = 'f'.repeat(40);

test('the served Canary commit is the newest successful deployment', async () => {
  const { request } = fakeGithub({ deployments: [{ sha: B, state: 'failure' }, { sha: A, state: 'success' }] });
  assert.equal(await servedCanarySha(request), A);
});

test('a main candidate with the same tree as a green Canary commit passes', async () => {
  const { request } = fakeGithub({
    commits: { [M]: { tree: 't1', dashboard: 'd1' }, [A]: { tree: 't1', dashboard: 'd1' } },
    deployments: [{ sha: A, state: 'success' }],
    statuses: { [A]: green },
  });
  const result = await evaluateGate(request, 'ffffffff');
  assert.equal(result.ok, true);
  assert.equal(result.swept, A);
  assert.equal(result.match, 'same tree');
});

test('a docs-only difference outside dashboard/ still matches on the dashboard tree', async () => {
  const { request } = fakeGithub({
    commits: { [M]: { tree: 't2', dashboard: 'd1' }, [A]: { tree: 't1', dashboard: 'd1' } },
    deployments: [{ sha: A, state: 'success' }],
    statuses: { [A]: green },
  });
  const result = await evaluateGate(request, M);
  assert.equal(result.ok, true);
  assert.equal(result.match, 'same dashboard tree');
});

test('a candidate whose source Canary never served, or whose sweep failed, does not pass', async () => {
  const unswept = fakeGithub({
    commits: { [M]: { tree: 't9', dashboard: 'd9' }, [A]: { tree: 't1', dashboard: 'd1' } },
    deployments: [{ sha: A, state: 'success' }],
    statuses: { [A]: green },
  });
  const never = await evaluateGate(unswept.request, M);
  assert.equal(never.ok, false);
  assert.match(never.reason, /Roll it out to Canary/);

  const failed = fakeGithub({
    commits: { [M]: { tree: 't1', dashboard: 'd1' }, [A]: { tree: 't1', dashboard: 'd1' }, [C]: { tree: 't1', dashboard: 'd1' } },
    deployments: [{ sha: A, state: 'success' }, { sha: C, state: 'success' }],
    statuses: { [A]: red },
  });
  const result = await evaluateGate(failed.request, M);
  assert.equal(result.ok, false);
  assert.deepEqual(result.checked.map((row) => row.state), ['failure']);
});

test('an older green sweep does not outweigh a newer red one for the same source', async () => {
  const { request } = fakeGithub({
    commits: { [M]: { tree: 't2', dashboard: 'd1' }, [A]: { tree: 't1', dashboard: 'd1' }, [C]: { tree: 't1', dashboard: 'd1' } },
    deployments: [{ sha: A, state: 'success' }, { sha: C, state: 'success' }],
    statuses: { [A]: red, [C]: green },
  });
  const result = await evaluateGate(request, M);
  assert.equal(result.ok, false);
  assert.match(result.reason, /newest launch sweep/);
});

test('an unswept newer deployment of the same source defers to the newest swept one', async () => {
  const { request } = fakeGithub({
    commits: { [M]: { tree: 't1', dashboard: 'd1' }, [A]: { tree: 't1', dashboard: 'd1' }, [C]: { tree: 't1', dashboard: 'd1' } },
    deployments: [{ sha: A, state: 'success' }, { sha: C, state: 'success' }],
    statuses: { [C]: green },
  });
  const result = await evaluateGate(request, M);
  assert.equal(result.ok, true);
  assert.equal(result.swept, C);
});

test('a red or pending status on the candidate itself fails without falling back to Canary', async () => {
  const { request } = fakeGithub({
    commits: { [M]: { tree: 't1', dashboard: 'd1' }, [A]: { tree: 't1', dashboard: 'd1' } },
    deployments: [{ sha: A, state: 'success' }],
    statuses: { [M]: red, [A]: green },
  });
  const result = await evaluateGate(request, M);
  assert.equal(result.ok, false);
  assert.match(result.reason, /own launch sweep is failure/);
});

test('a green status on the candidate itself passes without looking at Canary', async () => {
  const { request, calls } = fakeGithub({ commits: { [A]: { tree: 't1', dashboard: 'd1' } }, statuses: { [A]: green } });
  assert.equal((await evaluateGate(request, A)).match, 'same commit');
  assert.equal(calls.some((call) => call.path.includes('/deployments')), false);
});

test('the verdict becomes the status; an empty or missing verdict is never green', () => {
  assert.deepEqual(describeVerdict({ ok: true, total: 12, passed: 8, knownBroken: 4, broken: 0, leaked: 0, privateOnlyFailed: 0 }), {
    state: 'success',
    description: '8/12 passed, 4 known broken',
  });
  assert.equal(describeVerdict({ ok: false, total: 12, passed: 7, knownBroken: 4, broken: 1, leaked: 1, privateOnlyFailed: 0 }).description, '7/12 passed, 4 known broken, 1 broken, 1 left running');
  assert.equal(describeVerdict({ ok: true, total: 0 }).state, 'failure');
  assert.equal(describeVerdict(null).state, 'error');
});

test('publish posts the launch-sweep context and refuses a bad SHA or state', async () => {
  const { request, calls } = fakeGithub();
  await publishStatus(request, { sha: A, state: 'pending', description: 'Sweeping', targetUrl: 'https://runs/2' });
  assert.equal(calls[0].path, `/repos/ashneil12/hivra/statuses/${A}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { state: 'pending', context: STATUS_CONTEXT, description: 'Sweeping', target_url: 'https://runs/2' });
  await assert.rejects(publishStatus(request, { sha: 'main', state: 'success' }), /commit SHA/);
  await assert.rejects(publishStatus(request, { sha: A, state: 'green' }), /Unknown state/);
});

test('the gate command exits 1 on a candidate without a green sweep', async () => {
  const { request } = fakeGithub({ commits: { [M]: { tree: 't9', dashboard: 'd9' } }, deployments: [] });
  const lines = [];
  assert.equal(await main(['gate', M], { request, log: (line) => lines.push(line) }), 1);
  assert.match(lines[0], /^FAIL/);
  assert.equal(await main(['needs-sweep', '--sha', M], { request, log: (line) => lines.push(line) }), 0);
  assert.equal(lines.at(-1), 'true');
});
