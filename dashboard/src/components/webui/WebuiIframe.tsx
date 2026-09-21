'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExternalLink, Loader2 } from 'lucide-react';
import { useTheme } from 'next-themes';
import {
  LOCALE_COOKIE_NAME,
  appendWebUILocaleSearchParams,
  normalizeLocale,
  type Locale,
} from '@/lib/i18n';
import { trackIframeError, trackIframeLoaded, trackIframeStopped } from '@/lib/telemetry/iframe-events';
import {
  WEBUI_DASHBOARD_APPEARANCE_MESSAGE_TYPE,
  WEBUI_DASHBOARD_SEND_MESSAGE_TYPE,
  resolveWebUIAppearanceFromDashboardTheme,
  type WebUIAppearance,
} from '@/lib/webui-appearance';
import { ReportProblemLink } from '@/components/support/ReportProblemLink';

type LoginUrlResponse = {
  url: string;
  expiresAt: number;
  kind?: 'ready';
};

type LoginUrlPendingResponse = {
  kind: 'pending';
  reason: string;
  message?: string;
  instanceStatus?: string | null;
  retryAfterMs?: number;
  requestId?: string | null;
};

// What a user can read off a failed panel and paste back to support. Every
// field here exists to make a report actionable without a repro: `code` says
// which failure it was, `requestId` (Vercel's x-vercel-id) pins the exact
// server-side log line, `instanceStatus` says what the box claimed at the time.
// Without this the user can only report "it's blank", which is what happened on
// 2026-07-18 and cost a day of guessing.
type PanelDiagnostics = {
  code: string;
  instanceStatus?: string | null;
  requestId?: string | null;
  at: number;
};

function formatDiagnostics(instanceId: string, d: PanelDiagnostics): string {
  return [
    `instance: ${instanceId}`,
    `code: ${d.code}`,
    d.instanceStatus ? `box status: ${d.instanceStatus}` : null,
    d.requestId ? `request: ${d.requestId}` : null,
    `at: ${new Date(d.at).toISOString()}`,
  ]
    .filter(Boolean)
    .join('\n');
}

type FetchState =
  | { kind: 'loading' }
  | { kind: 'pending'; message: string; retryAfterMs: number }
  | { kind: 'ready'; url: string; loadAttempt: number }
  | { kind: 'stopped'; variant: StoppedPanelVariant; instanceStatus: string | null }
  // Honest dead-end after the gateway has been unreachable for too long. The
  // pending state used to poll forever behind "Preparing your workspace",
  // which reads as "almost there" while the agent is in fact broken. After
  // PENDING_REPAIR_THRESHOLD_MS of continuous gateway-unreachable polls we
  // switch to this state: tell the truth, say we've been notified, and offer
  // Retry + a support link instead of an infinite spinner.
  | { kind: 'repairing'; diagnostics: PanelDiagnostics }
  | { kind: 'error'; reason: string; diagnostics: PanelDiagnostics };

const REFRESH_BACKOFF_MS = 750;
const DEFAULT_PENDING_RETRY_AFTER_MS = 4000;
const MIN_PENDING_RETRY_AFTER_MS = 1000;
const MAX_PENDING_RETRY_AFTER_MS = 15000;
const NETWORK_RETRY_LIMIT = 2;
const NETWORK_RETRY_BASE_DELAY_MS = 500;
// After this long of CONTINUOUS gateway-unreachable pending polls, stop
// pretending the workspace is "preparing" and switch to the repairing state.
// 2.5 min is past every legitimate cold-boot we observe but well short of the
// user concluding the product is just broken.
const PENDING_REPAIR_THRESHOLD_MS = 150000;
// The pending reasons that mean "the agent's gateway isn't answering" (as
// opposed to a normal still-starting state). Only these accumulate toward the
// repair threshold — a benign "still booting" reason should keep the patient
// preparing spinner.
const GATEWAY_UNREACHABLE_PENDING_REASONS = new Set(['gateway_unreachable', 'gateway_unhealthy']);
// Absolute ceiling on the patient "preparing" spinner regardless of pending
// reason. The gateway-unreachable threshold above only trips for the two
// gateway reasons; a never-resolving non-gateway reason (e.g. a perpetual
// "still booting") would otherwise reset that streak every poll and trap the
// user on the spinner forever. After this long of CONTINUOUS pending (any
// reason) we escalate to the honest repairing state. Set well above any
// legitimate cold-boot so real slow starts still complete on their own.
const ABSOLUTE_PENDING_REPAIR_THRESHOLD_MS = 300000;

// How long a loaded iframe document gets to prove the chat inside it actually
// works. The DOM load event fires for ANY completed document — an HTTP error
// page, a CSP-blocked frame, a blank shell — so on its own it cannot tell a
// working chat from a broken one. 20s is comfortably past a healthy box's
// first paint while still well inside the window where a user would otherwise
// sit staring at a blank panel.
const LIVENESS_WATCHDOG_MS = 20000;
// Posted by the box SPA (ashneil12/vanilla-hermes-agent) after its first
// successful gateway session. Boxes running an image that predates that emit
// will never send it — which is exactly why watchdog expiry falls back to a
// server-side gateway probe instead of declaring the box broken outright.
const WEBUI_READY_MESSAGE_TYPE = 'HERMES_WEBUI_READY';
// Shown in the error panel's detail line when the watchdog fires. User-facing
// (the panel renders `state.reason` verbatim), so it stays plain English.
const LIVENESS_TIMEOUT_REASON = "Your workspace opened but never finished starting up.";

