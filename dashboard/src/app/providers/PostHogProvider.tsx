'use client'

import { useUser } from '@clerk/nextjs'
import posthog from 'posthog-js'
import type { BeforeSendFn, CaptureResult } from 'posthog-js'
import { PostHogProvider as PHProvider } from 'posthog-js/react'
import { Suspense, useEffect } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'

import {
  captureClient,
  identifyUserClient,
  resetIfIdentifiedClient,
  flushPostHogQueue,
  disablePostHogClient,
} from '@/lib/telemetry/posthog-client'
import { readStoredConsent } from '@/lib/consent/cookie-consent'

// ---------------------------------------------------------------------------
// Project token — environment ONLY. A missing key means analytics OFF.
//
// This used to fall back to a baked-in literal (`phc_zNoQ…`, the PRODUCTION
// project). Because no Vercel project ever set NEXT_PUBLIC_POSTHOG_KEY, EVERY
// deployment — canary and every preview build included — ingested into
// production analytics under the prod token. The fallback made a
// misconfiguration indistinguishable from a correct config, and the failure
// mode was silent data corruption of the prod funnel rather than a missing
// dashboard. Analytics-off is the safe default; polluting prod is not.
//
// Next inlines `process.env.NEXT_PUBLIC_*` at BUILD time, and only for full
// literal member expressions. Do not destructure, index, or alias these reads.
// ---------------------------------------------------------------------------
const POSTHOG_KEY =
  process.env.NEXT_PUBLIC_POSTHOG_KEY ||
  process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ||
  ''

/** True when a project token is configured and posthog will be initialized. */
export const analyticsEnabled = POSTHOG_KEY.length > 0

type CheckoutRedirectContextStatus = 'present' | 'missing' | 'invalid' | 'unavailable';

type CheckoutRedirectContext = {
  status: CheckoutRedirectContextStatus;
  plan: string | null;
  cadence: string | null;
  startedAt: number | null;
  errorName?: string;
};

function readCheckoutRedirectContext(): CheckoutRedirectContext {
  try {
    const raw = window.localStorage.getItem('hermes:checkout_plan');
    if (!raw) {
      return {
        status: 'missing',
        plan: null,
        cadence: null,
        startedAt: null,
      };
    }

    try {
      const parsed = JSON.parse(raw) as {
        plan?: unknown;
        cadence?: unknown;
        started_at?: unknown;
      };

      return {
        status: 'present',
        plan: typeof parsed.plan === 'string' ? parsed.plan : null,
        cadence: typeof parsed.cadence === 'string' ? parsed.cadence : null,
        startedAt: typeof parsed.started_at === 'number' ? parsed.started_at : null,
      };
    } catch (error) {
      return {
        status: 'invalid',
        plan: null,
        cadence: null,
        startedAt: null,
        errorName: error instanceof Error ? error.name : typeof error,
      };
    }
  } catch (error) {
    return {
      status: 'unavailable',
      plan: null,
      cadence: null,
      startedAt: null,
      errorName: error instanceof Error ? error.name : typeof error,
    };
  }
}

function clearCheckoutRedirectContext() {
  try {
    window.localStorage.removeItem('hermes:checkout_plan');
  } catch {
    // localStorage can be unavailable in private browsing modes.
  }
}

// First-touch signup attribution: on the first navigation that carries any
// utm_* param OR arrives from an external referrer, stash the UTM set +
// referrer + landing page once. The billing client forwards the stash to
// /api/billing/subscribe, which persists it write-once on the subscription
// row. Never overwritten — first touch wins.
const SIGNUP_ATTRIBUTION_STORAGE_KEY = 'hermes:signup_attribution';
const UTM_PARAM_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
] as const;

function captureSignupAttribution(
  pathname: string,
  searchParams: URLSearchParams | null
) {
  try {
    if (window.localStorage.getItem(SIGNUP_ATTRIBUTION_STORAGE_KEY)) return;

    const truncate = (value: string) => value.slice(0, 256);

    const utm: Record<string, string> = {};
    for (const key of UTM_PARAM_KEYS) {
      const value = searchParams?.get(key);
      if (value) utm[key] = truncate(value);
    }

    const referrer = typeof document !== 'undefined' ? document.referrer : '';
    let externalReferrer = '';
    if (referrer) {
      try {
        if (new URL(referrer).origin !== window.location.origin) {
          externalReferrer = truncate(referrer);
        }
      } catch {
        // Unparseable referrer — treat as absent.
      }
    }

    if (Object.keys(utm).length === 0 && !externalReferrer) return;

    window.localStorage.setItem(
      SIGNUP_ATTRIBUTION_STORAGE_KEY,
      JSON.stringify({
        ...utm,
        ...(externalReferrer ? { referrer: externalReferrer } : {}),
        landing_page: truncate(pathname),
        captured_at: Date.now(),
      })
    );
  } catch {
    // localStorage unavailable (private mode) — attribution is best-effort.
  }
}

