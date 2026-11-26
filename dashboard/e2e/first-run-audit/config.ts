import { randomBytes } from 'node:crypto';

/** Agent name prefix — becomes part of the Proxmox VM name, so keep it greppable. */
export const AUDIT_AGENT_PREFIX = 'firstrun-audit-';

/** The only live-auth mechanism the managed-hosting audits may use. */
export const LIVE_AUDIT_AUTH_ENV = 'HIVRA_LIVE_AUDIT_AUTH';
export const LIVE_AUDIT_AUTH_CLERK_TEST_OTP = 'clerk-test-otp';
export const CLERK_TEST_OTP_CODE = '424242';
export const CLERK_TEST_EMAIL_TAG = '+clerk_test';

export function liveAuditAuthMode(): string | null {
  return process.env[LIVE_AUDIT_AUTH_ENV]?.trim().toLowerCase() || null;
}

export function assertLiveManagedHostingAuditAllowed(): void {
  if (liveAuditAuthMode() === LIVE_AUDIT_AUTH_CLERK_TEST_OTP) return;
  throw new Error(
    '[managed-hosting-audit] Live runs are paused. ' +
      `Set ${LIVE_AUDIT_AUTH_ENV}=${LIVE_AUDIT_AUTH_CLERK_TEST_OTP} only on an owner-approved isolated runner; ` +
      'it signs in to standing Clerk test-mode accounts; it never signs up users.',
  );
}

export function assertClerkTestAuditEmail(email: string | null | undefined): asserts email is string {
  const normalized = email?.toLowerCase();
  const at = normalized?.lastIndexOf('@') ?? -1;
  const localPart = at > 0 ? normalized!.slice(0, at) : '';
  const domain = at > 0 ? normalized!.slice(at + 1) : '';
  if (!localPart.endsWith(CLERK_TEST_EMAIL_TAG)) {
    throw new Error(
      '[managed-hosting-audit] audit email is not a Clerk test address. ' +
        `Every live audit account must end its local part with ${CLERK_TEST_EMAIL_TAG} so Clerk suppresses test mail.`,
    );
  }
  assertAuditEmailDomain(domain);
}

/** Sign-in tickets are not an approved audit auth path: Clerk sent mail after ticket redemption. */
export function assertTicketSignInDisabled(): never {
  throw new Error('[managed-hosting-audit] Clerk sign-in tickets are disabled for live audits because ticket sign-in sent mail.');
}

/**
 * Audit accounts must not use a real customer or company domain. Reserved
 * example domains cannot receive mail and cannot confer domain-based trust if
 * an application ever uses email domains as a signal.
 */
const AUDIT_EMAIL_DOMAINS = new Set(['example.com', 'example.net', 'example.org', 'example.test']);

export function assertAuditEmailDomain(domain: string): void {
  if (!AUDIT_EMAIL_DOMAINS.has(domain.toLowerCase())) {
    throw new Error('[managed-hosting-audit] audit email domain must be a reserved example domain.');
  }
}

export interface AuditConfig {
  /** Deployed target. NEVER point this at production. */
  baseUrl: string;
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

  const requireAgentReply = envBool('FIRST_RUN_AUDIT_REQUIRE_AGENT_REPLY');

  return {
    baseUrl,
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
  };
}

/**
 * Hard guard for audit targets. Standing credentials additionally require
 * the exact public Canary origin in the session helper.
 */
export function assertNotProduction(baseUrl: string): void {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    throw new Error(`[first-run-audit] invalid base URL: ${baseUrl}`);
  }

  // Allow only the real canary host and localhost. A `canary.` prefix on an
  // attacker-controlled domain is not a canary environment.
  const allowed = host === 'localhost' || host === '127.0.0.1' || host === 'canary.hermesos.cloud';
  if (!allowed) {
    throw new Error(
      `[first-run-audit] refusing to target "${host}". ` +
        'It is canary-only (canary.hermesos.cloud), or localhost.',
    );
  }
}

/** 8 hex chars — short enough for a VM name, long enough not to collide. */
export function newRunId(): string {
  return randomBytes(4).toString('hex');
}

export function auditAgentName(runId: string): string {
  if (!/^[a-f0-9]{8}$/.test(runId)) throw new Error('Audit resource cleanup requires an exact eight-hex run ID.');
  return `${AUDIT_AGENT_PREFIX}${runId}`;
}
