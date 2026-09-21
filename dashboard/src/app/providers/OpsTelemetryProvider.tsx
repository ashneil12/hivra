'use client';

import React from 'react';
import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import posthog from 'posthog-js';

import { clientLog } from '@/lib/client/logger';
import { getLastRequestId, installFetchRequestIdInterceptor } from '@/lib/client/request-id-tracker';
import {
  containsBrowserExtensionOrigin,
  extractRawErrorMetadata,
  isClerkSessionTouchNetworkError,
  shouldIgnoreClientError,
  toError,
} from '@/lib/clerk-runtime-errors';

interface OpsTelemetryProviderProps {
  children: React.ReactNode;
  releaseFingerprint?: string;
}

declare global {
  interface Window {
    __hermesOpsTelemetryActive?: boolean;
    __hermesOpsTelemetryReporting?: boolean;
  }
}

const CHUNK_LOAD_RELOAD_PREFIX = 'hermes:chunk-load-reload';
const SERVER_ACTION_RELOAD_PREFIX = 'hermes:server-action-reload';
// Matches the asset URL embedded in a chunk-load error for the recovery
// breadcrumb. Covers both JS chunks (/_next/static/chunks/*.js) and the CSS
// chunks emitted by mini-css-extract (/_next/static/css/*.css) — a stale CSS
// chunk after a deploy throws "Loading CSS chunk N failed" the same way.
const CHUNK_URL_PATTERN =
  /https?:\/\/[^\s)'"<>]+\/_next\/static\/(?:chunks\/[^\s)'"<>]+\.js|css\/[^\s)'"<>]+\.css)/i;
// One reload attempt per route within this window; afterwards the guard expires
// so a later transient chunk failure on the same route can still self-recover.
const CHUNK_RELOAD_TTL_MS = 60_000;
// A reload only helps when the fresh document references fresh chunk URLs.
// When stale HTML keeps coming back (pinned CDN/proxy cache) each reload
// destroys page state without fixing anything, so cap attempts per
// route+release for the life of the tab session on top of the TTL.
const CHUNK_RELOAD_MAX_ATTEMPTS = 3;

function getErrorText(error: Error, metadata: Record<string, unknown>): string {
  return [
    error.name,
    error.message,
    error.stack,
    typeof metadata.filename === 'string' ? metadata.filename : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n');
}

function extractChunkUrl(error: Error, metadata: Record<string, unknown>): string | undefined {
  const text = getErrorText(error, metadata);
  const match = text.match(CHUNK_URL_PATTERN);
  return match?.[0];
}

function isChunkLoadFailure(error: Error, metadata: Record<string, unknown>): boolean {
  const text = getErrorText(error, metadata);
  return (
    error.name === 'ChunkLoadError' ||
    // \S+ instead of \d+: Clerk UI chunk ids look like "Loading chunk 666/26 failed".
    // Optional "CSS ": after a deploy a stale mini-css-extract chunk throws
    // "Loading CSS chunk N failed" — same version-skew class, same fix.
    /Loading (?:CSS )?chunk \S+ failed/i.test(text) ||
    /Failed to load chunk /i.test(text) ||
    /Failed to fetch dynamically imported module/i.test(text) ||
    /error loading dynamically imported module/i.test(text) ||
    (/\/_next\/static\/(?:chunks|css)\//i.test(text) && /(failed|load failed|404|not found)/i.test(text))
  );
}

function isStaleServerActionFailure(error: Error, metadata: Record<string, unknown>): boolean {
  const text = getErrorText(error, metadata);
  return (
    error.name === 'UnrecognizedActionError' ||
    (/server action/i.test(text) && /(not found|unrecognized|missing|no longer exists)/i.test(text))
  );
}

function getChunkReloadKey(route: string, releaseFingerprint?: string): string {
  return `${CHUNK_LOAD_RELOAD_PREFIX}:${releaseFingerprint || 'unknown-release'}:${route || 'unknown-route'}`;
}

function getServerActionReloadKey(route: string, releaseFingerprint?: string): string {
  return `${SERVER_ACTION_RELOAD_PREFIX}:${releaseFingerprint || 'unknown-release'}:${route || 'unknown-route'}`;
}

function describeReporterFailure(rawError: unknown): { name: string; message: string } {
  if (rawError instanceof Error) {
    return {
      name: rawError.name || 'Error',
      message: rawError.message || 'Telemetry reporter failed',
    };
  }

  return {
    name: typeof rawError,
    message: String(rawError || 'Telemetry reporter failed'),
  };
}

function warnReporterFailure(message: string, rawError: unknown): void {
  try {
    clientLog.warn(message, {
      source: 'client-runtime',
      failureType: 'client_runtime_reporter_failed',
      ...describeReporterFailure(rawError),
    });
  } catch {
    // The global error handler must never throw while reporting another error.
  }
}

function buildExceptionMetadata(error: Error): Record<string, string> {
  const exceptionType = error.name || 'Error';
  const exceptionMessage = error.message || exceptionType;

  return {
    exception_type: exceptionType,
    exception_message: exceptionMessage,
    $exception_type: exceptionType,
    $exception_message: exceptionMessage,
  };
}

function claimChunkReload(route: string, releaseFingerprint?: string): { shouldReload: boolean; storage: 'session' | 'blocked' } {
  const key = getChunkReloadKey(route, releaseFingerprint);

  try {
    // The stored value is {ts, n}: claim timestamp + attempts so far. Claims
    // older than the TTL expire so a later transient failure can recover
    // again, but never past CHUNK_RELOAD_MAX_ATTEMPTS for this tab session.
    // Legacy bare-timestamp / '1' values count as one prior attempt.
    const raw = window.sessionStorage.getItem(key);
    let claimedAt = 0;
    let attempts = 0;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { ts?: unknown; n?: unknown };
        claimedAt = typeof parsed.ts === 'number' ? parsed.ts : 0;
        attempts = typeof parsed.n === 'number' ? parsed.n : 0;
      } catch {
        const legacy = Number(raw);
        claimedAt = Number.isFinite(legacy) ? legacy : 0;
        attempts = 1;
      }
    }
    if (attempts >= CHUNK_RELOAD_MAX_ATTEMPTS) {
      return { shouldReload: false, storage: 'session' };
    }
    if (claimedAt > 0 && Date.now() - claimedAt < CHUNK_RELOAD_TTL_MS) {
      return { shouldReload: false, storage: 'session' };
    }
    window.sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), n: attempts + 1 }));
    return { shouldReload: true, storage: 'session' };
  } catch {
    // No claim survives location.reload() without sessionStorage — the
    // in-memory map dies with the document, so reloading here would loop
    // forever. Skip recovery and let the error report instead.
    return { shouldReload: false, storage: 'blocked' };
  }
}

