#!/usr/bin/env node
// Per-agent install-and-reply check: the cheap check each agent gets when it
// changes. ops/agent-container-check/run.sh installs one agent kind with the
// real guest installer in a container on the shared runner box, then this
// script asks the box's own chat for a sum and expects the answer.
//
//   node scripts/release/agent-container-check.mjs changed --base <sha> --head <sha>
//     prints the agent kinds whose files changed, one per line
//   node scripts/release/agent-container-check.mjs ask --url http://127.0.0.1:18080 --token-file <path>
//     asks the box's chat and exits non-zero unless the reply has the answer
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const AGENT_KINDS = ['claude', 'codex', 'aeon', 'openclaw', 'agent-zero', 'openbot', 'nuphos', 'hermes'];
// Shared install code: a change there is covered by the reference kind here
// and by the nightly full-launch sample, not by installing every kind.
export const REFERENCE_KIND = 'claude';
export const CHECK_PROMPT = 'What is 389 + 448? Reply with only the number.';
export const CHECK_ANSWER = '837';

const OWN_PATHS = [
  ['dashboard/runtime-adapters/agent-zero-native/', 'agent-zero'],
  ['dashboard/provisioner/hermes-plugins/', 'hermes'],
  ['dashboard/provisioner/agent-addons/hivra-ask-claude', 'claude'],
  ['dashboard/provisioner/hivra-claude-app', 'claude'],
  ['dashboard/provisioner/system-prompt-codex.md', 'codex'],
  ['dashboard/provisioner/hivra-codex-config-pin.py', 'codex'],
];
const SHARED_PATHS = [
  'dashboard/provisioner/provision-claude-code-box.sh',
  'dashboard/provisioner/hivra-install-agent.py',
  'dashboard/provisioner/hivra-chat/',
  'dashboard/provisioner/system-prompt.md',
  'dashboard/provisioner/bux-hivra-chat.service',
];

/** The agent kinds a change touches, in catalog order. */
export function changedKinds(paths) {
  const kinds = new Set();
  for (const path of paths) {
    for (const [prefix, kind] of OWN_PATHS) if (path.startsWith(prefix)) kinds.add(kind);
    if (SHARED_PATHS.some((prefix) => path.startsWith(prefix))) kinds.add(REFERENCE_KIND);
    for (const kind of AGENT_KINDS) {
      // An agent's own files carry its name (hivra-openbot.service, openclaw-*.json).
      const name = path.split('/').pop() || '';
      if (path.startsWith('dashboard/provisioner/') && new RegExp(`(^|[-_.])${kind}([-_.]|$)`).test(name)) kinds.add(kind);
    }
  }
  return AGENT_KINDS.filter((kind) => kinds.has(kind));
}

/** The agent's own reply text in a streamed run (NDJSON): Claude Code, Codex and plain-text agents. */
export function replyTexts(ndjson) {
  const texts = [];
  for (const line of String(ndjson).split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'result' && typeof event.result === 'string') texts.push(event.result);
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const part of event.message.content) if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text);
    }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') texts.push(event.item.text);
    if (event.type === '_text' && typeof event.text === 'string') texts.push(event.text);
  }
  return texts;
}

/** True when the agent's reply (never the stream's metadata) carries the answer. */
export function replyHasAnswer(ndjson, answer = CHECK_ANSWER) {
  const pattern = new RegExp(`(^|[^0-9])${answer}([^0-9]|$)`);
  return replyTexts(ndjson).some((text) => pattern.test(text));
}

function flagsOf(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[i + 1], i += 1;
  return flags;
}

/** Ask the box's chat; read its stream until the run ends, the answer shows, or time runs out. */
async function ask(url, token, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let body = '';
  try {
    const res = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: CHECK_PROMPT }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`the box's chat answered HTTP ${res.status}`);
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      body += decoder.decode(chunk, { stream: true });
      if (replyHasAnswer(body) || /\{"type":"_done"/.test(body)) break;
    }
    controller.abort();
    return body;
  } catch (error) {
    if (controller.signal.aborted && body) return body;
    if (controller.signal.aborted) throw new Error(`no reply within ${Math.round(timeoutMs / 1000)}s`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** Mirror the initial provider file written by the launch bootstrap. Run as bux. */
export function seedCodexProvider(home, { CHECK_MODEL_KEY: apiKey, CHECK_MODEL_BASE_URL: baseUrl, CHECK_MODEL: model }) {
  if (!apiKey || !baseUrl || !model) throw new Error('Codex provider needs a model key, base URL, and model');
  writeFileSync(join(home, '.hivra', 'llm-provider.json'),
    JSON.stringify({ provider: 'venice', apiKey, baseUrl, model }) + '\n',
    { flag: 'wx', mode: 0o600 });
}

async function main(argv) {
  const [command, ...rest] = argv;
  const flags = flagsOf(rest);
  if (command === 'changed') {
    if (!flags.base || !flags.head) throw new Error('changed needs --base and --head');
    const paths = execFileSync('git', ['diff', '--name-only', flags.base, flags.head], { encoding: 'utf8' }).split('\n').filter(Boolean);
    for (const kind of changedKinds(paths)) console.log(kind);
    return;
  }
  if (command === 'ask') {
    if (!flags.url || !flags['token-file']) throw new Error('ask needs --url and --token-file');
    const token = readFileSync(flags['token-file'], 'utf8').trim();
    const body = await ask(flags.url, token, Number(flags['timeout-ms']) || 5 * 60_000);
    if (!replyHasAnswer(body)) throw new Error(`no ${CHECK_ANSWER} in the agent's reply`);
    console.log(`replied ${CHECK_ANSWER}`);
    return;
  }
  if (command === 'seed-codex') {
    if (!flags.home) throw new Error('seed-codex needs --home');
    seedCodexProvider(flags.home, process.env);
    return;
  }
  throw new Error(`Unknown command "${command ?? ''}". Use changed, ask, or seed-codex.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[agent-container-check] ${error.message}`);
    process.exit(1);
  });
}
