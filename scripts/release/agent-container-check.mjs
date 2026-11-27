#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const AGENT_KINDS = ['claude', 'codex', 'aeon', 'openclaw', 'agent-zero', 'openbot', 'nuphos', 'hermes'];
const REFERENCE_KIND = 'claude';
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
    if (path.startsWith('dashboard/provisioner/')) {
      const name = path.split('/').at(-1);
      for (const kind of AGENT_KINDS) {
        if (new RegExp(`(^|[-_.])${kind}([-_.]|$)`).test(name)) kinds.add(kind);
      }
    }
  }
  return AGENT_KINDS.filter((kind) => kinds.has(kind));
}

function main(argv) {
  const [command, baseFlag, base, headFlag, head, ...extra] = argv;
  if (command !== 'changed' || baseFlag !== '--base' || headFlag !== '--head' || !base || !head ||
    base.startsWith('-') || head.startsWith('-') || extra.length) {
    throw new Error('Usage: changed --base <sha> --head <sha>');
  }
  const paths = execFileSync('git', ['diff', '--name-only', '-z', '--no-ext-diff', base, head, '--'], {
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
  for (const kind of changedKinds(paths)) console.log(kind);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(process.argv.slice(2)); }
  catch {
    console.error('[agent-container-check] Could not list changed agents. Usage: changed --base <sha> --head <sha>');
    process.exitCode = 1;
  }
}
