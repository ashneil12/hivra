/**
 * What the launch sweep launches: every tile Launch offers on Hivra Cloud.
 *
 * Each entry names the tile exactly as a customer sees it on /dashboard/launch.
 * The sweep clicks that tile, so a renamed tile fails loudly here instead of
 * quietly dropping out of the test. A separate check ("every offered tile is
 * covered") reads the live Launch page and fails when it offers a tile that is
 * missing from this list, so a new agent is never shipped untested.
 */

export type SweepTargetKind = 'agent' | 'computer';

/** How the sweep proves the thing works once it is open. */
export type SweepProof =
  /** Hivra's own chat (Claude Code, Codex): type in the composer, wait for a reply. */
  | 'hivra-chat'
  /** The agent's own web UI in the agent page's iframe: type in its composer, wait for a reply. */
  | 'agent-ui-chat'
  /** A computer: its page opens running, with a terminal or desktop surface. */
  | 'computer-open';

export interface SweepTarget {
  /** Launch profile id (src/lib/launch/contracts.ts). Also the test's slug. */
  profileId: string;
  /** The tile's visible name on Launch. */
  tile: string;
  kind: SweepTargetKind;
  proof: SweepProof;
  /**
   * Known not to work on Canary today, with the reason. The sweep still runs it
   * and reports the result, but a failure here does not fail the run.
   */
  knownBroken?: string;
}

export const SWEEP_TARGETS: readonly SweepTarget[] = [
  { profileId: 'hermes-computer', tile: 'Hermes', kind: 'agent', proof: 'agent-ui-chat' },
  { profileId: 'claude-code', tile: 'Claude Code', kind: 'agent', proof: 'hivra-chat' },
  { profileId: 'codex', tile: 'Codex', kind: 'agent', proof: 'hivra-chat' },
  { profileId: 'openclaw', tile: 'OpenClaw', kind: 'agent', proof: 'agent-ui-chat' },
  { profileId: 'agent-zero', tile: 'Agent Zero', kind: 'agent', proof: 'agent-ui-chat' },
  {
    profileId: 'openbot',
    tile: 'OpenBot',
    kind: 'agent',
    proof: 'agent-ui-chat',
    knownBroken: 'By design OpenBot waits for the owner\'s own CopilotKit Intelligence key before it can chat, so a fresh account stops at its setup screen.',
  },
  {
    profileId: 'nuphos',
    tile: 'Nuphos',
    kind: 'agent',
    proof: 'agent-ui-chat',
    knownBroken: 'After its console password, Nuphos waits for the owner to pair Nuphos Desktop and sign its agent in, so a fresh account has nowhere to chat yet.',
  },
  { profileId: 'deepseek-harness', tile: 'DeepSeek Harness', kind: 'agent', proof: 'agent-ui-chat' },
  {
    profileId: 'aeon',
    tile: 'Aeon',
    kind: 'agent',
    proof: 'agent-ui-chat',
    knownBroken: 'Aeon installs and starts (fixed in release 2026.11.18.1), then asks its owner to connect their own Aeon fork with a GitHub token before its dashboard boots, so a fresh account has nowhere to chat yet.',
  },
  { profileId: 'ubuntu-server', tile: 'Linux computer', kind: 'computer', proof: 'computer-open' },
  { profileId: 'ubuntu-desktop', tile: 'Ubuntu Desktop', kind: 'computer', proof: 'computer-open' },
  {
    profileId: 'omarchy',
    tile: 'Omarchy',
    kind: 'computer',
    proof: 'computer-open',
    knownBroken: 'Canary has a single prepared Omarchy computer and a real owner holds it, so a fresh account is always told it is already claimed.',
  },
];

/**
 * Tiles that only run on a server the customer connected themselves. A
 * throwaway Hivra Cloud account has none, so the sweep can't launch them.
 */
export const OWN_SERVER_ONLY_TILES: readonly string[] = ['Linux Sandbox', 'Windows (your ISO)'];

/** Pick targets from LAUNCH_SWEEP_ONLY (comma-separated profile ids or tile names). */
export function selectedTargets(only = process.env.LAUNCH_SWEEP_ONLY): SweepTarget[] {
  const wanted = (only ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (wanted.length === 0) return [...SWEEP_TARGETS];
  return SWEEP_TARGETS.filter(
    (target) => wanted.includes(target.profileId) || wanted.includes(target.tile.toLowerCase()),
  );
}

/**
 * The question every agent is asked. The answer (837) does not appear in the
 * question, so seeing it on screen means the model really answered.
 */
export const SWEEP_CHAT_PROMPT = 'What is 389 + 448? Reply with only the number.';
export const SWEEP_CHAT_ANSWER = '837';

/**
 * Tonight's rotating sample for the nightly full launch: `size` targets taken
 * in catalog order from a window that moves `size` places each UTC day, so
 * every target gets a full launch every ceil(targets / size) nights however
 * long the catalog grows.
 */
export function pickNightlySample(
  date: Date = new Date(),
  size = Number(process.env.LAUNCH_SWEEP_SAMPLE_SIZE) || 3,
  targets: readonly SweepTarget[] = SWEEP_TARGETS,
): SweepTarget[] {
  if (targets.length === 0) return [];
  const count = Math.max(1, Math.min(Math.floor(size), targets.length));
  const day = Math.floor(date.getTime() / 86_400_000);
  const start = (day * count) % targets.length;
  return Array.from({ length: count }, (_, i) => targets[(start + i) % targets.length]);
}
