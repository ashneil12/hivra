import { apiError } from '../api-response';
import { reportOpsEvent } from '../ops-events';

jest.mock('../ops-events', () => ({
  ...jest.requireActual('../ops-events'),
  reportOpsEvent: jest.fn().mockResolvedValue(null),
}));

describe('api-response observability', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('reports 500 responses to ops events', async () => {
    apiError('Internal Server Error', 500, new Error('boom'));

    await Promise.resolve();

    expect(reportOpsEvent).toHaveBeenCalledWith(expect.objectContaining({
      source: 'api-response',
      severity: 'error',
      title: expect.stringContaining('API 500'),
      message: 'Internal Server Error',
    }));
  });

  it('includes route attribution when provided', async () => {
    apiError('Internal Server Error', 500, new Error('boom'), undefined, {
      route: '/api/instances/[id]/profiles/[name]',
      method: 'PATCH',
      metadata: { instanceId: 'inst_123' },
    });

    await Promise.resolve();

    expect(reportOpsEvent).toHaveBeenCalledWith(expect.objectContaining({
      route: '/api/instances/[id]/profiles/[name]',
      metadata: expect.objectContaining({
        method: 'PATCH',
        instanceId: 'inst_123',
      }),
    }));
  });

  it('passes raw details through for ops-event sanitization without exposing secrets in metadata', async () => {
    apiError('Internal Server Error', 500, {
      stderr: 'refresh_token=super-secret',
      token: 'also-secret',
    });

    await Promise.resolve();

    expect(reportOpsEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        details: {
          stderr: 'refresh_token=[REDACTED]',
          token: '[REDACTED]',
        },
      }),
    }));

    // The logger writes a single structured line to console.error for 500s.
    // Crucially, the secret values must not appear in that line.
    expect(consoleErrorSpy).toHaveBeenCalled();
    const allLogs = JSON.stringify(consoleErrorSpy.mock.calls);
    expect(allLogs).not.toContain('super-secret');
    expect(allLogs).not.toContain('also-secret');
  });

  it('does not report 400 responses to ops events by default', async () => {
    const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    apiError('Validation failed', 400, { issue: 'bad input' });

    await Promise.resolve();

    expect(reportOpsEvent).not.toHaveBeenCalled();
    consoleWarnSpy.mockRestore();
  });
});
