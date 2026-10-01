import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  inspectPublicText,
  inspectPublicTree,
  isSyntheticWalletAddress,
  projectRefAllowlist,
  publicContractAddresses,
  walletAddressExemptPaths,
} from './public-tree-hygiene.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'hivra-public-tree-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root]);
  const write = (relative, content = 'safe fixture\n') => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), content);
  };
  const add = () => execFileSync('git', ['-C', root, 'add', '-A']);
  return { root, write, add };
}

test('a normal tracked source tree and explicit environment examples pass', (t) => {
  const f = fixture(t);
  f.write('src/index.ts');
  f.write('services/app/.env.example', 'SERVICE_TOKEN=replace-me\n');
  f.write('services/app/.env.box.template', 'SERVICE_TOKEN=replace-me\n');
  f.add();
  assert.deepEqual(inspectPublicTree(f.root), []);
});

test('generated output and sensitive filenames fail without exposing contents', (t) => {
  const f = fixture(t);
  f.write('dashboard/.next/cache/output.js');
  f.write('supabase/.temp/project-ref');
  f.write('tmp/phase0-baseline.txt');
  f.write('docs/audits/disposable-canary.md');
  f.write('.planning/STATE.md');
  f.write('articles/workflow-audit-2026-06-23.md');
  f.write('dashboard/hermes_upstream_audit.md');
  f.write('HIVRA_V1_REBUILD_PLAN.md');
  f.write('.github/workflows/first-run-audit.yml');
  f.write('change.diff');
  f.write('dashboard/public/roadmap/generated.docx');
  f.write('FEATURE_TRACKER.csv');
  f.write('FEATURE_TRACKER.md');
  f.write('dashboard/scripts/reconcile-migrations-2026-05-14.ts');
  f.write('dashboard/supabase/migrations/20260101000000_cleanup_orphan_customer.sql');
  f.write('services/app/.env.production', 'DO_NOT_PRINT_THIS_VALUE\n');
  f.write('keys/deploy_key', 'DO_NOT_PRINT_THIS_VALUE\n');
  f.add();
  const findings = inspectPublicTree(f.root);
  assert.deepEqual(findings.map((item) => item.category).sort(), [
    'generated-output', 'generated-output', 'generated-output', 'generated-output', 'generated-output',
    'generated-output', 'generated-output', 'generated-output', 'generated-output', 'generated-output',
    'generated-output', 'generated-output', 'generated-output', 'generated-output', 'generated-output',
    'sensitive-filename', 'sensitive-filename',
  ]);
  assert.doesNotMatch(JSON.stringify(findings), /DO_NOT_PRINT_THIS_VALUE/);
});

test('live operational identities fail while placeholders and documentation addresses pass', (t) => {
  const f = fixture(t);
  const fleetNode = (value) => ['pve', value].join('');
  f.write('.codex/skills/fleet/SKILL.md', 'ssh root@203.0.113.10\n');
  f.write('dashboard/scripts/smoke-canary-vm.sh', 'PVE_HOST="198.51.100.8"\nVM_IP="127.0.0.1"\n');
  f.write('.codex/skills/leaky/SKILL.md', `host ${fleetNode(42)} at 10.242.4.5\n`);
  const randomUuid = ['123e4567', 'e89b', '42d3', 'a456', '426614174000'].join('-');
  f.write('dashboard/scripts/verify-canary.ts', `instance ${randomUuid}\n`);
  f.write('.github/workflows/deploy.yml', `# runner ${fleetNode(7)} at 10.242.4.8\n`);
  f.write('dashboard/supabase/migrations/20260101000000_hosts.sql', `insert into hosts values ('${fleetNode(8)}');\n`);
  f.write('dashboard/supabase/migrations/20260101000001_network_policy.sql', [
    "select '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8';",
    "select '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '2026.08.28.1';",
  ].join('\n'));
  f.add();
  assert.deepEqual(inspectPublicTree(f.root), [
    { category: 'live-infrastructure-metadata', path: '.codex/skills/leaky/SKILL.md' },
    { category: 'live-infrastructure-metadata', path: '.github/workflows/deploy.yml' },
    { category: 'non-placeholder-uuid', path: 'dashboard/scripts/verify-canary.ts' },
    { category: 'live-infrastructure-metadata', path: 'dashboard/supabase/migrations/20260101000000_hosts.sql' },
  ]);
});