// Routes that handle credentials, payments, wallet operations, or token-bearing
// flows: session replay must never capture them. posthog-js's `urlBlocklist` is
// a remote (server-controlled) recording-config field — NOT a client `init`
// option (#128/#142) — so we enforce the same policy client-side instead: stop
// replay when navigating into one of these routes and resume when leaving.
const SENSITIVE_RECORDING_ROUTES: RegExp[] = [
  /\/sign-in/,
  /\/sign-up/,
  /\/dashboard\/welcome/,
  /\/dashboard\/billing/,
  /\/dashboard\/wallet/,
  /\/dashboard\/settings/,
  /\/dashboard\/chat/,
  /\/dashboard\/agent\/[^/]+/,
  /\/dashboard\/instances\/[^/]+\/console/,
  /\/token(\b|\/)/,
  /\/get-started\/activate/,
];

function isLocalhostHost(): boolean {
  if (typeof window === 'undefined') return false;
  return /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0)$/i.test(window.location.hostname);
}

function isSensitiveRecordingPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return SENSITIVE_RECORDING_ROUTES.some((pattern) => pattern.test(pathname));
}

// Collapse UUID-shaped path segments before reporting a pageview so PostHog's
// route distribution buckets cleanly (`/dashboard/instances/:id`) instead of
// producing one row per instance/agent id and pushing real routes out of the
// top-N. Applied only to the pageview properties — `isSensitiveRecordingPath`
// still sees the raw pathname.
const PATH_UUID_RE = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi;
function normalizePagePath(pathname: string): string {
  return pathname.replace(PATH_UUID_RE, '/:id');
}

// Tracks whether WE suppressed replay for the current route, so we only resume
// recording we ourselves stopped — never overriding posthog's own start/stop
// decisions (sampling, remote config, consent, localhost).
let replaySuppressedByRoute = false;

// posthog's stop/startSessionRecording are just set_config calls, and every
// set_config re-runs the lazy recorder-script loader. If that script ever
// fired `load` without registering itself (content blocker / bad proxy
// response neutering execution), posthog 1.318.x's loader callback throws
// "Called on script loaded before session recording is available"
// (SessionRecording._onScriptLoaded) — synchronously, inside OUR stop/start
// call, on every subsequent route transition. The disable_session_recording
// flip is applied before the loader runs inside set_config, so swallowing the
// throw keeps the privacy guarantee while keeping the route policy from
// surfacing recurring exceptions.
function toggleSessionRecordingSafely(action: 'stop' | 'start') {
  try {
    if (action === 'stop') {
      posthog.stopSessionRecording();
    } else {
      posthog.startSessionRecording();
    }
  } catch {
    // Recorder script loaded without registering (see comment above). The
    // config flip already took effect, so recording state is still correct.
  }
}

// stopSessionRecording() does NOT cancel an in-flight recorder-script load:
// posthog's onload callback unconditionally (re)starts capture
// (SessionRecording._onScriptLoaded → LazyLoadedSessionRecording.start, whose
// status getter hardcodes isRecordingEnabled). If we entered a sensitive route
// while the script was still downloading, re-assert the stop once the recorder
// reports itself started — but only while the suppression is still ours.
const REPLAY_SUPPRESSION_REASSERT_INTERVAL_MS = 1_000;
// The recorder bundle can land arbitrarily late on slow connections, so a
// couple of fixed timers isn't enough — watch on an interval instead. Once
// the script has loaded and the stop has been re-applied, resurrection is
// impossible (the loader fires once per page), so a bounded horizon is
// sufficient; past it the connection is too slow for the recorder to matter.
const REPLAY_SUPPRESSION_REASSERT_MAX_TICKS = 30;
let replayReassertInterval: ReturnType<typeof setInterval> | undefined;

function clearReplayReassertTimers() {
  if (replayReassertInterval !== undefined) {
    clearInterval(replayReassertInterval);
    replayReassertInterval = undefined;
  }
}

