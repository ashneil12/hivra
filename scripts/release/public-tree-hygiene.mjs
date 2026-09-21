#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
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
const liveHostName = /\bpve\d+\b/i;
const uuid = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const developerHome = /\/Users\/([^/\s"'`]+)/g;
const developerTemp = /\/private\/tmp(?:\/|\b)/;
const deployedInstanceHostname = /\b(?!0{20}\b)[0-9a-f]{20,}\.(?:agents\.)?(?:[a-z0-9-]+\.)*(?:hermesos|hivra)\.cloud\b/i;
const hostedAccountId = /\buser_[A-Za-z0-9]{20,}\b/;
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

export function inspectPublicTree(root) {
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
      const content = bytes.toString('utf8');
      if (privateKeyMarker.test(content) || puttyPrivateKeyMarker.test(content)) {
        findings.push({ category: 'private-key-material', path: normalized });
      }
      if ([...content.matchAll(developerHome)].some((match) => match[1] !== 'example') || developerTemp.test(content)) {
        findings.push({ category: 'developer-local-path', path: normalized });
      }
      if (deployedInstanceHostname.test(content)) {
        findings.push({ category: 'live-instance-hostname', path: normalized });
      }
      if (hostedAccountId.test(content) || knownPersonalEmail.test(content)) {
        findings.push({ category: 'hosted-account-identity', path: normalized });
      }
      if (liveHostName.test(content) || liveFleetIdentityPair.test(content)) {
        findings.push({ category: 'live-infrastructure-metadata', path: normalized });
      }
      const containsUnredactedAddress = [...content.matchAll(ipv4)]
        .some((match) => isValidIpv4(match[0]) && !isPermittedDocumentationAddress(match[0]));
      const containsUnredactedSslipAddress = [...content.matchAll(sslipIpv4)]
        .map((match) => match[1].replaceAll('-', '.'))
        .some((value) => isValidIpv4(value) && !isPermittedDocumentationAddress(value));
      if (containsUnredactedAddress || containsUnredactedSslipAddress) {
        findings.push({ category: 'public-network-address', path: normalized });
      }
      if (namedOperationalSshKey.test(content)) {
        findings.push({ category: 'operational-ssh-key-path', path: normalized });
      }
      if (!hygieneRuleFixturePaths.has(normalized) && renamedFleetIdentity.test(content)) {
        findings.push({ category: 'renamed-live-infrastructure-metadata', path: normalized });
      }
      if (normalized.startsWith('.github/workflows/') && privateWorkflowBinding.test(content)) {
        findings.push({ category: 'private-live-workflow-binding', path: normalized });
      }
      if (!hygieneRuleFixturePaths.has(normalized) && (liveBoxFragment.test(content) || contextualLiveId.test(content))) {
        findings.push({ category: 'contextual-live-identifier', path: normalized });
      }
      if (!hygieneRuleFixturePaths.has(normalized) && namedIncident.test(content)) {
        findings.push({ category: 'named-customer-incident', path: normalized });
      }
      if (!hygieneRuleFixturePaths.has(normalized) && omittedAuditLink.test(content)) {
        findings.push({ category: 'omitted-private-document-link', path: normalized });
      }
      const containsUnredactedUuid = !uuidExemptPaths.has(normalized) &&
        [...content.matchAll(uuid)].some((match) =>
          !isPermittedPlaceholderUuid(match[0]) && !permittedStandardUuids.has(match[0].toLowerCase()));
      if (containsUnredactedUuid) {
        findings.push({ category: 'non-placeholder-uuid', path: normalized });
      }
    }
  }

  return findings.sort((a, b) => a.path.localeCompare(b.path) || a.category.localeCompare(b.category));
}

function main() {
  const args = process.argv.slice(2);
  let root;
  if (args.length === 0) root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  else if (args.length === 2 && args[0] === '--root') root = args[1];
  else throw new Error('Usage: node scripts/release/public-tree-hygiene.mjs [--root CHECKOUT]');

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
