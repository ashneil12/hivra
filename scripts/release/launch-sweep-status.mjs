import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The launch sweep's result on GitHub, and the pre-Promote gate that reads it.
//
// A private runner runs the launch sweep (dashboard/e2e/launch-sweep.spec.ts)
// against the revision Canary serves, then records the verdict on that commit
// in this repository as a commit status named `launch-sweep`. Production
// Promote requires that status: a main candidate passes the gate only when it,
// or a Canary commit with the same source tree, has a green sweep.
//
// Usage:
//   node scripts/release/launch-sweep-status.mjs served-sha
//       The commit the Canary project serves now (its newest successful
//       GitHub deployment).
//   node scripts/release/launch-sweep-status.mjs needs-sweep [--sha <sha>]
//       Prints `true` when that commit (default: the served one) has no
//       launch-sweep status yet.
//   node scripts/release/launch-sweep-status.mjs publish --sha <sha> --state <pending|success|failure|error>
//       [--verdict <verdict.json>] [--description <text>] [--target-url <url>]
//       Writes the status. Needs GITHUB_TOKEN with commit statuses: write.
//   node scripts/release/launch-sweep-status.mjs gate <candidate-sha> [--json]
//       Exits 0 only when the candidate has a green sweep, directly or through
//       a Canary commit with the same tree. Read-only.
//
// GITHUB_TOKEN is optional for reads (public repository, lower rate limit).

export const STATUS_CONTEXT = 'launch-sweep';
export const DEFAULT_REPO = 'ashneil12/hivra';
export const CANARY_ENVIRONMENT = 'Production – hermesos-canary';
const API = 'https://api.github.com';
const SHA = /^[0-9a-f]{7,40}$/i;