function scheduleReplaySuppressionReassert() {
  clearReplayReassertTimers();
  let ticks = 0;
  replayReassertInterval = setInterval(() => {
    ticks += 1;
    if (!replaySuppressedByRoute || ticks > REPLAY_SUPPRESSION_REASSERT_MAX_TICKS) {
      clearReplayReassertTimers();
      return;
    }
    if (typeof posthog.sessionRecordingStarted !== 'function') return;
    let started = false;
    try {
      started = posthog.sessionRecordingStarted();
    } catch {
      return;
    }
    if (started) {
      toggleSessionRecordingSafely('stop');
    }
  }, REPLAY_SUPPRESSION_REASSERT_INTERVAL_MS);
}

function applyRouteRecordingPolicy(pathname: string | null | undefined) {
  if (!analyticsEnabled) return;
  if (isLocalhostHost()) return;
  if (typeof posthog.stopSessionRecording !== 'function') return;

  if (isSensitiveRecordingPath(pathname)) {
    toggleSessionRecordingSafely('stop');
    replaySuppressedByRoute = true;
    scheduleReplaySuppressionReassert();
  } else if (replaySuppressedByRoute) {
    clearReplayReassertTimers();
    toggleSessionRecordingSafely('start');
    replaySuppressedByRoute = false;
  }
}

// ---------------------------------------------------------------------------
// $exception noise filtering
//
// 263 of 366 prod $exception events over 5 days were "Invalid call to
// runtime.sendMessage(). Tab not found." — Chrome-extension noise injected
// into the page, burying real errors. before_send drops a NARROW denylist of
// known browser-extension noise; every other event flows through untouched.
// ---------------------------------------------------------------------------

const EXTENSION_STACK_SOURCE_RE = /^(?:chrome|moz)-extension:\/\//i;

type ExceptionStackFrame = { filename?: unknown };
type ExceptionListEntry = {
  value?: unknown;
  stacktrace?: { frames?: ExceptionStackFrame[] } | null;
};

function isExtensionNoiseMessage(message: string): boolean {
  return message.includes('runtime.sendMessage') && message.includes('Tab not found');
}

function isBrowserExtensionNoiseException(event: CaptureResult | null): boolean {
  if (!event || event.event !== '$exception') return false;
  const props = (event.properties ?? {}) as Record<string, unknown>;

  const messages: string[] = [];
  const sources: string[] = [];

  if (typeof props.$exception_message === 'string') messages.push(props.$exception_message);
  if (typeof props.$exception_source === 'string') sources.push(props.$exception_source);

  const exceptionList = props.$exception_list;
  if (Array.isArray(exceptionList)) {
    for (const entry of exceptionList as ExceptionListEntry[]) {
      if (typeof entry?.value === 'string') messages.push(entry.value);
      const frames = entry?.stacktrace?.frames;
      if (Array.isArray(frames)) {
        for (const frame of frames) {
          if (typeof frame?.filename === 'string') sources.push(frame.filename);
        }
      }
    }
  }

  if (messages.some(isExtensionNoiseMessage)) return true;

  // Drop only when every resolvable stack source points into an extension — a
  // mixed stack could still be an app error passing through an extension
  // wrapper, so it is kept.
  return sources.length > 0 && sources.every((source) => EXTENSION_STACK_SOURCE_RE.test(source));
}

// posthog-js 1.318.x throws "Called on script loaded before session recording
// is available" from SessionRecording._onScriptLoaded when the recorder bundle
// fires its onload callback before the recorder registered itself (content
// blocker / slow or neutered proxy response). The route-policy code already
// swallows this where our own stop/start calls trigger it
// (toggleSessionRecordingSafely) and re-asserts the stop, so recording state
// stays correct — but the throw still escapes the library's own internal onload
// path and surfaces as a handled $exception. Over the last several days it was
// the single freshest exception class and ~40% of captured $exception volume,
// burying real app errors. It carries no app signal, so drop it from capture
// the same way as the extension noise above (narrow, exact-string match only).
const SESSION_RECORDER_LOAD_NOISE_RE =
  /script loaded before session recording is available/i;

function isSessionRecorderLoadNoiseException(event: CaptureResult | null): boolean {
  if (!event || event.event !== '$exception') return false;
  const props = (event.properties ?? {}) as Record<string, unknown>;

  const messages: string[] = [];
  if (typeof props.$exception_message === 'string') messages.push(props.$exception_message);

  const exceptionList = props.$exception_list;
  if (Array.isArray(exceptionList)) {
    for (const entry of exceptionList as ExceptionListEntry[]) {
      if (typeof entry?.value === 'string') messages.push(entry.value);
    }
  }

  return messages.some((message) => SESSION_RECORDER_LOAD_NOISE_RE.test(message));
}

