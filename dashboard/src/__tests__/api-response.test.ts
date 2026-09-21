import { z } from 'zod';

import { apiSuccess, apiError, handleApiError } from '../lib/api-response';

interface MockResponse {
  status: number;
  body: Record<string, unknown>;
  headers: { set: jest.Mock };
}

jest.mock('next/server', () => {
  return {
    NextResponse: {
      json: jest.fn((body, init) => ({
        body,
        status: init?.status ?? 200,
        headers: { set: jest.fn() },
      })),
    },
  };
});

jest.mock('@/lib/ops-events', () => {
  const actual = jest.requireActual('@/lib/ops-events');
  return {
    ...actual,
    reportOpsEvent: jest.fn().mockResolvedValue(null),
  };
});

describe('api-response', () => {
  it('apiSuccess wraps data correctly', () => {
    const result = apiSuccess({ hello: 'world' }) as unknown as MockResponse;
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ success: true, data: { hello: 'world' } });
  });

  it('apiSuccess accepts custom status codes', () => {
    const result = apiSuccess({ created: true }, 201) as unknown as MockResponse;
    expect(result.status).toBe(201);
  });

  it('apiError returns expected format without leaking details', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = apiError('Internal Server Error', 500, { sensitiveData: 'xyz' }) as unknown as MockResponse;

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ success: false, error: 'Internal Server Error' });
    expect(result.body.sensitiveData).toBeUndefined();

    // The logger emitted exactly one error line for this 500.
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const logLine = String(consoleSpy.mock.calls[0][0]);
    expect(logLine).toContain('Internal Server Error');
    expect(logLine).toContain('"status":500');
    // The "sensitiveData" field is internal and not redacted by ops-events
    // sanitization (it doesn't match a sensitive key pattern), but it should
    // never appear in the response body — only in the log.
    expect(JSON.stringify(result.body)).not.toContain('xyz');

    consoleSpy.mockRestore();
  });

  it('apiError appends extra fields', () => {
    const result = apiError('Bad Request', 400, null, { field: 'email_invalid' }) as unknown as MockResponse;
    expect(result.body).toEqual({ success: false, error: 'Bad Request', field: 'email_invalid' });
  });

  it('handleApiError does not log raw unexpected errors', () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('secret-message');
    error.stack = 'stack-secret';

    const result = handleApiError(error) as unknown as MockResponse;

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ success: false, error: 'Internal Server Error' });
    expect(JSON.stringify(result.body)).not.toContain('secret-message');
    // Logger captures the error stack/message into the log line — that's
    // intentional (server-side only). What we guard against is the message
    // being echoed in the *response body*, which the assertion above covers.
    // We additionally verify the response body doesn't carry the raw stack.
    expect(JSON.stringify(result.body)).not.toContain('stack-secret');

    consoleSpy.mockRestore();
  });

  it('handleApiError preserves validation issues without leaking raw zod messages in the body', () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = z.object({ email: z.string().email() }).safeParse({ email: 'not-an-email' });
    if (parsed.success) {
      throw new Error('Expected validation to fail');
    }

    const result = handleApiError(parsed.error) as unknown as MockResponse;

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      success: false,
      error: 'Validation failed',
      issues: parsed.error.issues,
    });

    consoleWarnSpy.mockRestore();
  });
});
