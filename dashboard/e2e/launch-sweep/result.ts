/**
 * One result file per launched target, and a Markdown table across them.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SWEEP_SCHEMA = 'hivra.launch-sweep.v1';

/** Where a launch got to, in the order a customer meets them. */
export const SWEEP_STAGES = ['account', 'choose', 'review', 'launch', 'ready', 'open', 'chat', 'teardown'] as const;
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
  startedAt: string;
  finishedAt?: string;
  passed: boolean;
  /** The last stage that completed. */
  reached: SweepStage | null;
  stageSeconds: Partial<Record<SweepStage, number>>;
  failure?: { stage: SweepStage; category: SweepFailureCategory; reason: string };
  agentId?: string | null;
  chat?: { surface: string; replySeconds?: number };
  teardown?: { agentsLeft: number; instancesLeft: number; accountDeleted: boolean; error?: string };
  screenshots: string[];
}

export class SweepRecorder {
  readonly result: SweepResult;
  private stageStart = Date.now();

  constructor(init: Pick<SweepResult, 'runId' | 'baseUrl' | 'profileId' | 'tile' | 'kind' | 'knownBroken'>) {
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
export function sweepVerdict(results: SweepResult[]): { ok: boolean; broken: SweepResult[]; leaked: SweepResult[] } {
  const broken = results.filter(
    (row) => !row.passed && row.failure?.category === 'product' && !row.knownBroken,
  );
  const leaked = results.filter(
    (row) => row.teardown && (row.teardown.agentsLeft > 0 || row.teardown.instancesLeft > 0),
  );
  return { ok: broken.length === 0 && leaked.length === 0, broken, leaked };
}

export function sweepMarkdown(results: SweepResult[]): string {
  const rows = [...results].sort((a, b) => a.tile.localeCompare(b.tile));
  const verdict = sweepVerdict(rows);
  const lines = [
    `## Launch sweep: ${verdict.ok ? 'every launch works' : `${verdict.broken.length} broken`}${verdict.leaked.length ? `, ${verdict.leaked.length} left running` : ''}`,
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
  if (verdict.leaked.length) {
    lines.push('', `Left running after teardown: ${verdict.leaked.map((row) => row.tile).join(', ')}. Run \`npm run audit:first-run:cleanup\`.`);
  }
  return `${lines.join('\n')}\n`;
}
