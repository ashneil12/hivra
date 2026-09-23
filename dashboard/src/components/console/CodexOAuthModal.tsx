import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import posthog from 'posthog-js';
import { X, Terminal, Loader2, ExternalLink, Copy, CheckCircle2, AlertTriangle } from 'lucide-react';
import { readCodexAuthenticatedFlag } from '@/lib/codex-oauth';
import { copyTextToClipboard } from '@/lib/client/clipboard';
import { normalizeSshWarmupMessage } from '@/lib/ssh-warmup';
import { SafePortal } from '@/components/ui/SafePortal';
import {
  buildHermesOverlayVariants,
  buildHermesSurfaceSpring,
  buildHermesSurfaceVariants,
} from '@/components/ui/motion';

// Server worst case is 8s ssh-ready + 30s start command; keep the client
// abort above that so it cannot race the server's own timeout.
const CODEX_OAUTH_START_TIMEOUT_MS = 45_000;
// Codex device codes expire ~15 min server-side. Cap the polling at 12 min
// so the user gets an actionable error before the code is dead.
const CODEX_OAUTH_POLL_TIMEOUT_MS = 12 * 60 * 1000;
// Tolerate this many *consecutive* transient poll failures (network blip /
// 5xx / 429) before surfacing the error step, so a single hiccup mid-wait
// doesn't kill the whole flow. The 12-min hard cap still bounds the wait.
const CODEX_OAUTH_MAX_TRANSIENT_POLL_FAILURES = 3;

// Per-instance Codex OAuth attempt counter for the provider_oauth_*
// PostHog funnel. Lives at module scope so it survives unrelated
// re-renders inside the modal but resets on a hard refresh — which
// matches user perception of "starting over."
const codexAttemptByInstanceId = new Map<string, number>();

interface CodexOAuthModalProps {
  instanceId: string;
  profileName?: string;
  autoStart?: boolean;
  onClose: () => void;
  onSuccess?: (result?: { vaultKeyId?: string | null }) => void;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

// Sanitize an error before it ships to analytics: cap the length and strip
// anything token-shaped (JWTs, long base64/hex blobs) so a secret leaking
// into an upstream error message can never reach PostHog. The messages we
// expect here are our own apiError strings or fetch-level errors, but the
// scrub is cheap insurance.
function sanitizeOauthErrorMessage(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value
      : value instanceof Error
        ? value.message
        : String(value ?? '');
  return text
    .replace(/eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{4,}){0,2}/g, '[REDACTED]')
    .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, '[REDACTED]')
    .slice(0, 300);
}

function captureOauthEvent(
  event: 'provider_oauth_started' | 'provider_oauth_completed' | 'provider_oauth_failed',
  properties: Record<string, unknown>,
): void {
  try {
    posthog.capture(event, properties);
  } catch {
    // never let telemetry break the OAuth flow
  }
}

const codexOauthBaseProperties = (instanceId: string) => ({
  provider: 'codex',
  instance_id: instanceId,
  flow_type: 'device_code',
});