function claimServerActionReload(route: string, releaseFingerprint?: string): { shouldReload: boolean; storage: 'session' | 'blocked' } {
  const key = getServerActionReloadKey(route, releaseFingerprint);

  try {
    if (window.sessionStorage.getItem(key)) {
      return { shouldReload: false, storage: 'session' };
    }
    window.sessionStorage.setItem(key, '1');
    return { shouldReload: true, storage: 'session' };
  } catch {
    // Same reasoning as claimChunkReload: without a persistable claim a
    // reload can never prove it already ran, so don't attempt recovery.
    return { shouldReload: false, storage: 'blocked' };
  }
}

export function OpsTelemetryProvider({ children, releaseFingerprint }: OpsTelemetryProviderProps) {
  const pathname = usePathname();
  const routeRef = useRef('');
  const releaseFingerprintRef = useRef<string | undefined>(releaseFingerprint || undefined);

  useEffect(() => {
    routeRef.current = pathname || window.location.pathname;
    releaseFingerprintRef.current = releaseFingerprint || undefined;
  }, [pathname, releaseFingerprint]);

  useEffect(() => {
    if (window.__hermesOpsTelemetryActive) {
      return;
    }

    window.__hermesOpsTelemetryActive = true;

    const uninstallFetchInterceptor = installFetchRequestIdInterceptor();

    const reportError = (
      title: string,
      rawError: unknown,
      severity: 'warn' | 'error' = 'error',
      extraMetadata: Record<string, unknown> = {}
    ) => {
      if (window.__hermesOpsTelemetryReporting) {
        return;
      }

      window.__hermesOpsTelemetryReporting = true;

      try {
        const error = toError(rawError, title);
        if (shouldIgnoreClientError(error)) {
          // Extension/third-party noise: drop it (never sent to PostHog/ops).
          // The breadcrumb is debug-level, i.e. dev/test-only — the prod log
          // threshold is 'warn', so dropped errors are deliberately invisible
          // in production. Safe because the filter matches only unambiguous
          // extension signatures (see EXTENSION_MESSAGE_SIGNATURES).
          clientLog.debug('Dropped third-party client error', {
            source: 'client-runtime',
            failureType: 'client_runtime_noise_filtered',
            droppedErrorName: error.name,
            droppedErrorMessage: error.message,
          });
          return;
        }
        if (isClerkSessionTouchNetworkError(error)) return;

        const route = routeRef.current || window.location.pathname;
        const normalizedExtraMetadata = {
          ...extractRawErrorMetadata(rawError),
          ...extraMetadata,
          ...buildExceptionMetadata(error),
        };
        const posthogSessionId =
          typeof posthog.get_session_id === 'function' ? posthog.get_session_id() : undefined;
        const lastRequestId = getLastRequestId() ?? undefined;
        const chunkUrl = extractChunkUrl(error, normalizedExtraMetadata);
        const chunkFailure = isChunkLoadFailure(error, normalizedExtraMetadata);
        const staleServerActionFailure = isStaleServerActionFailure(error, normalizedExtraMetadata);
        const chunkRecovery = chunkFailure
          ? claimChunkReload(route, releaseFingerprintRef.current)
          : undefined;
        const staleActionRecovery = staleServerActionFailure
          ? claimServerActionReload(route, releaseFingerprintRef.current)
          : undefined;
        const recoveryMetadata = chunkFailure
          ? {
              chunkLoadRecovery: true,
              chunkUrl,
              recoveryAction: chunkRecovery?.shouldReload
                ? 'reload'
                : chunkRecovery?.storage === 'blocked'
                  ? 'reload-unavailable'
                  : 'reload-already-attempted',
              recoveryStorage: chunkRecovery?.storage,
            }
          : {};
        const staleActionRecoveryMetadata = staleServerActionFailure
          ? {
              staleActionRecovery: true,
              recoveryAction: staleActionRecovery?.shouldReload ? 'reload' : 'reload-already-attempted',
              recoveryStorage: staleActionRecovery?.storage,
            }
          : {};

        if (typeof posthog.captureException === 'function') {
          try {
            posthog.captureException(error, {
              source: 'client-runtime',
              route,
              severity,
              posthogSessionId,
              requestId: lastRequestId,
              releaseFingerprint: releaseFingerprintRef.current,
              ...normalizedExtraMetadata,
              ...recoveryMetadata,
              ...staleActionRecoveryMetadata,
            });
          } catch (captureError) {
            warnReporterFailure('PostHog exception capture failed', captureError);
          }
        }

        const ctx = {
          source: 'client-runtime',
          route,
          posthogSessionId,
          requestId: lastRequestId,
          releaseFingerprint: releaseFingerprintRef.current,
          ...normalizedExtraMetadata,
          ...recoveryMetadata,
          ...staleActionRecoveryMetadata,
        };

        try {
          if (severity === 'warn') {
            clientLog.warn(title, ctx, error);
          } else {
            clientLog.error(title, error, ctx);
          }
        } catch (logError) {
          warnReporterFailure('Client ops logger failed', logError);
        }

        if (chunkRecovery?.shouldReload && typeof posthog.capture === 'function') {
          // Named event (in addition to the exception) so chunk self-recovery
          // stays visible/queryable even though the page reloads right after.
          try {
            posthog.capture('chunk_load_recovered', {
              source: 'client-runtime',
              route,
              chunkUrl,
              recoveryStorage: chunkRecovery.storage,
              releaseFingerprint: releaseFingerprintRef.current,
            });
          } catch (captureError) {
            warnReporterFailure('PostHog chunk recovery capture failed', captureError);
          }
        }

        if (chunkRecovery?.shouldReload || staleActionRecovery?.shouldReload) {
          window.location.reload();
        }
      } catch (telemetryError) {
        warnReporterFailure('Client runtime telemetry failed', telemetryError);
      } finally {
        delete window.__hermesOpsTelemetryReporting;
      }
    };

    const handleWindowError = (event: ErrorEvent) => {
      // Extension-injected scripts surface their origin in event.filename even
      // when the error message/stack look first-party — skip those outright.
      if (event.filename && containsBrowserExtensionOrigin(event.filename)) {
        return;
      }

      reportError('Unhandled client error', event.error || event.message || 'Unhandled client error', 'error', {
        filename: event.filename || undefined,
        lineno: event.lineno ?? undefined,
        colno: event.colno ?? undefined,
      });
    };

    const handleUnhandledRejection = (event: Event) => {
      const rejectionEvent = event as Event & { reason?: unknown };
      reportError('Unhandled promise rejection', rejectionEvent.reason || 'Unhandled promise rejection');
    };

    window.addEventListener('error', handleWindowError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    return () => {
      delete window.__hermesOpsTelemetryActive;
      window.removeEventListener('error', handleWindowError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
      uninstallFetchInterceptor();
    };
  }, []);

  return <>{children}</>;
}