// Browser page-translation tools (Google Translate, Microsoft Translator, and
// similar) replace text nodes out from under React's reconciler. When React
// then tries to insert or remove a node whose parent the extension already
// rewrote, the DOM throws a NotFoundError DOMException — "Failed to execute
// 'insertBefore' on 'Node'" / "Failed to execute 'removeChild' on 'Node'" —
// from inside react-dom, surfaced here as a handled $exception with no
// app-owned stack frame. It is unactionable third-party noise (the app cannot
// fix a user's translation extension) and, after the extension- and
// recorder-load filters above, is the largest remaining non-app exception
// class — it buries the real chunk-load errors. Drop it from capture with the
// same narrow, exact-string match used for the other noise classes; a genuine
// app NotFoundError carries a different message.
const TRANSLATION_DOM_NOISE_RE =
  /Failed to execute '(?:insertBefore|removeChild)' on 'Node'/i;

function isTranslationDomNoiseException(event: CaptureResult | null): boolean {
  if (!event || event.event !== '$exception') return false;
  const props = (event.properties ?? {}) as Record<string, unknown>;

  const messages: string[] = [];
  if (typeof props.$exception_message === 'string') messages.push(props.$exception_message);

  const exceptionList = props.$exception_list;
  if (Array.isArray(exceptionList)) {
    for (const entry of exceptionList as ExceptionListEntry[]) {
      if (typeof entry?.value === 'string') messages.push(entry.value);
    }
  }

  return messages.some((message) => TRANSLATION_DOM_NOISE_RE.test(message));
}

// Injected wallet/web3 browser extensions (MetaMask, Phantom, Coinbase Wallet,
// and similar) speak an EIP-1193 provider over a content-script bridge. When
// that bridge drops or times out a message the injected provider throws its own
// RPC error class — surfaced here as a handled $exception with the class token
// `RpcResponse.InternalError` / `ProviderRpcError` and the value "Invalid
// message", carrying NO app-owned stack frame (the throw originates entirely in
// the extension's injected page script, which posthog cannot resolve a source
// for). The app does not own a web3 provider, so it can never fix or act on
// these; left in, they are now the largest non-app exception class after the
// extension/recorder/translation filters above and bury the real Clerk
// chunk-load errors. Drop them with the same narrow shape match: an extension
// RPC class/message AND a stack with no resolvable (in-app) source. A genuine
// app error that happened to mention "Invalid message" would carry a resolved
// app stack frame and is kept.
const WEB3_PROVIDER_NOISE_CLASS_RE =
  /^(?:RpcResponse\.InternalError|ProviderRpcError|RpcRequestError)$/;
const WEB3_PROVIDER_NOISE_VALUE_RE = /^Invalid message$/;

type ExceptionListEntryTyped = ExceptionListEntry & { type?: unknown };

function isWeb3ProviderNoiseException(event: CaptureResult | null): boolean {
  if (!event || event.event !== '$exception') return false;
  const props = (event.properties ?? {}) as Record<string, unknown>;

  const exceptionList = props.$exception_list;
  if (!Array.isArray(exceptionList)) return false;

  let matchedShape = false;
  for (const entry of exceptionList as ExceptionListEntryTyped[]) {
    const type = typeof entry?.type === 'string' ? entry.type : '';
    const value = typeof entry?.value === 'string' ? entry.value : '';
    if (WEB3_PROVIDER_NOISE_CLASS_RE.test(type) && WEB3_PROVIDER_NOISE_VALUE_RE.test(value)) {
      matchedShape = true;
    }
    // Any resolvable app source means it is NOT pure injected-provider noise; keep it.
    const frames = entry?.stacktrace?.frames;
    if (Array.isArray(frames)) {
      for (const frame of frames) {
        if (typeof frame?.filename === 'string' && frame.filename.length > 0) {
          return false;
        }
      }
    }
  }

  return matchedShape;
}

const dropBrowserExtensionNoise: BeforeSendFn = (event) =>
  isBrowserExtensionNoiseException(event) ||
  isSessionRecorderLoadNoiseException(event) ||
  isTranslationDomNoiseException(event) ||
  isWeb3ProviderNoiseException(event)
    ? null
    : event;

