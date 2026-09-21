/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, waitFor } from '@testing-library/react';

import { OpsTelemetryProvider } from '../OpsTelemetryProvider';
import { clientLog } from '@/lib/client/logger';
import posthog from 'posthog-js';

jest.mock('@/lib/client/logger', () => ({
  clientLog: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('@/lib/client/request-id-tracker', () => ({
  installFetchRequestIdInterceptor: jest.fn(() => () => {}),
  getLastRequestId: jest.fn(() => null),
  recordRequestId: jest.fn(),
  consumeLastRequestId: jest.fn(() => null),
  trackedFetch: jest.fn(),
}));

jest.mock('next/navigation', () => ({
  usePathname: jest.fn(() => '/dashboard/chat'),
}));

jest.mock('posthog-js', () => ({
  __esModule: true,
  default: {
    capture: jest.fn(),
    captureException: jest.fn(),
    get_session_id: jest.fn(() => 'sess_123'),
  },
}));

describe('OpsTelemetryProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sessionStorage.clear();
    delete (window as typeof window & { __hermesOpsTelemetryActive?: boolean }).__hermesOpsTelemetryActive;
  });

  it('captures unhandled browser errors into ops events and PostHog', async () => {
    render(
      <OpsTelemetryProvider>
        <div>child</div>
      </OpsTelemetryProvider>
    );

    const error = new Error('boom');
    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));

    await waitFor(() => {
      expect(posthog.captureException).toHaveBeenCalledWith(
        error,
        expect.objectContaining({
          source: 'client-runtime',
          route: '/dashboard/chat',
        })
      );
    });

    expect(clientLog.error).toHaveBeenCalledWith(
      'Unhandled client error',
      error,
      expect.objectContaining({
        source: 'client-runtime',
        route: '/dashboard/chat',
        posthogSessionId: 'sess_123',
      })
    );
  });

  it('adds explicit exception type and message fields for non-Error promise rejections', async () => {
    render(
      <OpsTelemetryProvider>
        <div>child</div>
      </OpsTelemetryProvider>
    );

    const event = new Event('unhandledrejection') as Event & { reason?: unknown };
    event.reason = { source: 'clerk', stage: 'first-paint-hydration' };
    window.dispatchEvent(event);

    await waitFor(() => {
      expect(posthog.captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          source: 'client-runtime',
          route: '/dashboard/chat',
          exception_type: 'Error',
          exception_message: expect.stringContaining('first-paint-hydration'),
          $exception_type: 'Error',
          $exception_message: expect.stringContaining('first-paint-hydration'),
          rawErrorType: 'object',
          rawErrorKeys: ['source', 'stage'],
        })
      );
    });
  });

  it('ignores narrow Clerk session touch network errors that already show inline recovery UI', async () => {
    render(
      <OpsTelemetryProvider>
        <div>child</div>
      </OpsTelemetryProvider>
    );

    const event = new Event('unhandledrejection') as Event & { reason?: unknown };
    event.reason = new Error('ClerkJS: Network error at "https://clerk.hermesos.cloud/v1/client/sessions/sess_123/touch" - TypeError: Load failed. Please try again.');
    window.dispatchEvent(event);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posthog.captureException).not.toHaveBeenCalled();
    expect(clientLog.error).not.toHaveBeenCalled();
    expect(clientLog.warn).not.toHaveBeenCalled();
  });

  it('ignores browser extension runtime failures', async () => {
    render(
      <OpsTelemetryProvider>
        <div>child</div>
      </OpsTelemetryProvider>
    );

    const error = new Error('Failed to fetch');
    Object.defineProperty(error, 'stack', {
      configurable: true,
      value: 'TypeError: Failed to fetch\n    at chrome-extension://hoklmmgfnpapgjgcpechhaamimifchmp/frame_ant/frame_ant.js:2:18047',
    });

    const event = new Event('unhandledrejection') as Event & { reason?: unknown };
    event.reason = error;
    window.dispatchEvent(event);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posthog.captureException).not.toHaveBeenCalled();
    expect(clientLog.error).not.toHaveBeenCalled();
    expect(clientLog.warn).not.toHaveBeenCalled();
  });

  it('drops extension content-script bridge errors without sending them to PostHog or ops', async () => {
    render(
      <OpsTelemetryProvider>
        <div>child</div>
      </OpsTelemetryProvider>
    );

    // Chrome extension messaging bridge (arrives as a window error string).
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'Invalid call to runtime.sendMessage(). Tab not found.' })
    );

    // Binance Wallet extension SSE bridge (arrives as an unhandled rejection).
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejection.reason = new Error('func sseError not found');
    window.dispatchEvent(rejection);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posthog.captureException).not.toHaveBeenCalled();
    expect(posthog.capture).not.toHaveBeenCalled();
    expect(clientLog.error).not.toHaveBeenCalled();
    expect(clientLog.warn).not.toHaveBeenCalled();
    // The drop is still counted locally for debugging.
    expect(clientLog.debug).toHaveBeenCalledWith(
      'Dropped third-party client error',
      expect.objectContaining({
        failureType: 'client_runtime_noise_filtered',
        droppedErrorMessage: 'func sseError not found',
      })
    );
  });

  it('skips window errors whose filename points at a browser extension script', async () => {
    render(
      <OpsTelemetryProvider>
        <div>child</div>
      </OpsTelemetryProvider>
    );

    // Extension-injected scripts often raise first-party-looking errors; the
    // extension origin only shows up in event.filename.
    const error = new Error('Invalid frame state');
    window.dispatchEvent(
      new ErrorEvent('error', {
        error,
        message: error.message,
        filename: 'chrome-extension://hoklmmgfnpapgjgcpechhaamimifchmp/frame_ant/frame_ant.js',
        lineno: 2,
        colno: 18047,
      })
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posthog.captureException).not.toHaveBeenCalled();
    expect(clientLog.error).not.toHaveBeenCalled();
    expect(clientLog.warn).not.toHaveBeenCalled();
  });

  it('still captures first-party errors that resemble extension noise', async () => {
    render(
      <OpsTelemetryProvider>
        <div>child</div>
      </OpsTelemetryProvider>
    );

    const error = new Error('Failed to fetch');
    Object.defineProperty(error, 'stack', {
      configurable: true,
      value: 'TypeError: Failed to fetch\n    at fetchUsage (https://hermesos.cloud/dashboard/chat:1:100)',
    });

    const event = new Event('unhandledrejection') as Event & { reason?: unknown };
    event.reason = error;
    window.dispatchEvent(event);

    await waitFor(() => {
      expect(posthog.captureException).toHaveBeenCalledWith(
        error,
        expect.objectContaining({ source: 'client-runtime' })
      );
    });
    expect(clientLog.error).toHaveBeenCalled();
  });

  it('ignores generic cross-origin script errors without useful context', async () => {
    render(
      <OpsTelemetryProvider>
        <div>child</div>
      </OpsTelemetryProvider>
    );

    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posthog.captureException).not.toHaveBeenCalled();
    expect(clientLog.error).not.toHaveBeenCalled();
    expect(clientLog.warn).not.toHaveBeenCalled();
  });

  it('ignores meaningless native event rejection payloads', async () => {
    render(
      <OpsTelemetryProvider>
        <div>child</div>
      </OpsTelemetryProvider>
    );

    const event = new Event('unhandledrejection') as Event & { reason?: unknown };
    event.reason = { isTrusted: true };
    window.dispatchEvent(event);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(posthog.captureException).not.toHaveBeenCalled();
    expect(clientLog.error).not.toHaveBeenCalled();
    expect(clientLog.warn).not.toHaveBeenCalled();
  });

  it('includes file and position metadata for browser errors', async () => {
    render(
      <OpsTelemetryProvider releaseFingerprint="deploy_123">
        <div>child</div>
      </OpsTelemetryProvider>
    );

    const error = new Error('bad token');
    window.dispatchEvent(
      new ErrorEvent('error', {
        error,
        message: error.message,
        filename: 'https://hermesos.cloud/_next/static/chunks/app.js',
        lineno: 17,
        colno: 23,
      })
    );

    await waitFor(() => {
      expect(clientLog.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          filename: 'https://hermesos.cloud/_next/static/chunks/app.js',
          lineno: 17,
          colno: 23,
          releaseFingerprint: 'deploy_123',
        })
      );
    });

    expect(posthog.captureException).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        filename: 'https://hermesos.cloud/_next/static/chunks/app.js',
        lineno: 17,
        colno: 23,
        releaseFingerprint: 'deploy_123',
      })
    );
  });

  it('reloads once with recovery metadata when a stale Next.js chunk fails to load', async () => {
    const originalLocation = window.location;
    const reloadSpy = jest.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        pathname: '/dashboard/chat',
        reload: reloadSpy,
      },
    });

    try {
      render(
        <OpsTelemetryProvider releaseFingerprint="deploy_456">
          <div>child</div>
        </OpsTelemetryProvider>
      );

      const error = new Error(
        'Loading chunk 947888 failed.\n(error: https://hermesos.cloud/_next/static/chunks/0kec4zxr-id8l.js)'
      );
      error.name = 'ChunkLoadError';

      window.dispatchEvent(
        new ErrorEvent('error', {
          error,
          message: error.message,
          filename: 'https://hermesos.cloud/_next/static/chunks/turbopack-loader.js',
        })
      );

      await waitFor(() => {
        expect(reloadSpy).toHaveBeenCalledTimes(1);
      });

      expect(posthog.captureException).toHaveBeenCalledWith(
        error,
        expect.objectContaining({
          chunkLoadRecovery: true,
          chunkUrl: 'https://hermesos.cloud/_next/static/chunks/0kec4zxr-id8l.js',
          recoveryAction: 'reload',
          releaseFingerprint: 'deploy_456',
          route: '/dashboard/chat',
        })
      );
      expect(clientLog.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          chunkLoadRecovery: true,
          chunkUrl: 'https://hermesos.cloud/_next/static/chunks/0kec4zxr-id8l.js',
          recoveryAction: 'reload',
        })
      );

      window.dispatchEvent(
        new ErrorEvent('error', {
          error,
          message: error.message,
          filename: 'https://hermesos.cloud/_next/static/chunks/turbopack-loader.js',
        })
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it('reloads once and emits chunk_load_recovered when a Clerk CDN UI chunk fails', async () => {
    const originalLocation = window.location;
    const reloadSpy = jest.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        pathname: '/get-started',
        reload: reloadSpy,
      },
    });

    try {
      render(
        <OpsTelemetryProvider releaseFingerprint="deploy_clerk">
          <div>child</div>
        </OpsTelemetryProvider>
      );

      // Clerk UI chunk ids look like "666/26" and the error name is a plain
      // Error, so recovery must trigger off the message pattern alone.
      const error = new Error(
        'Loading chunk 666/26 failed.\n(error: https://cdn.jsdelivr.net/npm/@clerk/ui@1.7.0/dist/chunks/666.js)'
      );

      const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
      rejection.reason = error;
      window.dispatchEvent(rejection);

      await waitFor(() => {
        expect(reloadSpy).toHaveBeenCalledTimes(1);
      });

      expect(posthog.capture).toHaveBeenCalledWith(
        'chunk_load_recovered',
        expect.objectContaining({
          source: 'client-runtime',
          route: '/dashboard/chat',
          recoveryStorage: 'session',
          releaseFingerprint: 'deploy_clerk',
        })
      );
      expect(posthog.captureException).toHaveBeenCalledWith(
        error,
        expect.objectContaining({
          chunkLoadRecovery: true,
          recoveryAction: 'reload',
        })
      );

      // A second failure inside the TTL passes through without another reload.
      const secondRejection = new Event('unhandledrejection') as Event & { reason?: unknown };
      secondRejection.reason = error;
      window.dispatchEvent(secondRejection);

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reloadSpy).toHaveBeenCalledTimes(1);
      expect(posthog.capture).toHaveBeenCalledTimes(1);
      expect(posthog.captureException).toHaveBeenCalledWith(
        error,
        expect.objectContaining({
          chunkLoadRecovery: true,
          recoveryAction: 'reload-already-attempted',
        })
      );
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it('reloads once with the CSS asset url when a stale Next.js CSS chunk fails to load', async () => {
    const originalLocation = window.location;
    const reloadSpy = jest.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        pathname: '/sign-in',
        reload: reloadSpy,
      },
    });

    try {
      render(
        <OpsTelemetryProvider releaseFingerprint="deploy_css">
          <div>child</div>
        </OpsTelemetryProvider>
      );

      // mini-css-extract surfaces stale-CSS-chunk version skew as
      // "Loading CSS chunk N failed" — the "CSS" word sits between "Loading"
      // and "chunk", so the JS-only matcher would have missed it.
      const error = new Error(
        'Loading CSS chunk 5 failed.\n(missing: https://hermesos.cloud/_next/static/css/8a1c2.css)'
      );

      window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));

      await waitFor(() => {
        expect(reloadSpy).toHaveBeenCalledTimes(1);
      });

      expect(posthog.captureException).toHaveBeenCalledWith(
        error,
        expect.objectContaining({
          chunkLoadRecovery: true,
          chunkUrl: 'https://hermesos.cloud/_next/static/css/8a1c2.css',
          recoveryAction: 'reload',
          releaseFingerprint: 'deploy_css',
        })
      );

      // One-shot guard: a second identical CSS-chunk failure inside the TTL
      // must not trigger a second reload (no reload loop).
      window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it('does not reload on an ordinary runtime ReferenceError that is not a chunk-load failure', async () => {
    const originalLocation = window.location;
    const reloadSpy = jest.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        pathname: '/dashboard/chat',
        reload: reloadSpy,
      },
    });

    try {
      render(
        <OpsTelemetryProvider releaseFingerprint="deploy_ref">
          <div>child</div>
        </OpsTelemetryProvider>
      );

      // A genuine app bug ("X is not defined") must report but NEVER reload —
      // reloading an ordinary runtime error would mask real bugs and risk a loop.
      const error = new ReferenceError('clerkLoaded is not defined');

      window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));

      await waitFor(() => {
        expect(posthog.captureException).toHaveBeenCalledWith(
          error,
          expect.objectContaining({ source: 'client-runtime' })
        );
      });

      // No chunk recovery metadata and no reload for a plain runtime error.
      expect(reloadSpy).not.toHaveBeenCalled();
      expect(posthog.captureException).not.toHaveBeenCalledWith(
        error,
        expect.objectContaining({ chunkLoadRecovery: true })
      );
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it('allows another chunk reload after the recovery guard TTL expires', async () => {
    const originalLocation = window.location;
    const reloadSpy = jest.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        pathname: '/dashboard/chat',
        reload: reloadSpy,
      },
    });
    const baseNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseNow);

    try {
      render(
        <OpsTelemetryProvider releaseFingerprint="deploy_ttl">
          <div>child</div>
        </OpsTelemetryProvider>
      );

      const error = new Error('Loading chunk 947888 failed.');
      error.name = 'ChunkLoadError';

      window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));
      await waitFor(() => {
        expect(reloadSpy).toHaveBeenCalledTimes(1);
      });

      // Still inside the TTL: guarded, no reload loop.
      nowSpy.mockReturnValue(baseNow + 10_000);
      window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reloadSpy).toHaveBeenCalledTimes(1);

      // After the TTL the guard expires and recovery may run again.
      nowSpy.mockReturnValue(baseNow + 61_000);
      window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));
      await waitFor(() => {
        expect(reloadSpy).toHaveBeenCalledTimes(2);
      });
    } finally {
      nowSpy.mockRestore();
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it('reloads once when a stale client calls a removed Server Action', async () => {
    const originalLocation = window.location;
    const reloadSpy = jest.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        pathname: '/get-started/activate',
        reload: reloadSpy,
      },
    });

    try {
      render(
        <OpsTelemetryProvider releaseFingerprint="deploy_789">
          <div>child</div>
        </OpsTelemetryProvider>
      );

      const error = new Error(
        'Server Action "00b5b44105617b81beff495474233a2c523c036d89" was not found on the server.'
      );
      error.name = 'UnrecognizedActionError';

      window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));

      await waitFor(() => {
        expect(reloadSpy).toHaveBeenCalledTimes(1);
      });

      expect(posthog.captureException).toHaveBeenCalledWith(
        error,
        expect.objectContaining({
          staleActionRecovery: true,
          recoveryAction: 'reload',
          releaseFingerprint: 'deploy_789',
          route: '/dashboard/chat',
        })
      );

      window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it('preserves object rejection diagnostics instead of reporting Error: {}', async () => {
    render(
      <OpsTelemetryProvider>
        <div>child</div>
      </OpsTelemetryProvider>
    );

    const event = new Event('unhandledrejection') as Event & { reason?: unknown };
    event.reason = { code: -32603, method: 'eth_call' };
    window.dispatchEvent(event);

    await waitFor(() => {
      expect(posthog.captureException).toHaveBeenCalled();
    });

    const capturedError = (posthog.captureException as jest.Mock).mock.calls[0][0] as Error;
    const capturedMetadata = (posthog.captureException as jest.Mock).mock.calls[0][1];

    expect(capturedError.message).toBe('JSON-RPC error -32603');
    expect(capturedError.message).not.toBe('{}');
    expect(capturedMetadata).toEqual(
      expect.objectContaining({
        rawErrorCode: -32603,
        rawErrorMethod: 'eth_call',
        rawErrorType: 'object',
      })
    );
  });

  it('registers global runtime listeners only once even when nested providers mount', async () => {
    render(
      <OpsTelemetryProvider releaseFingerprint="deploy_outer">
        <OpsTelemetryProvider releaseFingerprint="deploy_inner">
          <div>child</div>
        </OpsTelemetryProvider>
      </OpsTelemetryProvider>
    );

    const error = new Error('boom');
    window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));

    await waitFor(() => {
      expect(posthog.captureException).toHaveBeenCalledTimes(1);
    });

    expect(clientLog.error).toHaveBeenCalledTimes(1);
  });

  it('does not recursively throw when the PostHog reporter fails while handling a runtime error', async () => {
    const posthogCapture = posthog.captureException as jest.Mock;
    posthogCapture.mockImplementationOnce(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });

    render(
      <OpsTelemetryProvider>
        <div>child</div>
      </OpsTelemetryProvider>
    );

    const error = new Error('original render failure');

    expect(() => {
      window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));
    }).not.toThrow();

    await waitFor(() => {
      expect(clientLog.error).toHaveBeenCalledWith(
        'Unhandled client error',
        error,
        expect.objectContaining({
          source: 'client-runtime',
          route: '/dashboard/chat',
        })
      );
    });

    expect(posthogCapture).toHaveBeenCalledTimes(1);
  });

  it('does not recursively throw when the client logger fails while handling a runtime error', async () => {
    const clientLogError = clientLog.error as jest.Mock;
    clientLogError.mockImplementationOnce(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });

    render(
      <OpsTelemetryProvider>
        <div>child</div>
      </OpsTelemetryProvider>
    );

    const error = new Error('original render failure');

    expect(() => {
      window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }));
    }).not.toThrow();

    await waitFor(() => {
      expect(posthog.captureException).toHaveBeenCalledWith(
        error,
        expect.objectContaining({
          source: 'client-runtime',
          route: '/dashboard/chat',
        })
      );
    });

    expect(clientLogError).toHaveBeenCalledTimes(1);
  });
});
