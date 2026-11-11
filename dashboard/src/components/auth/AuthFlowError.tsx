'use client';

import { useEffect } from 'react';
import posthog from 'posthog-js';

import { captureClientOpsEvent } from '@/lib/client/ops-events';

interface AuthFlowErrorProps {
  error: Error & { digest?: string };
  unstable_retry: () => void;
  route: string;
  title: string;
  description: string;
  retryLabel: string;
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

export default function AuthFlowError({
  error,
  unstable_retry,
  route,
  title,
  description,
  retryLabel,
}: AuthFlowErrorProps) {
  useEffect(() => {
    const metadata = {
      digest: error.digest || null,
      posthogSessionId: typeof posthog.get_session_id === 'function' ? posthog.get_session_id() : undefined,
      ...buildExceptionMetadata(error),
    };

    if (typeof posthog.captureException === 'function') {
      posthog.captureException(error, {
        source: 'auth-error-boundary',
        route,
        ...metadata,
      });
    }

    void captureClientOpsEvent({
      source: 'auth-error-boundary',
      title: 'Auth flow render error',
      message: error.message || 'Auth flow render error',
      severity: 'fatal',
      route,
      sampleStack: error.stack,
      metadata,
    });
  }, [error, route]);

  return (
    <div
      className="min-h-[100dvh] w-full flex items-center justify-center px-6 py-10"
      style={{ background: 'transparent' }}
    >
      <div
        className="w-full max-w-2xl"
        style={{
          border: '1px solid var(--hg-stroke)', borderRadius: 'var(--hg-radius-lg)',
          background: 'var(--hg-glass)',
          padding: '2rem',
          boxShadow: 'var(--hg-glass-edge), var(--hg-shadow-md)',
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
          Auth Recovery
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
          {title}
        </h2>
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.7, marginBottom: '1.5rem' }}>
          {description}
        </p>
        <div className="flex flex-wrap gap-3 items-center">
          <button
            type="button"
            onClick={() => unstable_retry()}
            className="action-button"
            style={{ padding: '10px 16px', fontSize: 11, letterSpacing: '0.12em' }}
          >
            {retryLabel}
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
