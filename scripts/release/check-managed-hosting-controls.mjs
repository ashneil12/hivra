import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Operational audit only. Never print provider API responses: project responses
// can include environment metadata. Return only violations of explicit controls.
export function validateControls(s) {
  const errors = [];
  const check = (ok, message) => { if (!ok) errors.push(message); };
  for (const [name, branch, automatic] of [
    ['hermesos', 'main', false], ['hermesos-canary', 'canary', true],
  ]) {
    const p = s.projects?.[name];
    check(p?.link?.org === 'ashneil12' && p?.link?.repo === 'hivra', `${name}: wrong source repository`);
    check(p?.link?.productionBranch === branch, `${name}: wrong tracked branch`);
    check(p?.autoAssignCustomDomains === automatic, `${name}: wrong automatic domain assignment`);
    check(p?.previewDeploymentsDisabled === true, `${name}: automatic previews must be disabled`);
    check(p?.gitForkProtection === true, `${name}: fork protection required`);
    check(['all_except_custom_domains', 'all'].includes(p?.ssoProtection?.deploymentType), `${name}: generated deployments need authentication`);
    check(Array.isArray(p?.link?.deployHooks) && p.link.deployHooks.length === 0, `${name}: unexpected deployment hook`);
  }
  for (const branch of ['main', 'canary']) {
    const p = s.branches?.[branch];
    check(p?.enforce_admins?.enabled === true, `${branch}: administrators must follow protection`);
    check(p?.required_pull_request_reviews != null, `${branch}: pull request required`);
    const bypass = p?.required_pull_request_reviews?.bypass_pull_request_allowances;
    check(bypass == null || Object.values(bypass).every(v => Array.isArray(v) && v.length === 0), `${branch}: PR bypass allowances must be empty`);
    check(p?.required_pull_request_reviews?.dismiss_stale_reviews === true, `${branch}: stale reviews must be dismissed`);
    check(p?.required_status_checks?.strict === true, `${branch}: up-to-date checks required`);
    check(p?.required_status_checks?.checks?.some(c => c.context === 'Current tree safety' && c.app_id === 15368), `${branch}: GitHub Actions source-safety check required`);
    check(p?.allow_force_pushes?.enabled === false, `${branch}: force pushes must be prohibited`);
    check(p?.allow_deletions?.enabled === false, `${branch}: deletion must be prohibited`);
    check(p?.required_conversation_resolution?.enabled === true, `${branch}: conversations must be resolved`);
  }
  check(s.forkApproval?.approval_policy === 'all_external_contributors', 'Every external contributor must require Actions approval');
  check(s.actions?.enabled === true && s.actions?.sha_pinning_required === true, 'Actions must require full commit SHA pinning');
  check(s.token?.default_workflow_permissions === 'read' && s.token?.can_approve_pull_request_reviews === false, 'Workflow tokens must be read-only and unable to approve PRs');
  const e = s.smokeEnvironment;
  check(e?.can_admins_bypass === false, 'Live smoke environment must prohibit administrator bypass');
  check(e?.protection_rules?.some(r => r.type === 'required_reviewers' && r.reviewers?.length === 1 && r.reviewers[0].type === 'User' && r.reviewers[0].reviewer?.login === 'ashneil12'), 'Live smoke requires owner approval');
  check(e?.deployment_branch_policy?.custom_branch_policies === true, 'Live smoke needs an explicit branch policy');
  const policies = s.smokeBranches?.branch_policies;
  check(policies?.length === 1 && policies[0].name === 'main' && policies[0].type === 'branch', 'Live smoke must only run from main');
  check(s.repositorySecrets?.total_count === 0, 'Move operational credentials out of repository-level secrets');
  return errors;
}

function json(command, args) {
  return JSON.parse(execFileSync(command, args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }));
}
export function readLiveControls() {
  const gh = endpoint => json('gh', ['api', `repos/ashneil12/hivra/${endpoint}`]);
  return {
    projects: Object.fromEntries(['hermesos', 'hermesos-canary'].map(name => [name, json('vercel', ['api', `/v9/projects/${name}`, '--raw'])])),
    branches: Object.fromEntries(['main', 'canary'].map(branch => [branch, gh(`branches/${branch}/protection`)])),
    actions: gh('actions/permissions'),
    forkApproval: gh('actions/permissions/fork-pr-contributor-approval'),
    token: gh('actions/permissions/workflow'),
    smokeEnvironment: gh('environments/managed-live-smoke'),
    smokeBranches: gh('environments/managed-live-smoke/deployment-branch-policies'),
    repositorySecrets: gh('actions/secrets'),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2] !== '--live') {
    console.error('Usage: node scripts/release/check-managed-hosting-controls.mjs --live');
    process.exitCode = 2;
  } else {
    try {
      const violations = validateControls(readLiveControls());
      console.log(JSON.stringify({ status: violations.length ? 'FAIL' : 'PASS', checkedAt: new Date().toISOString(), violations }, null, 2));
      process.exitCode = violations.length ? 1 : 0;
    } catch {
      // Child-process error objects can include provider responses. Keep them private.
      console.error('FAIL: could not read every required control. Check gh/vercel authentication and API access.');
      process.exitCode = 1;
    }
  }
}