// ---------------------------------------------------------------------------
// GDPR/UK cookie-consent gate
//
// Invariant: in consent-required regions (EU/EEA + UK; unknown geo = required,
// fail safe) NO non-essential analytics or session-replay events may fire
// before the visitor grants consent. We can't know geo synchronously at module
// load (it comes from /api/geo, called by the banner on mount), so we init
// posthog opted-OUT whenever consent is not already affirmatively stored. The
// banner then resolves geo and either grants consent (non-required region, or
// the user clicked Accept) or leaves it opted out (required + undecided, or the
// user clicked Reject). This composes with — and never overrides — the existing
// route-level replay suppression + input masking, which only ever runs once
// capturing is active.
// ---------------------------------------------------------------------------

// Resolved once posthog.init() has run, so consent calls made by the banner
// before init are replayed afterwards (init is deferred via requestIdleCallback).
let posthogInitialized = false;
let pendingConsentAction: 'grant' | 'revoke' | undefined;

function enableSessionRecordingRespectingRoutePolicy() {
  if (isLocalhostHost()) return;
  if (typeof posthog.startSessionRecording !== 'function') return;
  // Turn recording back on, then immediately re-apply the route policy so a
  // grant on a sensitive route does NOT start recording there. The policy
  // owns the stop/start decision for sensitive routes from here on.
  toggleSessionRecordingSafely('start');
  applyRouteRecordingPolicy(
    typeof window !== 'undefined' ? window.location.pathname : null
  );
}

/**
 * Grant consent: opt posthog in to capturing and (re)enable session recording,
 * letting the existing route suppression + masking take over. Called by the
 * banner on Accept, and automatically in non-consent-required regions when no
 * explicit Reject is stored.
 */
export function grantAnalyticsConsent() {
  // No project token => posthog was never initialized and never will be. Do not
  // stash a pending action that can only be replayed by an init that cannot run.
  if (!analyticsEnabled) return;
  if (!posthogInitialized) {
    pendingConsentAction = 'grant';
    return;
  }
  try {
    if (typeof posthog.opt_in_capturing === 'function') {
      posthog.opt_in_capturing({ captureEventName: false });
    }
  } catch {
    // Best-effort: a failed opt-in must never surface to the user.
  }
  enableSessionRecordingRespectingRoutePolicy();
}

/**
 * Revoke / withhold consent: opt posthog out of capturing and keep session
 * recording disabled. Called by the banner on Reject, and the default state in
 * consent-required regions until the user decides.
 */
export function revokeAnalyticsConsent() {
  // Nothing is capturing, so there is nothing to revoke. (Safe: the consent
  // banner still persists the visitor's choice via writeStoredConsent.)
  if (!analyticsEnabled) return;
  if (!posthogInitialized) {
    pendingConsentAction = 'revoke';
    return;
  }
  try {
    if (typeof posthog.stopSessionRecording === 'function') {
      posthog.stopSessionRecording();
    }
    if (typeof posthog.opt_out_capturing === 'function') {
      posthog.opt_out_capturing();
    }
  } catch {
    // Best-effort.
  }
}

if (typeof window !== 'undefined' && !analyticsEnabled) {
  // Analytics off: make every captureClient()/identifyUserClient() call site in
  // the app a no-op instead of queueing against an init that will never run.
  disablePostHogClient();
  if (process.env.NODE_ENV === 'production') {
    // Loud, once. A production build with no project token is a deploy
    // misconfiguration, and the whole point of dropping the fallback is that it
    // must not fail silently (previously it "succeeded" — into prod's project).
    // eslint-disable-next-line no-console
    console.warn(
      '[posthog] NEXT_PUBLIC_POSTHOG_KEY is not set — product analytics and session replay are disabled.'
    );
  }
}

