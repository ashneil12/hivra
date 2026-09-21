import test from 'node:test';
import assert from 'node:assert/strict';
import { validateControls } from './check-managed-hosting-controls.mjs';

function fixture() {
  return {
    projects: Object.fromEntries(['hermesos', 'hermesos-canary'].map((n, i) => [n, {
      link: { org: 'ashneil12', repo: 'hivra', productionBranch: i ? 'canary' : 'main', deployHooks: [] },
      autoAssignCustomDomains: !!i, previewDeploymentsDisabled: true, gitForkProtection: true,
      ssoProtection: { deploymentType: 'all_except_custom_domains' },
    }])),
    branches: Object.fromEntries(['main', 'canary'].map(n => [n, {
      enforce_admins: { enabled: true }, required_pull_request_reviews: { dismiss_stale_reviews: true },
      required_status_checks: { strict: true, checks: [{ context: 'Current tree safety', app_id: 15368 }] },
      allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false }, required_conversation_resolution: { enabled: true },
    }])),
    actions: { enabled: true, sha_pinning_required: true },
    forkApproval: { approval_policy: 'all_external_contributors' },
    token: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false },
    smokeEnvironment: { can_admins_bypass: false, deployment_branch_policy: { custom_branch_policies: true }, protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'ashneil12' } }] }] },
    smokeBranches: { branch_policies: [{ name: 'main', type: 'branch' }] },
    repositorySecrets: { total_count: 0 },
  };
}
test('accepts staged production, automatic Canary and gated live smoke', () => assert.deepEqual(validateControls(fixture()), []));
test('missing API results fail closed', () => assert.ok(validateControls({}).length > 10));
for (const [name, change] of [
  ['production auto-promotion', s => s.projects.hermesos.autoAssignCustomDomains = true],
  ['production previews with credentials', s => s.projects.hermesos.previewDeploymentsDisabled = false],
  ['Canary previews with credentials', s => s.projects['hermesos-canary'].previewDeploymentsDisabled = false],
  ['fork authorization disabled', s => s.projects.hermesos.gitForkProtection = false],
  ['public staged deployments', s => s.projects.hermesos.ssoProtection = null],
  ['unexpected deployment hooks', s => s.projects.hermesos.link.deployHooks.push({})],
  ['wrong production branch', s => s.projects.hermesos.link.productionBranch = 'canary'],
  ['wrong source repository', s => s.projects.hermesos.link.repo = 'other'],
  ['main direct writes', s => s.branches.main.required_pull_request_reviews = null],
  ['Canary direct writes', s => s.branches.canary.required_pull_request_reviews = null],
  ['PR bypass allowance', s => s.branches.main.required_pull_request_reviews.bypass_pull_request_allowances = { apps: [{ slug: 'bypass' }] }],
  ['administrator bypass', s => s.branches.main.enforce_admins.enabled = false],
  ['spoofed status check app', s => s.branches.main.required_status_checks.checks[0].app_id = 1],
  ['stale status checks', s => s.branches.main.required_status_checks.strict = false],
  ['force push', s => s.branches.main.allow_force_pushes.enabled = true],
  ['branch deletion', s => s.branches.canary.allow_deletions.enabled = true],
  ['repeat contributor implicit trust', s => s.forkApproval.approval_policy = 'first_time_contributors'],
  ['floating action versions', s => s.actions.sha_pinning_required = false],
  ['write workflow tokens', s => s.token.default_workflow_permissions = 'write'],
  ['workflow PR approval', s => s.token.can_approve_pull_request_reviews = true],
  ['additional live approver', s => s.smokeEnvironment.protection_rules[0].reviewers.push({ type: 'User', reviewer: { login: 'someone-else' } })],
  ['missing live approval', s => s.smokeEnvironment.protection_rules = []],
  ['live approval bypass', s => s.smokeEnvironment.can_admins_bypass = true],
  ['untrusted live-smoke branch', s => s.smokeBranches.branch_policies.push({ name: '*', type: 'branch' })],
  ['tag masquerading as main', s => s.smokeBranches.branch_policies[0].type = 'tag'],
  ['repository-wide live secrets', s => s.repositorySecrets.total_count = 1],
]) {
  test(`rejects ${name}`, () => { const s = fixture(); change(s); assert.ok(validateControls(s).length > 0); });
}

// These workflows execute repository code. Keep the trust boundaries observable
// even when an unrelated workflow edit changes the live-smoke job or checkout.
import { readFileSync, readdirSync } from 'node:fs';
const workflowRoot = new URL('../../.github/workflows/', import.meta.url);
test('live smoke requires main and the protected operational environment', () => {
  const source = readFileSync(new URL('live-instance-smoke.yml', workflowRoot), 'utf8');
  assert.match(source, /if:.*github\.ref == 'refs\/heads\/main'/);
  assert.match(source, /^    environment: managed-live-smoke$/m);
  assert.match(source, /if:.*github.event_name == 'workflow_dispatch'/);
  assert.doesNotMatch(source, /^  schedule:/m);
});
test('CI never persists checkout credentials or executes PRs in privileged events', () => {
  for (const name of readdirSync(workflowRoot).filter(n => /\.ya?ml$/.test(n))) {
    const source = readFileSync(new URL(name, workflowRoot), 'utf8');
    assert.doesNotMatch(source, /^\s*(pull_request_target|workflow_run):/m, name);
    for (const checkout of source.matchAll(/uses: actions\/checkout@[^\n]+\n([\s\S]*?)(?=\n\s*- (?:name:|uses:)|$)/g)) {
      assert.match(checkout[1], /persist-credentials: false/, name);
    }
    for (const action of source.matchAll(/uses:\s+([^\s]+)\s*(?:#.*)?/g)) {
      assert.match(action[1], /@[a-f0-9]{40}$/, `${name}: ${action[1]}`);
    }
  }
});
