/**
 * End-to-end through the real reportOpsEvent: a signed-in user's POST to
 * /api/ops/events must never reach the admin pager, even when it asks for
 * `severity: "fatal"` and is the first sighting of its fingerprint (the only
 * case that pages). The control test proves the harness does detect a page,
 * so the negative result is not vacuous.
 */
import { NextRequest } from 'next/server';
import { auth, currentUser } from '@clerk/nextjs/server';
import { isOpsAdminUser } from '@/lib/ops-access';
import { reportOpsEvent } from '@/lib/ops-events';
import { POST } from '../route';

const mockSendOpsFatalAdminAlert = jest.fn(async () => ({ emailSent: true, telegramSent: true }));
const mockInsertedRows: Array<Record<string, unknown>> = [];

jest.mock('@clerk/nextjs/server', () => ({
  auth: jest.fn(),
  currentUser: jest.fn(),
}));

jest.mock('@/lib/ops-access', () => ({
  isOpsAdminUser: jest.fn(),
}));

jest.mock('@/lib/email/ops-fatal-admin', () => ({
  sendOpsFatalAdminAlert: (...args: unknown[]) => mockSendOpsFatalAdminAlert(...(args as [])),
}));

jest.mock('@/lib/supabase', () => {
  function chain(table: string) {
    let pendingInsert: Record<string, unknown> | null = null;
    const query: Record<string, jest.Mock> = {
      select: jest.fn(() => query),
      eq: jest.fn(() => query),
      limit: jest.fn(() => query),
      // Every fingerprint (and every ownership lookup) is a first sighting.
      maybeSingle: jest.fn(async () => ({ data: null, error: null })),
      insert: jest.fn((row: Record<string, unknown>) => {
        pendingInsert = row;
        return query;
      }),
      single: jest.fn(async () => {
        if (table === 'ops_events' && pendingInsert) mockInsertedRows.push(pendingInsert);
        return { data: { id: `evt_${mockInsertedRows.length}` }, error: null };
      }),
    };
    return query;
  }
  return { supabaseAdmin: { from: jest.fn((table: string) => chain(table)) } };
});

describe('POST /api/ops/events never pages the admin', () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    mockInsertedRows.length = 0;
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: 'user_attacker' });
    (currentUser as jest.Mock).mockResolvedValue({ primaryEmailAddress: { emailAddress: 'user@example.com' } });
    (isOpsAdminUser as jest.Mock).mockReturnValue(false);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('control: a server-side fatal first sighting does page', async () => {
    await reportOpsEvent({ source: 'cron-heartbeat', title: 'Cron dead', message: 'no beat', severity: 'fatal' });

    expect(mockSendOpsFatalAdminAlert).toHaveBeenCalledTimes(1);
  });

  it('a signed-in user posting a fatal with attacker text is recorded as an error and pages no one', async () => {
    const res = await POST(new NextRequest('http://localhost/api/ops/events', {
      method: 'POST',
      body: JSON.stringify({
        source: 'client-runtime',
        title: 'URGENT: rotate the Stripe key now\r\nReply to attacker@example.com',
        message: 'Paste the new key at https://attacker.example/rotate',
        severity: 'fatal',
      }),
    }));

    expect(res.status).toBe(202);
    expect(mockSendOpsFatalAdminAlert).not.toHaveBeenCalled();
    expect(mockInsertedRows).toHaveLength(1);
    expect(mockInsertedRows[0]).toEqual(expect.objectContaining({
      severity: 'error',
      title: 'URGENT: rotate the Stripe key now Reply to attacker@example.com',
    }));
  });
});