test('developer-local paths and deployed instance hostnames fail globally', (t) => {
  const f = fixture(t);
  const localPath = ['', 'Users', 'alice', '.ssh', 'admin'].join('/');
  const misleadingExamplePath = ['', 'Users', 'examplex', '.ssh', 'admin'].join('/');
  const instanceHost = ['abcdefabcdefabcdefab', 'agents', 'canary', 'hermesos', 'cloud'].join('.');
  const localTemp = ['', 'private', 'tmp', 'release-receipt'].join('/');
  f.write('docs/runbook.md', `${localPath}\n${localTemp}\nhttps://${instanceHost}\n`);
  f.write('docs/example.md', '/Users/example/.ssh/admin\nhttps://00000000000000000000.agents.hermesos.cloud\n');
  f.write('docs/not-an-example.md', `${misleadingExamplePath}\n`);
  f.add();
  assert.deepEqual(inspectPublicTree(f.root), [
    { category: 'developer-local-path', path: 'docs/not-an-example.md' },
    { category: 'developer-local-path', path: 'docs/runbook.md' },
    { category: 'live-instance-hostname', path: 'docs/runbook.md' },
  ]);
});

test('hosted identities, live fleet pairs, and public infrastructure addresses fail globally', (t) => {
  const f = fixture(t);
  const hostedId = ['user_', '3BrimH80SPnn3OXBqVOhRQa6uDV'].join('');
  const personalEmail = ['hmotto74', 'gmail.com'].join('@');
  const fleetPair = [['pve', '9'].join(''), 'vm937'].join('/');
  const publicAddress = ['31', '111', '180', '163'].join('.');
  const privateTopology = ['10', '70', '20', '5'].join('.');
  const publicSslip = ['31', '111', '180', '163'].join('-') + '.sslip.io';
  const sshKeyPath = ['', 'root', '.ssh', 'hermes-vm-orchestrator'].join('/');
  f.write('fixtures/account.txt', `${hostedId}\n`);
  f.write('fixtures/email.txt', `${personalEmail}\n`);
  f.write('fixtures/fleet.txt', `captured from ${fleetPair}\n`);
  f.write('fixtures/network.txt', `host ${publicAddress}\n`);
  f.write('fixtures/private-network.txt', `guest ${privateTopology}\n`);
  f.write('fixtures/sslip.txt', `https://${publicSslip}\n`);
  f.write('fixtures/ssh-key.txt', `${sshKeyPath}\n`);
  f.write('fixtures/placeholders.txt', 'user_fixture_pilot\n203.0.113.10\npve-fixture\n');
  f.add();
  assert.deepEqual(inspectPublicTree(f.root), [
    { category: 'hosted-account-identity', path: 'fixtures/account.txt' },
    { category: 'hosted-account-identity', path: 'fixtures/email.txt' },
    { category: 'live-infrastructure-metadata', path: 'fixtures/fleet.txt' },
    { category: 'public-network-address', path: 'fixtures/network.txt' },
    { category: 'public-network-address', path: 'fixtures/private-network.txt' },
    { category: 'operational-ssh-key-path', path: 'fixtures/ssh-key.txt' },
    { category: 'public-network-address', path: 'fixtures/sslip.txt' },
  ]);
});

test('renamed fleet metadata, private workflows, contextual ids, customer incidents, and omitted audit links fail closed', (t) => {
  const f = fixture(t);
  f.write('fixtures/fleet.txt', 'targets compute1,compute7 and redzero via example-node\n');
  f.write('.github/workflows/live.yml', 'runs-on: [self-hosted, homelab]\nurl: https://canary.hermesos.cloud\n');
  f.write('fixtures/ids.txt', 'incident row 7fd41bb9 on box-5f937d0e837e\n');
  f.write('fixtures/customer.txt', 'Alice / Bob incident regression\n');
  f.write('docs/architecture.md', '[private receipt](audits/live-host.md)\n');
  f.add();
  assert.deepEqual(inspectPublicTree(f.root), [
    { category: 'private-live-workflow-binding', path: '.github/workflows/live.yml' },
    { category: 'omitted-private-document-link', path: 'docs/architecture.md' },
    { category: 'named-customer-incident', path: 'fixtures/customer.txt' },
    { category: 'renamed-live-infrastructure-metadata', path: 'fixtures/fleet.txt' },
    { category: 'contextual-live-identifier', path: 'fixtures/ids.txt' },
  ]);
});

