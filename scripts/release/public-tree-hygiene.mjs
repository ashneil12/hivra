#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const commandOptions = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 };

const generatedPaths = [
  /(^|\/)(?:node_modules|\.next(?: \d+)?|\.vercel|\.turbo|dist|build|out|coverage|\.jest-cache|\.ruff_cache|__pycache__)(\/|$)/,
  /(^|\/)supabase\/\.temp(\/|$)/,
  /(^|\/)(?:\.DS_Store|Thumbs\.db)$/,
  /(?:\.tsbuildinfo|\.pyc)$/,
  /(^|\/)next-env\.d\.ts$/,
  /^tmp(\/|$)/,
  /^docs\/audits(\/|$)/,
  /^\.planning(\/|$)/,
  /(^|\/)(?:workflow-audit-\d{4}-\d{2}-\d{2}|hermes_upstream_audit)\.md$/i,
  /^(?:HIVRA_V1_REBUILD_PLAN|VENICE_ALL_AGENTS_PLAN|VERCEL_COST_REDUCTION_PLAN|ONBOARDING_REVAMP_PLAN)\.md$/,
  /^\.github\/workflows\/(?:browser-sidecar-publish|dashboard-e2e|first-run-audit)\.yml$/,
  /(^|\/)change\.diff$/,
  /^dashboard\/public\/roadmap\/.*\.docx$/i,
  /^dashboard\/scripts\/reconcile-migrations-[^/]+\.(?:js|ts)$/,
  /^dashboard\/supabase\/migrations\/[^/]*(?:cleanup_orphan|nuke_proxmox)[^/]*\.sql$/,
  /^(?:FEATURE_TRACKER\.csv|FEATURE_TRACKER\.md)$/,
];

const internalWorkingPaths = [
  /^\.agents(\/|$)/,
  /^[^/]*_PLAN\.md$/i,
  /^(?:BENCHMARK_AFTER|HERMES_FORK_CHANGELOG|HIVRA_DOMAIN_CUTOVER|PATCHES|gemini|writelikeahuman)\.md$/i,
  /^missed-call-demo\.html$/,
  /^tests\/(?:missed_call_demo\.browser\.cjs|test_missed_call_demo\.py)$/,
  /^(?:dashboard\/)?docs\/superpowers\/plans(\/|$)/,
  /^docs\/(?:designs|design-reviews|operations|verification)(\/|$)/,
  /^docs\/litepaper\/review(\/|$)/,
  /^docs\/release\/\d{4}-\d{2}-\d{2}[^/]*\.md$/,
  /^docs\/(?:chat-durability-sidecar-plan|sprint-2-resource-discipline-brief)\.md$/,
  /^docs\/release\/PREPARATION-2026-09-21\.md$/,
];

