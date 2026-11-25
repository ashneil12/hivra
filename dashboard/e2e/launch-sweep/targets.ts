/**
 * What the launch sweep launches: every tile Launch offers on Hivra Cloud.
 *
 * Each entry names the tile exactly as a customer sees it on /dashboard/launch.
 * The sweep clicks that tile, so a renamed tile fails loudly here instead of
 * quietly dropping out of the test. A separate check ("every offered tile is
 * covered") reads the live Launch page and fails when it offers a tile that is
 * missing from this list, so a new agent is never shipped untested.
 */

import { createHash } from 'node:crypto';

import { UNIVERSAL_CATALOG_MANIFESTS } from '../../src/lib/hivra/catalog-manifests/manifests/index';
import { catalogAppHasWebSurface, catalogAppHostPort, type CatalogAppManifest } from '../../src/lib/hivra/catalog-manifests/index';

export type SweepTargetKind = 'agent' | 'computer';

/** How the sweep proves the thing works once it is open. */
export type SweepProof =
  /** Hivra's own chat (Claude Code, Codex): type in the composer, wait for a reply. */
  | 'hivra-chat'
  /** The agent's own web UI in the agent page's iframe: type in its composer, wait for a reply. */
  | 'agent-ui-chat'
  /** A self-hosted app: its authenticated web surface renders real app content. */
  | 'app-open'
  /** A computer: its page opens running, with a terminal or desktop surface. */
  | 'computer-open';

export interface SweepCatalogEvidence {
  /** sha256 of the exact manifest object in the checkout that launched it. */
  manifestSha256: string;
  runtimeKind: CatalogAppManifest['runtime']['kind'];
  hostPort: number | null;
  healthPath: string | null;
  /** Container image references for docker runtimes; package/installer identity for CLIs. */
  runtimeRefs: string[];
}

export interface SweepTarget {
  /** Launch profile id (src/lib/launch/contracts.ts). Also the test's slug. */
  profileId: string;
  /** The tile's visible name on Launch. */
  tile: string;
  kind: SweepTargetKind;
  proof: SweepProof;
  /** Catalog manifest provenance, present only for universal-catalog targets. */
  catalog?: SweepCatalogEvidence;
  /**
   * Known not to work on Canary today, with the reason. The sweep still runs it
   * and reports the result, but a failure here does not fail the run.
   */
  knownBroken?: string;
}

function catalogEvidence(manifest: CatalogAppManifest): SweepCatalogEvidence {
  const runtime = manifest.runtime;
  const healthPath = runtime.kind === 'docker-web'
    ? runtime.healthPath
    : runtime.kind === 'docker-stack'
      ? runtime.web.healthPath
      : runtime.webService?.healthPath ?? null;
  const runtimeRefs = runtime.kind === 'docker-web'
    ? [`${runtime.imageRepo}:${runtime.imageTag}`]
    : runtime.kind === 'docker-stack'
      ? runtime.services.map((service) => `${service.imageRepo}:${service.imageTag}`)
      : runtime.installer.method === 'npm-global' || runtime.installer.method === 'uv-tool'
        ? [`${runtime.installer.method}:${runtime.installer.packageName}#${runtime.installer.binName}`]
        : [`github-release:${runtime.installer.repo}#${runtime.installer.assetX64}${runtime.installer.assetArm64 ? `,${runtime.installer.assetArm64}` : ''}#${runtime.installer.binName}`];
  return {
    manifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    runtimeKind: runtime.kind,
    hostPort: catalogAppHostPort(manifest),
    healthPath,
    runtimeRefs,
  };
}

/**
 * Universal catalog apps come from the manifest registry, so a new manifest
 * is covered here without a second per-app list. The proof follows the
 * runtime and category: a self-hosted app with its own web UI must render
 * through the authenticated gateway; a catalog agent with a web UI must answer
 * in that UI; a chat-only CLI is proven in Hivra's own chat.
 */
const CATALOG_TARGETS: readonly SweepTarget[] = UNIVERSAL_CATALOG_MANIFESTS.map((manifest) => ({
  profileId: manifest.id,
  tile: manifest.name,
  kind: 'agent',
  proof: catalogAppHasWebSurface(manifest)
    ? (manifest.category === 'app' ? 'app-open' : 'agent-ui-chat')
    : 'hivra-chat',
  catalog: catalogEvidence(manifest),
}));

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
  ...CATALOG_TARGETS,
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