test('private-key markers are rejected from ordinary filenames', (t) => {
  const f = fixture(t);
  const begin = ['-----BEGIN ', 'OPENSSH PRIVATE KEY-----'].join('');
  const end = ['-----END ', 'OPENSSH PRIVATE KEY-----'].join('');
  f.write('fixtures/data.txt', `${begin}\nQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB\n${end}\n`);
  f.add();
  assert.deepEqual(inspectPublicTree(f.root), [
    { category: 'private-key-material', path: 'fixtures/data.txt' },
  ]);
});

test('PuTTY private-key bodies are rejected from ordinary filenames', (t) => {
  const f = fixture(t);
  const header = ['PuTTY-User-Key-', 'File-3: ssh-ed25519'].join('');
  const bodyLabel = ['Private-', 'Lines: 1'].join('');
  f.write('fixtures/putty.txt', `${header}\nEncryption: none\n${bodyLabel}\nQUFBQUFBQUFBQUFB\n`);
  f.add();
  assert.deepEqual(inspectPublicTree(f.root), [
    { category: 'private-key-material', path: 'fixtures/putty.txt' },
  ]);
});

test('tracked symlinks cannot bypass content inspection', (t) => {
  const f = fixture(t);
  f.write('target.txt');
  symlinkSync('target.txt', path.join(f.root, 'link.txt'));
  f.add();
  assert.deepEqual(inspectPublicTree(f.root), [
    { category: 'tracked-symlink', path: 'link.txt' },
  ]);
});

test('untracked local credentials are outside the proposed tracked-tree scope', (t) => {
  const f = fixture(t);
  f.write('src/index.ts');
  f.add();
  f.write('.env', 'DO_NOT_PRINT_THIS_VALUE\n');
  assert.deepEqual(inspectPublicTree(f.root), []);
});

test('a caller cannot narrow inspection to a repository subdirectory', (t) => {
  const f = fixture(t);
  f.write('safe/index.ts');
  f.write('outside/.env', 'DO_NOT_PRINT_THIS_VALUE\n');
  f.add();
  assert.throws(() => inspectPublicTree(path.join(f.root, 'safe')), /repository root/);
});


test('internal plans, personal skills and unrelated demos cannot return to public source', (t) => {
  const f = fixture(t);
  const paths = ['BUILD_PLAN.md', 'COMMAND_PANEL_OVERHAUL_PLAN.md', 'CONVERSION_PLAN.md',
    'STICKINESS_PLAN.md', 'HERMES_FORK_CHANGELOG.md', 'HIVRA_DOMAIN_CUTOVER.md',
    'writelikeahuman.md', 'gemini.md', 'missed-call-demo.html',
    'tests/missed_call_demo.browser.cjs', '.agents/skills/copywriting/SKILL.md',
    'docs/superpowers/plans/old-plan.md', 'dashboard/docs/superpowers/plans/old-plan.md',
    'docs/designs/prototype/index.html', 'docs/release/2026-01-01-internal-handoff.md'];
  for (const file of paths) f.write(file);
  f.write('README.md'); f.write('CHANGELOG.md'); f.write('docs/self-host/QUICKSTART.md');
  f.add();
  const findings = inspectPublicTree(f.root);
  assert.deepEqual(findings.map(v => v.path).sort(), paths.sort());
  assert.ok(findings.every(v => v.category === 'internal-working-material'));
});

// ---------------------------------------------------------------------------------------------
// Classes the gate used to miss: storage box hosts, raw wallet addresses, database project refs,
// fleet host numbers in environment variable names, and free text such as pull request bodies.
// Values are assembled with join() so this file does not name what it forbids.
// ---------------------------------------------------------------------------------------------

const address = (hex) => ['0', 'x', hex].join('');
const randomLooking = address('8f3a2b9c4d5e6f708192a3b4c5d6e7f809a1b2c3');
const randomLookingMixedCase = address('8F3a2B9c4D5e6F708192A3b4C5d6E7f809a1B2c3');
const usdcOnBase = address('833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');

test('a Hetzner Storage Box host fails, whatever the account name', (t) => {
  const f = fixture(t);
  const host = ['u123456', 'your-storagebox', 'de'].join('.');
  f.write('dashboard/docs/backups.md', `ssh to ${host} on port 23\n`);
  f.write('dashboard/docs/other.md', `${['box7', 'your-storagebox', 'de'].join('.')}\n`);
  f.write('dashboard/docs/placeholder.md', 'host: <storage-box-host> (HERMES_COLD_STORAGE_HOST)\n');
  f.write('dashboard/docs/vendor.md', 'Hetzner sells Storage Boxes; see the vendor site.\n');
  f.add();
  assert.deepEqual(inspectPublicTree(f.root), [
    { category: 'storage-box-host', path: 'dashboard/docs/backups.md' },
    { category: 'storage-box-host', path: 'dashboard/docs/other.md' },
  ]);
});

