import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const sha256 = (relative) => createHash('sha256').update(readFileSync(path.join(root, relative))).digest('hex');

function workflowActionReferences(source, label) {
  const actions = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (line.trimStart().startsWith('#')) continue;
    assert.doesNotMatch(line, /\\(?:x[0-9a-f]{2}|u[0-9a-f]{4}|U[0-9a-f]{8})/i,
      `${label}:${index + 1}: escaped YAML scalars are not allowed in workflow source`);
    if (!/\buses\b/.test(line)) continue;
    const canonical = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#.*)?$/);
    assert.ok(canonical,
      `${label}:${index + 1}: every uses token must be one canonical action-reference line`);
    actions.push(canonical[1]);
  }
  return actions;
}

test('root license is the complete Apache License 2.0 text', () => {
  const license = read('LICENSE');
  assert.match(license, /^\s*Apache License\s+Version 2\.0, January 2004/m);
  assert.match(license, /END OF TERMS AND CONDITIONS/);
  assert.match(license, /http:\/\/www\.apache\.org\/licenses\/LICENSE-2\.0/);
  assert.equal(sha256('LICENSE'), 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30');
});

test('all tracked npm application roots declare Apache-2.0 consistently', () => {
  for (const directory of [
    'dashboard',
    'services/browser-sidecar',
    'services/posthog-proxy-worker',
    'services/venice-proxy-worker',
  ]) {
    const manifest = JSON.parse(read(`${directory}/package.json`));
    const lock = JSON.parse(read(`${directory}/package-lock.json`));
    assert.equal(manifest.license, 'Apache-2.0', `${directory} manifest license`);
    assert.equal(lock.packages?.['']?.license, 'Apache-2.0', `${directory} lock root license`);
  }
});

test('public-address sanitization cannot rewrite dependency semver or engine constraints', () => {
  const browser = JSON.parse(read('services/browser-sidecar/package-lock.json'));
  assert.equal(browser.packages['node_modules/mailparser'].dependencies['html-to-text'], '10.0.1');
  assert.equal(browser.packages['node_modules/socks'].engines.node, '>= 10.0.0');

  for (const directory of ['services/posthog-proxy-worker', 'services/venice-proxy-worker']) {
    const lock = JSON.parse(read(`${directory}/package-lock.json`));
    assert.equal(lock.packages['node_modules/@poppinss/dumper'].dependencies['supports-color'], '^10.0.0');
    assert.equal(lock.packages['node_modules/ws'].engines.node, '>=10.0.0');
  }
});

test('release policies preserve third-party and incomplete-release boundaries', () => {
  for (const relative of [
    'NOTICE',
    'CONTRIBUTING.md',
    'SECURITY.md',
    'TRADEMARKS.md',
    'docs/release/PUBLIC-REPOSITORY-DECISION.md',
    'docs/release/RUNTIME-DISTRIBUTION.md',
    'docs/release/runtime-distribution-boundary.json',
    'docs/release/credential-reconciliation.json',
    'docs/release/VERIFICATION-STATUS.md',
    'THIRD_PARTY_LICENSES/marketing-skills.txt',
    'contracts/LICENSE',
  ]) {
    assert.ok(read(relative).trim().length > 0, `${relative} must not be empty`);
  }

  const notice = read('NOTICE');
  assert.match(notice, /not part of the Hivra Work/i);
  assert.match(notice, /their own\s+licenses and terms/i);
  assert.match(notice, /Marketing\s+Skills by Corey Haines and contributors/);
  assert.match(notice, /github\.com\/coreyhaines31\/marketingskills/);
  assert.equal(sha256('THIRD_PARTY_LICENSES/marketing-skills.txt'),
    'b70d71e24e40fce5da8f4b6f9cd862096a048e433db7f3c8cac5e348e6d34591');

  const trademarks = read('TRADEMARKS.md');
  assert.match(trademarks, /Forks and competing hosted services are explicitly permitted/);
  assert.match(trademarks, /must not be used to restrict the code\s+rights granted by Apache-2\.0/i);

  const contributing = read('CONTRIBUTING.md');
  assert.match(contributing, /contributions are submitted under Apache-2\.0/);
  assert.match(contributing, /Developer Certificate of Origin 1\.1/);

  const security = read('SECURITY.md');
  assert.match(security, /Report a vulnerability privately/);
  assert.match(security, /info@hermesos\.cloud/);
  assert.match(security, /remains gated on enabling and testing a private GitHub/i);

  const readme = read('README.md');
  assert.match(readme, /Do not publish a release artifact/i);
  assert.doesNotMatch(readme, /No root open-source license has been selected/i);

  const boundary = read('docs/OPEN-SOURCE-BOUNDARY.md');
  assert.match(boundary, /does not complete Phase 0/i);
  assert.doesNotMatch(boundary, /No root open-source license is currently committed/i);

  const runtime = read('docs/release/RUNTIME-DISTRIBUTION.md');
  assert.match(runtime, /\| Buzz \|[^\n]+\| Connect; later upstream download after image audit \|/);
  assert.match(runtime, /Existing managed Hermes lane/);
  assert.match(runtime, /Not approved for public distribution/);
  assert.match(runtime, /They do not block the exact source-only archive/i);
  assert.match(runtime, /self-host acceptance and independent export review/i);

  const roadmap = read('ROADMAP.md');
  assert.match(roadmap, /Phase 0 — Canonical truth and public-release safety[\s\S]*?\*\*Status:\*\* Building/);
  assert.match(roadmap, /first public artifact\s+is explicitly source-only/i);
  assert.match(roadmap, /separate byte-level evidence is complete/i);
  assert.match(roadmap, /\[x\] Decide preserved-history versus fresh-public-repository/);

  const repositoryDecision = read('docs/release/PUBLIC-REPOSITORY-DECISION.md');
  assert.match(repositoryDecision, /Publish a fresh repository from an exact, reviewed current-tree export/);
  assert.match(repositoryDecision, /reachable `main` history through audit target `8308da55c1a2` \(3,243 commits\)/i);
  assert.match(repositoryDecision, /must not be used to create a hidden or\s+functionally superior private core/);
  assert.match(repositoryDecision, /No public repository is created by this decision/);
  assert.match(repositoryDecision, /reconciles the current authorization boundary/);
  assert.match(repositoryDecision, /Source-only runtime boundary/);

  for (const relative of [
    'docs/SECURITY-MODEL.md',
    '.agents/product-marketing-context.md',
  ]) {
    assert.doesNotMatch(read(relative), /current (?:unlicensed )?repository[^\n]*(?:no root|does not grant)|(?:the )?repository has no root open-source license|no committed root license/i,
      `${relative} must not contradict the root license`);
  }
});

test('the source candidate builder remains a private fail-closed review artifact', () => {
  const builder = read('scripts/release/public-source-candidate.mjs');
  const approval = read('scripts/release/public-source-approval.mjs');
  const evidenceBuilder = read('scripts/release/notice-source-offer-evidence.mjs');
  const assetEvidenceBuilder = read('scripts/release/asset-provenance-evidence.mjs');
  const runtimeBoundaryBuilder = read('scripts/release/runtime-distribution-boundary.mjs');
  const credentialEvidenceBuilder = read('scripts/release/credential-reconciliation-evidence.mjs');
  const assetPolicy = JSON.parse(read('docs/release/asset-provenance.json'));
  const assetRecords = JSON.parse(read('docs/release/asset-generation-records.json'));
  const fontEvidence = JSON.parse(read('docs/release/font-license-evidence.json'));
  const ownerAssertions = JSON.parse(read('docs/release/asset-owner-assertions.json'));
  const sourceProvenance = JSON.parse(read('docs/release/source-third-party-provenance.json'));
  const runtimeBoundary = JSON.parse(read('docs/release/runtime-distribution-boundary.json'));
  const credentialReconciliation = JSON.parse(read('docs/release/credential-reconciliation.json'));
  const overrides = JSON.parse(read('docs/release/npm-license-overrides.json'));
  const decision = read('docs/release/PUBLIC-REPOSITORY-DECISION.md');
  const quickstart = read('docs/self-host/QUICKSTART.md');
  assert.match(builder, /releaseApproved:\s*false/);
  assert.match(builder, /complete-notice-and-source-offer-review/);
  assert.match(builder, /complete-asset-provenance-review/);
  assert.match(builder, /inspectRuntimeDistributionBoundary/);
  assert.match(builder, /inspectCredentialReconciliation/);
  assert.doesNotMatch(builder, /exact-runtime-and-image-notices/);
  assert.match(builder, /complete-self-host-acceptance/);
  assert.match(builder, /fresh-context-export-review/);
  assert.match(builder, /test-public-source-bootstrap-e2e\.test\.mjs/);
  assert.match(builder, /test-self-host-recovery-e2e\.test\.mjs/);
  assert.match(builder, /public-source-approval\.test\.mjs/);
  assert.match(approval, /hivra-public-source-review-v1/);
  assert.match(approval, /hivra-public-source-bootstrap-e2e-v1/);
  assert.match(approval, /approved-for-new-repository-publication/);
  assert.match(approval, /Write release approval evidence outside the source repository/);
  assert.doesNotMatch(approval, /github\.com\/(?:repos|orgs)|gh repo create|git push/);
  assert.match(decision, /public-source-approval\.mjs/);
  assert.match(decision, /does not create,\s*push, or make a repository public/i);
  assert.match(quickstart, /npm run test:self-host-public-source/);
  assert.match(quickstart, /public-source-bootstrap-e2e\.json/);
  assert.match(evidenceBuilder, /This is deterministic review evidence, not legal advice/);
  assert.match(assetEvidenceBuilder, /This is deterministic provenance review evidence, not legal advice/);
  assert.match(runtimeBoundaryBuilder, /source-only-runtime-boundary-complete/);
  assert.match(credentialEvidenceBuilder, /current-authorization-boundary-reconciled/);
  assert.equal(assetPolicy.format, 'hivra-asset-provenance-policy-v1');
  assert.equal(assetPolicy.releaseApproved, false);
  assert.equal(assetPolicy.assets.length, 24);
  assert.equal(new Set(assetPolicy.assets.map((entry) => entry.path)).size, 24);
  assert.ok(assetPolicy.assets.every((entry) => entry.redistributionDecision === 'include'));
  assert.ok(assetPolicy.assets.some((entry) => entry.rightsStatus === 'documented-project-generated'));
  assert.equal(assetPolicy.assets.filter((entry) => entry.rightsStatus === 'documented-third-party-font').length, 12);
  assert.equal(assetPolicy.assets.filter(
    (entry) => entry.rightsStatus === 'documented-owner-asserted-original-artwork',
  ).length, 5);
  assert.equal(assetRecords.format, 'hivra-asset-generation-records-v1');
  assert.equal(assetRecords.generatedAssets.length, 3);
  assert.equal(assetPolicy.rightsReview.generationRecordsSha256, sha256('docs/release/asset-generation-records.json'));
  assert.equal(fontEvidence.format, 'hivra-font-license-evidence-v1');
  assert.equal(fontEvidence.fonts.length, 12);
  assert.ok(fontEvidence.fonts.every((entry) => entry.licenseSpdx === 'OFL-1.1'));
  assert.ok(fontEvidence.fonts.every((entry) => entry.sha256 === entry.upstreamDownloadedSha256));
  assert.equal(assetPolicy.rightsReview.fontLicenseEvidenceSha256, sha256('docs/release/font-license-evidence.json'));
  assert.equal(ownerAssertions.format, 'hivra-asset-owner-assertions-v1');
  assert.equal(ownerAssertions.assertions.length, 5);
  assert.equal(ownerAssertions.assertions.filter(
    (entry) => entry.independentEvidenceLevel === 'owner-supplied-original-byte-match',
  ).length, 1);
  assert.equal(assetPolicy.rightsReview.ownerAssertionsSha256, sha256('docs/release/asset-owner-assertions.json'));
  assert.equal(overrides.format, 'hivra-npm-license-overrides-v1');
  assert.equal(overrides.releaseApproved, false);
  assert.equal(sourceProvenance.format, 'hivra-source-third-party-provenance-v1');
  assert.equal(sourceProvenance.artifactClass, 'source-only-current-tree');
  assert.equal(sourceProvenance.releaseApproved, false);
  assert.equal(sourceProvenance.components.length, 1);
  assert.equal(sourceProvenance.components[0].files.length, 124);
  assert.equal(sourceProvenance.acquiredArtifacts.length, 4);
  assert.ok(sourceProvenance.acquiredArtifacts.every(
    (entry) => entry.acquisitionDecision === 'download-at-build-hash-verified',
  ));
  assert.equal(runtimeBoundary.format, 'hivra-runtime-distribution-boundary-v1');
  assert.equal(runtimeBoundary.artifactClass, 'source-only-current-tree');
  assert.equal(runtimeBoundary.sourceOnlyBoundaryApproved, true);
  assert.equal(runtimeBoundary.releaseApproved, false);
  assert.equal(runtimeBoundary.externalInputs.length, 12);
  assert.ok(runtimeBoundary.externalInputs.every((entry) => entry.identity && entry.evidencePath));
  assert.equal(credentialReconciliation.format, 'hivra-credential-reconciliation-v1');
  assert.equal(credentialReconciliation.status, 'current-authorization-boundary-reconciled');
  assert.equal(credentialReconciliation.releaseApproved, false);
  assert.equal(credentialReconciliation.historicalSshCredential.activeManagedTargets, 4);
  assert.equal(credentialReconciliation.historicalSshCredential.activeManagedTargetsChecked, 4);
  assert.equal(credentialReconciliation.historicalSshCredential.activeTargetsAuthorizingHistoricalKey, 0);
  assert.deepEqual(credentialReconciliation.gaps, []);
  assert.equal(sha256('.agents/skills/LICENSE'), 'b70d71e24e40fce5da8f4b6f9cd862096a048e433db7f3c8cac5e348e6d34591');
  assert.deepEqual(overrides.packages.map((entry) => `${entry.name}@${entry.version}`).sort(), [
    'buildcheck@0.0.7',
    'cpu-features@0.0.10',
    'duck@0.1.12',
    'exit@0.1.2',
    'format@0.2.2',
    'posthog-js@1.318.2',
    'ssh2@1.17.0',
  ]);
  for (const entry of overrides.packages) {
    assert.match(entry.distributionUrl, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(entry.distributionSha512, /^[0-9a-f]{128}$/);
    assert.ok(entry.licenseFiles.length > 0, `${entry.name}@${entry.version} must have packaged license evidence`);
  }
  assert.deepEqual(overrides.packages.find((entry) => entry.name === 'format').licenseFiles, [{
    name: 'Readme.md',
    sha256: 'e078ab4217332db9ac446cdf23e932eabd21d6db7c239a6495df4d3802251f20',
    bytes: 1053,
  }]);
  assert.match(decision, /clean committed\s+`HEAD`/i);
  assert.match(decision, /does not publish\s+a repository/i);
});

test('public-release CI runs the credential and runtime boundary regressions', () => {
  const workflow = read('.github/workflows/public-release-safety.yml');
  assert.match(workflow, /credential-reconciliation-evidence\.test\.mjs/);
  assert.match(workflow, /runtime-distribution-boundary\.test\.mjs/);
});

test('the separate Solidity license boundary remains MIT', () => {
  assert.equal(sha256('contracts/LICENSE'), '1b8b2d100029dafacff36c16f4ad85d40b8b0af0c0610ecc6291246238b944b0');
  const contracts = execFileSync('git', ['-C', root, 'ls-files', '-z', '--', 'contracts/*.sol', 'contracts/**/*.sol'],
    { encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.ok(contracts.length > 0, 'expected tracked Solidity sources');
  for (const relative of contracts) {
    assert.match(read(relative), /SPDX-License-Identifier:\s*MIT/, relative);
  }
});

test('release metadata changes cannot bypass the CI guard path filters', () => {
  const workflow = read('.github/workflows/worker-builds.yml');
  for (const filter of [
    '.gitleaks.toml',
    '.gitleaksignore',
    '.agents/product-marketing-context.md',
    '.agents/skills/**',
    'CONTRIBUTING.md',
    'LICENSE',
    'NOTICE',
    'README.md',
    'ROADMAP.md',
    'SECURITY.md',
    'THIRD_PARTY_LICENSES/**',
    'TRADEMARKS.md',
    'contracts/LICENSE',
    'contracts/**/*.sol',
    'dashboard/package.json',
    'dashboard/package-lock.json',
    'docs/OPEN-SOURCE-BOUNDARY.md',
    'docs/SECURITY-MODEL.md',
    'docs/release/**',
    'services/browser-sidecar/package.json',
    'services/browser-sidecar/package-lock.json',
    'services/posthog-proxy-worker/**',
    'services/venice-proxy-worker/**',
    'scripts/release/**',
    '.github/workflows/worker-builds.yml',
    '.github/workflows/public-release-safety.yml',
  ]) {
    assert.equal(workflow.split(`'${filter}'`).length - 1, 2, `${filter} must guard push and pull requests`);
  }
});

test('every third-party GitHub Action is pinned to an immutable commit', () => {
  const workflowDirectory = path.join(root, '.github/workflows');
  const workflows = readdirSync(workflowDirectory)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  const approvedActionReferences = new Set([
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    'astral-sh/setup-uv@20cfd1bf945f4377ade1205e4dbc17946fc9a30d',
    'docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a',
    'docker/login-action@dbcb813823bdd20940b903addbd779551569679f',
    'docker/setup-buildx-action@37fe631027851001ddb9b187196cc803df7f5f0e',
    'docker/setup-qemu-action@96fe6ef7f33517b61c61be40b68a1882f3264fb8',
  ]);
  let actionCount = 0;

  for (const workflowName of workflows) {
    const workflow = read(`.github/workflows/${workflowName}`);
    const actions = workflowActionReferences(workflow, workflowName);
    actionCount += actions.length;
    for (const action of actions) {
      assert.match(action, /@[0-9a-f]{40}$/, `${workflowName}: ${action}`);
      assert.ok(approvedActionReferences.has(action),
        `${workflowName}: review and approve the exact action identity ${action}`);
    }
  }

  assert.deepEqual(workflowActionReferences(read('.github/workflows/deepseek-systemd-fixture.yml'), 'deepseek-systemd-fixture.yml'), [
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  ], 'the offline VM fixture adds only the reviewed checkout and evidence upload');
  assert.equal(actionCount, 12, 'review the complete workflow action inventory when it changes');
});

test('workflow action inventory fails closed on alternate uses-key forms', () => {
  for (const fixture of [
    '- { uses: attacker/action@v1 }',
    '- { name: Example, uses: attacker/action@v1 }',
    'uses : attacker/action@v1',
    '"uses": attacker/action@v1',
    'uses:\n  attacker/action@v1',
  ]) {
    assert.throws(
      () => workflowActionReferences(fixture, 'mutation-fixture.yml'),
      /every uses token must be one canonical action-reference line/,
    );
  }
  for (const fixture of [
    '"u\\u0073es": attacker/action@v1',
    '"\\x75ses": attacker/action@v1',
  ]) {
    assert.throws(
      () => workflowActionReferences(fixture, 'escape-mutation.yml'),
      /escaped YAML scalars are not allowed in workflow source/,
    );
  }
  assert.deepEqual(workflowActionReferences('# uses: ignored/comment@v1', 'comment.yml'), []);
});

test('current-tree secret scanning cannot be weakened with broad allowlists or path filters', () => {
  assert.equal(read('.gitleaks.toml'), 'title = "Hivra public current-tree secret scan"\n\n[extend]\nuseDefault = true\n');

  const fingerprints = read('.gitleaksignore').split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'));
  assert.equal(fingerprints.length, 68);
  assert.equal(new Set(fingerprints).size, fingerprints.length);
  for (const fingerprint of fingerprints) {
    assert.match(fingerprint, /^[^:\r\n]+:(?:curl-auth-header|discord-client-id|generic-api-key|private-key|stripe-access-token):\d+$/);
  }

  // Directory-scan fingerprints identify path/rule/line, not the matched
  // value. Bind every reviewed line to its content hash so replacing a fixture
  // with a real credential at the same line cannot inherit the exception.
  const reviewedLineMaterial = [...fingerprints].sort().map((fingerprint) => {
    const lineSeparator = fingerprint.lastIndexOf(':');
    const ruleSeparator = fingerprint.lastIndexOf(':', lineSeparator - 1);
    const file = fingerprint.slice(0, ruleSeparator);
    const lineNumber = Number(fingerprint.slice(lineSeparator + 1));
    const line = read(file).split(/\r?\n/)[lineNumber - 1];
    assert.notEqual(line, undefined, `${fingerprint} points outside its reviewed file`);
    return `${fingerprint}\0${createHash('sha256').update(line).digest('hex')}`;
  }).join('\n');

  const reviewedNonTestPaths = fingerprints
    .map((fingerprint) => fingerprint.slice(0, fingerprint.lastIndexOf(':', fingerprint.lastIndexOf(':') - 1)))
    .filter((file) => !/(?:__tests__|\/tests\/)/.test(file));
  assert.deepEqual([...new Set(reviewedNonTestPaths)].sort(), [
    'dashboard/auth.ts',
    'dashboard/src/components/landing/DemoVideoSection.tsx',
    'dashboard/src/data/curated-skills.ts',
    'dashboard/src/lib/blog/articles/hermes-agent-telegram-discord-setup.ts',
    'dashboard/src/lib/encryption-rotation.ts',
  ]);

  const workflow = read('.github/workflows/public-release-safety.yml');
  assert.doesNotMatch(workflow, /^\s+paths:/m);
  assert.match(workflow, /git archive "\$GITHUB_SHA"/);
  assert.match(workflow, /gitleaks_8\.29\.1_linux_x64\.tar\.gz/);
  assert.match(workflow, /e4eb209d04e20339d77122a3bdf9cd41351255cfb27ebcb75e85325e04f88924/);
  assert.match(workflow, /--redact=100/);
  assert.match(workflow, /--gitleaks-ignore-path "\$tree_ignore"/);
  assert.match(workflow, /public-release-metadata\.test\.mjs/);
  assert.match(workflow, /--max-archive-depth 2/);
  assert.match(workflow, /--max-decode-depth 3/);
  assert.match(workflow, /Gitleaks reported a scan\/parsing error; refusing a partial scan/);
  assert.match(workflow, /gitleaks-detector-probe\/synthetic-credential\.txt/);
  assert.match(workflow, /test "\$probe_code" -eq 1/);
  assert.match(workflow, /gitleaks-forced-text\/forced-text\.txt/);
  assert.match(workflow, /scan "\$RUNNER_TEMP\/gitleaks-forced-text"[\s\S]*?scan \.[\s\S]*?mv tests\/missed_call_demo\.browser\.cjs/,
    'the forced-text pass must succeed before the browser fixture is removed');
  assert.equal(sha256('tests/missed_call_demo.browser.cjs'),
    '8f6c56ebc1910e2a4e9b31f777afd5f9b2eb94a9bacbeaafb6eda07614367a2e');
  assert.equal(workflow.split(/gitleaks\/gitleaks" dir "\$target"/).length - 1, 1,
    'every pass must use the single fail-closed scan helper');
});

test('Operator OS is not a new-launch or private-build path in the public source candidate', () => {
  assert.equal(existsSync(path.join(root, '.github/workflows/operatoros-box-publish.yml')), false);
  assert.equal(existsSync(path.join(root, '.github/workflows/operatoros-save-images.yml')), false);
  assert.doesNotMatch(read('dashboard/src/lib/welcome-agent-catalog.ts'), /key:\s*["']operatoros["']/);
  assert.doesNotMatch(read('dashboard/src/components/dashboard/welcome/DeployForm.tsx'), /Agent Runtime|Operator OS/);
  assert.match(read('dashboard/src/lib/services/instance-service.ts'), /agentFlavor:\s*z\.literal\(["']vanilla["']\)/);
  assert.match(read('docs/release/RUNTIME-DISTRIBUTION.md'), /Compatibility only; no new launch or default image/);

});

test('Buzz and DeepSeek Harness identities stay exact and behind bounded adapters', () => {
  const roadmap = read('ROADMAP.md');
  const distribution = read('docs/release/RUNTIME-DISTRIBUTION.md');
  const assessment = distribution;

  assert.match(roadmap, /\[x\] Identify the exact Buzz project/);
  assert.match(assessment, /block\/buzz/);
  assert.match(assessment, /8dbc65d9e2c80d9d8516e17b751c46e0568100e6/);
  assert.match(assessment, /deepseek-ai\/deepseek-harness/);
  assert.match(assessment, /cd5ef8148158c3a752a658978873241fdf8e2bbc/);
  for (const exactEvidence of [
    '| Buzz | [`block/buzz`](https://github.com/block/buzz) | `8dbc65d9e2c80d9d8516e17b751c46e0568100e6` | Apache-2.0 |',
    '`desktop-v0.5.20` at `95154bee4034ca7a40b33095c2ddbde8c9aa1614`',
    'SHA-256 `0471456eaa7c3a4ab83ed93cc75d14b21eb57032f96bf2cfa49c0f9fa847bde6`',
    'official updater assets include detached Tauri signatures',
    '| DeepSeek Harness | [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) | `cd5ef8148158c3a752a658978873241fdf8e2bbc` | MIT |',
    '`dsh-v0.1.2-alpha.1`',
    '`@deepseek-ai/dsh@0.1.1-rc.2`',
    '`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`',
    '`sha512-UP1UIh6q3Gme/yXRn/QL2P8IsVlv8Shpg22TRJIZPsCRWLm4CBiA1MUvXmJAfsOEETBMLAl+xWPtFw6ICsN3wg==`',
    'proprietary Anthropic/Claude payloads',
  ]) assert.ok(assessment.includes(exactEvidence), exactEvidence);
  assert.match(distribution, /\| Buzz \|[^\n]+\| Connect;/);
  assert.match(distribution, /\| DeepSeek Harness \|[^\n]+\| Experimental operator-selected download \|/);
  assert.match(assessment, /not a replacement for Hivra's computer\s+boundary/);
  assert.match(assessment, /source adapters are part of the source-only candidate/);
  assert.match(assessment, /no Buzz image,\s+desktop artifact, DeepSeek package/);
  assert.match(assessment, /DeepSeek ACP acceptance/);
  assert.match(read('NOTICE'), /block\/buzz[\s\S]*deepseek-ai\/deepseek-harness/);
});

test('Fingerprint Pro stays outside the public dashboard artifact and requires hosted opt-in', () => {
  const manifest = read('dashboard/package.json');
  const lock = read('dashboard/package-lock.json');
  const client = read('dashboard/src/lib/abuse/client-fingerprint.ts');
  const distribution = read('docs/release/RUNTIME-DISTRIBUTION.md');
  const dashboardWorkflow = read('.github/workflows/dashboard-ci.yml');
  const artifactGuard = read('scripts/release/check-dashboard-public-artifact.mjs');

  assert.doesNotMatch(manifest, /@fingerprintjs\/fingerprintjs-pro/);
  assert.doesNotMatch(lock, /@fingerprintjs\/fingerprintjs-pro/);
  assert.doesNotMatch(client, /import\(["']@fingerprintjs\/fingerprintjs-pro["']\)/);
  assert.match(client, /if \(!apiKey\) return null/);
  assert.match(client, /FINGERPRINT_PRO_TIMEOUT_MS = 4_000/);
  assert.match(client, /withTimeout\([\s\S]*loadHostedFingerprintPro\(apiKey\)/);
  assert.match(client, /https:\/\/fpjscdn\.net\/v3\/\$\{encodeURIComponent\(apiKey\)\}\/iife\.min\.js/);
  assert.match(distribution, /Not present in the dashboard manifest, lockfile, or public build artifact/);
  assert.match(distribution, /an unconfigured self-host[\s\S]*without downloading Fingerprint code/);
  assert.match(dashboardWorkflow, /npm run verify:public-artifact/);
  assert.match(artifactGuard, /@fingerprintjs\/fingerprintjs-pro/);
  assert.match(artifactGuard, /Fingerprint v3\.12\.9 - Copyright \(c\) FingerprintJS, Inc, 2026/);
  assert.match(artifactGuard, /FORBIDDEN_SHA256/);
  assert.match(artifactGuard, /path === resolve\(artifactRoot, 'cache'\)/);
  const publicSafety = read('.github/workflows/public-release-safety.yml');
  assert.match(publicSafety, /check-dashboard-public-artifact\.test\.mjs/);
});
