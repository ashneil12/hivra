import { archiveOpsEvents, buildOpsEventFingerprint, reportOpsEvent, sanitizeOpsMetadata } from '../ops-events';
import { supabaseAdmin } from '@/lib/supabase';
import { sendOpsFatalAdminAlert } from '@/lib/email/ops-fatal-admin';

jest.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

// The fatal-alert transport is dynamically imported inside reportOpsEvent;
// jest.mock hoists so the dynamic import resolves to this mock.
jest.mock('@/lib/email/ops-fatal-admin', () => ({
  sendOpsFatalAdminAlert: jest.fn().mockResolvedValue({ emailSent: true, telegramSent: false }),
}));

const mockedFatalAlert = sendOpsFatalAdminAlert as jest.Mock;

describe('ops-events helper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('redacts sensitive metadata and truncates oversized strings', () => {
    const sanitized = sanitizeOpsMetadata({
      apiKey: 'secret-key',
      nested: {
        authorization: 'Bearer top-secret',
      },
      stderr: 'refresh_token=super-secret and client_secret=other-secret',
      genericLeak: 'db leaked "sk-live-secret"',
      harmless: 'ok',
      giant: 'x'.repeat(5000),
    });

    expect(sanitized).toEqual({
      apiKey: '[REDACTED]',
      nested: {
        authorization: '[REDACTED]',
      },
      stderr: 'refresh_token=[REDACTED] and client_secret=[REDACTED]',
      genericLeak: 'db leaked "[REDACTED]"',
      harmless: 'ok',
      giant: expect.stringContaining('[TRUNCATED]'),
    });
  });

  it('redacts bearer/pepper/credentials/private-key/webhook keys (Hermes-specific secret names)', () => {
    const sanitized = sanitizeOpsMetadata({
      // Real env-var names from this repo that the original regex missed.
      HERMES_INSTANCE_BEARER_ENCRYPTION_KEY: 'bearer-key-value',
      MANAGED_VENICE_PROXY_KEY_PEPPER: 'pepper-value',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----',
      webhookSecret: 'whsec_value',
      credentials: { user: 'a', pass: 'b' },
      safeField: 'visible',
    });

    expect(sanitized).toEqual({
      HERMES_INSTANCE_BEARER_ENCRYPTION_KEY: '[REDACTED]',
      MANAGED_VENICE_PROXY_KEY_PEPPER: '[REDACTED]',
      privateKey: '[REDACTED]',
      webhookSecret: '[REDACTED]',
      credentials: '[REDACTED]',
      safeField: 'visible',
    });
  });

  it('builds a stable fingerprint from the same event shape', () => {
    const first = buildOpsEventFingerprint({
      source: 'api',
      title: 'Responses proxy failed',
      message: 'Gateway unreachable',
      route: '/api/instances/123/responses',
      userId: 'user_123',
      instanceId: 'inst_123',
    });

    const second = buildOpsEventFingerprint({
      source: 'api',
      title: 'Responses proxy failed',
      message: 'Gateway unreachable',
      route: '/api/instances/123/responses',
      userId: 'user_123',
      instanceId: 'inst_123',
    });

    expect(first).toBe(second);
  });

  it('inserts a redacted event when no fingerprint match exists', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    const eq = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const single = jest.fn().mockResolvedValue({ data: { id: 'evt_123' }, error: null });
    const insert = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({
        select,
        eq,
        maybeSingle,
      })
      .mockReturnValueOnce({
        insert,
        select,
        single,
      });

    await reportOpsEvent({
      source: 'client-runtime',
      severity: 'error',
      title: 'Unhandled client exception',
      message: 'Exploded',
      userId: 'user_123',
      metadata: {
        token: 'really-secret',
      },
    });

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      source: 'client-runtime',
      severity: 'error',
      title: 'Unhandled client exception',
      message: 'Exploded',
      user_id: 'user_123',
      occurrence_count: 1,
      metadata: {
        token: '[REDACTED]',
      },
    }));
  });

  it('increments the occurrence count when the fingerprint already exists', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { id: 'evt_123', occurrence_count: 2 },
      error: null,
    });
    const eqSelect = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const updateEq = jest.fn().mockReturnThis();
    const updateSingle = jest.fn().mockResolvedValue({ data: { id: 'evt_123' }, error: null });
    const update = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({
        select,
        eq: eqSelect,
        maybeSingle,
      })
      .mockReturnValueOnce({
        update,
        eq: updateEq,
        select,
        single: updateSingle,
      });

    await reportOpsEvent({
      source: 'api',
      severity: 'error',
      title: 'Responses proxy failed',
      message: 'Gateway unreachable',
      userId: 'user_123',
    });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      occurrence_count: 3,
    }));
    expect(updateEq).toHaveBeenCalledWith('id', 'evt_123');
  });

  it('reopens an archived incident when the fingerprint reoccurs', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { id: 'evt_123', occurrence_count: 4 },
      error: null,
    });
    const eqSelect = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const updateEq = jest.fn().mockReturnThis();
    const updateSingle = jest.fn().mockResolvedValue({ data: { id: 'evt_123' }, error: null });
    const update = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({
        select,
        eq: eqSelect,
        maybeSingle,
      })
      .mockReturnValueOnce({
        update,
        eq: updateEq,
        select,
        single: updateSingle,
      });

    await reportOpsEvent({
      source: 'api',
      severity: 'error',
      title: 'Responses proxy failed',
      message: 'Gateway unreachable',
      userId: 'user_123',
    });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      occurrence_count: 5,
      archived_at: null,
      archived_by_user_id: null,
    }));
  });

  it('pages an admin on the FIRST occurrence of a fatal fingerprint (insert branch)', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    const eq = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const single = jest.fn().mockResolvedValue({ data: { id: 'evt_fatal' }, error: null });
    const insert = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq, maybeSingle })
      .mockReturnValueOnce({ insert, select, single });

    await reportOpsEvent({
      source: 'synthetic.proxmox-host-wedged',
      severity: 'fatal',
      title: 'Host fixturenode2 wedged',
      message: '3 gateways unreachable',
      instanceId: null,
    });

    expect(mockedFatalAlert).toHaveBeenCalledTimes(1);
    expect(mockedFatalAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'synthetic.proxmox-host-wedged',
        title: 'Host fixturenode2 wedged',
        message: '3 gateways unreachable',
        fingerprint: expect.any(String),
      }),
    );
  });

  it('does NOT page again when the same fatal fingerprint reoccurs (update branch)', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { id: 'evt_fatal', occurrence_count: 7 },
      error: null,
    });
    const eqSelect = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const updateEq = jest.fn().mockReturnThis();
    const updateSingle = jest.fn().mockResolvedValue({ data: { id: 'evt_fatal' }, error: null });
    const update = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq: eqSelect, maybeSingle })
      .mockReturnValueOnce({ update, eq: updateEq, select, single: updateSingle });

    await reportOpsEvent({
      source: 'synthetic.proxmox-host-wedged',
      severity: 'fatal',
      title: 'Host fixturenode2 wedged',
      message: '3 gateways unreachable',
    });

    // Extended outage re-reporting the same fingerprint pages exactly once.
    expect(mockedFatalAlert).not.toHaveBeenCalled();
  });

  it('does NOT page for a non-fatal first occurrence', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    const eq = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const single = jest.fn().mockResolvedValue({ data: { id: 'evt_warn' }, error: null });
    const insert = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq, maybeSingle })
      .mockReturnValueOnce({ insert, select, single });

    await reportOpsEvent({
      source: 'synthetic.instance-health',
      severity: 'error',
      title: 'Gateway unhealthy',
      message: 'probe 502',
    });

    expect(mockedFatalAlert).not.toHaveBeenCalled();
  });

  it('soft-archives the requested events for the current operator', async () => {
    const inMock = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const then = (resolve: (value: { data: Array<{ id: string }>; error: null }) => void) =>
      resolve({ data: [{ id: 'evt_123' }, { id: 'evt_456' }], error: null });
    const update = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock).mockReturnValue({
      update,
      in: inMock,
      select,
      then,
    });

    const result = await archiveOpsEvents({
      ids: ['evt_123', 'evt_456'],
      archivedByUserId: 'user_ops',
    });

    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      archived_by_user_id: 'user_ops',
      archived_at: expect.any(String),
    }));
    expect(inMock).toHaveBeenCalledWith('id', ['evt_123', 'evt_456']);
    expect(result).toEqual({
      archivedCount: 2,
    });
  });
});