test('raw wallet addresses fail unless they are published contracts or plainly made up', (t) => {
  const f = fixture(t);
  f.write('fixtures/real.ts', `const depositAddress = "${randomLooking}";\n`);
  f.write('fixtures/real-checksummed.ts', `const a = "${randomLookingMixedCase}";\n`);
  f.write('fixtures/contract.ts', `const usdc = "${usdcOnBase}";\nconst lower = "${usdcOnBase.toLowerCase()}";\n`);
  f.write('fixtures/synthetic.ts', [
    address('0000000000000000000000000000000000000000'),
    address('1111111111111111111111111111111111111111'),
    address('000000000000000000000000000000000000dEaD'),
    address('000000000000000000000000000000000000c0fe'),
    address('0000000000000000000000000000000000001E6a'),
    address('deaddeaddeaddeaddeaddeaddeaddeaddeaddead'),
    address('1234567890123456789012345678901234567890'),
    address('1234567890abcdef1234567890abcdef12345678'),
    address('abcdefabcdefabcdefabcdefabcdefabcdefabcd'),
  ].join('\n'));
  // 64 hex digits is a transaction hash or a padded topic, not an address.
  f.write('fixtures/hash.ts', `const tx = "${address('8f3a2b9c4d5e6f708192a3b4c5d6e7f809a1b2c38f3a2b9c4d5e6f708192a3b4')}";\n`);
  f.add();
  assert.deepEqual(inspectPublicTree(f.root), [
    { category: 'raw-wallet-address', path: 'fixtures/real-checksummed.ts' },
    { category: 'raw-wallet-address', path: 'fixtures/real.ts' },
  ]);
});

test('vendored skill text may list public contract addresses, and only that path', (t) => {
  const f = fixture(t);
  f.write('dashboard/src/data/curated-skills.ts', `Token: \`${randomLooking}\`\n`);
  f.write('dashboard/src/data/other-skills.ts', `Token: \`${randomLooking}\`\n`);
  f.add();
  assert.deepEqual(inspectPublicTree(f.root), [
    { category: 'raw-wallet-address', path: 'dashboard/src/data/other-skills.ts' },
  ]);
});