if (typeof window !== 'undefined' && analyticsEnabled) {
  const isLocalhost = isLocalhostHost();

  // Read any previously-stored consent choice synchronously so a returning
  // visitor who already chose is honored from the very first init — no flash of
  // opted-in capture for someone who rejected, no needless opt-out for someone
  // who accepted.
  const storedConsent = readStoredConsent();
  // Consent is affirmatively granted only when a stored choice says "accepted".
  // Everything else (rejected, or NO stored choice) starts opted out — the
  // fail-safe default. Localhost never captures regardless.
  const consentGrantedAtInit = !isLocalhost && storedConsent?.choice === 'accepted';

  // Direct landing on a sensitive route: posthog.init() starts session
  // recording from the PERSISTED remote config (returning visitors) and kicks
  // off the lazy recorder-script load before our post-init stop can win the
  // race — the in-flight script's onload callback then either resurrects
  // capture on the sensitive page or throws "Called on script loaded before
  // session recording is available". Prevent recording from starting at all
  // instead, and mark the suppression as OURS so the first navigation to a
  // non-sensitive route resumes it (same resume-only-what-we-stopped
  // semantics as applyRouteRecordingPolicy).
  //
  // Re-evaluate the sensitive-route check at INIT time, not module-load time:
  // init is deferred up to 2s via requestIdleCallback, so the path the visitor
  // is actually on when the recorder could start may differ from the path at
  // module load (#352 — a returning visitor's persisted recording config began
  // a replay on /sign-in before the post-init stop won the race). Computing the
  // disable flag and the synchronous stop from the live pathname inside
  // initPosthog closes that window.
  const isSensitiveLandingAtInit = () =>
    !isLocalhost && isSensitiveRecordingPath(window.location.pathname);

  const posthogConfig: Parameters<typeof posthog.init>[1] & {
    disable_external_dependency_loading?: boolean;
  } = {
    // Default: same-origin `/p` rewrite (proxied through Vercel — see
    // next.config.ts). Set NEXT_PUBLIC_POSTHOG_API_HOST to the Cloudflare
    // posthog-proxy-worker URL to move ALL PostHog traffic (events + session
    // replay + flags + bundles) off Vercel's Fast Origin Transfer while keeping
    // a first-party origin for ad-block resistance. Cutover/rollback is env-only
    // (services/posthog-proxy-worker/README.md).
    api_host: process.env.NEXT_PUBLIC_POSTHOG_API_HOST || '/p',
    ui_host: 'https://us.posthog.com',
    person_profiles: 'identified_only',
    capture_pageview: false, // Disable automatic pageview capture, as we capture manually
    // Consent gate: opt OUT of capturing by default unless a stored "accepted"
    // choice is already present. The banner flips this on for non-required
    // regions (or on Accept) via grantAnalyticsConsent(). This is the load-
    // bearing guarantee that nothing fires before consent in EU/UK/EEA (and on
    // unknown geo, since storedConsent is then null => opted out). PostHog's
    // opt-out disables BOTH event capture and session replay, so it is the sole
    // consent gate; recording stays off until grantAnalyticsConsent() opts in.
    opt_out_capturing_by_default: !consentGrantedAtInit,
    // Set authoritatively from the LIVE pathname inside initPosthog (below),
    // because init is deferred and the visitor's route can change before it
    // runs. Initialized here for localhost; the sensitive-route case is applied
    // at init time so the recorder is never allowed to start on a sensitive
    // landing (#352).
    disable_session_recording: isLocalhost,
    capture_dead_clicks: isLocalhost ? false : undefined,
    disable_external_dependency_loading: isLocalhost,
    enable_recording_console_log: false,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: '[data-ph-mask], [data-sensitive]',
      blockSelector: 'input[type="password"], [data-ph-block]',
      // Route-level suppression (credential/payment/token pages) is enforced
      // client-side via applyRouteRecordingPolicy — see SENSITIVE_RECORDING_ROUTES.
      // (urlBlocklist is a server-only remote-config field, not a client init
      // option — #128/#142.)
    },
    capture_exceptions: {
      // Route runtime failures through OpsTelemetryProvider so filtering and metadata
      // stay consistent instead of letting PostHog capture a parallel raw error stream.
      capture_unhandled_errors: false,
      capture_unhandled_rejections: false,
      capture_console_errors: false,
    },
    // Drop known browser-extension noise from error tracking (narrow denylist;
    // see isBrowserExtensionNoiseException). Applies to every capture path,
    // including OpsTelemetryProvider's captureException forwarding.
    before_send: dropBrowserExtensionNoise,
  };

  const initPosthog = () => {
    // Decide suppression from the live pathname at the moment init actually
    // runs (not module load). When sensitive, disable recording in the init
    // config itself so posthog never even kicks off the lazy recorder-script
    // load from persisted remote config — closing the pre-stop window in #352.
    const suppressRecordingAtInit = isSensitiveLandingAtInit()
    if (suppressRecordingAtInit) {
      posthogConfig.disable_session_recording = true
      // Mark the suppression as OURS so the first navigation to a non-sensitive
      // route resumes it (same resume-only-what-we-stopped semantics as
      // applyRouteRecordingPolicy).
      replaySuppressedByRoute = true
    }

    posthog.init(POSTHOG_KEY, posthogConfig)

    posthogInitialized = true

    if (isLocalhost) {
      posthog.set_config({
        capture_dead_clicks: false,
        disable_session_recording: true,
      })
      if (typeof posthog.stopSessionRecording === 'function') {
        posthog.stopSessionRecording()
      }
    } else if (suppressRecordingAtInit) {
      // Sensitive landing: in addition to the disable flag above, issue a
      // synchronous stop in the SAME tick as init (before any deferred recorder
      // start can race it) and arm the in-flight-load watchdog, so a returning
      // visitor's persisted recording config cannot emit a replay-start on the
      // sensitive route (#352).
      toggleSessionRecordingSafely('stop')
      scheduleReplaySuppressionReassert()
    } else {
      // Direct landing on a non-sensitive route after a deferred init: the
      // page-view effect may have run before init finished, so apply the policy
      // now that replay can actually be toggled (resumes only what we stopped).
      applyRouteRecordingPolicy(window.location.pathname)
    }

    // The banner may have called grant/revoke before deferred init finished;
    // replay the latest decision now that posthog can act on it.
    if (pendingConsentAction === 'grant') {
      pendingConsentAction = undefined
      grantAnalyticsConsent()
    } else if (pendingConsentAction === 'revoke') {
      pendingConsentAction = undefined
      revokeAnalyticsConsent()
    }

    // Init is deferred (requestIdleCallback), so the pageview/identify effects
    // may have already fired and queued their calls. Now that posthog is
    // initialized, drain the queue so those early events reach PostHog instead
    // of throwing pre-init (#129).
    flushPostHogQueue()
  }

  // Defer PostHog init until after the page is interactive so it doesn't
  // compete with LCP. requestIdleCallback yields up to 2s; setTimeout is the
  // fallback for Safari.
  const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
  if (typeof w.requestIdleCallback === 'function') {
    w.requestIdleCallback(initPosthog, { timeout: 2000 })
  } else {
    setTimeout(initPosthog, 1500)
  }
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  return (
    <PHProvider client={posthog}>
      <Suspense fallback={null}>
        <PostHogPageView />
      </Suspense>
      {children}
    </PHProvider>
  )
}