// The stopped / error / repairing panels replace the iframe, and the surfaces
// behind them (.instance-chat-root, the page wrapper) are transparent — so each
// panel has to paint its own background. They used to hardcode the dark-theme
// cream palette, which rendered near-white text on the light-theme #ffffff
// surface: the panel was invisible, so a broken agent looked like an empty chat
// with no error and no Retry. Drive both surface and text off the theme tokens
// (which flip with :root.dark) so every state is legible in both themes.
const PANEL_SURFACE_STYLE: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  height: '100%',
  padding: 24,
  textAlign: 'center',
  fontSize: 13,
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
};

const PANEL_DETAIL_STYLE: React.CSSProperties = {
  margin: 0,
  marginBottom: 16,
  fontSize: 12,
  color: 'var(--text-secondary)',
};

const PANEL_BUTTON_STYLE: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  padding: '6px 14px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--btn-bg)',
  color: 'var(--btn-text)',
  cursor: 'pointer',
};

// Shown on every dead-end panel. The point is that a user can copy one string
// that pins the exact server-side log line, instead of describing a blank box.
function PanelDiagnosticsBlock({
  instanceId,
  diagnostics,
}: {
  instanceId: string;
  diagnostics: PanelDiagnostics;
}) {
  const [copied, setCopied] = useState(false);
  const text = formatDiagnostics(instanceId, diagnostics);

  return (
    <div style={{ marginTop: 16 }} data-testid="webui-panel-diagnostics">
      <div
        style={{
          fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
          fontSize: 11,
          lineHeight: 1.5,
          color: 'var(--text-muted)',
          userSelect: 'all',
          wordBreak: 'break-all',
        }}
      >
        {diagnostics.code}
        {diagnostics.requestId ? ` · ${diagnostics.requestId}` : ''}
      </div>
      <button
        type="button"
        data-testid="webui-copy-diagnostics"
        onClick={() => {
          // Clipboard can reject (permissions, insecure context). The text is
          // selectable above either way, so a failure is not a dead end.
          void navigator.clipboard
            ?.writeText(text)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
        style={{
          marginTop: 8,
          fontSize: 11,
          fontWeight: 600,
          padding: '4px 10px',
          border: '1px solid var(--border)',
          borderRadius: 6,
          background: 'transparent',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
        }}
      >
        {copied ? 'Copied' : 'Copy details'}
      </button>
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePendingRetryAfter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_PENDING_RETRY_AFTER_MS;
  }

  return Math.min(
    MAX_PENDING_RETRY_AFTER_MS,
    Math.max(MIN_PENDING_RETRY_AFTER_MS, Math.floor(value)),
  );
}

function toPendingFetchState(body: LoginUrlPendingResponse): Extract<FetchState, { kind: 'pending' }> {
  return {
    kind: 'pending',
    retryAfterMs: normalizePendingRetryAfter(body.retryAfterMs),
    message:
      typeof body.message === 'string' && body.message.trim()
        ? body.message
        : 'Hermes is still preparing this workspace.',
  };
}

function readSavedWebuiLocale(): Locale | null {
  if (typeof document === 'undefined') {
    return null;
  }

  const cookie = document.cookie
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${LOCALE_COOKIE_NAME}=`));
  if (!cookie) return null;

  let value: string;
  try {
    value = decodeURIComponent(cookie.slice(LOCALE_COOKIE_NAME.length + 1));
  } catch {
    return null;
  }

  return normalizeLocale(value);
}

function buildLoginUrlEndpoint(
  instanceId: string,
  locale: Locale | null,
  appearance: WebUIAppearance | null,
): string {
  const endpoint = `/api/instances/${instanceId}/webui-login-url`;
  const params = new URLSearchParams();
  if (locale) params.set('locale', locale);
  if (appearance) {
    params.set('theme', appearance.theme);
    params.set('skin', appearance.skin);
  }
  const query = params.toString();
  return query ? `${endpoint}?${query}` : endpoint;
}

type HandoffPhase = 'loading' | 'pending';

function WebuiHandoffLoadingShell({
  className,
  phase,
  message,
}: {
  className?: string;
  phase: HandoffPhase;
  message?: string;
}) {
  // The loading phase covers a real (usually brief) wait: the handoff URL the
  // iframe points at is minted by /webui-login-url, which probes the instance
  // gateway before it can answer. There's nothing to render the iframe against
  // until that resolves, so we show an honest spinner rather than a staged
  // progress animation. The pending phase is the genuinely-slower cold-boot
  // wait and keeps its own server-provided message.
  const title = phase === 'loading' ? 'Connecting' : 'Preparing your workspace';
  const description =
    phase === 'loading' ? null : message ?? 'Hermes is still preparing this workspace.';

  return (
    <div
      className={className}
      role="status"
      aria-live="polite"
      aria-label={title}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        width: '100%',
        height: '100%',
        minHeight: 260,
        padding: 24,
        textAlign: 'center',
        color: 'var(--ink-black)',
        borderRadius: 0,
        background: 'transparent',
      }}
    >
      <Loader2
        size={22}
        aria-hidden="true"
        style={{ animation: 'spin 1s linear infinite', color: 'var(--gold-leaf)' }}
      />
      <p
        style={{
          margin: 0,
          fontSize: 13,
          fontWeight: 650,
          color: 'var(--ink-black)',
        }}
      >
        {title}…
      </p>
      {description ? (
        <p
          style={{
            margin: 0,
            maxWidth: 360,
            fontSize: 12,
            lineHeight: 1.45,
            color: 'var(--text-secondary)',
          }}
        >
          {description}
        </p>
      ) : null}
    </div>
  );
}

type LoginUrlErrorBody = {
  message: string;
  instanceStatus: string | null;
  serverReason: string | null;
};

async function readErrorBody(response: Response): Promise<LoginUrlErrorBody> {
  const text = await response.text().catch(() => '');
  if (!text) return { message: '', instanceStatus: null, serverReason: null };

  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && typeof parsed.error === 'string') {
      return {
        message: parsed.error,
        instanceStatus:
          typeof parsed.instanceStatus === 'string' ? parsed.instanceStatus : null,
        // Machine-readable not-running reason (instance_stopped /
        // instance_error / instance_failed) from the handoff route.
        serverReason: typeof parsed.reason === 'string' ? parsed.reason : null,
      };
    }
  } catch {
    // Fall back to the raw response text below.
  }

  return { message: text, instanceStatus: null, serverReason: null };
}

class LoginUrlHttpError extends Error {
  readonly status: number;
  readonly instanceStatus: string | null;
  readonly serverReason: string | null;
  readonly requestId: string | null;

  constructor(status: number, body: LoginUrlErrorBody, requestId: string | null = null) {
    super(`HTTP ${status}${body.message ? `: ${body.message.slice(0, 120)}` : ''}`);
    this.name = 'LoginUrlHttpError';
    this.status = status;
    this.instanceStatus = body.instanceStatus;
    this.serverReason = body.serverReason;
    this.requestId = requestId;
  }
}

function requestIdOf(err: unknown): string | null {
  return err instanceof LoginUrlHttpError ? err.requestId : null;
}

// The handoff route answers 400 + "Instance is not currently running" for
// instances that are genuinely stopped (statuses that are merely *starting*
// come back as kind:'pending' instead). Treat it as a distinct UI state, not
// a generic failure.
function isInstanceNotRunningError(err: unknown): err is LoginUrlHttpError {
  return (
    err instanceof LoginUrlHttpError &&
    err.status === 400 &&
    err.message.toLowerCase().includes('not currently running')
  );
}

// Which not-running panel to show. Prefers the route's machine-readable
// reason; falls back to the raw instanceStatus for older server responses.
//   'failed'  → dead deployment: redeploy/support, no Start button
//   'error'   → broken box: restart/repair guidance
//   'stopped' → expected parked box (manual stop / inactivity pause): Start
type StoppedPanelVariant = 'stopped' | 'error' | 'failed';

function resolveStoppedPanelVariant(err: LoginUrlHttpError): StoppedPanelVariant {
  if (err.serverReason === 'instance_failed' || err.instanceStatus === 'failed') {
    return 'failed';
  }
  if (err.serverReason === 'instance_error' || err.instanceStatus === 'error') {
    return 'error';
  }
  return 'stopped';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function fetchWithNetworkRetry(input: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (err) {
      // fetch() only rejects at the network level ("Failed to fetch"), which
      // is frequently transient (tab wake-up, flaky wifi, brief blips). HTTP
      // error statuses resolve normally and are never retried here.
      if (!(err instanceof TypeError) || attempt >= NETWORK_RETRY_LIMIT) {
        throw err;
      }
      await delay(NETWORK_RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
}

async function fetchLoginUrl(
  instanceId: string,
  appearance: WebUIAppearance | null,
): Promise<LoginUrlResponse | LoginUrlPendingResponse> {
  const locale = readSavedWebuiLocale();
  const r = await fetchWithNetworkRetry(buildLoginUrlEndpoint(instanceId, locale, appearance), {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  // Vercel stamps every response with x-vercel-id; it is the join key back to
  // the server-side log line for this exact request. Capture it so a user can
  // hand us one string instead of a screenshot of a blank box.
  // Optional-chained deliberately: capturing a support breadcrumb must never be
  // able to throw on the path that opens the user's chat.
  const requestId = r.headers?.get('x-vercel-id') ?? null;
  if (!r.ok) {
    throw new LoginUrlHttpError(r.status, await readErrorBody(r), requestId);
  }
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    throw new Error('Login URL response was not JSON');
  }

  if (isRecord(body) && body.kind === 'pending') {
    return {
      kind: 'pending',
      reason: typeof body.reason === 'string' ? body.reason : 'instance_not_ready',
      message: typeof body.message === 'string' ? body.message : undefined,
      instanceStatus: typeof body.instanceStatus === 'string' ? body.instanceStatus : null,
      retryAfterMs: typeof body.retryAfterMs === 'number' ? body.retryAfterMs : undefined,
      requestId,
    };
  }

  if (!isRecord(body) || typeof body.url !== 'string') {
    throw new Error('Login URL response was malformed');
  }
  return {
    kind: 'ready',
    url: locale ? appendWebUILocaleSearchParams(body.url, locale) : body.url,
    expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : Date.now(),
  };
}

function postWebUIAppearance(
  iframe: HTMLIFrameElement | null,
  url: string,
  appearance: WebUIAppearance | null,
) {
  if (!iframe?.contentWindow || !appearance) return;

  try {
    iframe.contentWindow.postMessage(
      {
        type: WEBUI_DASHBOARD_APPEARANCE_MESSAGE_TYPE,
        source: 'hermes-dashboard',
        appearance,
      },
      new URL(url).origin,
    );
  } catch {
    // The iframe URL is minted by our own route, but keep appearance sync from
    // breaking handoff if a malformed gateway URL ever sneaks through.
  }
}

// Inject a prompt into the embedded chat as a user message. The box webui
// (apps/desktop) listens for this on window.parent and submits it via the
// normal send path (creating the first session). Returns whether the post was
// dispatched (best-effort; an older box silently ignores the message type).
function postWebUIMessage(
  iframe: HTMLIFrameElement | null,
  url: string,
  text: string,
): boolean {
  const trimmed = text.trim();
  if (!iframe?.contentWindow || !trimmed) return false;

  try {
    iframe.contentWindow.postMessage(
      {
        type: WEBUI_DASHBOARD_SEND_MESSAGE_TYPE,
        source: 'hermes-dashboard',
        text: trimmed,
      },
      new URL(url).origin,
    );
    return true;
  } catch {
    return false;
  }
}

export interface WebuiIframeProps {
  instanceId: string;
  className?: string;
  /**
   * Live instance.status from the parent (which polls it). When the instance
   * is auto-woken (inactivity pause → start) or manually started, this flips
   * from a non-running value to 'running'. The iframe watches it and re-fetches
   * the handoff URL so it self-recovers instead of sitting on a stale 'stopped'
   * panel until the user manually clicks Refresh. Optional — when omitted the
   * iframe behaves exactly as before (mount-time fetch only).
   */
  instanceStatus?: string | null;
  /**
   * Invoked when the user clicks Start from the stopped panel (non-inactivity
   * stopped reasons, where there is no transparent auto-wake). The parent owns
   * the power action; the iframe just surfaces the affordance. When omitted the
   * Start button is hidden and only Refresh is shown.
   */
  onRequestStart?: () => void;
  /**
   * Registers (and later clears) a sender the parent can call to inject a
   * prompt into the embedded chat. Provided once the iframe handoff URL is
   * ready, cleared (null) when it isn't. Lets prompt-injection surfaces (the
   * Workflows-of-the-week shelf, the welcome starter strip) drive the chat
   * without reaching into the iframe ref. Memoize this (useCallback) to avoid
   * re-registration churn.
   */
  onStarterSenderReady?: (send: ((text: string) => boolean) | null) => void;
}

export function WebuiIframe({
  instanceId,
  className,
  instanceStatus,
  onRequestStart,
  onStarterSenderReady,
}: WebuiIframeProps) {
  const [state, setState] = useState<FetchState>({ kind: 'loading' });
  // Set when a popup blocker ate the open-in-new-tab window: holds a freshly
  // minted handoff URL we render as a plain anchor (a direct link click
  // carries its own user activation, so the blocker won't eat it).
  const [newTabFallbackUrl, setNewTabFallbackUrl] = useState<string | null>(null);
  const { resolvedTheme } = useTheme();
  const appearance = useMemo(
    () => resolveWebUIAppearanceFromDashboardTheme(resolvedTheme),
    [resolvedTheme],
  );
  const appearanceRef = useRef<WebUIAppearance | null>(appearance);
  const lastRefreshRef = useRef<number>(0);
  const loadAttemptRef = useRef<number>(0);
  const pollTimerRef = useRef<number | null>(null);
  const refreshGenerationRef = useRef<number>(0);
  const refreshRef = useRef<(options?: { force?: boolean; silent?: boolean }) => Promise<void>>(async () => {});
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Timestamp of the FIRST gateway-unreachable pending poll in the current
  // unreachable streak. Reset whenever we leave that condition (ready, stopped,
  // error, a non-gateway pending reason, or a manual retry). Drives the switch
  // to the honest `repairing` state once the streak exceeds the threshold.
  const gatewayUnreachableSinceRef = useRef<number | null>(null);
  // Timestamp of the FIRST pending poll in the current continuous-pending
  // streak, REGARDLESS of reason. Drives the absolute spinner ceiling so a
  // never-resolving non-gateway reason can't trap the user forever. Reset
  // whenever we leave pending (ready/stopped/error) or on a manual retry.
  const pendingSinceRef = useRef<number | null>(null);
  // Ensures the "we've been notified" ops report fires at most once per
  // unreachable streak — cleared alongside gatewayUnreachableSinceRef.
  const repairReportedRef = useRef<boolean>(false);
  // Armed when an iframe document finishes loading; cleared the moment the box
  // confirms liveness. Surviving to expiry means nothing inside the frame ever
  // proved itself, so we probe the gateway before believing the worst.
  const livenessTimerRef = useRef<number | null>(null);
  // The loadAttempt whose chat has already been confirmed alive. The box emits
  // HERMES_WEBUI_READY once per handoff session, so a LATER document load
  // within the same session (in-box navigation) would re-arm a watchdog that
  // can never be satisfied — flipping a working chat to the error panel. Keyed
  // by loadAttempt so a genuinely new handoff still re-arms.
  const livenessConfirmedAttemptRef = useRef<number | null>(null);

  const clearPendingPoll = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const clearLivenessWatchdog = useCallback(() => {
    if (livenessTimerRef.current !== null) {
      window.clearTimeout(livenessTimerRef.current);
      livenessTimerRef.current = null;
    }
  }, []);

  // Fire-and-forget breadcrumb so the founder sees a stuck workspace in
  // /dashboard/ops without waiting for the user to email. Mirrors the
  // ReportProblemLink → /api/support/report contract; outcome is ignored.
  const reportRepairing = useCallback(() => {
    try {
      void fetch('/api/support/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          surface: 'webui-pending-timeout',
          summary: 'Workspace stuck: gateway unreachable past repair threshold',
          instanceId,
          errorContext: `gateway unreachable for >${Math.round(PENDING_REPAIR_THRESHOLD_MS / 1000)}s of continuous pending polls`,
        }),
      }).catch(() => {});
    } catch {
      // best-effort
    }
  }, [instanceId]);

  const schedulePendingRefresh = useCallback((retryAfterMs: number) => {
    clearPendingPoll();
    pollTimerRef.current = window.setTimeout(() => {
      pollTimerRef.current = null;
      void refreshRef.current({ force: true, silent: true });
    }, normalizePendingRetryAfter(retryAfterMs));
  }, [clearPendingPoll]);

  const applyPendingResult = useCallback((result: LoginUrlPendingResponse) => {
    const now = Date.now();
    // Track the overall continuous-pending streak (any reason) for the absolute
    // ceiling, independent of the gateway-specific streak below.
    if (pendingSinceRef.current === null) {
      pendingSinceRef.current = now;
    }
    const reachedRepairState = (reasonTag: string) => {
      // Stop polling and switch to the honest repairing state. Emit the
      // breadcrumb once per streak.
      clearPendingPoll();
      if (!repairReportedRef.current) {
        repairReportedRef.current = true;
        // pending_reason (NOT `reason`): the enum slot belongs to the stable
        // IframeErrorReason; the server's pending reason rides alongside it.
        trackIframeError(instanceId, 'fetch_url_failed', {
          message: reasonTag,
          pending_reason: result.reason,
        });
        reportRepairing();
      }
      // Keep the server's pending reason: it is the difference between
      // "gateway_unreachable" (the box isn't answering) and a generic stall.
      setState({
        kind: 'repairing',
        diagnostics: {
          code: result.reason || reasonTag,
          instanceStatus: result.instanceStatus,
          requestId: result.requestId,
          at: Date.now(),
        },
      });
    };

    // Track how long the gateway has been continuously unreachable. Only
    // gateway-unreachable reasons accumulate; any other pending reason (normal
    // boot) resets the streak so we keep the patient preparing spinner for
    // legitimate cold-starts.
    const isGatewayUnreachable = GATEWAY_UNREACHABLE_PENDING_REASONS.has(result.reason);
    if (isGatewayUnreachable) {
      if (gatewayUnreachableSinceRef.current === null) {
        gatewayUnreachableSinceRef.current = now;
      }
      const elapsed = now - gatewayUnreachableSinceRef.current;
      if (elapsed >= PENDING_REPAIR_THRESHOLD_MS) {
        reachedRepairState('pending_repair_threshold_exceeded');
        return;
      }
    } else {
      gatewayUnreachableSinceRef.current = null;
    }

    // Absolute ceiling: even a non-gateway reason that never resolves must not
    // trap the user on the spinner indefinitely.
    if (now - pendingSinceRef.current >= ABSOLUTE_PENDING_REPAIR_THRESHOLD_MS) {
      reachedRepairState('pending_absolute_threshold_exceeded');
      return;
    }

    const pending = toPendingFetchState(result);
    setState(pending);
    schedulePendingRefresh(pending.retryAfterMs);
  }, [clearPendingPoll, instanceId, reportRepairing, schedulePendingRefresh]);

  const refresh = useCallback(async (options?: { force?: boolean; silent?: boolean }) => {
    const now = Date.now();
    if (!options?.force && now - lastRefreshRef.current < REFRESH_BACKOFF_MS) return;
    lastRefreshRef.current = now;
    const refreshGeneration = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = refreshGeneration;

    // Clear any pending poll timer up front: whether this refresh ends up
    // pending again or transitions to ready/error, the previous timer is
    // stale either way.
    clearPendingPoll();

    // A user-initiated (forced) refresh — including the repairing-state Retry —
    // starts a fresh unreachable streak so a previous timeout doesn't instantly
    // re-trip the repairing UI before the new attempt has had its own chance.
    // Only a genuine user-initiated retry (force AND not the silent pending
    // poll) resets these streaks. The silent poll cycle is force:true too —
    // resetting on it restarts the clock every tick and defeats the threshold
    // entirely. That bug used to apply to gatewayUnreachableSinceRef: because
    // every ~4s silent poll cleared it, the 150s gateway-unreachable threshold
    // could never elapse, so a dead gateway fell through to the 300s absolute
    // ceiling instead — users stared at "Preparing your workspace" for twice as
    // long as intended before being told anything was wrong.
    if (options?.force && !options.silent) {
      gatewayUnreachableSinceRef.current = null;
      repairReportedRef.current = false;
      pendingSinceRef.current = null;
    }

    // Any minted popup-fallback link is single-purpose and short-lived;
    // a refresh supersedes it.
    setNewTabFallbackUrl(null);

    // Silent refresh: skip the loading reset so the pending-state poll
    // cycle doesn't flip the user back to the initial handoff shell every
    // retryAfterMs tick. The preparation shell stays mounted continuously
    // while the next fetch is in flight; state only changes when the result
    // actually does.
    if (!options?.silent) {
      setState({ kind: 'loading' });
    }
    try {
      const result = await fetchLoginUrl(instanceId, appearanceRef.current);
      if (refreshGeneration !== refreshGenerationRef.current) return;
      if (result.kind === 'pending') {
        applyPendingResult(result);
        return;
      }

      // Gateway answered — clear any unreachable streak so a later flap starts
      // counting fresh.
      gatewayUnreachableSinceRef.current = null;
      pendingSinceRef.current = null;
      repairReportedRef.current = false;
      loadAttemptRef.current += 1;
      setState({ kind: 'ready', url: result.url, loadAttempt: loadAttemptRef.current });
    } catch (err) {
      if (refreshGeneration !== refreshGenerationRef.current) return;
      // Leaving the pending poll cycle (stopped/error) ends the continuous
      // streak — reset so a later reconnect starts its clock fresh.
      pendingSinceRef.current = null;
      const reason = err instanceof Error ? err.message : String(err);
      if (isInstanceNotRunningError(err)) {
        // NOTE: free-form detail key is `message`, never `reason` —
        // trackIframeError keeps `reason` as the stable enum PostHog
        // dashboards bucket on.
        const variant = resolveStoppedPanelVariant(err);
        if (variant === 'stopped') {
          // Expected parked-box state (manual stop / inactivity pause) — a
          // normal outcome of the mount-time fetch, not an error. Keep it
          // out of webui_iframe_error so the error dashboards stay signal.
          trackIframeStopped(instanceId, {
            message: reason,
            instanceStatus: err.instanceStatus,
          });
        } else {
          trackIframeError(instanceId, 'instance_not_running', {
            message: reason,
            instanceStatus: err.instanceStatus,
            panel_variant: variant,
          });
        }
        setState({ kind: 'stopped', variant, instanceStatus: err.instanceStatus });
        return;
      }
      trackIframeError(instanceId, 'fetch_url_failed', { message: reason });
      setState({
        kind: 'error',
        reason,
        diagnostics: {
          code:
            err instanceof LoginUrlHttpError
              ? err.serverReason || `http_${err.status}`
              : 'handoff_fetch_failed',
          instanceStatus: err instanceof LoginUrlHttpError ? err.instanceStatus : null,
          requestId: requestIdOf(err),
          at: Date.now(),
        },
      });
    }
  }, [applyPendingResult, clearPendingPoll, instanceId]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  useEffect(() => {
    appearanceRef.current = appearance;
  }, [appearance]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh({ force: true });
    return () => {
      refreshGenerationRef.current += 1;
      clearPendingPoll();
      clearLivenessWatchdog();
    };
  }, [clearLivenessWatchdog, clearPendingPoll, refresh]);

  // Self-recover on wake. The parent polls instance.status; when it flips to
  // 'running' (auto-wake after an inactivity pause, or a manual Start) we
  // re-fetch the handoff URL so a previously-rendered 'stopped'/'error' panel
  // reconnects on its own. We only act on the transition INTO 'running' so a
  // steady 'running' status (the normal case) never triggers extra fetches.
  const prevStatusRef = useRef<string | null | undefined>(instanceStatus);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = instanceStatus;
    if (instanceStatus === 'running' && prev !== 'running' && prev !== undefined) {
      void refreshRef.current({ force: true });
    }
  }, [instanceStatus]);

  const confirmLiveness = useCallback(
    (loadAttempt: number, source: 'postmessage' | 'probe') => {
      clearLivenessWatchdog();
      // Confirm at most once per handoff session, so a chatty box can't spam
      // chat_alive and skew the document_loaded → chat_alive funnel.
      if (livenessConfirmedAttemptRef.current === loadAttempt) return;
      livenessConfirmedAttemptRef.current = loadAttempt;
      trackIframeLoaded(instanceId, 'chat_alive', { loadAttempt, source });
    },
    [clearLivenessWatchdog, instanceId],
  );

  // Watchdog expiry. A silent frame is NOT proof of a broken box: every box on
  // an image older than the HERMES_WEBUI_READY emit is silent by definition,
  // and erroring those out would turn a working fleet into a fake outage. So
  // ask the server whether the gateway is actually healthy, and only surface
  // the error panel when the probe agrees.
  const runLivenessProbe = useCallback(
    // `armedGeneration` is captured when the watchdog is ARMED, not when it
    // fires: a refresh in between supersedes this attempt entirely, and a
    // generation read at fire time would match itself and let a stale verdict
    // through under the wrong loadAttempt.
    async (loadAttempt: number, armedGeneration: number) => {
      let isReady = false;
      let detail: string | undefined;
      // Same support breadcrumbs the handoff paths capture, sourced from the
      // probe instead: the box's own status and the x-vercel-id that pins this
      // exact probe's server-side log line.
      let probeRequestId: string | null = null;
      let probeStatus: string | null = null;
      try {
        const r = await fetch(`/api/instances/${instanceId}/health`, {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        probeRequestId = r.headers?.get('x-vercel-id') ?? null;
        const body: unknown = await r.json().catch(() => null);
        isReady = r.ok && isRecord(body) && body.isReady === true;
        if (isRecord(body) && typeof body.status === 'string') {
          probeStatus = body.status;
        }
        if (!isReady && isRecord(body) && typeof body.error === 'string') {
          detail = body.error;
        }
      } catch (err) {
        // A probe we couldn't even send says nothing about the box — but it
        // also leaves the user in front of a frame that never came alive, so
        // the honest panel is still the right destination.
        detail = err instanceof Error ? err.message : String(err);
      }
      // A refresh/unmount superseded this attempt while the probe was in
      // flight — its verdict is about a frame nobody is looking at anymore.
      if (armedGeneration !== refreshGenerationRef.current) return;

      if (isReady) {
        confirmLiveness(loadAttempt, 'probe');
        return;
      }

      trackIframeError(instanceId, 'liveness_timeout', {
        loadAttempt,
        message: detail,
        timeout_ms: LIVENESS_WATCHDOG_MS,
        instanceStatus: probeStatus,
        requestId: probeRequestId,
      });
      setState({
        kind: 'error',
        reason: LIVENESS_TIMEOUT_REASON,
        diagnostics: {
          code: 'liveness_timeout',
          instanceStatus: probeStatus,
          requestId: probeRequestId,
          at: Date.now(),
        },
      });
    },
    [confirmLiveness, instanceId],
  );

  const handleLoad = useCallback(() => {
    if (state.kind !== 'ready') {
      trackIframeLoaded(instanceId, 'document_loaded');
      return;
    }
    const { loadAttempt } = state;
    // Deliberately NOT a success on its own — see IframeLoadedOutcome. The
    // matching chat_alive only lands if the box proves itself below.
    trackIframeLoaded(instanceId, 'document_loaded', { loadAttempt });
    postWebUIAppearance(iframeRef.current, state.url, appearanceRef.current);

    if (livenessConfirmedAttemptRef.current === loadAttempt) return;
    clearLivenessWatchdog();
    const armedGeneration = refreshGenerationRef.current;
    livenessTimerRef.current = window.setTimeout(() => {
      livenessTimerRef.current = null;
      void runLivenessProbe(loadAttempt, armedGeneration);
    }, LIVENESS_WATCHDOG_MS);
  }, [clearLivenessWatchdog, instanceId, runLivenessProbe, state]);

  // The box's own liveness signal — the fast path that keeps a healthy chat
  // from ever paying for the probe.
  useEffect(() => {
    if (state.kind !== 'ready') return;
    let expectedOrigin: string;
    try {
      expectedOrigin = new URL(state.url).origin;
    } catch {
      return;
    }
    const { loadAttempt } = state;
    const onMessage = (event: MessageEvent) => {
      // Any page can postMessage to us, so pin BOTH the origin and the frame:
      // a same-origin popup the user opened via "Open in new tab" shares the
      // gateway origin but must not vouch for the embedded chat.
      if (event.origin !== expectedOrigin) return;
      const contentWindow = iframeRef.current?.contentWindow;
      if (contentWindow && event.source !== contentWindow) return;
      if (!isRecord(event.data) || event.data.type !== WEBUI_READY_MESSAGE_TYPE) return;
      confirmLiveness(loadAttempt, 'postmessage');
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, [confirmLiveness, state]);

  // Leaving 'ready' (refresh, stop, error) means the frame the watchdog was
  // guarding is gone — disarm so it can't fire against a panel.
  useEffect(() => {
    if (state.kind !== 'ready') clearLivenessWatchdog();
  }, [clearLivenessWatchdog, state]);

  useEffect(() => {
    if (state.kind !== 'ready') return;
    postWebUIAppearance(iframeRef.current, state.url, appearance);
  }, [appearance, state]);

  // Expose a prompt sender to the parent while the handoff URL is ready.
  // Captures the ready url so the sender posts to the correct iframe origin.
  useEffect(() => {
    if (!onStarterSenderReady) return;
    if (state.kind !== 'ready') {
      onStarterSenderReady(null);
      return;
    }
    const url = state.url;
    onStarterSenderReady((text: string) => postWebUIMessage(iframeRef.current, url, text));
    return () => onStarterSenderReady(null);
  }, [state, onStarterSenderReady]);

  const handleError = useCallback(() => {
    trackIframeError(instanceId, 'load', state.kind === 'ready'
      ? { url: state.url, loadAttempt: state.loadAttempt }
      : undefined);
    void refresh({ force: true });
  }, [instanceId, refresh, state]);

  useEffect(() => {
    if (state.kind !== 'ready') return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    iframe.addEventListener('error', handleError);
    return () => {
      iframe.removeEventListener('error', handleError);
    };
  }, [handleError, state]);

  // Open-in-new-tab path. Top-level navigation puts <vm>.agents.hermesos.cloud
  // as the document's own first-party origin, so the cookie set by
  // /_sidecar/webui-login is sent on the redirect-followed GET / by all
  // browsers. Avoids the third-party-iframe cookie partition mess that
  // Chrome M125+ enforces on the inline iframe path.
  const openInNewTab = useCallback(async () => {
    setNewTabFallbackUrl(null);
    // window.open must run synchronously inside the click's user activation,
    // and must NOT pass 'noopener'/'noreferrer' window features: per spec
    // those make window.open() return null even when nothing was blocked,
    // which both looked like a popup blocker in telemetry and left us no
    // handle to navigate once the login URL resolved. We sever the reverse
    // opener link manually instead.
    const openedWindow = window.open('about:blank', '_blank');
    if (openedWindow) {
      try {
        openedWindow.opener = null;
      } catch {
        // Best-effort hardening; the URL is minted by our own route.
      }
    } else {
      trackIframeError(instanceId, 'open_new_tab_blocked', {
        source: 'open_new_tab',
        state: state.kind,
      });
    }

    try {
      const result = await fetchLoginUrl(instanceId, appearanceRef.current);
      if (result.kind === 'pending') {
        applyPendingResult(result);
        openedWindow?.close();
        return;
      }

      if (openedWindow) {
        openedWindow.location.href = result.url;
      } else {
        // Genuinely popup-blocked: offer the minted URL as a plain anchor the
        // user can click directly (its own gesture, so it won't be blocked).
        setNewTabFallbackUrl(result.url);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      openedWindow?.close();
      if (isInstanceNotRunningError(err)) {
        const variant = resolveStoppedPanelVariant(err);
        if (variant === 'stopped') {
          trackIframeStopped(instanceId, {
            message: reason,
            source: 'open_new_tab',
            instanceStatus: err.instanceStatus,
          });
        } else {
          trackIframeError(instanceId, 'instance_not_running', {
            message: reason,
            source: 'open_new_tab',
            instanceStatus: err.instanceStatus,
            panel_variant: variant,
          });
        }
        setState({ kind: 'stopped', variant, instanceStatus: err.instanceStatus });
        return;
      }
      trackIframeError(instanceId, 'fetch_url_failed', { message: reason, source: 'open_new_tab' });
    }
  }, [applyPendingResult, instanceId, state]);

  if (state.kind === 'stopped') {
    // Three not-running shapes, mapped off the handoff route's machine
    // reason (fallback: raw instanceStatus):
    //   failed  → the deployment is dead: redeploy or support; a Start
    //             button would be a lie, so it's hidden.
    //   error   → the box is broken but usually recoverable: restart/repair.
    //   stopped → the expected parked box: the plain Start panel.
    const headline =
      state.variant === 'failed'
        ? "This agent's deployment failed."
        : state.variant === 'error'
          ? 'This agent hit an error.'
          : "This workspace isn't running right now.";
    const detail =
      state.variant === 'failed'
        ? 'Redeploy it from the agent console, or contact support if it keeps failing.'
        : state.variant === 'error'
          ? onRequestStart
            ? "Restart it to recover — if that doesn't help, repair it from the agent console."
            : "Restart the instance from its controls to recover — if that doesn't help, repair it from the agent console."
          : onRequestStart
            ? 'Start it back up — it reconnects automatically once it’s running.'
            : 'Start the instance from its controls, then refresh to reconnect.';
    const showStartButton = Boolean(onRequestStart) && state.variant !== 'failed';
    return (
      <div
        className={className}
        role="status"
        aria-live="polite"
        data-testid="webui-stopped-state"
        data-variant={state.variant}
        style={PANEL_SURFACE_STYLE}
      >
        <div>
          <p style={{ margin: 0, marginBottom: 8 }}>
            {headline}
          </p>
          <p style={PANEL_DETAIL_STYLE}>
            {detail}
          </p>
          {showStartButton ? (
            <button
              type="button"
              data-testid="webui-stopped-start"
              onClick={() => onRequestStart?.()}
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: '6px 14px',
                border: '1px solid var(--border)',
                borderRadius: 6,
                background: 'var(--gold-leaf, #c9a24b)',
                color: 'var(--ink-black, #11151b)',
                cursor: 'pointer',
                marginRight: 8,
              }}
            >
              {state.variant === 'error' ? 'Restart' : 'Start'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void refresh({ force: true })}
            style={PANEL_BUTTON_STYLE}
          >
            Refresh
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div
        className={className}
        role="alert"
        data-testid="webui-error-state"
        style={PANEL_SURFACE_STYLE}
      >
        <div>
          <p style={{ margin: 0, marginBottom: 8 }}>
            We couldn&apos;t open your workspace just now.
          </p>
          <p style={PANEL_DETAIL_STYLE}>
            {state.reason}
          </p>
          <button
            type="button"
            onClick={() => void refresh({ force: true })}
            style={{ ...PANEL_BUTTON_STYLE, marginRight: 8 }}
          >
            Retry
          </button>
          <button
            type="button"
            onClick={() => void openInNewTab()}
            style={{
              ...PANEL_BUTTON_STYLE,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            Open in new tab
            <ExternalLink size={12} aria-hidden="true" />
          </button>
          {newTabFallbackUrl ? (
            <p style={{ margin: 0, marginTop: 14, fontSize: 12 }}>
              Your browser blocked the new tab.{' '}
              <a
                href={newTabFallbackUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setNewTabFallbackUrl(null)}
                style={{ color: 'inherit', fontWeight: 600, textDecoration: 'underline' }}
              >
                Click here to open
              </a>
            </p>
          ) : null}
          <PanelDiagnosticsBlock instanceId={instanceId} diagnostics={state.diagnostics} />
        </div>
      </div>
    );
  }

  if (state.kind === 'repairing') {
    return (
      <div
        className={className}
        role="alert"
        data-testid="webui-repairing-state"
        style={PANEL_SURFACE_STYLE}
      >
        <div>
          <p style={{ margin: 0, marginBottom: 8, fontWeight: 650 }}>
            Something&apos;s wrong with your agent.
          </p>
          <p style={{ ...PANEL_DETAIL_STYLE, maxWidth: 360 }}>
            We&apos;ve been notified and are working to repair it. You can try
            again in a moment, or reach out if it stays stuck.
          </p>
          <button
            type="button"
            onClick={() => void refresh({ force: true })}
            style={PANEL_BUTTON_STYLE}
          >
            Retry
          </button>
          <PanelDiagnosticsBlock instanceId={instanceId} diagnostics={state.diagnostics} />
          <div style={{ marginTop: 14 }}>
            <ReportProblemLink
              surface="webui-repairing"
              summary="Agent stuck"
              instanceId={instanceId}
              errorContext={formatDiagnostics(instanceId, state.diagnostics)}
            />
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === 'loading' || state.kind === 'pending' || !state.url) {
    return (
      <WebuiHandoffLoadingShell
        className={className}
        phase={state.kind === 'pending' ? 'pending' : 'loading'}
        message={state.kind === 'pending' ? state.message : undefined}
      />
    );
  }

  return (
    <div
      className={className ? `${className} instance-chat-frame-shell` : 'instance-chat-frame-shell'}
      data-testid="webui-frame-shell"
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
        background: 'var(--bg-surface)',
      }}
    >
      <iframe
        key={`${state.url}:${state.loadAttempt}`}
        ref={iframeRef}
        src={state.url}
        data-load-attempt={state.loadAttempt}
        onLoad={handleLoad}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
        allow="clipboard-write; microphone"
        title="Workspace"
        style={{ border: 0, width: '100%', height: '100%', display: 'block' }}
      />
    </div>
  );
}
