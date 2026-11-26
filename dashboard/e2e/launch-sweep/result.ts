/**
 * One result file per launched target, and a Markdown table across them.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { IdleUsage } from './idle';
import type { SweepCatalogEvidence } from './targets';
import type { SweepSoftwareEvidence } from './software';
import type { PrivateOnlyCheck } from './private-only';

export const SWEEP_SCHEMA = 'hivra.launch-sweep.v1';

/** Where a launch got to, in the order a customer meets them. */
export const SWEEP_STAGES = ['account', 'choose', 'review', 'launch', 'ready', 'open', 'chat', 'private', 'idle', 'teardown'] as const;
export type SweepStage = (typeof SWEEP_STAGES)[number];

/**
 * product: Hivra or the agent is broken for customers.
 * not_offered: Launch doesn't show this tile on this deployment.
 * harness_environment / harness_bug: the test itself couldn't run fairly.
 */
export type SweepFailureCategory = 'product' | 'not_offered' | 'harness_environment' | 'harness_bug';

export class SweepFailure extends Error {
  constructor(
    readonly stage: SweepStage,
    readonly category: SweepFailureCategory,
    message: string,
  ) {
    super(message);
    this.name = 'SweepFailure';
  }
}

export interface SweepResult {
  schema: typeof SWEEP_SCHEMA;
  runId: string;
  baseUrl: string;
  profileId: string;
  tile: string;
  kind: string;
  knownBroken?: string;
  /** Universal-catalog manifest provenance when this target came from the catalog. */
  catalog?: SweepCatalogEvidence;
  /** Git SHA of the checkout whose test code and manifests ran the sweep. */
  checkoutSha?: string;
  /** Optional operator-supplied SHA verified externally as the served Canary revision. */
  expectedCanarySha?: string;
  /** Provisioner bundle version required by the checkout that ran the sweep. */
  expectedProvisionerVersion?: string;
  /** Live software version/digest evidence read after the customer-visible proof. */
  software?: SweepSoftwareEvidence;
  startedAt: string;
  finishedAt?: string;
  passed: boolean;
  /** The last stage that completed. */
  reached: SweepStage | null;
  stageSeconds: Partial<Record<SweepStage, number>>;
  failure?: { stage: SweepStage; category: SweepFailureCategory; reason: string };
  agentId?: string | null;
  chat?: { surface: string; replySeconds?: number };
  /** "Private models only" turned on after the agent answered, then asked again. */
  privateOnly?: PrivateOnlyCheck;
  /** What it used while nobody talked to it, after it worked. */
  idle?: IdleUsage;
  teardown?: { agentsLeft: number; instancesLeft: number; accountDeleted: boolean; error?: string };
  screenshots: string[];
  /** On failure: the agent's recent lifecycle events with detail, read before teardown. */
  evidence?: Array<Record<string, unknown>>;
}

export class SweepRecorder {
  readonly result: SweepResult;
  private stageStart = Date.now();

  constructor(init: Pick<SweepResult, 'runId' | 'baseUrl' | 'profileId' | 'tile' | 'kind' | 'knownBroken' | 'catalog' | 'checkoutSha' | 'expectedCanarySha' | 'expectedProvisionerVersion'>) {
    this.result = {
      schema: SWEEP_SCHEMA,
      ...init,
      startedAt: new Date().toISOString(),
      passed: false,
      reached: null,
      stageSeconds: {},
      screenshots: [],
    };
  }

  /** Mark a stage done and time it from the previous one. */
  done(stage: SweepStage): void {
    this.result.stageSeconds[stage] = Math.round((Date.now() - this.stageStart) / 1000);
    this.result.reached = stage;
    this.stageStart = Date.now();
  }

  fail(err: unknown, fallbackStage: SweepStage): void {
    if (this.result.failure) return;
    if (err instanceof SweepFailure) {
      this.result.failure = { stage: err.stage, category: err.category, reason: err.message };
    } else {
      const message = err instanceof Error ? err.message : String(err);
      // A Playwright locator error is the test's own bug, not the product's.
      const harness = /strict mode violation|locator\.|Target page, context or browser has been closed/.test(message);
      this.result.failure = {
        stage: fallbackStage,
        category: harness ? 'harness_bug' : 'product',
        reason: (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 600),
      };
    }
  }