const uuidExemptPaths = new Set([
  // Upstream/artifact identities with separately reviewed provenance.
  'dashboard/scripts/omarchy-proxmox-lab.ts',
  'dashboard/src/data/agency-templates.json',
  'docs/release/asset-generation-records.json',
]);
const permittedStandardUuids = new Set([
  // RFC 6455 WebSocket GUID and a conventional UUID documentation fixture.
  '258eafa5-e914-47da-95ca-c5ab0dc85b11',
  '123e4567-e89b-12d3-a456-426614174000',
  // Microsoft's SoftwareLicensingProduct ApplicationID for the Windows operating
  // system. A published OS constant, not customer data: it appears in the
  // documented `Get-CimInstance SoftwareLicensingProduct` query that decides
  // whether a Windows guest is licensed. Rewriting it makes $licensed empty and
  // reports an unlicensed guest as licensed, so it must survive sanitisation.
  '55c92734-d682-4d71-983e-d6ec3f16059f',
]);
// A fleet host number: "pve" followed by digits, as a bare name, as a hostname label, or inside
// an environment variable name (an underscore on either side still counts as a boundary).
// Letters and digits around it keep identifiers and base64 text that merely contain "pve" from
// matching.
const liveHostName = /(?<![A-Za-z0-9])pve\d+(?![A-Za-z0-9])/i;
const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const developerHome = /\/Users\/([^/\s"'`]+)/g;
const developerTemp = /\/private\/tmp(?:\/|\b)/;
const deployedInstanceHostname = /\b(?!0{20}\b)[0-9a-f]{20,}\.(?:agents\.)?(?:[a-z0-9-]+\.)*(?:hermesos|hivra)\.cloud\b/i;
// Clerk identifiers: user, organisation, session and instance ids, plus live publishable keys.
const hostedAccountId = /\b(?:user|org|sess|ins)_[A-Za-z0-9]{20,}\b|\bpk_live_[A-Za-z0-9]{20,}/;
const knownPersonalEmail = /\b(?:ash(?:jeff|eff)\d*|hmotto\d*)@(?:gmail|hotmail|outlook|icloud)\.com\b/i;
const liveFleetIdentityPair = /\bpve\d+\s*\/\s*vm\d+\b/i;
const sslipIpv4 = /\b((?:\d{1,3}-){3}\d{1,3})\.sslip\.io\b/gi;
const namedOperationalSshKey = /(?:\/root|~)\/\.ssh\/(?:hermes[^/\s"'`]*|id_hermes|key)\b/i;
const renamedFleetIdentity = /\b(?:compute\d+|example-node|(?:pve-|host-|atlas-)?redzero)\b/i;
const privateWorkflowBinding = /(?:runs-on:\s*\[[^\]]*\bhomelab\b|https:\/\/canary\.hermesos\.cloud|\b(?:CANARY_CLERK|CANARY_SUPABASE|HETZNER_TOKEN)\b)/i;
const liveBoxFragment = /\bbox-[0-9a-f]{8,16}\b/i;
const contextualLiveId = /\b(?:prod\s+row|canary\s+run|live[- ]verified[^\n]{0,24}box|incident(?:\s+row)?)\b[^\n]{0,64}\b[0-9a-f]{8,16}\b/i;
const namedIncident = /\b[A-Z][a-z]{2,20}\s*\/\s*[A-Z][a-z]{2,20}\s+incident\b/;
const omittedAuditLink = /\]\((?:\.\.\/)*audits\/[^)]+\)/i;
// Hetzner Storage Box hosts (<account>.your-storagebox.de). The host and account name belong in
// deployment configuration, never in a public tree.
const storageBoxHost = /\b[a-z0-9-]+\.your-storagebox\.de\b/i;

// Supabase project refs are 20 lowercase letters. The refs of this deployment's databases are
// kept as SHA-256 digests so that naming them here does not publish them. To add one, hash the
// lowercase ref with `printf %s REF | shasum -a 256`.
const projectRefToken = /(?<![a-z0-9])[a-z]{20}(?![a-z0-9])/g;
const knownProjectRefDigests = new Set([
  'd6ed0887d164f35fa7525e495bdb68e58a24fbdd2b45842b364512848f3866a7',
  'b070375434b797f9baea484ad36e755e5556b7fd251fa417227fb0518d5d253d',
]);
// Files that may still name a project ref. Each entry needs a reason and must stay live: the test
// fails when the ref is gone from the file, so the list cannot rot.
// Empty since 2026-10-10: the three security docs that used to be allowed now point at the private
// ops notes instead, so no tracked file names a database project ref.
export const projectRefAllowlist = new Map();

// EVM addresses. A raw address in a fixture is either a published contract, an obviously made-up
// value, or a real wallet that should not be in a public tree. Real wallets are what this rule is
// for, so published contracts and made-up values pass and everything else is reported.
const walletAddress = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
export const publicContractAddresses = new Map([
  ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC on Base'],
  ['0x4200000000000000000000000000000000000006', 'Wrapped ether predeploy on Base'],
  ['0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', 'First account of the public Anvil and Hardhat test mnemonic'],
  ['0x95ccfd2b81a9667b0cc979992632f98fc853eba3', 'HermesOS token contract (HERMESOS_TOKEN_ADDRESS in the billing code)'],
  ['0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf', 'VVV token contract (VVV_TOKEN_ADDRESS in the billing code)'],
  ['0x22af33fe49fd1fa80c7149773dde5890d3c76f3b', 'BNKR token contract (BNKR_CONTRACT in the wallet code)'],
  ['0xf4d97f2da56e8c3098f3a8d538db630a2606a024', 'DIEM token contract (DIEM_CONTRACT in the wallet code)'],
  ['0x321b7ff75154472b18edb199033ff4d116f340ff', 'sVVV staking contract (VENICE_SVVV_STAKING_CONTRACT in token-holdings.ts)'],
  ['0x316ffb9c875f900adcf04889e415cc86b564eba3', 'Token contract named in the vendored curated skill text (curated-skills.ts)'],
  ['0x52908400098527886e0f7030069857d2e4169ee7', 'Made-up address with a valid EIP-55 checksum, marked as such in the activation script tests'],
]);
// Third-party skill text that lists public DeFi contracts. It is vendored content, not wallets.
export const walletAddressExemptPaths = new Map([
  ['dashboard/src/data/curated-skills.ts', 'Vendored skill text that lists public protocol contracts.'],
]);

// Made-up addresses are easy to tell from random ones: few distinct digits, a short repeating
// block (0xdead...dead, 0x1234567890 repeated), or a long run of leading zeros (0x000...0a11).
// A random 40-digit address has about 15 distinct digits and no period.
export function isSyntheticWalletAddress(address) {
  const digits = address.slice(2).toLowerCase();
  if (new Set(digits).size <= 6) return true;
  if (/^0{24,}/.test(digits)) return true;
  for (let period = 1; period <= 20; period += 1) {
    let repeats = true;
    for (let index = period; index < digits.length && repeats; index += 1) {
      repeats = digits[index] === digits[index - period];
    }
    if (repeats) return true;
  }
  return false;
}

const hygieneRuleFixturePaths = new Set([
  'scripts/release/public-tree-hygiene.mjs',
  'scripts/release/public-tree-hygiene.test.mjs',
]);

function isPermittedPlaceholderUuid(value) {
  return /^00000000-0000-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ||
    new Set(value.replaceAll('-', '').toLowerCase()).size <= 3;
}

function isPermittedDocumentationAddress(value) {
  return value.startsWith('0.') || value.startsWith('127.') || value.startsWith('169.254.') ||
    /^(?:10\.(?:240|241|242|250|251|252|253|254)\.|10\.(?:0\.0\.0|255\.255\.255)$)/.test(value) ||
    /^(?:192\.168\.(?:0|1)\.|172\.(?:16\.0\.|18\.|31\.255\.))/.test(value) ||
    /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(value) ||
    value.startsWith('192.0.2.') || value.startsWith('198.51.100.') || value.startsWith('203.0.113.') ||
    value.startsWith('198.18.') || value.startsWith('198.19.') ||
    /^22[4-9]\.|^23\d\.|^24\d\.|^25[0-5]\./.test(value) ||
    value.startsWith('192.0.0.') || value.startsWith('192.88.99.') ||
    ['1.0.0.1', '1.1.1.1', '8.8.4.4', '8.8.8.8', '9.9.9.9', '11.0.0.1',
      '76.76.21.21', '93.184.216.34', '100.63.0.1', '100.128.0.1', '172.15.0.1',
      '172.32.0.1', '185.12.64.1', '185.12.64.2', '193.168.0.1', '213.239.239.165'].includes(value);
}

function isValidIpv4(value) {
  const parts = value.split('.');
  if (parts.some((part) => part.length > 1 && part.startsWith('0'))) return false;
  const octets = parts.map(Number);
  return octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
}

const sensitivePaths = [
  /(^|\/)(?:id_rsa|id_ed25519|deploy_key|temp_key|user_token\.json|oauth_creds\.json|credentials\.json|service-account\.json|kubeconfig)$/i,
  /(^|\/)(?:\.npmrc|\.pypirc|\.netrc|\.envrc|\.dev\.vars|\.git-credentials)$/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)\.kube\/config$/i,
  /\.(?:pem|key|ppk|p12|pfx|jks|kdbx)$/i,
];

const privateKeyMarker = new RegExp([
  '-----BEGIN ', '(?:[A-Z0-9 ]+ )?', 'PRIVATE KEY-----', '\\r?\\n',
  '(?:[A-Za-z0-9+/=]{20,}\\r?\\n)+', '-----END ', '(?:[A-Z0-9 ]+ )?', 'PRIVATE KEY-----',
].join(''));
const puttyPrivateKeyMarker = new RegExp([
  'PuTTY-User-Key-File-', '\\d+:', '[\\s\\S]{0,500}', 'Private-Lines:', '\\s*[1-9]',
].join(''));

function git(root, args) {
  try { return execFileSync('git', ['-C', root, ...args], commandOptions); }
  catch { throw new Error('Cannot inspect the selected Git checkout.'); }
}

function isEnvironmentFile(file) {
  const base = path.posix.basename(file);
  return /^\.env(?:\..+)?$/i.test(base) && !/\.(?:example|sample|template)$/i.test(base);
}

// Content rules shared by the tracked-tree scan and the text scan. `file` is the repository path
// for a tracked file and null for free text such as a pull request title or body, where no path
// exemption applies.
function contentCategories(content, file, options = {}) {
  const allowedProjectRefFiles = options.projectRefAllowlist ?? projectRefAllowlist;
  const isRuleFixture = file !== null && hygieneRuleFixturePaths.has(file);
  const categories = [];
  if (privateKeyMarker.test(content) || puttyPrivateKeyMarker.test(content)) {
    categories.push('private-key-material');
  }
  if ([...content.matchAll(developerHome)].some((match) => match[1] !== 'example') || developerTemp.test(content)) {
    categories.push('developer-local-path');
  }
  if (deployedInstanceHostname.test(content)) categories.push('live-instance-hostname');
  if (hostedAccountId.test(content) || knownPersonalEmail.test(content)) {
    categories.push('hosted-account-identity');
  }
  if (liveHostName.test(content) || liveFleetIdentityPair.test(content)) {
    categories.push('live-infrastructure-metadata');
  }
  const containsUnredactedAddress = [...content.matchAll(ipv4)]
    .some((match) => isValidIpv4(match[0]) && !isPermittedDocumentationAddress(match[0]));
  const containsUnredactedSslipAddress = [...content.matchAll(sslipIpv4)]
    .map((match) => match[1].replaceAll('-', '.'))
    .some((value) => isValidIpv4(value) && !isPermittedDocumentationAddress(value));
  if (containsUnredactedAddress || containsUnredactedSslipAddress) categories.push('public-network-address');
  if (namedOperationalSshKey.test(content)) categories.push('operational-ssh-key-path');
  if (!isRuleFixture && renamedFleetIdentity.test(content)) {
    categories.push('renamed-live-infrastructure-metadata');
  }
  if (file !== null && file.startsWith('.github/workflows/') && privateWorkflowBinding.test(content)) {
    categories.push('private-live-workflow-binding');
  }
  if (!isRuleFixture && (liveBoxFragment.test(content) || contextualLiveId.test(content))) {
    categories.push('contextual-live-identifier');
  }
  if (!isRuleFixture && namedIncident.test(content)) categories.push('named-customer-incident');
  if (!isRuleFixture && omittedAuditLink.test(content)) categories.push('omitted-private-document-link');
  if (storageBoxHost.test(content)) categories.push('storage-box-host');
  if (!allowedProjectRefFiles.has(file) && containsKnownProjectRef(content, options.projectRefDigests ?? knownProjectRefDigests)) {
    categories.push('database-project-ref');
  }
  if (!walletAddressExemptPaths.has(file) && containsRealLookingWalletAddress(content)) {
    categories.push('raw-wallet-address');
  }
  const containsUnredactedUuid = !(file !== null && uuidExemptPaths.has(file)) &&
    [...content.matchAll(uuid)].some((match) =>
      !isPermittedPlaceholderUuid(match[0]) && !permittedStandardUuids.has(match[0].toLowerCase()));
  if (containsUnredactedUuid) categories.push('non-placeholder-uuid');
  return categories;
}

function containsKnownProjectRef(content, digests) {
  for (const match of content.matchAll(projectRefToken)) {
    if (digests.has(createHash('sha256').update(match[0]).digest('hex'))) return true;
  }
  return false;
}

function containsRealLookingWalletAddress(content) {
  return [...content.matchAll(walletAddress)].some((match) =>
    !publicContractAddresses.has(match[0].toLowerCase()) && !isSyntheticWalletAddress(match[0]));
}

export function inspectPublicTree(root, options = {}) {
  root = realpathSync(root);
  const repositoryRoot = realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim());
  if (root !== repositoryRoot) throw new Error('The selected checkout must be the Git repository root.');
  const entries = git(root, ['ls-files', '-s', '-z']).split('\0').filter(Boolean).map((entry) => {
    const match = entry.match(/^(\d{6}) [0-9a-f]+ \d+\t([\s\S]+)$/);
    if (!match) throw new Error('Git returned an unsupported index entry.');
    return { mode: match[1], file: match[2] };
  });
  const findings = [];

  for (const { mode, file } of entries) {
    const normalized = file.replaceAll('\\', '/');
    if (generatedPaths.some((pattern) => pattern.test(normalized))) {
      findings.push({ category: 'generated-output', path: normalized });
      continue;
    }
    if (internalWorkingPaths.some((pattern) => pattern.test(normalized))) {
      findings.push({ category: 'internal-working-material', path: normalized });
      continue;
    }
    if (isEnvironmentFile(normalized) || sensitivePaths.some((pattern) => pattern.test(normalized))) {
      findings.push({ category: 'sensitive-filename', path: normalized });
      continue;
    }
    if (mode === '120000') {
      findings.push({ category: 'tracked-symlink', path: normalized });
      continue;
    }
    if (mode !== '100644' && mode !== '100755') {
      findings.push({ category: 'unsupported-file-mode', path: normalized });
      continue;
    }
    const absolute = path.join(root, normalized);
    let metadata;
    try { metadata = lstatSync(absolute); }
    catch { findings.push({ category: 'missing-index-file', path: normalized }); continue; }
    if (!metadata.isFile() || realpathSync(absolute) !== absolute) {
      findings.push({ category: 'non-regular-file', path: normalized });
      continue;
    }
    if (statSync(absolute).size > 25 * 1024 * 1024) {
      findings.push({ category: 'oversized-unreviewed-file', path: normalized });
      continue;
    }
    const bytes = readFileSync(absolute);
    if (!bytes.includes(0)) {
      for (const category of contentCategories(bytes.toString('utf8'), normalized, options)) {
        findings.push({ category, path: normalized });
      }
    }
  }

  return findings.sort((a, b) => a.path.localeCompare(b.path) || a.category.localeCompare(b.category));
}

// Scan free text, such as a pull request title and body, with the same content rules. Pull
// request text is public and outlives the tree: edit history stays visible. Returns findings
// shaped like the tree scan's, with `path` set to `label`.
export function inspectPublicText(text, label = 'text') {
  return contentCategories(String(text), null)
    .map((category) => ({ category, path: label }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--text-file') {
    const text = readFileSync(args[1] === '-' ? 0 : args[1], 'utf8');
    const findings = inspectPublicText(text, args[1] === '-' ? 'stdin' : args[1]);
    if (findings.length) {
      console.error(JSON.stringify({ status: 'blocked', findings }));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ status: 'pass' }));
    }
    return;
  }
  let root;
  if (args.length === 0) root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  else if (args.length === 2 && args[0] === '--root') root = args[1];
  else throw new Error('Usage: node scripts/release/public-tree-hygiene.mjs [--root CHECKOUT | --text-file FILE|-]');

  const findings = inspectPublicTree(root);
  if (findings.length) {
    console.error(JSON.stringify({ status: 'blocked', findings }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ status: 'pass', trackedFilesChecked: git(root, ['ls-files', '-z']).split('\0').filter(Boolean).length }));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Public-tree hygiene failed.');
    process.exitCode = 1;
  }
}