export function github({ token = process.env.GITHUB_TOKEN, fetchImpl = fetch } = {}) {
  return async function request(path, init = {}) {
    const res = await fetchImpl(`${API}${path}`, {
      ...init,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (res.status === 404 && init.allow404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub ${init.method || 'GET'} ${path} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  };
}

/** Successful Canary deployments, newest first: [{ sha, createdAt }]. */
export async function canaryDeployments(request, repo = DEFAULT_REPO, limit = 30) {
  const env = encodeURIComponent(CANARY_ENVIRONMENT);
  const deployments = await request(`/repos/${repo}/deployments?environment=${env}&per_page=${limit}`);
  const out = [];
  for (const deployment of deployments) {
    const statuses = await request(`/repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`);
    if (statuses[0]?.state === 'success') out.push({ sha: deployment.sha, createdAt: deployment.created_at });
  }
  return out;
}

/** The commit Canary serves: its newest successful deployment. */
export async function servedCanarySha(request, repo = DEFAULT_REPO) {
  const env = encodeURIComponent(CANARY_ENVIRONMENT);
  const deployments = await request(`/repos/${repo}/deployments?environment=${env}&per_page=10`);
  for (const deployment of deployments) {
    const statuses = await request(`/repos/${repo}/deployments/${deployment.id}/statuses?per_page=1`);
    if (statuses[0]?.state === 'success') return deployment.sha;
  }
  throw new Error(`No successful "${CANARY_ENVIRONMENT}" deployment found in ${repo}.`);
}

/** The newest launch-sweep status on a commit, or null. */
export async function sweepStatus(request, sha, repo = DEFAULT_REPO) {
  const combined = await request(`/repos/${repo}/commits/${sha}/status?per_page=100`);
  const status = (combined.statuses || []).find((row) => row.context === STATUS_CONTEXT);
  return status
    ? { state: status.state, description: status.description, targetUrl: status.target_url, sha: combined.sha }
    : null;
}

/** The commit's full SHA, its tree, and the tree of dashboard/ (what Vercel builds). */
export async function commitTrees(request, sha, repo = DEFAULT_REPO) {
  const commit = await request(`/repos/${repo}/commits/${sha}`);
  const tree = commit.commit.tree.sha;
  const root = await request(`/repos/${repo}/git/trees/${tree}`);
  const dashboard = (root.tree || []).find((entry) => entry.path === 'dashboard' && entry.type === 'tree');
  return { sha: commit.sha, tree, dashboardTree: dashboard?.sha ?? null };
}

/** Status text for a sweep verdict written by `test:launch-sweep:summary`. */
export function describeVerdict(verdict) {
  if (!verdict || typeof verdict.total !== 'number') {
    return { state: 'error', description: 'The sweep wrote no verdict.' };
  }
  if (verdict.total === 0) return { state: 'failure', description: 'The sweep recorded no results.' };
  const parts = [`${verdict.passed}/${verdict.total} passed`];
  if (verdict.knownBroken) parts.push(`${verdict.knownBroken} known broken`);
  if (verdict.broken) parts.push(`${verdict.broken} broken`);
  if (verdict.leaked) parts.push(`${verdict.leaked} left running`);
  if (verdict.privateOnlyFailed) parts.push(`${verdict.privateOnlyFailed} private-model failures`);
  return { state: verdict.ok ? 'success' : 'failure', description: parts.join(', ').slice(0, 140) };
}

export async function publishStatus(request, { repo = DEFAULT_REPO, sha, state, description, targetUrl }) {
  if (!SHA.test(sha || '')) throw new Error(`publish needs a commit SHA, got "${sha}".`);
  if (!['pending', 'success', 'failure', 'error'].includes(state)) throw new Error(`Unknown state "${state}".`);
  return request(`/repos/${repo}/statuses/${sha}`, {
    method: 'POST',
    body: JSON.stringify({
      state,
      context: STATUS_CONTEXT,
      description: (description || '').slice(0, 140),
      ...(targetUrl ? { target_url: targetUrl } : {}),
    }),
  });
}

/**
 * The pre-Promote gate. Passes when the candidate itself has a green sweep, or
 * when a recently served Canary commit with a green sweep has the same tree, or
 * the same dashboard/ tree (a docs-only difference outside dashboard/ does not
 * change what production builds).
 */
export async function evaluateGate(request, candidate, repo = DEFAULT_REPO) {
  const target = await commitTrees(request, candidate, repo);
  const own = await sweepStatus(request, target.sha, repo);
  if (own?.state === 'success') {
    return { ok: true, candidate: target.sha, match: 'same commit', swept: target.sha, status: own };
  }
  const checked = [];
  for (const deployment of await canaryDeployments(request, repo)) {
    const trees = await commitTrees(request, deployment.sha, repo);
    const sameTree = trees.tree === target.tree;
    const sameDashboard = Boolean(target.dashboardTree) && trees.dashboardTree === target.dashboardTree;
    if (!sameTree && !sameDashboard) continue;
    const status = await sweepStatus(request, trees.sha, repo);
    checked.push({ sha: trees.sha, match: sameTree ? 'same tree' : 'same dashboard tree', state: status?.state ?? 'none' });
    if (status?.state === 'success') {
      return { ok: true, candidate: target.sha, match: checked.at(-1).match, swept: trees.sha, status, checked };
    }
  }
  const reason = checked.length
    ? 'Canary served this source, but no green launch sweep is recorded for it.'
    : 'No recently served Canary commit has this source tree. Roll it out to Canary and let the sweep run first.';
  return { ok: false, candidate: target.sha, reason, own: own ?? null, checked };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--json') flags.json = true;
    else if (arg.startsWith('--')) flags[arg.slice(2)] = rest[(i += 1)];
    else positional.push(arg);
  }
  return { command, flags, positional };
}

export async function main(argv = process.argv.slice(2), { request = github(), log = console.log } = {}) {
  const { command, flags, positional } = parseArgs(argv);
  const repo = flags.repo || process.env.LAUNCH_SWEEP_STATUS_REPO || DEFAULT_REPO;
  if (command === 'served-sha') {
    log(await servedCanarySha(request, repo));
    return 0;
  }
  if (command === 'needs-sweep') {
    const sha = flags.sha || (await servedCanarySha(request, repo));
    log(String((await sweepStatus(request, sha, repo)) === null));
    return 0;
  }
  if (command === 'publish') {
    let { state, description } = flags;
    if (flags.verdict) {
      const verdict = describeVerdict(JSON.parse(readFileSync(flags.verdict, 'utf8')));
      state = verdict.state;
      description = description || verdict.description;
    }
    await publishStatus(request, { repo, sha: flags.sha, state, description, targetUrl: flags['target-url'] });
    log(`${STATUS_CONTEXT}: ${state} on ${flags.sha}${description ? ` (${description})` : ''}`);
    return 0;
  }
  if (command === 'gate') {
    const candidate = positional[0];
    if (!SHA.test(candidate || '')) throw new Error('gate needs the candidate commit SHA.');
    const result = await evaluateGate(request, candidate, repo);
    if (flags.json) log(JSON.stringify(result, null, 2));
    else if (result.ok) {
      log(`PASS ${result.candidate}: green launch sweep on ${result.swept} (${result.match}): ${result.status.description || ''}`);
      if (result.status.targetUrl) log(`Run: ${result.status.targetUrl}`);
    } else {
      log(`FAIL ${result.candidate}: ${result.reason}`);
      for (const row of result.checked) log(`  ${row.sha} (${row.match}): launch-sweep ${row.state}`);
    }
    return result.ok ? 0 : 1;
  }
  throw new Error(`Unknown command "${command ?? ''}". Use served-sha, needs-sweep, publish or gate.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(2);
    },
  );
}