function PostHogPageView() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Enforce session-replay suppression on sensitive routes (the client-side
  // equivalent of posthog's remote-only urlBlocklist): stop replay when
  // entering a credential/payment/token route, resume when leaving.
  useEffect(() => {
    applyRouteRecordingPolicy(pathname);
  }, [pathname]);

  // Handle Pageview and Conversion Catching
  useEffect(() => {
    if (pathname && posthog) {
      captureSignupAttribution(pathname, searchParams)
      const normalizedPathname = normalizePagePath(pathname)
      let url = window.origin + normalizedPathname
      if (searchParams && searchParams.toString()) {
        url = url + `?${searchParams.toString()}`
      }
      captureClient('$pageview', {
        '$current_url': url,
        '$pathname': normalizedPathname,
      })

      // Track the browser return from Stripe as diagnostics only. The
      // authoritative checkout_payment_completed event is emitted by
      // server-side Stripe confirmation/webhook code where payment_status
      // and plan attribution are available without guessing.
      if (searchParams?.get('subscription') === 'success') {
        const checkoutContext = readCheckoutRedirectContext();

        captureClient('checkout_redirect_returned', {
          source: 'frontend_redirect',
          session_id: searchParams.get('session_id'),
          plan: checkoutContext.plan,
          cadence: checkoutContext.cadence,
          checkout_context_status: checkoutContext.status,
          checkout_context_error_name: checkoutContext.errorName,
          via_checkout_flow: checkoutContext.status === 'present',
          time_in_checkout_ms:
            checkoutContext.startedAt
              ? Date.now() - checkoutContext.startedAt
              : null,
        });

        clearCheckoutRedirectContext();

        // Push a diagnostic event to GTM/GA4. Do not use purchase_completed
        // here: the browser redirect cannot prove the payment settled.
        if (typeof window !== 'undefined') {
          const w = window as unknown as { dataLayer: Record<string, unknown>[] };
          w.dataLayer = w.dataLayer || [];
          w.dataLayer.push({
            event: 'checkout_redirect_returned',
            session_id: searchParams.get('session_id'),
            checkout_context_status: checkoutContext.status,
          });
        }
      }
    }
  }, [pathname, searchParams])

  return null
}

