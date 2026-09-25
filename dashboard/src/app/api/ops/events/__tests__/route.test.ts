import { NextRequest } from 'next/server';
import { DELETE, GET, PATCH, POST } from '../route';
import { auth, currentUser } from '@clerk/nextjs/server';
import { supabaseAdmin } from '@/lib/supabase';
import { isOpsAdminUser } from '@/lib/ops-access';
import { archiveOpsEvents, deleteOpsEvents, reportOpsEvent } from '@/lib/ops-events';
import { makeJsonRequest } from "@/test-utils/request";

jest.mock('@clerk/nextjs/server', () => ({
  auth: jest.fn(),
  currentUser: jest.fn(),
}));

jest.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

jest.mock('@/lib/ops-access', () => ({
  isOpsAdminUser: jest.fn(),
}));

jest.mock('@/lib/ops-events', () => ({
  ...jest.requireActual('@/lib/ops-events'),
  archiveOpsEvents: jest.fn(),
  deleteOpsEvents: jest.fn(),
  reportOpsEvent: jest.fn(),
}));

describe('/api/ops/events', () => {
  const archiveIds = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];

  let consoleErrorSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let mockQuery: Record<string, jest.Mock | ((...args: unknown[]) => unknown) | unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    mockQuery = {
      select: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      then: (resolve: (value: { data: unknown[]; error: null }) => void) =>
        resolve({ data: [{ id: 'evt_123' }], error: null }),
    };

    (supabaseAdmin!.from as jest.Mock).mockReturnValue(mockQuery);
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: 'user_123' });
    (currentUser as jest.Mock).mockResolvedValue({
      primaryEmailAddress: { emailAddress: 'admin@example.com' },
    });
    (isOpsAdminUser as jest.Mock).mockReturnValue(false);
    (archiveOpsEvents as jest.Mock).mockResolvedValue({ archivedCount: 2 });
    (deleteOpsEvents as jest.Mock).mockResolvedValue({ deletedCount: 2 });
    (reportOpsEvent as jest.Mock).mockResolvedValue({ id: 'evt_123' });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('returns 401 when GET is unauthenticated', async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });

    const req = new NextRequest('http://localhost/api/ops/events');
    const res = await GET(req);

    expect(res.status).toBe(401);
  });

  it('rejects GET requests from non-admin users', async () => {
    const req = new NextRequest('http://localhost/api/ops/events?limit=25');
    const res = await GET(req);

    expect(res.status).toBe(403);
    expect(isOpsAdminUser).toHaveBeenCalledWith({
      userId: 'user_123',
      email: 'admin@example.com',
    });
    expect(supabaseAdmin!.from).not.toHaveBeenCalled();
  });

  it('returns the global feed for ops admins', async () => {
    (isOpsAdminUser as jest.Mock).mockReturnValue(true);

    const req = new NextRequest('http://localhost/api/ops/events');
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.data.scope).toBe('global');
    expect(mockQuery.eq).not.toHaveBeenCalledWith('user_id', 'user_123');
  });

  it('does not log raw database text when ops event loading fails', async () => {
    (isOpsAdminUser as jest.Mock).mockReturnValue(true);

    mockQuery = {
      select: jest.fn().mockReturnThis(),
      is: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      then: (resolve: (value: { data: null; error: { message: string } }) => void) =>
        resolve({ data: null, error: { message: 'ops_events replica shard 3 timed out' } }),
    };
    (supabaseAdmin!.from as jest.Mock).mockReturnValue(mockQuery);

    const req = new NextRequest('http://localhost/api/ops/events');
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.error).toBe('Failed to fetch ops events');
    expect(JSON.stringify(data)).not.toContain('ops_events replica shard 3 timed out');
    expect(consoleErrorSpy.mock.calls.flat().join(' ')).not.toContain('ops_events replica shard 3 timed out');
  });

  it('accepts authenticated client incident reports and forces the current user id', async () => {
    const req = new NextRequest('http://localhost/api/ops/events', {
      method: 'POST',
      body: JSON.stringify({
        source: 'client-runtime',
        title: 'Unhandled client exception',
        message: 'Exploded',
        userId: 'someone-else',
      }),
    });

    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(202);
    expect(data.success).toBe(true);
    expect(reportOpsEvent).toHaveBeenCalledWith(expect.objectContaining({
      source: 'client-runtime',
      title: 'Unhandled client exception',
      message: 'Exploded',
      userId: 'user_123',
    }));
  });

  it('logs accepted client error reports to server logs with request context without duplicating ops events', async () => {
    const req = new NextRequest('http://localhost/api/ops/events', {
      method: 'POST',
      headers: {
        'x-vercel-id': 'iad1::abc123',
      },
      body: JSON.stringify({
        source: 'client-runtime',
        title: 'Unhandled client exception',
        message: 'Exploded while rendering chat',
        severity: 'error',
        route: '/dashboard/chat',
        instanceId: 'inst_123',
        conversationId: 'conv_123',
        profileName: 'default',
        metadata: {
          requestId: 'browser_req_456',
          component: 'HermesChat',
        },
      }),
    });

    const res = await POST(req);

    expect(res.status).toBe(202);
    expect(res.headers.get('x-request-id')).toBe('iad1::abc123');
    expect(reportOpsEvent).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    const logLine = JSON.stringify(consoleErrorSpy.mock.calls);
    expect(logLine).toContain('client ops event received');
    expect(logLine).toContain('client-runtime');
    expect(logLine).toContain('/dashboard/chat');
    expect(logLine).toContain('iad1::abc123');
    expect(logLine).toContain('browser_req_456');
  });

  function postEvent(body: Record<string, unknown>) {
    return POST(new NextRequest('http://localhost/api/ops/events', {
      method: 'POST',
      body: JSON.stringify({ source: 'client-runtime', title: 'Client failure', message: 'Exploded', ...body }),
    }));
  }

  function reportedEvent(): Record<string, unknown> {
    expect(reportOpsEvent).toHaveBeenCalledTimes(1);
    return (reportOpsEvent as jest.Mock).mock.calls[0][0];
  }

  function mockInstanceOwnership(owned: { table: string; id: string; userId: string } | null) {
    const lookups: Array<{ table: string; filters: Record<string, unknown> }> = [];
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      const filters: Record<string, unknown> = {};
      lookups.push({ table, filters });
      const chain: Record<string, jest.Mock> = {
        select: jest.fn(() => chain),
        eq: jest.fn((column: string, value: unknown) => {
          filters[column] = value;
          return chain;
        }),
        limit: jest.fn(() => chain),
        maybeSingle: jest.fn(async () => ({
          data: owned && owned.table === table && filters.id === owned.id && filters.user_id === owned.userId
            ? { id: owned.id }
            : null,
          error: null,
        })),
      };
      return chain;
    });
    return lookups;
  }

  it('never forwards a client-reported fatal as fatal, so a signed-in user cannot page the admin', async () => {
    const res = await postEvent({ severity: 'fatal' });

    expect(res.status).toBe(202);
    const event = reportedEvent();
    expect(event.severity).toBe('error');
    expect(event.metadata).toEqual(expect.objectContaining({ clientRequestedSeverity: 'fatal' }));
  });

  it('clamps client fatals for ops admins too: every POST here is browser-sourced', async () => {
    (isOpsAdminUser as jest.Mock).mockReturnValue(true);

    await postEvent({ source: 'admin.force_delete', severity: 'fatal' });

    expect(reportedEvent().severity).toBe('error');
  });

  it('keeps non-fatal client severities as reported', async () => {
    await postEvent({ severity: 'warn' });
    expect(reportedEvent().severity).toBe('warn');
  });

  it('flattens the title to one plain line and clamps the title and message', async () => {
    const title = `Checkout broken\r\nBcc: victim@example.com\u0007\u202Egnp.exe\u200B ${'x'.repeat(120)}`;
    const message = `line one\r\nline two\u0000\u001B[31m\u2066hidden\u2069 ${'y'.repeat(3900)}`;

    await postEvent({ title, message });

    const event = reportedEvent();
    const reportedTitle = String(event.title);
    const reportedMessage = String(event.message);
    expect(reportedTitle.startsWith('Checkout broken Bcc: victim@example.com gnp.exe x')).toBe(true);
    expect(reportedTitle).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/);
    expect(Array.from(reportedTitle).length).toBeLessThanOrEqual(160);
    expect(reportedMessage.startsWith('line one\nline two[31mhidden y')).toBe(true);
    expect(reportedMessage).not.toMatch(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/);
    expect(Array.from(reportedMessage).length).toBeLessThanOrEqual(1000);

    expect(JSON.stringify(consoleErrorSpy.mock.calls)).toContain('Checkout broken Bcc: victim@example.com gnp.exe');
  });

  it('drops an instanceId the caller does not own and strips banner-driving metadata', async () => {
    const lookups = mockInstanceOwnership({ table: 'hermes_instances', id: '33333333-3333-4333-8333-333333333333', userId: 'someone-else' });

    await postEvent({
      instanceId: '33333333-3333-4333-8333-333333333333',
      metadata: {
        failureOwner: 'hermes',
        failurePhase: 'runtime',
        recoveryAction: 'contact_support',
        component: 'HermesChat',
      },
    });

    const event = reportedEvent();
    expect(event.instanceId).toBeUndefined();
    expect(event.metadata).toEqual(expect.objectContaining({ component: 'HermesChat' }));
    expect(event.metadata).not.toHaveProperty('failureOwner');
    expect(event.metadata).not.toHaveProperty('failurePhase');
    expect(event.metadata).not.toHaveProperty('recoveryAction');
    expect(lookups.every((lookup) => lookup.filters.user_id === 'user_123')).toBe(true);
  });

  it('keeps an instanceId the caller owns (Hermes instance or Hivra agent)', async () => {
    mockInstanceOwnership({ table: 'hivra_agents', id: '44444444-4444-4444-8444-444444444444', userId: 'user_123' });

    await postEvent({ instanceId: '44444444-4444-4444-8444-444444444444' });

    expect(reportedEvent().instanceId).toBe('44444444-4444-4444-8444-444444444444');
  });

  it('drops a malformed instanceId without querying for it', async () => {
    const lookups = mockInstanceOwnership(null);

    await postEvent({ instanceId: "x' or 1=1" });

    expect(reportedEvent().instanceId).toBeUndefined();
    expect(lookups).toHaveLength(0);
  });

  it('rate-limits each signed-in user', async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: `user_flood_${Date.now()}` });

    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      const res = await POST(new NextRequest('http://localhost/api/ops/events', {
        method: 'POST',
        headers: { 'cf-connecting-ip': `198.51.100.${i + 1}` },
        body: JSON.stringify({ source: 'client-runtime', title: `Flood ${i}`, message: 'x' }),
      }));
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 30).every((status) => status === 202)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(reportOpsEvent).toHaveBeenCalledTimes(30);
  });

  it('rejects bulk archive requests from non-admin users', async () => {
    const req = new NextRequest('http://localhost/api/ops/events', {
      method: 'PATCH',
      body: JSON.stringify({
        ids: [archiveIds[0]],
      }),
    });

    const res = await PATCH(req);

    expect(res.status).toBe(403);
    expect(archiveOpsEvents).not.toHaveBeenCalled();
  });

  it('archives the requested incidents for ops admins', async () => {
    (isOpsAdminUser as jest.Mock).mockReturnValue(true);

    const req = new NextRequest('http://localhost/api/ops/events', {
      method: 'PATCH',
      body: JSON.stringify({
        ids: archiveIds,
      }),
    });

    const res = await PATCH(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(archiveOpsEvents).toHaveBeenCalledWith({
      ids: archiveIds,
      archivedByUserId: 'user_123',
    });
  });

  it('surfaces the archive failure reason for ops admins instead of silently succeeding', async () => {
    (isOpsAdminUser as jest.Mock).mockReturnValue(true);
    (archiveOpsEvents as jest.Mock).mockResolvedValue({ archivedCount: 0, error: 'rls denied' });

    const req = makeJsonRequest('http://localhost/api/ops/events', { ids: archiveIds }, { method: "PATCH" });

    const res = await PATCH(req);
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.error).toContain('rls denied');
  });

  it('rejects bulk delete requests from non-admin users', async () => {
    const req = new NextRequest('http://localhost/api/ops/events', {
      method: 'DELETE',
      body: JSON.stringify({
        ids: [archiveIds[0]],
      }),
    });

    const res = await DELETE(req);

    expect(res.status).toBe(403);
    expect(deleteOpsEvents).not.toHaveBeenCalled();
  });

  it('hard-deletes the requested incidents for ops admins', async () => {
    (isOpsAdminUser as jest.Mock).mockReturnValue(true);

    const req = new NextRequest('http://localhost/api/ops/events', {
      method: 'DELETE',
      body: JSON.stringify({
        ids: archiveIds,
      }),
    });

    const res = await DELETE(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(deleteOpsEvents).toHaveBeenCalledWith({ ids: archiveIds });
  });

  it('surfaces the delete failure reason instead of silently succeeding', async () => {
    (isOpsAdminUser as jest.Mock).mockReturnValue(true);
    (deleteOpsEvents as jest.Mock).mockResolvedValue({ deletedCount: 0, error: 'fk constraint' });

    const req = new NextRequest('http://localhost/api/ops/events', {
      method: 'DELETE',
      body: JSON.stringify({ ids: archiveIds }),
    });

    const res = await DELETE(req);
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.error).toContain('fk constraint');
  });

  it('rejects malformed delete bodies', async () => {
    (isOpsAdminUser as jest.Mock).mockReturnValue(true);

    const req = new NextRequest('http://localhost/api/ops/events', {
      method: 'DELETE',
      body: JSON.stringify({ ids: ['not-a-uuid'] }),
    });

    const res = await DELETE(req);

    expect(res.status).toBe(400);
    expect(deleteOpsEvents).not.toHaveBeenCalled();
  });
});
