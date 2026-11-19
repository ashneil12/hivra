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

test('the runner template records green only for a complete, cleanly reaped run, and only the customer path gates Promote', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../ops/launch-sweep-runner/launch-sweep.yml', import.meta.url), 'utf8');
  const step = (name) => {
    const start = source.indexOf(`- name: ${name}`);
    assert.notEqual(start, -1, `missing step: ${name}`);
    const next = source.indexOf('\n      - ', start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  };
  // A run limited with `only` must never write a status on the commit.
  assert.match(step('Mark the commit as being tested'), /if: env\.LAUNCH_SWEEP_ONLY == ''/);
  const record = step('Record the verdict on the commit');
  assert.match(record, /if: always\(\) && steps\.runner_tools\.outcome == 'success' && env\.LAUNCH_SWEEP_ONLY == ''/);
  // The sweep's own exit and the reaper's result both gate a green verdict.
  assert.match(record, /SWEEP_OUTCOME: \$\{\{ steps\.sweep\.outcome \}\}/);
  assert.match(record, /REAP_OUTCOME: \$\{\{ steps\.reap\.outcome \}\}/);
  assert.ok(record.indexOf('"$SWEEP_OUTCOME" != "success"') < record.indexOf('--verdict'));
  assert.ok(record.indexOf('"$REAP_OUTCOME" != "success"') < record.indexOf('--verdict'));
  assert.ok(record.indexOf('"$served" != "$SHA"') < record.indexOf('--state success'));
  assert.match(step('Mark the commit as being tested'), /served-sha/);
  assert.match(step("Run the customer path or tonight's sample on Canary"), /id: sweep/);
  assert.match(step('Reap anything a crashed run left'), /id: reap/);
  // The release run (customer path) writes the gating status; the nightly sample does not.
  assert.match(source, /STATUS_CONTEXT: \$\{\{ needs\.pick\.outputs\.mode == 'release' && 'launch-sweep' \|\| 'launch-sample' \}\}/);
  assert.match(source, /npm run test:trial-journey/);
  const run = step("Run the customer path or tonight's sample on Canary");
  assert.match(run, /none\[\[:space:\]\]\*\$/);
  assert.match(run, /sample="\$\(npm run -s test:launch-sweep:sample\)"\n\s+if \[ -z "\$sample" \]; then/);
});

test('runner verification does not depend on the status helper being on Canary', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../ops/launch-sweep-runner/launch-sweep.yml', import.meta.url), 'utf8');
  const [pick, sweep] = source.split('\n  sweep:');
  assert.match(pick, /ref: \$\{\{ github\.workflow_sha \}\}/);
  assert.match(pick, /node launch-sweep-status\.mjs served-sha/);
  assert.doesNotMatch(pick, /repository: ashneil12\/hivra/);
  assert.match(sweep, /ref: \$\{\{ github\.workflow_sha \}\}\n\s+path: runner-tools/);
  assert.match(sweep, /repository: ashneil12\/hivra\n\s+ref: \$\{\{ needs\.pick\.outputs\.sha \}\}\n\s+path: hivra/);
  assert.match(sweep, /path: hivra\n\s+clean: true/);
  assert.match(sweep, /LAUNCH_SWEEP_VERDICT_FILE: \$\{\{ github\.workspace \}\}\/hivra\//);
  assert.match(sweep, /STATUS_HELPER: \$\{\{ github\.workspace \}\}\/runner-tools\/launch-sweep-status\.mjs/);
  assert.doesNotMatch(sweep, /node scripts\/release\/launch-sweep-status\.mjs/);
});
