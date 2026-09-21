import { QwenAuthManager } from '../auth';
import { supabaseAdmin } from '../src/lib/supabase';

// Mock env variables
process.env.QWEN_REST_CLIENT_ID = 'test_client_id';
process.env.QWEN_REST_CLIENT_SECRET = 'test_client_secret';
process.env.QWEN_PORTAL_API = 'https://mock.qwen.api';

jest.mock('../src/lib/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

jest.mock('undici', () => ({
  fetch: jest.fn()
}));

import { fetch } from 'undici';

function parseWrittenJsonCalls(spy: jest.SpyInstance): Array<Record<string, unknown>> {
  return spy.mock.calls.flatMap(([chunk]) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    return text
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  });
}

describe('QwenAuthManager', () => {
  let authManager: QwenAuthManager;
  let mockFetch: jest.Mock;
  let authManagerInternals: QwenAuthManager & {
    clientId: string;
    clientSecret: string;
  };
  let mockedFrom: jest.Mock;
  let stderrWriteSpy: jest.SpyInstance;
  let stdoutWriteSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    authManager = new QwenAuthManager();
    // Re-initialize class to pickup mocked envs
    authManagerInternals = authManager as QwenAuthManager & {
      clientId: string;
      clientSecret: string;
    };
    authManagerInternals.clientId = 'test_client_id';
    authManagerInternals.clientSecret = 'test_client_secret';

    mockFetch = fetch as jest.Mock;
    mockFetch.mockReset();
    mockedFrom = supabaseAdmin!.from as jest.Mock;
    mockedFrom.mockReset();
    stderrWriteSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    stdoutWriteSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrWriteSpy.mockRestore();
    stdoutWriteSpy.mockRestore();
  });

  describe('refreshAccessToken', () => {
    it('successfully refreshes token and returns updated credentials', async () => {
      const mockCredentials = {
        access_token: 'old_token',
        refresh_token: 'refresh_123',
        token_type: 'Bearer',
        expiry_date: Date.now() - 1000, // expired
      };

      // Mock successful response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new_token_456',
          expires_in: 3600,
          token_type: 'Bearer',
        })
      });

      // We pass a dummy accountId to avoid db saving throwing error without mocking supabase
      // Actually, we should mock saveCredentials
      jest.spyOn(authManager, 'saveCredentials').mockResolvedValue(undefined);

      const result = await authManager.refreshAccessToken(mockCredentials);
      
      // Ensure the endpoint hits the token API
      expect(mockFetch).toHaveBeenCalledWith(
        'https://chat.qwen.ai/api/v1/oauth2/token',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: expect.any(URLSearchParams)
        })
      );
      
      expect(result.access_token).toBe('new_token_456');
      expect(result.refresh_token).toBe('refresh_123'); // retains old if not provided
    });

    it('throws a generic error and redacts provider error details from logs when refresh fails', async () => {
      const mockCredentials = {
        access_token: 'old_token',
        refresh_token: 'invalid_refresh',
      };

      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({
          error: 'invalid_grant',
          error_description: 'refresh_token=super-secret',
        })
      });

      await expect(authManager.refreshAccessToken(mockCredentials)).rejects.toThrow(
        'Failed to refresh access token. Please re-authenticate with the Qwen CLI.'
      );

      const errorLogs = parseWrittenJsonCalls(stderrWriteSpy);
      expect(JSON.stringify(errorLogs)).not.toContain('super-secret');
      expect(errorLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Failed to refresh Qwen access token.',
            failureType: 'qwen_token_refresh_failed',
            level: 'error',
            source: 'qwen-auth',
            errorName: 'Error',
          }),
        ])
      );
    });
  });

  describe('saveCredentials', () => {
    it('does not log raw Supabase error messages when saving credentials fails', async () => {
      mockedFrom.mockReturnValue({
        upsert: jest.fn().mockResolvedValue({
          error: {
            message: 'refresh_token=super-secret',
            code: '23505',
          },
        }),
      });

      await authManager.saveCredentials({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      });

      const errorLogs = parseWrittenJsonCalls(stderrWriteSpy);
      expect(JSON.stringify(errorLogs)).not.toContain('super-secret');
      expect(errorLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Error saving credentials to Supabase.',
            failureType: 'qwen_credentials_save_failed',
            level: 'error',
            source: 'qwen-auth',
            errorName: 'object',
            errorCode: '23505',
          }),
        ])
      );
    });
  });

  describe('loadAllAccounts', () => {
    it('does not log raw Supabase query error messages', async () => {
      mockedFrom.mockReturnValue({
        select: jest.fn().mockResolvedValue({
          data: [],
          error: {
            message: 'access_token=super-secret',
            code: 'PGRST116',
          },
        }),
      });

      const accounts = await authManager.loadAllAccounts();

      const warningLogs = parseWrittenJsonCalls(stdoutWriteSpy);
      expect(accounts.size).toBe(0);
      expect(JSON.stringify(warningLogs)).not.toContain('super-secret');
      expect(warningLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Failed to load multi-account credentials from Supabase.',
            failureType: 'qwen_multi_account_load_failed',
            level: 'warn',
            source: 'qwen-auth',
            errorName: 'object',
            errorCode: 'PGRST116',
          }),
        ])
      );
    });

    it('does not log raw unexpected load failures', async () => {
      mockedFrom.mockImplementation(() => {
        throw new Error('refresh_token=super-secret');
      });

      const accounts = await authManager.loadAllAccounts();

      const warningLogs = parseWrittenJsonCalls(stdoutWriteSpy);
      expect(accounts.size).toBe(0);
      expect(JSON.stringify(warningLogs)).not.toContain('super-secret');
      expect(warningLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'loadAllAccounts failed.',
            failureType: 'qwen_load_all_accounts_failed',
            level: 'warn',
            source: 'qwen-auth',
            errorName: 'Error',
          }),
        ])
      );
    });
  });

  describe('initiateDeviceFlow', () => {
    it('does not log raw device authorization response text on failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => 'device_code=super-secret',
      });

      await expect(authManager.initiateDeviceFlow()).rejects.toThrow(
        'Device authorization failed: 400 Bad Request. Response: device_code=super-secret'
      );

      const errorLogs = parseWrittenJsonCalls(stderrWriteSpy);
      expect(JSON.stringify(errorLogs)).not.toContain('super-secret');
      expect(errorLogs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: 'Device authorization flow failed.',
            failureType: 'qwen_device_authorization_failed',
            level: 'error',
            source: 'qwen-auth',
            errorName: 'Error',
          }),
        ])
      );
    });
  });

  describe('pollForToken', () => {
    // The poll loop uses `setTimeout(resolve, pollInterval)` between
    // attempts (5s default, can grow to 10s). Without a stub we'd hang the
    // suite for that long when the test exercises the retry path; here we
    // resolve every queued setTimeout synchronously via Promise.resolve so
    // the loop progresses without consuming real wall-clock time.
    let setTimeoutSpy: jest.SpyInstance;
    beforeEach(() => {
      setTimeoutSpy = jest
        .spyOn(global, 'setTimeout')
        .mockImplementation(((cb: () => void) => {
          // Fire on the microtask queue, never the macrotask queue, so
          // the loop yields back to the test code synchronously.
          Promise.resolve().then(cb);
          return 0 as unknown as NodeJS.Timeout;
        }) as unknown as typeof setTimeout);
    });

    afterEach(() => {
      setTimeoutSpy.mockRestore();
    });

    it('throws fast on a definite OAuth failure (not just retried 60×)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        // any non-pending/slow_down/expired/access_denied error code is
        // treated as terminal — the loop must NOT swallow and retry.
        text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'no' }),
      });

      await expect(
        authManager.pollForToken('dev-code', 'verifier', null)
      ).rejects.toThrow(/Device token poll failed: 400 invalid_grant/);

      // exactly one fetch — not the full retry budget
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('throws fast when the server returns non-JSON', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: async () => '<html>nginx</html>',
      });

      await expect(
        authManager.pollForToken('dev-code', 'verifier', null)
      ).rejects.toThrow(/Device token poll failed: 502/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('keeps polling on authorization_pending and resolves when the device is approved', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({ error: 'authorization_pending' }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'tok',
          refresh_token: 'rt',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      // upsert mock for saveCredentials
      const upsertMock = jest.fn().mockResolvedValue({ error: null });
      mockedFrom.mockReturnValue({ upsert: upsertMock });

      const credentials = await authManager.pollForToken('dev-code', 'verifier', null);

      expect(credentials.access_token).toBe('tok');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('throws immediately on expired_token', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({ error: 'expired_token' }),
      });

      await expect(
        authManager.pollForToken('dev-code', 'verifier', null)
      ).rejects.toThrow(/expired/i);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