  write(outDir: string): string {
    this.result.finishedAt = new Date().toISOString();
    mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${this.result.runId}-${this.result.profileId}.json`);
    writeFileSync(file, `${JSON.stringify(this.result, null, 2)}\n`);
    return file;
  }
}

export function readResults(outDir: string, runId?: string): SweepResult[] {
  let files: string[] = [];
  try {
    files = readdirSync(outDir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((name) => {
      try {
        return JSON.parse(readFileSync(path.join(outDir, name), 'utf8')) as SweepResult;
      } catch {
        return null;
      }
    })
    .filter((row): row is SweepResult => row?.schema === SWEEP_SCHEMA && (!runId || row.runId === runId));
}

function minutes(result: SweepResult): string {
  const total = Object.values(result.stageSeconds).reduce((sum, value) => sum + (value ?? 0), 0);
  return total ? `${(total / 60).toFixed(1)} min` : '';
}

/** The verdict for a whole run: did anything customers use break? */
export function sweepVerdict(results: SweepResult[]): {
  ok: boolean;
  broken: SweepResult[];
  leaked: SweepResult[];
  privateOnlyFailed: SweepResult[];
} {
  const broken = results.filter(
    (row) => !row.passed && row.failure?.category === 'product' && !row.knownBroken,
  );
  const leaked = results.filter(
    (row) => row.teardown && (row.teardown.agentsLeft > 0 || row.teardown.instancesLeft > 0),
  );
  const privateOnlyFailed = results.filter((row) => row.privateOnly?.state === 'failed' && !row.knownBroken);
  return { ok: broken.length === 0 && leaked.length === 0 && privateOnlyFailed.length === 0, broken, leaked, privateOnlyFailed };
}

export function sweepMarkdown(results: SweepResult[]): string {
  const rows = [...results].sort((a, b) => a.tile.localeCompare(b.tile));
  const verdict = sweepVerdict(rows);
  const lines = [
    `## Launch sweep: ${verdict.broken.length === 0 ? 'every launch works' : `${verdict.broken.length} broken`}${verdict.leaked.length ? `, ${verdict.leaked.length} left running` : ''}${verdict.privateOnlyFailed.length ? `, private models only failed on ${verdict.privateOnlyFailed.length}` : ''}`,
    '',
    rows[0] ? `Target ${rows[0].baseUrl}, run ${rows[0].runId}.` : 'No results.',
    '',
    '| Launch | Result | Got to | Time | Why |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) {
    const result = row.passed
      ? 'Pass'
      : row.failure?.category === 'not_offered'
        ? 'Not offered'
        : row.failure?.category === 'product'
          ? row.knownBroken ? 'Fail (known)' : '**Fail**'
          : 'Test problem';
    const why = (row.failure?.reason ?? (row.chat ? `Replied in ${row.chat.replySeconds ?? '?'}s via ${row.chat.surface}` : ''))
      .replace(/\|/g, '/')
      .replace(/\s+/g, ' ')
      .slice(0, 220);
    lines.push(`| ${row.tile} | ${result} | ${row.reached ?? 'nothing'} | ${minutes(row)} | ${why} |`);
  }
  const privateRows = rows.filter((row) => row.privateOnly);
  if (privateRows.length) {
    lines.push(
      '',
      '### Private models only',
      '',
      'After each agent answered, its owner turned on "private models only" (Manage › Inference) and asked a second question.',
      '',
      '| Launch | Result | Detail |',
      '| --- | --- | --- |',
    );
    for (const row of privateRows) {
      const check = row.privateOnly!;
      const result = check.state === 'passed' ? 'Pass' : check.state === 'not_offered' ? 'Not offered' : row.knownBroken ? 'Fail (known)' : '**Fail**';
      const detail = (check.state === 'passed'
        ? `Still answered in ${check.replySeconds}s on ${check.savedModel}`
        : check.reason)
        .replace(/\|/g, '/')
        .replace(/\s+/g, ' ')
        .slice(0, 220);
      lines.push(`| ${row.tile} | ${result} | ${detail} |`);
    }
  }
  const idleRows = rows.filter((row) => row.idle && row.idle.samples > 0);
  if (idleRows.length) {
    const fmt = (value: number | null | undefined, unit: string) => (value == null ? '?' : `${value}${unit}`);
    lines.push(
      '',
      `### Idle use (${idleRows[0].idle!.minutes} min with nobody using it, as Manage › Overview reads it)`,
      '',
      'RAM includes the computer\'s file cache, so it is an upper bound. The Linux computer row is the bare computer every agent runs on.',
      '',
      '| Launch | RAM (median / peak) | CPU (median / peak) | Disk used | Computer size |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const row of [...idleRows].sort((a, b) => (a.idle!.memoryMbMedian ?? 0) - (b.idle!.memoryMbMedian ?? 0))) {
      const idle = row.idle!;
      lines.push(
        `| ${row.tile} | ${fmt(idle.memoryMbMedian, ' MB')} / ${fmt(idle.memoryMbMax, ' MB')} | ${fmt(idle.cpuPercentMedian, '%')} / ${fmt(idle.cpuPercentMax, '%')} | ${fmt(idle.diskUsedGb, ' GB')} | ${fmt(idle.vcpus, ' vCPU')}, ${fmt(idle.memoryMbSize, ' MB')}, ${fmt(idle.diskAllocatedGb, ' GB')} disk |`,
      );
    }
    const unread = rows.filter((row) => row.idle && row.idle.samples === 0);
    if (unread.length) lines.push('', `No idle reading: ${unread.map((row) => `${row.tile} (${row.idle!.note ?? 'no samples'})`).join(', ')}.`);
  }
  if (verdict.leaked.length) {
    lines.push('', `Left running after teardown: ${verdict.leaked.map((row) => row.tile).join(', ')}. Run \`npm run audit:first-run:cleanup\`.`);
  }
  return `${lines.join('\n')}\n`;
}
