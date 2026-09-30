#!/usr/bin/env node
// Detector self-test for the custom gitleaks rules in .gitleaks.toml.
//
//   node scripts/release/gitleaks-format-probe.mjs write <dir>
//   node scripts/release/gitleaks-format-probe.mjs verify <gitleaks-report.json>
//
// `write` fills <dir> with freshly generated random tokens in every format this
// repository issues, placed where the default gitleaks rules do not look: bare
// on a line, inside prose, in a neutrally named variable and in a JSON list.
// CI scans that directory with the repository config and then runs `verify`,
// which fails unless every custom rule reported at least one finding. A config
// edit that silently disables a rule, or a gitleaks upgrade that changes how
// rules load, fails the job instead of passing with less coverage.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CUSTOM_RULE_IDS = [
  'hivra-managed-venice-proxy-key',
  'hivra-activity-collector-token',
  'hivra-server-enrollment-code',
  'bankr-api-key',
  'supabase-secret-key',
];

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function fromAlphabet(alphabet, length, random) {
  let out = '';
  for (const byte of random(length)) out += alphabet[byte % alphabet.length];
  return out;
}

const base64url = (length, random) => random(length).toString('base64url');

export function generateProbeTokens(random = randomBytes) {
  return {
    'hivra-managed-venice-proxy-key': `hven_live_${base64url(32, random)}`,
    'hivra-activity-collector-token': `hvra_otlp_v1.${base64url(24, random)}.${base64url(32, random)}`,
    'hivra-server-enrollment-code': `hse1_${fromAlphabet(BASE32, 32, random)}`,
    'bankr-api-key': `bk_${fromAlphabet(ALNUM, 40, random)}`,
    'supabase-secret-key': `sb_secret_${base64url(30, random)}`,
  };
}

// One file per context. Every token appears in at least one neutral context.
export function probeFiles(tokens) {
  const t = tokens;
  return {
    'bare.txt': `${Object.values(t).join('\n')}\n`,
    'prose.md': `Paste ${t['hivra-managed-venice-proxy-key']} and run it. The code ${t['hivra-server-enrollment-code']} works once.\n`,
    'neutral.ts': [
      `const a = "${t['hivra-activity-collector-token']}";`,
      `const b = "${t['bankr-api-key']}";`,
      `let c = \`${t['supabase-secret-key']}\`;`,
      '',
    ].join('\n'),
    'list.json': `${JSON.stringify([t['bankr-api-key'], t['hivra-managed-venice-proxy-key']])}\n`,
  };
}

export function missingRules(report, expected = CUSTOM_RULE_IDS) {
  if (!Array.isArray(report)) throw new Error('A gitleaks report must be a JSON array.');
  const seen = new Set(report.map((finding) => finding?.RuleID));
  return expected.filter((id) => !seen.has(id));
}

function main(argv) {
  const [command, target] = argv;
  if (command === 'write' && target) {
    mkdirSync(target, { recursive: true });
    for (const [name, content] of Object.entries(probeFiles(generateProbeTokens()))) {
      writeFileSync(path.join(target, name), content);
    }
    return 0;
  }
  if (command === 'verify' && target) {
    const missing = missingRules(JSON.parse(readFileSync(target, 'utf8')));
    if (missing.length) {
      console.error(`Custom gitleaks rules did not fire on freshly generated tokens: ${missing.join(', ')}`);
      return 1;
    }
    return 0;
  }
  console.error('Usage: gitleaks-format-probe.mjs write <dir> | verify <report.json>');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