test('the synthetic-address test separates made-up values from random ones', () => {
  for (const made of ['0000000000000000000000000000000000000001', 'ffffffffffffffffffffffffffffffffffffffff',
    'cafecafecafecafecafecafecafecafecafecafe', '0000000000000000000000000000000000abcdef']) {
    assert.equal(isSyntheticWalletAddress(address(made)), true, made);
  }
  for (const random of ['8f3a2b9c4d5e6f708192a3b4c5d6e7f809a1b2c3', 'f39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    '00000000219ab540356cbb839cbe05303d7705fa']) {
    assert.equal(isSyntheticWalletAddress(address(random)), false, random);
  }
});

test('a known database project ref fails by digest, without the ref being named in the gate', (t) => {
  const f = fixture(t);
  const ref = ['abcdefghij', 'klmnopqrst'].join('');
  const digests = new Set([createHash('sha256').update(ref).digest('hex')]);
  f.write('docs/runbook.md', `apply to project ${ref} first\n`);
  f.write('docs/other-ref.md', `apply to project ${['qrstuvwxyz', 'abcdefghij'].join('')} first\n`);
  f.write('docs/words.md', 'internationalization and responsibilities are long words\n');
  f.add();
  assert.deepEqual(inspectPublicTree(f.root, { projectRefDigests: digests }), [
    { category: 'database-project-ref', path: 'docs/runbook.md' },
  ]);
  assert.deepEqual(inspectPublicTree(f.root, {
    projectRefDigests: digests,
    projectRefAllowlist: new Map([['docs/runbook.md', 'fixture reason']]),
  }), []);
});

test('fleet host numbers fail in environment variable names too, while user examples pass', (t) => {
  const f = fixture(t);
  const host = (n) => ['pve', n].join('');
  f.write('fixtures/env.txt', `PROXMOX_${host(11).toUpperCase()}_SSH_HOST=example\n`);
  f.write('fixtures/label.txt', `ssh ${host(13)}.internal.example\n`);
  f.write('fixtures/lower-env.txt', `export HIVRA_${host(12)}_TEMPLATE_ID=1\n`);
  f.write('fixtures/user-example.txt', 'externalId: "pve-01"\nname: pve-fixture\n');
  f.write('fixtures/base64.txt', `integrity sha512-Ab${host(9)}Zy+Qq/9==\n`);
  f.write('fixtures/camel.txt', 'function seedNodeNineTargetEnv() {}\n');
  f.add();
  assert.deepEqual(inspectPublicTree(f.root), [
    { category: 'live-infrastructure-metadata', path: 'fixtures/env.txt' },
    { category: 'live-infrastructure-metadata', path: 'fixtures/label.txt' },
    { category: 'live-infrastructure-metadata', path: 'fixtures/lower-env.txt' },
  ]);
});

test('pull request text is scanned with the same rules', () => {
  const host = ['pve', '21'].join('');
  const dirty = [
    `Fixes the restart loop on ${host}`,
    `Account ${['user_', '3BrimH80SPnn3OXBqVOhRQa6uDV'].join('')} was affected`,
    `Backups go to ${['u123456', 'your-storagebox', 'de'].join('.')}`,
    `Paid to ${randomLooking}`,
    `Guest at ${['10', '70', '20', '63'].join('.')}`,
  ].join('\n');
  assert.deepEqual(inspectPublicText(dirty, 'PR 1').map((item) => item.category), [
    'hosted-account-identity', 'live-infrastructure-metadata', 'public-network-address',
    'raw-wallet-address', 'storage-box-host',
  ]);
  assert.ok(inspectPublicText(dirty, 'PR 1').every((item) => item.path === 'PR 1'));
  assert.deepEqual(inspectPublicText('Adds a retry to the billing cron.\nTests: jest, 4 suites.\n'), []);
  // No path exemption applies to free text, so the vendored-skill path rule cannot hide an address.
  assert.ok(inspectPublicText(`Token: ${randomLooking}`).length > 0);
});

test('the text scan works from the command line and exits non-zero on a finding', (t) => {
  const f = fixture(t);
  const body = path.join(f.root, 'pr-body.txt');
  writeFileSync(body, `Restarted ${['pve', '19'].join('')} by hand\n`);
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), 'public-tree-hygiene.mjs');
  assert.throws(() => execFileSync('node', [script, '--text-file', body], { stdio: 'pipe' }), (error) => {
    assert.match(String(error.stderr), /live-infrastructure-metadata/);
    return true;
  });
  writeFileSync(body, 'Adds a retry to the billing cron.\n');
  assert.match(execFileSync('node', [script, '--text-file', body], { encoding: 'utf8' }), /"status":"pass"/);
});

// ---------------------------------------------------------------------------------------------
// The allowlists describe this repository, so they are checked against this repository.
// ---------------------------------------------------------------------------------------------

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const addressPattern = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

test('the current tree passes the gate', () => {
  assert.deepEqual(inspectPublicTree(repoRoot), []);
});

test('every database project ref allowlist entry is still needed', () => {
  const flagged = inspectPublicTree(repoRoot, { projectRefAllowlist: new Map() })
    .filter((finding) => finding.category === 'database-project-ref')
    .map((finding) => finding.path)
    .sort();
  assert.deepEqual(flagged, [...projectRefAllowlist.keys()].sort(),
    'each allowlisted file must still name a project ref, and no other file may');
  for (const [file, reason] of projectRefAllowlist) assert.ok(reason.length >= 20, `${file} needs a reason`);
});

test('every published-contract and exempt-path entry is still used', () => {
  const tracked = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
    .split('\0').filter(Boolean);
  const seen = new Set();
  for (const file of tracked) {
    let text;
    try { text = readFileSync(path.join(repoRoot, file), 'utf8'); } catch { continue; }
    for (const match of text.matchAll(addressPattern)) seen.add(match[0].toLowerCase());
  }
  for (const [value, reason] of publicContractAddresses) {
    assert.ok(reason.length >= 10, `${value} needs a reason`);
    assert.ok(seen.has(value), `stale published-contract entry ${value}: no tracked file names it`);
  }
  for (const [file, reason] of walletAddressExemptPaths) {
    assert.ok(reason.length >= 10, `${file} needs a reason`);
    assert.ok(tracked.includes(file), `stale exempt path ${file}`);
    const text = readFileSync(path.join(repoRoot, file), 'utf8');
    assert.ok([...text.matchAll(addressPattern)]
      .some((match) => !publicContractAddresses.has(match[0].toLowerCase()) && !isSyntheticWalletAddress(match[0])),
    `${file} no longer needs its exemption`);
  }
});
