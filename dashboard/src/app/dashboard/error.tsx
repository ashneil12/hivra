'use client';

import { useEffect } from 'react';
import posthog from 'posthog-js';

import { clientLog } from '@/lib/client/logger';

export default function DashboardError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    const posthogSessionId =
      typeof posthog.get_session_id === 'function' ? posthog.get_session_id() : undefined;

    if (typeof posthog.captureException === 'function') {
      posthog.captureException(error, {
        source: 'dashboard-error-boundary',
        route: '/dashboard',
        digest: error.digest || null,
        posthogSessionId,
      });
    }

    clientLog.error('Dashboard render error', error, {
      source: 'dashboard-error-boundary',
      route: '/dashboard',
      digest: error.digest || null,
      posthogSessionId,
    });
  }, [error]);

  return (
    <div
      // Fill <main>, which already sits between the mobile header and bottom
      // bar; a full-viewport height pushed the card below the fold on phones.
      className="min-h-full w-full flex items-center justify-center px-4 py-6 md:px-6 md:py-10"
      style={{ background: 'var(--vellum-bg)' }}
    >
      <div
        className="w-full max-w-2xl"
        style={{
          border: '1px solid var(--etched-border)',
          background: 'var(--bg-surface)',
          padding: 'clamp(1.25rem, 5vw, 2rem)',
          boxShadow: '0 12px 30px rgba(0,0,0,0.06)',
        }}
      >
        <p
          className="mono"
          style={{
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.18em',
            color: 'var(--text-muted)',
            marginBottom: '1rem',
            fontWeight: 700,
          }}
        >
          Dashboard Recovery
        </p>
        <h2
          className="serif"
          style={{
            fontSize: 'clamp(1.8rem, 4vw, 2.4rem)',
            lineHeight: 1.1,
            marginBottom: '0.75rem',
            color: 'var(--ink-black)',
          }}
        >
          Something broke in the operator console.
        </h2>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: '1.5rem' }}>
          The error has been captured for review. You can retry the dashboard now without losing the rest of the app shell.
        </p>
        <div className="flex flex-wrap gap-3 items-center">
          <button
            type="button"
            onClick={() => unstable_retry()}
            className="action-button"
            style={{ minHeight: 44, padding: '10px 16px', fontSize: 11, letterSpacing: '0.12em' }}
          >
            Retry Dashboard
          </button>
          <span
            className="mono"
            style={{ fontSize: 11, color: 'var(--text-muted)', wordBreak: 'break-word' }}
          >
            {error.digest ? `Digest ${error.digest}` : error.message}
          </span>
        </div>
      </div>
    </div>
  );
}