// ---------------------------------------------------------------------------
// signup_completed — the dedicated signup conversion event.
//
// Fired exactly once per NEW user, at the first render where Clerk reports the
// freshly-created session. Discriminator: the account was created within the
// last hour AND this is still the first session (Clerk stamps lastSignInAt at
// — or within moments of — sign-up; depending on version it can also still be
// null right after signup, while a later, separate sign-in moves it far past
// createdAt). The recency window keeps pre-existing users who signed up once
// and never returned (lastSignInAt forever ≈ createdAt) from emitting a
// months-late signup event on their next visit.
//
// Exactly-once: a per-user localStorage guard persists across the many page
// loads of the first session (activate → checkout → welcome), and an in-memory
// set backstops private-browsing modes where localStorage throws (and React
// StrictMode's double effect run). Both guards are claimed BEFORE capture —
// same claim-then-emit pattern as captureBoxCreatedOnce in instance-service.
// ---------------------------------------------------------------------------
const SIGNUP_COMPLETED_GUARD_KEY_PREFIX = 'hermes:signup_completed:';
const SIGNUP_RECENCY_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const SIGNUP_FIRST_SESSION_DELTA_MS = 5 * 60 * 1000; // 5 minutes
const signupCompletedEmittedUserIds = new Set<string>();

type ClerkSignupUser = {
  id: string;
  createdAt: Date | null;
  lastSignInAt: Date | null;
};

function isFreshClerkSignup(user: ClerkSignupUser): boolean {
  const createdAt = user.createdAt?.getTime();
  if (!createdAt) return false;
  if (Date.now() - createdAt > SIGNUP_RECENCY_WINDOW_MS) return false;
  const lastSignInAt = user.lastSignInAt?.getTime();
  return (
    lastSignInAt == null ||
    Math.abs(lastSignInAt - createdAt) <= SIGNUP_FIRST_SESSION_DELTA_MS
  );
}

// Fold the first-touch attribution stash (UTM set + external referrer +
// landing page — see captureSignupAttribution) into the signup event so the
// conversion carries its acquisition source without a person-property join.
function readSignupAttributionForEvent(): Record<string, string> {
  const props: Record<string, string> = {};
  try {
    const raw = window.localStorage.getItem(SIGNUP_ATTRIBUTION_STORAGE_KEY);
    if (!raw) return props;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of [...UTM_PARAM_KEYS, 'referrer', 'landing_page']) {
      const value = parsed[key];
      if (typeof value === 'string') props[key] = value;
    }
  } catch {
    // localStorage unavailable or stash unparseable — attribution is best-effort.
  }
  return props;
}

function maybeCaptureSignupCompleted(user: ClerkSignupUser): void {
  if (!isFreshClerkSignup(user)) return;
  if (signupCompletedEmittedUserIds.has(user.id)) return;
  const guardKey = SIGNUP_COMPLETED_GUARD_KEY_PREFIX + user.id;
  try {
    if (window.localStorage.getItem(guardKey)) return;
  } catch {
    // localStorage unavailable — the in-memory set still prevents duplicate
    // emits within this page load; cross-load duplicates are acceptable for a
    // best-effort conversion event.
  }
  // Claim both guards BEFORE capturing so a re-render or StrictMode double
  // effect run can never emit twice.
  signupCompletedEmittedUserIds.add(user.id);
  try {
    window.localStorage.setItem(guardKey, String(Date.now()));
  } catch {
    // Best-effort.
  }
  captureClient('signup_completed', {
    ...readSignupAttributionForEvent(),
    signup_created_at: user.createdAt ? user.createdAt.toISOString() : null,
  });
}

export function PostHogIdentify() {
  const { isLoaded, isSignedIn, user } = useUser();

  // Identity stitching at the Clerk auth boundary.
  //
  // Signed in → identify(clerkUserId): posthog-js sends $identify with the
  // current anonymous distinct_id as $anon_distinct_id, merging the pre-auth
  // anonymous person (landing + /get-started pageviews) into the identified
  // one. identifyUserClient no-ops when posthog already carries this user's
  // id, so remounts across layouts don't spam.
  //
  // Signed OUT → resetIfIdentifiedClient(): clears identity only when posthog
  // is actually identified. It must NOT reset anonymous visitors — the old
  // unconditional reset here regenerated the anon distinct_id for every
  // pre-auth visitor entering sign-up/sign-in/get-started/checkout, so the
  // later identify() merged a nearly-empty anon person and orphaned the real
  // pre-auth history (2026-07 audit: 75% of activate-page persons had no
  // pre-auth pageviews; the strict funnel collapsed 1716→368→4→2).
  useEffect(() => {
    if (!isLoaded || !posthog) return;
    if (isSignedIn && user) {
      identifyUserClient(user.id, {
        email: user.primaryEmailAddress?.emailAddress,
        name: user.fullName
      });
      maybeCaptureSignupCompleted(user);
    } else if (!isSignedIn) {
      resetIfIdentifiedClient();
    }
  }, [isLoaded, isSignedIn, user]);

  return null;
}
