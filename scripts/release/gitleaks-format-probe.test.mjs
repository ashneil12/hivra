import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CUSTOM_RULE_IDS, generateProbeTokens, missingRules, probeFiles } from './gitleaks-format-probe.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(root, 'scripts/release/gitleaks-format-probe.mjs');

test('the probe covers exactly the custom rules declared in .gitleaks.toml', () => {
  const config = readFileSync(path.join(root, '.gitleaks.toml'), 'utf8');
  const declared = [...config.matchAll(/^\[\[rules\]\]\s*\nid = "([^"]+)"/gm)].map((match) => match[1]);
  assert.deepEqual([...declared].sort(), [...CUSTOM_RULE_IDS].sort());
});

test('generated tokens are fresh, in the real formats, and never the tree fixtures', () => {
  const first = generateProbeTokens();
  const second = generateProbeTokens();
  assert.notDeepEqual(first, second);
  assert.match(first['hivra-managed-venice-proxy-key'], /^hven_live_[A-Za-z0-9_-]{43}$/);
  assert.match(first['hivra-activity-collector-token'], /^hvra_otlp_v1\.[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{43}$/);
  assert.match(first['hivra-server-enrollment-code'], /^hse1_[a-z2-7]{32}$/);
  assert.match(first['bankr-api-key'], /^bk_[A-Za-z0-9]{40}$/);
  assert.match(first['supabase-secret-key'], /^sb_secret_[A-Za-z0-9_-]{40}$/);
});

test('every token lands in a neutral context, not only next to a key-like name', () => {
  const tokens = generateProbeTokens();
  const files = probeFiles(tokens);
  const all = Object.values(files).join('\n');
  for (const token of Object.values(tokens)) assert.ok(all.includes(token), token);
  assert.ok(files['bare.txt'].split('\n').includes(tokens['bankr-api-key']));
  assert.doesNotMatch(all, /(?:api[_-]?key|secret|token|password)\s*[:=]/i);
});

test('verify names every rule that did not fire and passes when all did', () => {
  assert.deepEqual(missingRules(CUSTOM_RULE_IDS.map((RuleID) => ({ RuleID }))), []);
  assert.deepEqual(
    missingRules([{ RuleID: 'generic-api-key' }, { RuleID: 'bankr-api-key' }]),
    CUSTOM_RULE_IDS.filter((id) => id !== 'bankr-api-key'),
  );
  assert.deepEqual(missingRules([]), CUSTOM_RULE_IDS);
  assert.throws(() => missingRules({}), /JSON array/);
});

test('the command line writes the files and verify exits non-zero on a short report', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hivra-format-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('node', [script, 'write', path.join(dir, 'probe')]);
  assert.deepEqual(readdirSync(path.join(dir, 'probe')).sort(), ['bare.txt', 'list.json', 'neutral.ts', 'prose.md']);

  const full = path.join(dir, 'full.json');
  const short = path.join(dir, 'short.json');
  writeFileSync(full, JSON.stringify(CUSTOM_RULE_IDS.map((RuleID) => ({ RuleID }))));
  writeFileSync(short, JSON.stringify([{ RuleID: 'hivra-managed-venice-proxy-key' }]));
  execFileSync('node', [script, 'verify', full]);
  assert.throws(() => execFileSync('node', [script, 'verify', short], { stdio: 'pipe' }), /Command failed/);
});