export function CodexOAuthModal({ instanceId, profileName, autoStart = false, onClose, onSuccess }: CodexOAuthModalProps) {
  type CodexStep = 'idle' | 'starting' | 'waiting' | 'success' | 'error';
  const [codexStep, setCodexStep] = useState<CodexStep>('idle');
  const [codexUrl, setCodexUrl] = useState('');
  const [codexCode, setCodexCode] = useState<string | null>(null);
  const [codexError, setCodexError] = useState('');
  // HTTP status of the failure that put us in the error step (null when the
  // failure happened before a response arrived). 503 = the runtime can't
  // host the device flow right now → offer the Vault page as an alternative.
  const [codexErrorStatus, setCodexErrorStatus] = useState<number | null>(null);
  const [codexCopied, setCodexCopied] = useState(false);
  const [urlCopied, setUrlCopied] = useState(false);
  const [openFallbackVisible, setOpenFallbackVisible] = useState(false);
  const [codexPollCount, setCodexPollCount] = useState(0);
  const codexPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startAbortRef = useRef<AbortController | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlCopyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const oauthStartedAtRef = useRef<number | null>(null);
  const autoStartFiredRef = useRef(false);
  // Count consecutive *transient* poll failures (network blip / 5xx / 429) so a
  // single hiccup during the ~12-min wait doesn't drop the user straight to the
  // error step. Reset on any successful poll. Definite errors (persistenceError,
  // 4xx) still fail immediately.
  const transientPollFailuresRef = useRef(0);
  // A backdrop press closes only when it also started on the backdrop, so a
  // drag-select out of the URL or code mid-sign-in does not.
  const backdropPressRef = useRef(false);
  const reduceMotion = useReducedMotion();
  const overlayVariants = buildHermesOverlayVariants(Boolean(reduceMotion));
  const modalVariants = buildHermesSurfaceVariants(Boolean(reduceMotion), {
    offset: 18,
    scale: 0.985,
    spring: 'panel',
  });
  const buttonSpring = buildHermesSurfaceSpring(Boolean(reduceMotion), 'dock');
  const tapScale = reduceMotion ? undefined : { scale: 0.97 };

  useEffect(() => {
    return () => {
      if (codexPollRef.current) clearInterval(codexPollRef.current);
      startAbortRef.current?.abort();
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
      if (urlCopyResetTimerRef.current) clearTimeout(urlCopyResetTimerRef.current);
    };
  }, []);

  const handleClose = useCallback(() => {
    if (successTimerRef.current) {
      clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }

    onClose();
  }, [onClose]);

  const handleCodexCopy = useCallback(async () => {
    if (!codexCode) {
      return;
    }

    const didCopy = await copyTextToClipboard(codexCode);
    if (!didCopy) {
      return;
    }

    setCodexCopied(true);
    if (copyResetTimerRef.current) {
      clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = setTimeout(() => {
      setCodexCopied(false);
      copyResetTimerRef.current = null;
    }, 2000);
  }, [codexCode]);

  const handleUrlCopy = useCallback(async () => {
    if (!codexUrl) return;
    const didCopy = await copyTextToClipboard(codexUrl);
    if (!didCopy) return;
    setUrlCopied(true);
    if (urlCopyResetTimerRef.current) {
      clearTimeout(urlCopyResetTimerRef.current);
    }
    urlCopyResetTimerRef.current = setTimeout(() => {
      setUrlCopied(false);
      urlCopyResetTimerRef.current = null;
    }, 2000);
  }, [codexUrl]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleClose]);

  const handleOpenInNewTab = useCallback(() => {
    if (!codexUrl) return;
    const win = typeof window !== 'undefined'
      ? window.open(codexUrl, '_blank', 'noopener,noreferrer')
      : null;
    // With noopener/noreferrer, some browsers return null even when they
    // successfully opened the tab. Treat null as "unknown" and show a neutral
    // copy fallback instead of a false red error.
    setOpenFallbackVisible(!win);
  }, [codexUrl]);

  // One tap on a phone: start the copy, then open sign-in in the same user
  // gesture so the popup is not blocked. The copy settles after the tab opens.
  const handleCopyCodeAndOpen = useCallback(() => {
    void handleCodexCopy();
    handleOpenInNewTab();
  }, [handleCodexCopy, handleOpenInNewTab]);

  const handleCodexStart = useCallback(async () => {
    if (!instanceId) return;
    const startSearchParams = new URLSearchParams();
    if (profileName && profileName !== 'default') {
      startSearchParams.set('profile', profileName);
    }
    const statusSearchParams = new URLSearchParams(startSearchParams);
    statusSearchParams.set('apply', '1');
    const startQuery = startSearchParams.toString();
    const profileQuery = startQuery
      ? `?${startQuery}`
      : '';
    const statusQuery = `?${statusSearchParams.toString()}`;
    setCodexStep('starting');
    setCodexError('');
    setCodexErrorStatus(null);
    setOpenFallbackVisible(false);
    setCodexPollCount(0);

    const previousAttempts = codexAttemptByInstanceId.get(instanceId) ?? 0;
    const attemptNumber = previousAttempts + 1;
    codexAttemptByInstanceId.set(instanceId, attemptNumber);
    oauthStartedAtRef.current = Date.now();
    captureOauthEvent('provider_oauth_started', {
      ...codexOauthBaseProperties(instanceId),
      attempt_number: attemptNumber,
    });

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let startHttpStatus: number | null = null;
    try {
      startAbortRef.current?.abort();
      const controller = new AbortController();
      startAbortRef.current = controller;
      timeoutId = setTimeout(() => {
        controller.abort();
      }, CODEX_OAUTH_START_TIMEOUT_MS);

      const res = await fetch(`/api/instances/${instanceId}/oauth/codex/start${profileQuery}`, {
        method: 'POST',
        signal: controller.signal,
      });
      startHttpStatus = res.status;
      // Gateways and edge proxies answer 502/504s with HTML; a bare
      // res.json() would throw "Unexpected token '<'" at the user. Parse
      // defensively and fall back to the generic message instead.
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // Machine-readable precondition from the start route: the box is
        // powered off/archived, so the device flow can't run. Show a friendly
        // "start your agent first" — and never auto-retry: the page behind
        // the modal owns the Start/Restore controls.
        if (res.status === 409 && data?.error === 'instance_off') {
          setCodexError(
            'This agent is powered off right now. Start (or restore) your agent first, then connect Codex.'
          );
          setCodexErrorStatus(409);
          setCodexStep('error');
          captureOauthEvent('provider_oauth_failed', {
            ...codexOauthBaseProperties(instanceId),
            failure_reason: 'instance_off',
            failure_stage: 'start',
            failure_category: 'precondition',
            retryable: true,
            http_status: 409,
            error_message: 'instance_off',
          });
          return;
        }
        throw new Error(
          normalizeSshWarmupMessage(
            typeof data?.error === 'string' ? data.error : undefined,
            'Failed to start Codex OAuth'
          )
        );
      }
      const startUrl = typeof data?.data?.url === 'string' ? data.data.url : '';
      if (!startUrl) {
        throw new Error('Codex login started but no authorization URL was returned. Please try again.');
      }
      setCodexUrl(startUrl);
      setCodexCode(typeof data?.data?.code === 'string' ? data.data.code : null);
      setCodexStep('waiting');
      const pollStartedAt = Date.now();
      transientPollFailuresRef.current = 0;
      codexPollRef.current = setInterval(async () => {
        // 12-min hard timeout: Codex device codes are valid for ~15 min;
        // give up before the server-side expiry so the user sees an
        // actionable error instead of an indefinite "Waiting…" hang.
        if (Date.now() - pollStartedAt > CODEX_OAUTH_POLL_TIMEOUT_MS) {
          if (codexPollRef.current) {
            clearInterval(codexPollRef.current);
            codexPollRef.current = null;
          }
          setCodexError('Authorization code expired. Codex codes are valid for ~15 minutes — try starting again.');
          setCodexErrorStatus(null);
          setCodexStep('error');
          captureOauthEvent('provider_oauth_failed', {
            ...codexOauthBaseProperties(instanceId),
            failure_reason: 'code_expired',
            failure_stage: 'poll',
            failure_category: 'cancelled',
            retryable: true,
            http_status: null,
            error_message: 'code_expired',
          });
          return;
        }
        let pollHttpStatus: number | null = null;
        try {
          setCodexPollCount((count) => count + 1);
          const sr = await fetch(`/api/instances/${instanceId}/oauth/codex/status${statusQuery}`);
          pollHttpStatus = sr.status;
          const sd = await sr.json().catch(() => null);
          if (!sr.ok) {
            const transient = sr.status >= 500 || sr.status === 429;
            const err = new Error(
              normalizeSshWarmupMessage(
                typeof sd?.error === 'string' ? sd.error : undefined,
                'Failed to check Codex OAuth status'
              )
            ) as Error & { codexTransient?: boolean };
            err.codexTransient = transient;
            throw err;
          }
          // A clean status read — clear any accumulated transient-failure streak.
          transientPollFailuresRef.current = 0;
          if (sd?.data?.persistenceError) {
            throw new Error(`Codex connected on this agent, but reusable Vault save failed: ${sd.data.persistenceError}`);
          }
          if (readCodexAuthenticatedFlag(sd)) {
            clearInterval(codexPollRef.current!);
            codexPollRef.current = null;
            setCodexStep('success');
            captureOauthEvent('provider_oauth_completed', {
              ...codexOauthBaseProperties(instanceId),
              time_to_complete_ms: oauthStartedAtRef.current
                ? Date.now() - oauthStartedAtRef.current
                : null,
            });
            if (successTimerRef.current) {
              clearTimeout(successTimerRef.current);
            }
            successTimerRef.current = setTimeout(() => {
              successTimerRef.current = null;
              if (onSuccess) onSuccess({ vaultKeyId: sd?.data?.vaultKeyId ?? null });
              onClose();
            }, 3000);
          }
        } catch (err: unknown) {
          // Distinguish transient failures (raw network throw, or a 5xx/429
          // tagged above) from definite ones (4xx, persistenceError). A
          // transient blip just increments the streak and lets the next tick
          // retry; we only escalate to the error step once the streak crosses
          // the threshold so a single hiccup doesn't end the whole wait.
          const tagged = err as (Error & { codexTransient?: boolean }) | undefined;
          const isTransient =
            tagged?.codexTransient === true ||
            (pollHttpStatus === null && err instanceof Error);
          if (isTransient) {
            transientPollFailuresRef.current += 1;
            if (transientPollFailuresRef.current < CODEX_OAUTH_MAX_TRANSIENT_POLL_FAILURES) {
              // Keep the interval alive and wait for the next tick.
              return;
            }
          }
          transientPollFailuresRef.current = 0;
          if (codexPollRef.current) {
            clearInterval(codexPollRef.current);
            codexPollRef.current = null;
          }
          const message = err instanceof Error ? err.message : String(err);
          setCodexError(message);
          setCodexErrorStatus(pollHttpStatus);
          setCodexStep('error');
          captureOauthEvent('provider_oauth_failed', {
            ...codexOauthBaseProperties(instanceId),
            failure_reason: 'poll_error',
            failure_stage: 'poll',
            failure_category: 'callback_error',
            retryable: true,
            http_status: pollHttpStatus,
            error_message: sanitizeOauthErrorMessage(message),
          });
        }
      }, 4000);
    } catch (err: unknown) {
      if (isAbortError(err)) {
        setCodexError('Timed out starting Codex login. Please try again.');
        setCodexErrorStatus(null);
        captureOauthEvent('provider_oauth_failed', {
          ...codexOauthBaseProperties(instanceId),
          failure_reason: 'start_timeout',
          failure_stage: 'start',
          failure_category: 'app_error',
          retryable: true,
          http_status: null,
          error_message: 'start_timeout_after_45s',
        });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        setCodexError(normalizeSshWarmupMessage(message, 'Failed to start Codex OAuth'));
        setCodexErrorStatus(startHttpStatus);
        captureOauthEvent('provider_oauth_failed', {
          ...codexOauthBaseProperties(instanceId),
          failure_reason: 'start_error',
          failure_stage: 'start',
          failure_category: 'app_error',
          retryable: true,
          http_status: startHttpStatus,
          error_message: sanitizeOauthErrorMessage(message),
        });
      }
      setCodexStep('error');
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      startAbortRef.current = null;
    }
  }, [instanceId, onClose, onSuccess, profileName]);

  useEffect(() => {
    if (!autoStart) return;
    if (autoStartFiredRef.current) return;
    if (codexStep !== 'idle') return;

    autoStartFiredRef.current = true;
    void handleCodexStart();
  }, [autoStart, codexStep, handleCodexStart]);

  const modalContent = (
    <motion.div
      initial="hidden"
      animate="visible"
      exit="exit"
      variants={overlayVariants}
      onPointerDown={(event) => {
        backdropPressRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const pressedBackdrop = backdropPressRef.current;
        backdropPressRef.current = false;
        if (pressedBackdrop && event.target === event.currentTarget) handleClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="codex-oauth-title"
      style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', overflowY: 'auto', background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(4px)', padding: 'max(12px, env(safe-area-inset-top, 0px)) 12px max(12px, env(safe-area-inset-bottom, 0px))' }}
    >
      <motion.div
        initial="hidden"
        animate="visible"
        exit="exit"
        variants={modalVariants}
        onClick={(event) => event.stopPropagation()}
        style={{ width: '100%', maxWidth: 520, maxHeight: 'calc(var(--workspace-viewport-height, 100dvh) - 24px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))', margin: 'auto', background: 'var(--bg-surface)', border: '1px solid var(--ink-black)', borderRadius: 0, boxShadow: '8px 8px 0px var(--ink-black)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 20px', minHeight: 52, borderBottom: '1px solid var(--etched-border)', background: 'var(--vellum-bg)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Terminal size={18} style={{ color: 'var(--ink-black)' }} />
            <h2 id="codex-oauth-title" style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink-black)', margin: 0 }}>Sign in with ChatGPT</h2>
          </div>
          <motion.button
            type="button"
            aria-label="Close"
            onClick={handleClose}
            style={{ width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginRight: -12, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
            whileTap={tapScale}
            transition={buttonSpring}
          >
            <X size={18} />
          </motion.button>
        </div>

        {/* Content */}
        <div style={{ padding: 'clamp(16px, 4vw, 24px)', display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto', minHeight: 0, overscrollBehavior: 'contain' }}>
          {codexStep === 'idle' && (
            <>
              <div style={{ padding: '16px', background: 'var(--vellum-bg)', border: '1px solid var(--etched-border)', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                <strong style={{ color: 'var(--ink-black)', display: 'block', marginBottom: 6 }}>Sign in with your ChatGPT subscription</strong>
                No API key needed. Use the button below to start sign-in; a code appears that you enter on OpenAI&apos;s sign-in page.
              </div>
              <motion.button
                onClick={handleCodexStart}
                type="button"
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 44, padding: '10px 18px', background: 'var(--ink-black)', border: 'none', borderRadius: 0, color: 'var(--bg-surface)', fontSize: 13, fontWeight: 600, cursor: 'pointer', width: '100%' }}
                whileTap={tapScale}
                transition={buttonSpring}
              >
                <Terminal size={14} /> Start Codex Login
              </motion.button>
            </>
          )}

          {codexStep === 'starting' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '24px 0' }}>
              <Loader2 size={28} style={{ animation: 'spin 1s linear infinite', color: 'var(--ink-black)' }} />
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0, textAlign: 'center' }}>Starting sign-in on your agent…</p>
            </div>
          )}

          {codexStep === 'waiting' && (
            <>
              {/* The code comes first: on a phone, switching to the sign-in page
                  before copying it strands the user without the code. */}
              {codexCode && (
                <div style={{ padding: '14px 16px', background: 'var(--vellum-bg)', border: '1px solid var(--etched-border)' }}>
                  <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>Step 1 — Copy this code</p>
                  <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
                    <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: '0.15em', fontFamily: 'var(--font-mono), monospace', color: 'var(--ink-black)', overflowWrap: 'anywhere' }}>{codexCode}</span>
                    <motion.button onClick={handleCodexCopy}
                      type="button"
                      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, minHeight: 44, padding: '0 14px', background: 'transparent', border: '1px solid var(--etched-border)', fontSize: 11, fontWeight: 600, cursor: 'pointer', color: codexCopied ? 'var(--green)' : 'var(--text-secondary)' }}
                      whileTap={tapScale}
                      transition={buttonSpring}
                    >
                      <Copy size={11} />{codexCopied ? 'Copied!' : 'Copy'}
                    </motion.button>
                  </div>
                  <motion.button
                    type="button"
                    onClick={handleCopyCodeAndOpen}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, width: '100%', minHeight: 44, padding: '0 16px', background: 'var(--ink-black)', border: 'none', color: 'var(--bg-surface)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                    whileTap={tapScale}
                    transition={buttonSpring}
                  >
                    <ExternalLink size={13} /> Copy code &amp; open sign-in
                  </motion.button>
                </div>
              )}
              <div style={{ padding: '14px 16px', background: 'var(--vellum-bg)', border: '1px solid var(--etched-border)' }}>
                <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)' }}>{codexCode ? 'Step 2 — Enter it on the sign-in page' : 'Step 1 — Open this URL'}</p>
                {/* Both buttons are visible from t=0; do NOT defer behind a
                    delay or disclosure. Bury-the-fallback is how Sessions D
                    and E in the PostHog audit died on this flow. */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                  <motion.button
                    type="button"
                    onClick={handleOpenInNewTab}
                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44, padding: '0 14px', background: codexCode ? 'transparent' : 'var(--ink-black)', border: codexCode ? '1px solid var(--ink-black)' : 'none', color: codexCode ? 'var(--ink-black)' : 'var(--bg-surface)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                    whileTap={tapScale}
                    transition={buttonSpring}
                  >
                    <ExternalLink size={12} /> Open authorization page
                  </motion.button>
                  <motion.button
                    type="button"
                    onClick={handleUrlCopy}
                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, minHeight: 44, padding: '0 14px', background: 'transparent', border: '1px solid var(--ink-black)', color: urlCopied ? 'var(--green)' : 'var(--ink-black)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                    whileTap={tapScale}
                    transition={buttonSpring}
                  >
                    <Copy size={12} /> {urlCopied ? 'Copied!' : 'Copy URL'}
                  </motion.button>
                </div>
                {openFallbackVisible && (
                  <div style={{ marginBottom: 10, padding: '8px 10px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.22)', color: '#1d4ed8', fontSize: 12, lineHeight: 1.5 }}>
                    If the authorization page did not open, use <strong>Copy URL</strong> and paste it into a new tab.
                  </div>
                )}
                <code style={{ display: 'block', fontSize: 11, color: 'var(--text-secondary)', wordBreak: 'break-all', fontFamily: 'var(--font-mono), monospace', userSelect: 'all' }}>
                  {codexUrl}
                </code>
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', background: 'rgba(0,0,0,0.02)', border: '1px solid var(--etched-border)', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                <Loader2 size={13} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
                <div style={{ display: 'grid', gap: 2 }}>
                  <span>Waiting for authorization. Hermes checks automatically every 4 seconds.</span>
                  <span>After you approve, saving the session and applying it to the agent can take about 30-60 seconds. Keep this window open.</span>
                  {codexPollCount > 0 && (
                    <span>Checked {codexPollCount} {codexPollCount === 1 ? 'time' : 'times'} so far.</span>
                  )}
                </div>
              </div>
            </>
          )}

          {codexStep === 'success' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '24px 0' }}>
              <CheckCircle2 size={40} style={{ color: 'var(--green)' }} />
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink-black)' }}>Codex Connected</div>
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center', maxWidth: 300, margin: 0 }}>Authenticated via your ChatGPT subscription. Hermes stored the session on this instance with the official Codex provider flow.</p>
            </div>
          )}

          {codexStep === 'error' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.25)', color: 'var(--red)', fontSize: 13 }}>
                <AlertTriangle size={14} style={{ flexShrink: 0 }} /><span>{codexError}</span>
              </div>
              <motion.button
                type="button"
                onClick={() => setCodexStep('idle')}
                style={{ minHeight: 44, padding: '8px 16px', background: 'transparent', border: '1px solid var(--ink-black)', fontSize: 13, fontWeight: 500, cursor: 'pointer', color: 'var(--ink-black)' }}
                whileTap={tapScale}
                transition={buttonSpring}
              >
                Try Again
              </motion.button>
              {codexErrorStatus === 503 && (
                <div style={{ padding: '12px 14px', background: 'var(--vellum-bg)', border: '1px solid var(--etched-border)', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                  This agent can&apos;t run the login flow right now — it may still be
                  warming up or need a redeploy. Wait a moment and use{' '}
                  <strong>Try Again</strong>. If it keeps failing, redeploy the agent from
                  its console and retry.
                </div>
              )}
            </>
          )}
        </div>

      </motion.div>
    </motion.div>
  );

  return <SafePortal>{modalContent}</SafePortal>;
}
