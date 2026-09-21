'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

import {
  isClerkAssetLoadError,
  isClerkSessionTouchNetworkError,
  shouldIgnoreClientError,
  shouldRetryClerkChunkLoad,
  toError,
} from '@/lib/clerk-runtime-errors';

const AUTH_RUNTIME_NOTICE =
  'We temporarily failed to reach our sign-in service. Please wait a moment and try Google sign-in again.';
const AUTH_WIDGET_ASSET_NOTICE =
  'The sign-in form failed to download all required files. Please refresh, try a private window, or disable blockers for this page.';
const AUTH_WIDGET_TIMEOUT_NOTICE =
  "The sign-in form did not finish loading. This is usually caused by a browser shield, extension, or stale site data blocking Clerk. Please refresh, try a private window, or disable blockers for this localhost page.";
const AUTH_WIDGET_SELECTOR = '[data-clerk-component], .cl-rootBox, .cl-card';
const AUTH_WIDGET_TIMEOUT_MS = 5000;

// sessionStorage access can throw outright when storage is blocked (some
// private-browsing/embedded contexts), so reach for it defensively. Returning
// null makes shouldRetryClerkChunkLoad decline the reload and fall back to the
// notice instead of letting an exception escape the error handler.
function getChunkRetryStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function toBrowserRuntimeError(event: ErrorEvent, fallbackTitle: string): Error {
  const error = toError(event.error || event.message || fallbackTitle, fallbackTitle);
  const filename = event.filename?.trim();

  if (!filename || error.message.includes(filename) || error.stack?.includes(filename)) {
    return error;
  }

  const contextualError = new Error(`${error.message} (${filename})`);
  contextualError.name = error.name;
  contextualError.stack = error.stack;
  return contextualError;
}

export function AuthRuntimeNotice() {
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const handleRuntimeError = (rawError: unknown) => {
      const error = toError(rawError, 'Auth runtime error');
      if (shouldIgnoreClientError(error)) return;
      if (isClerkSessionTouchNetworkError(error)) {
        setNotice(AUTH_RUNTIME_NOTICE);
        return;
      }
      if (isClerkAssetLoadError(error)) {
        // Transient Clerk UI CDN chunk failure: reload the route once to
        // recover instead of leaving a broken/blank sign-in screen.
        // shouldRetryClerkChunkLoad guarantees at most one reload per session —
        // if it declines (already retried, or no usable storage) we fall back
        // to the graceful notice rather than reloading in a loop.
        if (shouldRetryClerkChunkLoad(getChunkRetryStore())) {
          window.location.reload();
          return;
        }
        setNotice(AUTH_WIDGET_ASSET_NOTICE);
      }
    };

    const handleWindowError = (event: ErrorEvent) => {
      handleRuntimeError(toBrowserRuntimeError(event, 'Unhandled client error'));
    };

    const handleUnhandledRejection = (event: Event) => {
      const rejectionEvent = event as Event & { reason?: unknown };
      handleRuntimeError(rejectionEvent.reason || 'Unhandled promise rejection');
    };

    window.addEventListener('error', handleWindowError);
    window.addEventListener('unhandledrejection', handleUnhandledRejection);

    return () => {
      window.removeEventListener('error', handleWindowError);
      window.removeEventListener('unhandledrejection', handleUnhandledRejection);
    };
  }, []);

  useEffect(() => {
    const hasMountedClerkWidget = () => Boolean(document.querySelector(AUTH_WIDGET_SELECTOR));

    if (hasMountedClerkWidget()) return;

    const markClerkLoaded = () => {
      setNotice((currentNotice) =>
        currentNotice === AUTH_WIDGET_TIMEOUT_NOTICE ||
          currentNotice === AUTH_WIDGET_ASSET_NOTICE
          ? null
          : currentNotice
      );
    };

    const timeoutId = window.setTimeout(() => {
      if (hasMountedClerkWidget()) return;
      setNotice((currentNotice) => currentNotice ?? AUTH_WIDGET_TIMEOUT_NOTICE);
    }, AUTH_WIDGET_TIMEOUT_MS);

    const observer = new MutationObserver(() => {
      if (!hasMountedClerkWidget()) return;
      window.clearTimeout(timeoutId);
      markClerkLoaded();
      observer.disconnect();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      window.clearTimeout(timeoutId);
      observer.disconnect();
    };
  }, []);

  if (!notice) return null;

  return (
    <div
      role="alert"
      style={{
        margin: '16px auto 0',
        maxWidth: 720,
        border: '1px solid rgba(239,68,68,0.24)',
        background: 'rgba(239,68,68,0.05)',
        color: 'var(--ink-black)',
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
      }}
    >
      <AlertTriangle size={16} style={{ color: 'var(--red)', flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          className="mono"
          style={{
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            fontWeight: 700,
            marginBottom: 6,
            color: 'var(--red)',
          }}
        >
          Sign-In Recovery
        </p>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>{notice}</p>
      </div>
      <button
        type="button"
        onClick={() => setNotice(null)}
        style={{
          border: '1px solid var(--etched-border)',
          background: 'var(--bg-surface)',
          padding: '8px 10px',
          cursor: 'pointer',
          fontFamily: 'var(--font-mono), monospace',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        Dismiss Notice
      </button>
    </div>
  );
}
