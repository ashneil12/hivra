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
