/**
 * Configuration for the FIRST-RUN AUDIT harness.
 *
 * The audit answers exactly one question, the one Ash set as the gate for the
 * reactivation campaign and Product Hunt:
 *
 *   "new signup → first agent deployed → first real outcome,
 *    working clean 19 out of 20 times, zero manual intervention."
 *
 * Every knob here is env-driven so a 20-run campaign is a loop, not 20 edits.
 */

/** Local-part prefix for every audit account. The cleanup reaper keys on it. */
export const AUDIT_EMAIL_PREFIX = 'firstrun-audit-';

/** Agent name prefix — becomes part of the Proxmox VM name, so keep it greppable. */
export const AUDIT_AGENT_PREFIX = 'firstrun-audit-';

export interface AuditConfig {
  /** Deployed target. NEVER point this at production. */
  baseUrl: string;
  /** Clerk **canary** Backend API key (sk_test_…). */
  clerkSecretKey: string;
  /** Domain for the throwaway account, e.g. `hermesos.cloud`. */
  emailDomain: string;
  /** Where run-<id>.json verdicts are written. */
  outDir: string;
  /** How long to wait for the box to answer its own /health probe. */
  readyTimeoutMs: number;
  /** How long to wait for the workspace handoff + iframe load after ready. */
  workspaceTimeoutMs: number;
  /** Whole-test budget. */
  testTimeoutMs: number;
  /**
   * How long to let the box sit after it is proven interactive, BEFORE teardown.
   *
   * Promotion to `running` kicks off deferred, out-of-band work through Next's
   * `after()` — most importantly the post-ready SOUL.md reconcile that lands the
   * hired persona (soul-seed-reconcile.ts, canary #484). A real user's box lives
   * on and that work completes. An audit that destroys the VM the instant the
   * iframe paints does not merely fail to observe it: it ABORTS it, and every run
   * leaves a `post-ready soul-seed reconcile errored` warning in the deployment's
   * logs. A 20-run campaign would manufacture 20 false incidents.
   *
   * Measured on canary: promotion → reconcile write attempt is ~6-9s. 45s is a
   * comfortable margin and costs ~9% of a run's wall clock.
   */
  postReadySettleMs: number;
  /**
   * Optional: probe whether the agent can actually answer a message.
   * Off by default — it costs a real inference call and only means anything on a
   * box that booted with inference. Setting requireAgentReply also selects the
   * managed-Venice deploy lane (the clean-slate lane cannot answer).
   */
  probeAgentReply: boolean;
  requireAgentReply: boolean;
  /**
   * Budget for the agent runtime to start accepting chat. It answers 503/502/409
   * for a short window after the workspace paints, which the product itself calls
   * retryable ("wait about 30 seconds, then retry once"). The probe retries
   * inside this budget and records attempts + waited_ms. A billing failure (402)
   * is never retried.
   */
  agentReplyTimeoutMs: number;
  /** Bearer for /api/ops/events/feed. Absent → server-side ops events are skipped. */
  cronSecret?: string;
  /**
   * Pre-clear the free-tier abuse gate for the synthetic user.
   *
   * The gate scores a DATACENTER egress IP at +30 → tier "medium" → require_card
   * (src/lib/abuse/risk-scorer.ts). Every hosted CI runner is a datacenter IP, so
   * without this an audit run from CI measures the *runner's* network, not the
   * product. Residential runs (a laptop) score 0 and need none of this.
   *
   * Requires the canary Supabase service-role key. When unset, the real gate runs
   * and a card_required response is recorded as a `harness_environment` failure
   * rather than a product failure.
   */
  preclearRisk: boolean;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envBool(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function loadAuditConfig(): AuditConfig {
  const baseUrl = (
    process.env.FIRST_RUN_AUDIT_BASE_URL ||
    process.env.E2E_BASE_URL ||
    'https://canary.hermesos.cloud'
  ).replace(/\/$/, '');

  assertNotProduction(baseUrl);

  const clerkSecretKey = process.env.CLERK_SECRET_KEY ?? '';

  // A live Clerk key on a canary target means someone wired prod creds into the
  // audit. Creating and destroying throwaway users against the production Clerk
  // instance is exactly the accident this check exists to prevent.
  if (clerkSecretKey.startsWith('sk_live_')) {
    throw new Error(
      '[first-run-audit] refusing to run with a LIVE Clerk secret key. ' +
        'The audit creates and deletes real users; it must only ever touch the canary Clerk instance (sk_test_…).',
    );
  }

  const preclearRisk = envBool('FIRST_RUN_AUDIT_PRECLEAR_RISK');
  const supabaseUrl = process.env.FIRST_RUN_AUDIT_SUPABASE_URL?.trim() || undefined;
  const supabaseServiceRoleKey =
    process.env.FIRST_RUN_AUDIT_SUPABASE_SERVICE_ROLE_KEY?.trim() || undefined;

  if (preclearRisk && (!supabaseUrl || !supabaseServiceRoleKey)) {
    throw new Error(
      '[first-run-audit] FIRST_RUN_AUDIT_PRECLEAR_RISK=1 requires ' +
        'FIRST_RUN_AUDIT_SUPABASE_URL and FIRST_RUN_AUDIT_SUPABASE_SERVICE_ROLE_KEY (canary).',
    );
  }

  const requireAgentReply = envBool('FIRST_RUN_AUDIT_REQUIRE_AGENT_REPLY');

  return {
    baseUrl,
    clerkSecretKey,
    emailDomain: process.env.FIRST_RUN_AUDIT_EMAIL_DOMAIN?.trim() || 'hermesos.cloud',
    outDir: process.env.FIRST_RUN_AUDIT_OUT_DIR?.trim() || 'e2e/.first-run-audit',
    readyTimeoutMs: envInt('FIRST_RUN_AUDIT_READY_TIMEOUT_MS', 15 * 60_000),
    workspaceTimeoutMs: envInt('FIRST_RUN_AUDIT_WORKSPACE_TIMEOUT_MS', 5 * 60_000),
    testTimeoutMs: envInt('FIRST_RUN_AUDIT_TEST_TIMEOUT_MS', 40 * 60_000),
    postReadySettleMs: envInt('FIRST_RUN_AUDIT_POST_READY_SETTLE_MS', 45_000),
    // Requiring the reply implies probing for it.
    probeAgentReply: envBool('FIRST_RUN_AUDIT_PROBE_AGENT_REPLY') || requireAgentReply,
    requireAgentReply,
    agentReplyTimeoutMs: envInt('FIRST_RUN_AUDIT_AGENT_REPLY_TIMEOUT_MS', 3 * 60_000),
    cronSecret: process.env.FIRST_RUN_AUDIT_CRON_SECRET?.trim() || undefined,
    preclearRisk,
    supabaseUrl,
    supabaseServiceRoleKey,
  };
}

/**
 * Hard guard. The audit provisions and destroys real infrastructure and creates
 * and deletes real auth users. It must never be pointed at production, and no
 * env var should be able to talk it into it.
 */
export function assertNotProduction(baseUrl: string): void {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    throw new Error(`[first-run-audit] invalid base URL: ${baseUrl}`);
  }

  // Allow the canary subdomain and localhost. Everything else — in particular
  // the bare apex domains that serve production — is refused.
  const allowed = host === 'localhost' || host === '127.0.0.1' || host.startsWith('canary.');
  if (!allowed) {
    throw new Error(
      `[first-run-audit] refusing to target "${host}". ` +
        'This harness creates + destroys real users and real VMs. ' +
        'It is canary-only (canary.*), or localhost.',
    );
  }
}

/** 8 hex chars — short enough for a VM name, long enough not to collide. */
export function newRunId(): string {
  return Array.from({ length: 4 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0'),
  ).join('');
}

export function auditEmail(runId: string, domain: string): string {
  return `${AUDIT_EMAIL_PREFIX}${runId}@${domain}`;
}

export function auditAgentName(runId: string): string {
  return `${AUDIT_AGENT_PREFIX}${runId}`;
}

/** True for any email this harness could have created. Used by the reaper. */
export function isAuditEmail(email: string | null | undefined): boolean {
  return typeof email === 'string' && email.toLowerCase().startsWith(AUDIT_EMAIL_PREFIX);
}
