import { archiveOpsEvents, buildOpsEventFingerprint, reportOpsEvent, reportOpsEventOnce, sanitizeOpsMetadata } from '../ops-events';
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

  it('stores bare provider and bot token shapes redacted in the message and sample stack', async () => {
    // Synthetic tokens, built at runtime.
    const body = 'Ab3Cd5Ef7Gh9Jk2Mn4Pq6Rs8Tu0Vw'.repeat(2);
    const anthropicKey = `sk-ant-api03-${body}`;
    const telegramToken = `123456789:${body.slice(0, 35)}`;

    const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    const eq = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const single = jest.fn().mockResolvedValue({ data: { id: 'evt_456' }, error: null });
    const insert = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq, maybeSingle })
      .mockReturnValueOnce({ insert, select, single });

    await reportOpsEvent({
      source: 'provider-probe',
      severity: 'error',
      title: 'Provider call failed',
      message: `upstream rejected ${anthropicKey}; getMe at https://api.telegram.org/bot${telegramToken}/getMe`,
      sampleStack: `at probe (${anthropicKey})`,
    });

    const row = insert.mock.calls[0][0];
    expect(row.message).toBe(
      'upstream rejected [REDACTED]; getMe at https://api.telegram.org/bot[REDACTED]/getMe',
    );
    expect(row.sample_stack).toBe('at probe ([REDACTED])');
    expect(JSON.stringify(row)).not.toContain(anthropicKey);
    expect(JSON.stringify(row)).not.toContain(body.slice(0, 35));
  });

  // Events without a fingerprintDetail keep the fingerprint they had before the detail
  // field existed, so existing ops_events rows keep grouping as they did.
  it('keeps the fingerprint of an event that carries no detail', () => {
    expect(buildOpsEventFingerprint({
      source: 'api',
      title: 'Responses proxy failed',
      message: 'Gateway unreachable',
      route: '/api/instances/123/responses',
      userId: 'user_123',
      instanceId: 'inst_123',
    })).toBe('2342effbd0b4eac721d955ccb33a421c0eeb3c947c358c1ced741499c8e7d6b1');
  });

  it('separates events that share a stored message but carry different details', () => {
    const base = {
      source: 'instance-health',
      title: 'fetch failed',
      message: 'TypeError',
    };
    const first = buildOpsEventFingerprint({ ...base, fingerprintDetail: 'at siteA (/app/src/probe.ts:10:5)' });
    const second = buildOpsEventFingerprint({ ...base, fingerprintDetail: 'at siteB (/app/src/probe.ts:20:5)' });
    expect(first).not.toBe(second);
    expect(first).not.toBe(buildOpsEventFingerprint(base));
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
    const updateIs = jest.fn().mockReturnThis();
    const updateMaybeSingle = jest.fn().mockResolvedValue({ data: { id: 'evt_123' }, error: null });
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
        is: updateIs,
        select,
        maybeSingle: updateMaybeSingle,
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
    // The refresh is open-only: it cannot silently reopen a row that was
    // archived between the lookup and the write.
    expect(updateIs).toHaveBeenCalledWith('archived_at', null);
  });

  it('reopens an archived incident when the fingerprint reoccurs', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { id: 'evt_123', occurrence_count: 4, archived_at: '2026-11-20T00:00:00Z' },
      error: null,
    });
    const eqSelect = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const updateEq = jest.fn().mockReturnThis();
    const updateNot = jest.fn().mockReturnThis();
    const updateMaybeSingle = jest.fn().mockResolvedValue({ data: { id: 'evt_123' }, error: null });
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
        not: updateNot,
        select,
        maybeSingle: updateMaybeSingle,
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
    const updateIs = jest.fn().mockReturnThis();
    const updateMaybeSingle = jest
      .fn()
      .mockResolvedValue({ data: { id: 'evt_fatal' }, error: null });
    const update = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq: eqSelect, maybeSingle })
      .mockReturnValueOnce({
        update,
        eq: updateEq,
        is: updateIs,
        select,
        maybeSingle: updateMaybeSingle,
      });

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

  it('pages an admin on first sighting of a page:true non-fatal event, with metadata carried to the alert', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    const eq = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const single = jest.fn().mockResolvedValue({ data: { id: 'evt_incident' }, error: null });
    const insert = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq, maybeSingle })
      .mockReturnValueOnce({ insert, select, single });

    await reportOpsEvent({
      source: 'incident.box_down',
      severity: 'error',
      page: true,
      title: 'Customer incident: agent box down',
      message: 'A customer box is down',
      instanceId: 'agent_1',
      metadata: { incident_key: 'box_down:agent_1', rule: 'box_down' },
    });

    expect(mockedFatalAlert).toHaveBeenCalledTimes(1);
    expect(mockedFatalAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'incident.box_down',
        title: 'Customer incident: agent box down',
        metadata: expect.objectContaining({ incident_key: 'box_down:agent_1' }),
      }),
    );
  });

  it('does NOT re-page a page:true event while its row is still open (update branch, archived_at null)', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { id: 'evt_incident', occurrence_count: 3, archived_at: null },
      error: null,
    });
    const eqSelect = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const updateEq = jest.fn().mockReturnThis();
    const updateIs = jest.fn().mockReturnThis();
    const updateMaybeSingle = jest
      .fn()
      .mockResolvedValue({ data: { id: 'evt_incident' }, error: null });
    const update = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq: eqSelect, maybeSingle })
      .mockReturnValueOnce({
        update,
        eq: updateEq,
        is: updateIs,
        select,
        maybeSingle: updateMaybeSingle,
      });

    await reportOpsEvent({
      source: 'incident.box_down',
      severity: 'error',
      page: true,
      title: 'Customer incident: agent box down',
      message: 'A customer box is down',
    });

    expect(mockedFatalAlert).not.toHaveBeenCalled();
  });

  it('pages AGAIN when a page:true fingerprint recurs after its row was archived', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { id: 'evt_incident', occurrence_count: 9, archived_at: '2026-11-20T00:00:00Z' },
      error: null,
    });
    const eqSelect = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const updateEq = jest.fn().mockReturnThis();
    const updateNot = jest.fn().mockReturnThis();
    const updateSingle = jest.fn().mockResolvedValue({ data: { id: 'evt_incident' }, error: null });
    const updateMaybeSingle = jest
      .fn()
      .mockResolvedValue({ data: { id: 'evt_incident' }, error: null });
    const update = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq: eqSelect, maybeSingle })
      .mockReturnValueOnce({
        update,
        eq: updateEq,
        not: updateNot,
        select,
        single: updateSingle,
        maybeSingle: updateMaybeSingle,
      });

    await reportOpsEvent({
      source: 'incident.box_down',
      severity: 'error',
      page: true,
      title: 'Customer incident: agent box down',
      message: 'A customer box is down',
    });

    // The update un-archived the row; the recurrence is a fresh incident.
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ archived_at: null }));
    expect(mockedFatalAlert).toHaveBeenCalledTimes(1);
  });

  it('does NOT page a plain error event even when its archived row recurs', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { id: 'evt_plain', occurrence_count: 2, archived_at: '2026-11-20T00:00:00Z' },
      error: null,
    });
    const eqSelect = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const updateEq = jest.fn().mockReturnThis();
    const updateNot = jest.fn().mockReturnThis();
    const updateSingle = jest.fn().mockResolvedValue({ data: { id: 'evt_plain' }, error: null });
    const updateMaybeSingle = jest
      .fn()
      .mockResolvedValue({ data: { id: 'evt_plain' }, error: null });
    const update = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq: eqSelect, maybeSingle })
      .mockReturnValueOnce({
        update,
        eq: updateEq,
        not: updateNot,
        select,
        single: updateSingle,
        maybeSingle: updateMaybeSingle,
      });

    await reportOpsEvent({
      source: 'api',
      severity: 'error',
      title: 'Responses proxy failed',
      message: 'Gateway unreachable',
    });

    expect(mockedFatalAlert).not.toHaveBeenCalled();
  });

  it('reopen is conditional on the row still being archived: a lost race does not page', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { id: 'evt_race', occurrence_count: 9, archived_at: '2026-11-20T00:00:00Z' },
      error: null,
    });
    const eqSelect = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const updateEq = jest.fn().mockReturnThis();
    const updateNot = jest.fn().mockReturnThis();
    // The conditional update matched zero rows — another writer already
    // reopened the fingerprint and owns the page for this recurrence.
    const updateMaybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    const update = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq: eqSelect, maybeSingle })
      .mockReturnValueOnce({
        update,
        eq: updateEq,
        not: updateNot,
        select,
        maybeSingle: updateMaybeSingle,
      });

    const result = await reportOpsEvent({
      source: 'incident.box_down',
      severity: 'error',
      page: true,
      title: 'Customer incident: agent box down',
      message: 'A customer box is down',
    });

    expect(updateNot).toHaveBeenCalledWith('archived_at', 'is', null);
    expect(mockedFatalAlert).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'evt_race', fingerprint: expect.any(String) });
  });

  it('returns null and does not page when the archived-row reopen update fails', async () => {
    // Regression: a reopen UPDATE that errored used to fall through to the
    // "lost race" branch and return the existing row id — the row stayed
    // archived, no page went out, and callers saw a persisted-looking id for
    // an event that was never recorded. It must report failure (null) like
    // the lookup-error path; only an error-free update matching zero rows is
    // a genuine lost race.
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { id: 'evt_reopen_fail', occurrence_count: 9, archived_at: '2026-11-20T00:00:00Z' },
      error: null,
    });
    const eqSelect = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const updateEq = jest.fn().mockReturnThis();
    const updateNot = jest.fn().mockReturnThis();
    const updateMaybeSingle = jest
      .fn()
      .mockResolvedValue({ data: null, error: { message: 'reopen update exploded' } });
    const update = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq: eqSelect, maybeSingle })
      .mockReturnValueOnce({
        update,
        eq: updateEq,
        not: updateNot,
        select,
        maybeSingle: updateMaybeSingle,
      });

    const result = await reportOpsEvent({
      source: 'incident.box_down',
      severity: 'error',
      page: true,
      title: 'Customer incident: agent box down',
      message: 'A customer box is down',
    });

    expect(result).toBeNull();
    expect(mockedFatalAlert).not.toHaveBeenCalled();
  });

  it('does NOT page when the insert returns no persisted id', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    const eq = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const single = jest.fn().mockResolvedValue({ data: null, error: null });
    const insert = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq, maybeSingle })
      .mockReturnValueOnce({ insert, select, single });

    const result = await reportOpsEvent({
      source: 'incident.box_down',
      severity: 'error',
      page: true,
      title: 'Customer incident: agent box down',
      message: 'A customer box is down',
    });

    expect(mockedFatalAlert).not.toHaveBeenCalled();
    expect(result?.id).toBeUndefined();
  });

  it('resetFirstSeenOnReopen rewrites first_seen_at only on the archived-to-open update', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { id: 'evt_probe', occurrence_count: 4, archived_at: '2026-11-20T00:00:00Z' },
      error: null,
    });
    const eqSelect = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const updateEq = jest.fn().mockReturnThis();
    const updateNot = jest.fn().mockReturnThis();
    const updateMaybeSingle = jest
      .fn()
      .mockResolvedValue({ data: { id: 'evt_probe' }, error: null });
    const update = jest.fn().mockReturnThis();
    const before = Date.now();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq: eqSelect, maybeSingle })
      .mockReturnValueOnce({
        update,
        eq: updateEq,
        not: updateNot,
        select,
        maybeSingle: updateMaybeSingle,
      });

    await reportOpsEvent({
      source: 'box.public_probe.unreachable',
      severity: 'warn',
      title: 'Customer box public probe unreachable',
      message: 'probe failing',
      instanceId: 'agent_1',
      resetFirstSeenOnReopen: true,
    });

    const payload = update.mock.calls[0][0] as Record<string, unknown>;
    expect(typeof payload.first_seen_at).toBe('string');
    expect(Date.parse(payload.first_seen_at as string)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('resetFirstSeenOnReopen leaves first_seen_at alone on a still-open row', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: { id: 'evt_probe', occurrence_count: 4, archived_at: null },
      error: null,
    });
    const eqSelect = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const updateEq = jest.fn().mockReturnThis();
    const updateIs = jest.fn().mockReturnThis();
    const updateMaybeSingle = jest
      .fn()
      .mockResolvedValue({ data: { id: 'evt_probe' }, error: null });
    const update = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq: eqSelect, maybeSingle })
      .mockReturnValueOnce({
        update,
        eq: updateEq,
        is: updateIs,
        select,
        maybeSingle: updateMaybeSingle,
      });

    await reportOpsEvent({
      source: 'box.public_probe.unreachable',
      severity: 'warn',
      title: 'Customer box public probe unreachable',
      message: 'probe failing',
      instanceId: 'agent_1',
      resetFirstSeenOnReopen: true,
    });

    const payload = update.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('first_seen_at');
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

  it('refuses an archived-row reopen when the row was closed after the observation', async () => {
    // The stalled 'down' report: between this report's observation and its
    // in-flight write, a healthy scan archived the probe row. The row's
    // archived_at is newer than observedAt — reopening it would commit an
    // outage from an obsolete observation.
    const maybeSingle = jest.fn().mockResolvedValue({
      data: {
        id: 'evt_probe',
        occurrence_count: 4,
        archived_at: '2026-11-22T12:05:00.000Z',
        first_seen_at: '2026-11-22T11:40:00.000Z',
      },
      error: null,
    });
    const eqSelect = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const update = jest.fn();

    // No update-chain mock at all: the lookup is the only from() this path
    // makes — a second call would throw inside reportOpsEvent and surface as
    // a null result, and an unconsumed mockReturnValueOnce would leak into
    // the next test.
    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq: eqSelect, maybeSingle });

    const result = await reportOpsEvent({
      source: 'box.public_probe.unreachable',
      severity: 'warn',
      title: 'Customer box public probe unreachable',
      message: 'probe failing',
      instanceId: 'agent_1',
      resetFirstSeenOnReopen: true,
      observedAt: '2026-11-22T12:00:00.000Z',
    });

    expect(result).toEqual({ fingerprint: expect.any(String), superseded: true });
    // The lookup is the only read; no update was attempted.
    expect(update).not.toHaveBeenCalled();
  });

  it('reopens an archived row whose close predates the observation — with the close-time predicate on the write', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: {
        id: 'evt_probe',
        occurrence_count: 4,
        archived_at: '2026-11-22T11:30:00.000Z',
        first_seen_at: '2026-11-22T11:00:00.000Z',
      },
      error: null,
    });
    const eqSelect = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const updateEq = jest.fn().mockReturnThis();
    const updateNot = jest.fn().mockReturnThis();
    const updateLt = jest.fn().mockReturnThis();
    const updateMaybeSingle = jest
      .fn()
      .mockResolvedValue({ data: { id: 'evt_probe' }, error: null });
    const update = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq: eqSelect, maybeSingle })
      .mockReturnValueOnce({
        update,
        eq: updateEq,
        not: updateNot,
        lt: updateLt,
        select,
        maybeSingle: updateMaybeSingle,
      });

    const result = await reportOpsEvent({
      source: 'box.public_probe.unreachable',
      severity: 'warn',
      title: 'Customer box public probe unreachable',
      message: 'probe failing',
      instanceId: 'agent_1',
      resetFirstSeenOnReopen: true,
      observedAt: '2026-11-22T12:00:00.000Z',
    });

    // The row was archived BEFORE the observation → the reopen is current.
    expect(updateLt).toHaveBeenCalledWith('archived_at', '2026-11-22T12:00:00.000Z');
    expect(result).toEqual({ id: 'evt_probe', fingerprint: expect.any(String) });
  });

  it('refuses a refresh on an open row whose recorded start is newer than the observation', async () => {
    // The row records an outage that began AFTER this observation — a
    // fresher report already owns it; the stale report must not bump it.
    const maybeSingle = jest.fn().mockResolvedValue({
      data: {
        id: 'evt_probe',
        occurrence_count: 4,
        archived_at: null,
        first_seen_at: '2026-11-22T12:10:00.000Z',
      },
      error: null,
    });
    const eqSelect = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const update = jest.fn();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq: eqSelect, maybeSingle });

    const result = await reportOpsEvent({
      source: 'box.public_probe.unreachable',
      severity: 'warn',
      title: 'Customer box public probe unreachable',
      message: 'probe failing',
      instanceId: 'agent_1',
      observedAt: '2026-11-22T12:00:00.000Z',
    });

    expect(result).toEqual({ fingerprint: expect.any(String), superseded: true });
    expect(update).not.toHaveBeenCalled();
  });

  it('refreshes an open row inside its outage window — predicated against a newer start, open rows only', async () => {
    const maybeSingle = jest.fn().mockResolvedValue({
      data: {
        id: 'evt_probe',
        occurrence_count: 4,
        archived_at: null,
        first_seen_at: '2026-11-22T11:45:00.000Z',
      },
      error: null,
    });
    const eqSelect = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const updateEq = jest.fn().mockReturnThis();
    const updateIs = jest.fn().mockReturnThis();
    const updateLte = jest.fn().mockReturnThis();
    const updateMaybeSingle = jest
      .fn()
      .mockResolvedValue({ data: { id: 'evt_probe' }, error: null });
    const update = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq: eqSelect, maybeSingle })
      .mockReturnValueOnce({
        update,
        eq: updateEq,
        is: updateIs,
        lte: updateLte,
        select,
        maybeSingle: updateMaybeSingle,
      });

    const result = await reportOpsEvent({
      source: 'box.public_probe.unreachable',
      severity: 'warn',
      title: 'Customer box public probe unreachable',
      message: 'probe failing',
      instanceId: 'agent_1',
      observedAt: '2026-11-22T12:00:00.000Z',
    });

    // first_seen_at predates the observation → the refresh lands, guarded:
    // the row must still be open and must not record a newer start. An
    // archive racing the write can no longer be silently undone.
    expect(updateIs).toHaveBeenCalledWith('archived_at', null);
    expect(updateLte).toHaveBeenCalledWith('first_seen_at', '2026-11-22T12:00:00.000Z');
    expect(result).toEqual({ id: 'evt_probe', fingerprint: expect.any(String) });
  });

  it('predicates the refresh on last_seen_at only moving forward — a slower older refresh cannot drag the marker back', async () => {
    // Two racing refreshes stamp their own write-time `now`. If the slower,
    // older `now` commits second it would overwrite the newer last_seen_at —
    // and the healthy-verdict path reads last_seen_at as the newest down
    // sighting, so a regressed value lets an archive close a live outage.
    // The .lte guard makes the stale refresh a no-match instead.
    const maybeSingle = jest.fn().mockResolvedValue({
      data: {
        id: 'evt_probe',
        occurrence_count: 4,
        archived_at: null,
        first_seen_at: '2026-11-22T11:45:00.000Z',
      },
      error: null,
    });
    const eqSelect = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const updateEq = jest.fn().mockReturnThis();
    const updateIs = jest.fn().mockReturnThis();
    const updateLte = jest.fn().mockReturnThis();
    const updateMaybeSingle = jest
      .fn()
      .mockResolvedValue({ data: { id: 'evt_probe' }, error: null });
    const update = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq: eqSelect, maybeSingle })
      .mockReturnValueOnce({
        update,
        eq: updateEq,
        is: updateIs,
        lte: updateLte,
        select,
        maybeSingle: updateMaybeSingle,
      });

    const result = await reportOpsEvent({
      source: 'box.public_probe.unreachable',
      severity: 'warn',
      title: 'Customer box public probe unreachable',
      message: 'probe failing',
      instanceId: 'agent_1',
      observedAt: '2026-11-22T12:00:00.000Z',
    });

    const lastSeenGuard = updateLte.mock.calls.find((call) => call[0] === 'last_seen_at');
    expect(lastSeenGuard).toBeDefined();
    // The bound is this report's own write timestamp — a row carrying a
    // NEWER last_seen_at refuses the write.
    expect(Number.isNaN(Date.parse(String(lastSeenGuard![1])))).toBe(false);
    expect(result).toEqual({ id: 'evt_probe', fingerprint: expect.any(String) });
  });

  it('answers superseded when a guarded refresh matched no rows (a newer verdict won the window)', async () => {
    const openRow = {
      id: 'evt_probe',
      occurrence_count: 4,
      archived_at: null,
      first_seen_at: '2026-11-22T11:45:00.000Z',
    };
    const maybeSingle = jest.fn().mockResolvedValue({ data: openRow, error: null });
    const eqSelect = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const updateEq = jest.fn().mockReturnThis();
    const updateIs = jest.fn().mockReturnThis();
    const updateLte = jest.fn().mockReturnThis();
    // The open-only predicate filtered the row out between the lookup and
    // the write.
    const updateMaybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    const update = jest.fn().mockReturnThis();
    // The re-read finds the row still open — the first_seen_at guard is
    // what refused the write, so this stale report is superseded.
    const rereadMaybeSingle = jest.fn().mockResolvedValue({ data: openRow, error: null });
    const rereadEq = jest.fn().mockReturnThis();
    const rereadSelect = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq: eqSelect, maybeSingle })
      .mockReturnValueOnce({
        update,
        eq: updateEq,
        is: updateIs,
        lte: updateLte,
        select,
        maybeSingle: updateMaybeSingle,
      })
      .mockReturnValueOnce({ select: rereadSelect, eq: rereadEq, maybeSingle: rereadMaybeSingle });

    const result = await reportOpsEvent({
      source: 'box.public_probe.unreachable',
      severity: 'warn',
      title: 'Customer box public probe unreachable',
      message: 'probe failing',
      instanceId: 'agent_1',
      observedAt: '2026-11-22T12:00:00.000Z',
    });

    expect(result).toEqual({ fingerprint: expect.any(String), superseded: true });
  });

  it('routes a refresh zero-match on an archived row through the conditional reopen — recurrence keeps its page', async () => {
    // Regression: the open-row refresh used to carry archived_at:null with
    // no open predicate, so an archive landing between the lookup and the
    // update was silently undone — the row reopened WITHOUT the page a
    // pageable recurrence is owed, and without the first_seen_at reset the
    // reopen path applies. The refresh is now open-only; a no-match re-reads
    // the row and takes the conditional reopen branch.
    const maybeSingle = jest.fn().mockResolvedValue({
      data: {
        id: 'evt_incident',
        occurrence_count: 9,
        archived_at: null,
        first_seen_at: '2026-11-22T11:00:00.000Z',
      },
      error: null,
    });
    const eqSelect = jest.fn().mockReturnThis();
    const select = jest.fn().mockReturnThis();
    const updateEq = jest.fn().mockReturnThis();
    const updateIs = jest.fn().mockReturnThis();
    const updateLte = jest.fn().mockReturnThis();
    // The archive won the race to the row: the open-only refresh matched
    // nothing.
    const updateMaybeSingle = jest.fn().mockResolvedValue({ data: null, error: null });
    const update = jest.fn().mockReturnThis();
    // The re-read finds the row archived — closed BEFORE the observation,
    // so the reopen is the current verdict.
    const rereadEq = jest.fn().mockReturnThis();
    const rereadSelect = jest.fn().mockReturnThis();
    const rereadMaybeSingle = jest.fn().mockResolvedValue({
      data: {
        id: 'evt_incident',
        occurrence_count: 9,
        archived_at: '2026-11-22T11:55:00.000Z',
        first_seen_at: '2026-11-22T11:00:00.000Z',
      },
      error: null,
    });
    const reopenEq = jest.fn().mockReturnThis();
    const reopenNot = jest.fn().mockReturnThis();
    const reopenLt = jest.fn().mockReturnThis();
    const reopenMaybeSingle = jest
      .fn()
      .mockResolvedValue({ data: { id: 'evt_incident' }, error: null });
    const reopenUpdate = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({ select, eq: eqSelect, maybeSingle })
      .mockReturnValueOnce({
        update,
        eq: updateEq,
        is: updateIs,
        lte: updateLte,
        select,
        maybeSingle: updateMaybeSingle,
      })
      .mockReturnValueOnce({ select: rereadSelect, eq: rereadEq, maybeSingle: rereadMaybeSingle })
      .mockReturnValueOnce({
        update: reopenUpdate,
        eq: reopenEq,
        not: reopenNot,
        lt: reopenLt,
        select,
        maybeSingle: reopenMaybeSingle,
      });

    const result = await reportOpsEvent({
      source: 'incident.box_down',
      severity: 'error',
      page: true,
      title: 'Customer incident: agent box down',
      message: 'A customer box is down',
      resetFirstSeenOnReopen: true,
      observedAt: '2026-11-22T12:00:00.000Z',
    });

    // The refresh was open-only…
    expect(updateIs).toHaveBeenCalledWith('archived_at', null);
    // …the re-read routed through the conditional reopen (still archived,
    // close predates the observation) — the writer that actually reopens
    // is the one that pages, so the recurrence keeps its notification.
    expect(reopenNot).toHaveBeenCalledWith('archived_at', 'is', null);
    expect(reopenLt).toHaveBeenCalledWith('archived_at', '2026-11-22T12:00:00.000Z');
    expect(reopenUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ archived_at: null, first_seen_at: expect.any(String) }),
    );
    expect(mockedFatalAlert).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ id: 'evt_incident', fingerprint: expect.any(String) });
  });
});

