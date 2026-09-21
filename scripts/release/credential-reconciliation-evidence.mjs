#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const POLICY = 'docs/release/credential-reconciliation.json';
const CONTROL = /[\u0000-\u001f\u007f]/;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeRelative(value) {
  if (
    typeof value !== 'string' || !value || path.posix.isAbsolute(value) || value.includes('\\') || CONTROL.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) throw new Error('Credential reconciliation contains an unsafe path.');
  return value;
}

function regular(root, relative) {
  const safe = safeRelative(relative);
  const file = path.resolve(root, ...safe.split('/'));
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error('Credential reconciliation escaped the repository.');
  const info = lstatSync(file);
  if (!info.isFile() || realpathSync(file) !== file || info.size > 1024 * 1024) {
    throw new Error('Credential reconciliation evidence must be one bounded regular file.');
  }
  return readFileSync(file);
}

export function inspectCredentialReconciliation({ root } = {}) {
  root = realpathSync(root);
  const policyBytes = regular(root, POLICY);
  let policy;
  try { policy = JSON.parse(policyBytes.toString('utf8')); }
  catch { throw new Error('Credential reconciliation policy is not valid JSON.'); }
  if (
    policy?.format !== 'hivra-credential-reconciliation-v1' ||
    policy?.status !== 'current-authorization-boundary-reconciled' ||
    policy?.releaseApproved !== false || !Array.isArray(policy?.gaps) || policy.gaps.length !== 0 ||
    policy?.freshRepository?.privateHistoryExcluded !== true ||
    policy?.freshRepository?.currentTreePrivateKeyFindingCount !== 0 ||
    policy?.freshRepository?.archivePrivateKeyFindingCount !== 0 ||
    policy?.historicalStripeCredential?.readOnlyAuthenticationStatus !== 401 ||
    policy?.historicalStripeCredential?.conclusion !== 'invalid-or-revoked' ||
    policy?.historicalSshCredential?.activeManagedTargets < 1 ||
    policy.historicalSshCredential.activeManagedTargetsChecked !== policy.historicalSshCredential.activeManagedTargets ||
    policy.historicalSshCredential.activeTargetsAuthorizingHistoricalKey !== 0 ||
    policy.historicalSshCredential.strictHostKeyChecking !== true ||
    policy.historicalSshCredential.temporaryPrivateMaterialRemoved !== true ||
    policy.historicalSshCredential.inactiveRegistryTargetsHaveLaunchAuthority !== false ||
    policy?.providerCheck?.operatorHetznerCloudServers !== 0 ||
    policy.providerCheck.historicalKeyIsCurrentProviderKey !== false
  ) throw new Error('Credential reconciliation policy is incomplete.');

  const audit = regular(root, policy.auditPath).toString('utf8');
  for (const statement of [
    'The credential gate for the fresh source-only repository is reconciled.',
    'Four active targets were checked; zero authorized the historical key.',
    'Strict host-key checking remained enabled.',
    'No host authorization, provider resource, customer row, current credential, or Git history was changed',
  ]) {
    if (!audit.includes(statement)) throw new Error('Credential reconciliation audit drifted from its reviewed result.');
  }

  const historyDecision = regular(root, 'docs/release/PUBLIC-REPOSITORY-DECISION.md').toString('utf8');
  if (!historyDecision.includes('Publish a fresh repository from an exact, reviewed current-tree export.')) {
    throw new Error('The fresh-repository history boundary is no longer in force.');
  }

  return {
    format: 'hivra-credential-reconciliation-evidence-v1',
    status: 'current-authorization-boundary-reconciled',
    releaseApproved: false,
    policySha256: sha256(policyBytes),
    activeManagedTargetsChecked: policy.historicalSshCredential.activeManagedTargetsChecked,
    currentTargetsAuthorizingHistoricalKey: 0,
    privateHistoryExcluded: true,
    gaps: [],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(inspectCredentialReconciliation({ root: process.cwd() }))}\n`); }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Credential reconciliation inspection failed.');
    process.exitCode = 1;
  }
}
