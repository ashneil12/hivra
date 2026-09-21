import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inspectPublicTree } from './public-tree-hygiene.mjs';

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
