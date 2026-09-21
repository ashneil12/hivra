/**
 * The structured verdict every audit run emits — one JSON file per run, so 20
 * runs can be tallied against the 19/20 bar without anyone reading a log.
 *
 * A run that crashes still writes a verdict. A verdict that never got written is
 * itself a signal (the tally script counts missing files as failures).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const VERDICT_SCHEMA = 'hivra.first-run-audit.v1';

/**
 * The stages of a first run, in order. `stage_reached` is the last one that
 * passed; `failure.stage` is the one that broke. The tally script histograms on
 * exactly these strings, so renaming one is a breaking change.
 */
export const AUDIT_STAGES = [
  'clerk_user_created',
  'session_established',
  'welcome_loaded',
  'agent_type_selected',
  'plan_activated',
  'deploy_card_reached',
  'deploy_clicked',
  'instance_created',
  'instance_ready',
  'workspace_interactive',
  'agent_replied',
] as const;

export type AuditStage = (typeof AUDIT_STAGES)[number];

/**
 * Not every failure is the product's fault.
 *
 *  - `product`             — Hivra broke. Counts against the 19/20 bar.
 *  - `harness_environment` — the runner/config broke (datacenter IP tripping the
 *                            abuse gate, missing secret). Excluded from the bar,
 *                            reported loudly.
 *  - `harness_bug`         — the audit itself threw. Excluded, reported loudly.
 */
export type FailureCategory = 'product' | 'harness_environment' | 'harness_bug';

export interface StageRecord {
  name: AuditStage;
  ok: boolean;
  started_at: string;
  duration_ms: number;
  detail?: string;
}

export interface AuditFailure {
  stage: AuditStage;
  category: FailureCategory;
  reason: string;
  message: string;
}

export interface TeardownRecord {
  attempted: boolean;
  instances_destroyed: string[];
  instances_survived: Array<{ id: string; httpStatus: number; error?: string }>;
  clerk_user_deleted: boolean;
  /**
   * When the instance could not be destroyed we deliberately KEEP the Clerk user
   * so the reaper can still authenticate as them and finish the job. Deleting the
   * user first would strand the VM outside the app's own destroy path.
   */
  clerk_user_retained_for_reaper: boolean;
  errors: string[];
}

export interface AuditVerdict {
  schema: typeof VERDICT_SCHEMA;
  run_id: string;
  verdict: 'pass' | 'fail';
  /** The strongest outcome this run was CONFIGURED to prove. */
  outcome_level: 'workspace_interactive' | 'agent_replied';
  stage_reached: AuditStage | null;
  failure: AuditFailure | null;

  target: string;
  git_sha: string | null;
  started_at: string;
  finished_at: string;
  duration_ms: number;

  clerk_user_id: string | null;
  email: string | null;
  agent_name: string;

  instance: {
    id: string | null;
    status: string | null;
    provider: string | null;
    host_id: string | null;
    /**
     * Did the box boot with a provider+model configured? For a virgin free
     * account this is FALSE — the only available path (clean-slate BYOK) deploys
     * a box with nothing configured. This field is the honest answer to "could
     * this agent have answered a question?"
     */
    inference_configured: boolean;
  };

  stages: StageRecord[];
  timings_ms: Record<string, number>;

  /**
   * How `workspace_interactive` was actually proven. All three fields come from
   * the PRODUCT's own surfaces (its handoff route + the browser's network
   * events); none of them require analytics to be configured.
   *
   * `iframe_loaded_event` is the app's `webui_iframe_loaded` telemetry. It
   * CORROBORATES the proof and is worth recording — but it never gates, because
   * the canary deployment ingests no PostHog events at all (see iframe-watch.ts).
   */
  workspace: {
    handoff_minted: boolean;
    handoff_origin: string | null;
    /**
     * HTTP status of the response that SETTLED the workspace iframe's navigation
     * (redirect hops excluded). The signed handoff URL 302s once the box
     * establishes the session, so a healthy box reads `302→200` in the chain and
     * `200` here.
     */
    iframe_document_status: number | null;
    /** Every document status the box returned for the iframe, in order. */
    iframe_redirect_chain: number[];
    iframe_loaded_event: boolean;
  } | null;

  telemetry: {
    /**
     * False means the harness observed ZERO analytics ingest for the whole run.
     * When false, nothing telemetry-derived may be read as a product failure —
     * we simply could not see. The tally treats such a run's telemetry fields as
     * absent rather than as evidence of absence.
     */
    posthog_captured: boolean;
    funnel: Array<{ event: string; at: number; detail?: string }>;
    activation_failures: Array<Record<string, unknown>>;
    ops_events: { collected: boolean; reason?: string; events: Array<Record<string, unknown>> };
  };

  agent_reply: {
    attempted: boolean;
    ok: boolean;
    reason?: string;
    chars?: number;
    /** The assistant's actual words, truncated. Recorded so a human can read them. */
    text?: string;
    /** Terminal SSE frame: done | error | timeout | close | none. */
    terminal?: string;
    /** Sends made before the agent answered. >1 means the runtime wasn't ready. */
    attempts?: number;
    /** Wall-clock from first send to the answer (or to giving up). */
    waited_ms?: number;
    /** WS credential used: token (iframe-shim ?token=apiServerKey) | ticket (gated fallback). */
    auth?: string;
    /** Handoff entry path — '/webchat' (canary shell) vs '/' (prod SPA root). */
    entry?: string;
    /** Last attempt's handshake breadcrumbs — only on failure. */
    detail?: string;
  } | null;

  teardown: TeardownRecord;
}

export class RunRecorder {
  readonly runId: string;
  readonly startedAtMs = Date.now();
  private readonly stages: StageRecord[] = [];
  private stageStartMs = Date.now();

  constructor(runId: string) {
    this.runId = runId;
  }

  /** Mark a stage as passed and start the clock for the next one. */
  pass(name: AuditStage, detail?: string): void {
    const now = Date.now();
    this.stages.push({
      name,
      ok: true,
      started_at: new Date(this.stageStartMs).toISOString(),
      duration_ms: now - this.stageStartMs,
      detail,
    });
    this.stageStartMs = now;
    // eslint-disable-next-line no-console
    console.log(`[first-run-audit] ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  }

  fail(name: AuditStage, detail: string): void {
    const now = Date.now();
    this.stages.push({
      name,
      ok: false,
      started_at: new Date(this.stageStartMs).toISOString(),
      duration_ms: now - this.stageStartMs,
      detail,
    });
    this.stageStartMs = now;
    // eslint-disable-next-line no-console
    console.error(`[first-run-audit] ✗ ${name} — ${detail}`);
  }

  get reached(): AuditStage | null {
    const passed = this.stages.filter((s) => s.ok);
    return passed.length ? passed[passed.length - 1].name : null;
  }

  snapshot(): StageRecord[] {
    return [...this.stages];
  }

  timings(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const stage of this.stages) out[stage.name] = stage.duration_ms;
    out.total = Date.now() - this.startedAtMs;
    return out;
  }
}

export function writeVerdict(outDir: string, verdict: AuditVerdict): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `run-${verdict.run_id}.json`);
  writeFileSync(path, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[first-run-audit] verdict → ${path}`);
  return path;
}

/** A named error so the spec can attribute failures without string-matching. */
export class StageError extends Error {
  constructor(
    readonly stage: AuditStage,
    readonly reason: string,
    message: string,
    readonly category: FailureCategory = 'product',
  ) {
    super(message);
    this.name = 'StageError';
  }
}