describe('reportOpsEventOnce', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('inserts when the fingerprint is not stored and reports the new row', async () => {
    const upsert = jest.fn().mockReturnThis();
    const select = jest
      .fn()
      .mockResolvedValue({ data: [{ id: 'evt_new' }], error: null });

    (supabaseAdmin!.from as jest.Mock).mockReturnValueOnce({ upsert, select });

    const result = await reportOpsEventOnce({
      source: 'box.surface_watchdog.unit_failing',
      severity: 'warn',
      title: 'surface watchdog: unit_failing x.service [e1-1]',
      message: 'receipt',
      instanceId: 'agent_1',
    });

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        occurrence_count: 1,
        title: 'surface watchdog: unit_failing x.service [e1-1]',
      }),
      { onConflict: 'fingerprint', ignoreDuplicates: true },
    );
    expect(result).toEqual({
      id: 'evt_new',
      fingerprint: expect.any(String),
      inserted: true,
    });
  });

  it('answers inserted:false on a fingerprint conflict — already stored, nothing updated', async () => {
    const upsert = jest.fn().mockReturnThis();
    const select = jest.fn().mockResolvedValue({ data: [], error: null });

    (supabaseAdmin!.from as jest.Mock).mockReturnValueOnce({ upsert, select });

    const result = await reportOpsEventOnce({
      source: 'box.surface_watchdog.recovered',
      severity: 'info',
      title: 'surface watchdog: recovered x.service [e1-2]',
      message: 'receipt',
      instanceId: 'agent_1',
    });

    expect(result).toEqual({ fingerprint: expect.any(String), inserted: false });
    expect(mockedFatalAlert).not.toHaveBeenCalled();
  });

  it('returns null when the insert fails', async () => {
    const upsert = jest.fn().mockReturnThis();
    const select = jest
      .fn()
      .mockResolvedValue({ data: null, error: { message: 'db down' } });

    (supabaseAdmin!.from as jest.Mock).mockReturnValueOnce({ upsert, select });

    const result = await reportOpsEventOnce({
      source: 'box.surface_watchdog.unit_failing',
      severity: 'warn',
      title: 'surface watchdog: unit_failing x.service [e1-1]',
      message: 'receipt',
      instanceId: 'agent_1',
    });

    expect(result).toBeNull();
  });
});
