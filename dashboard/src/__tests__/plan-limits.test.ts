import { PATCH } from '../app/api/instances/[id]/resize/route';
import { supabaseAdmin } from '@/lib/supabase';
import { auth } from '@clerk/nextjs/server';
import { makeJsonRequest } from "@/test-utils/request";

jest.mock('@clerk/nextjs/server', () => ({
  auth: jest.fn(),
}));

jest.mock('@/lib/crypto', () => ({
  decryptApiKey: () => 'decrypted',
}));

jest.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

function createMockRequest(body: unknown) {
  return makeJsonRequest('http://localhost:3000/api', body, { method: "PATCH" });
}

interface MockChain {
  select: jest.Mock;
  eq: jest.Mock;
  neq: jest.Mock;
  not: jest.Mock;
  update: jest.Mock;
  single: jest.Mock;
  maybeSingle: jest.Mock;
  then: (resolve: (value: unknown) => void) => void;
}

function mockSupabaseChain(instanceData: unknown, subData: unknown, hostData: unknown, siblingsData: unknown) {
  // We need to mock .select().eq().eq().single() and .maybeSingle() chains.
  const createChain = (dataToReturn: unknown): MockChain => {
    const chain: MockChain = {
      select: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      neq: jest.fn(() => chain),
      not: jest.fn(() => chain),
      update: jest.fn(() => chain),
      single: jest.fn(async () => ({ data: dataToReturn, error: null })),
      maybeSingle: jest.fn(async () => ({ data: dataToReturn, error: null })),
      then: (resolve: (value: unknown) => void) => resolve({ data: dataToReturn, error: null }),
    };
    return chain;
  };

  const fromMock = jest.fn((table: string) => {
    if (table === 'hermes_instances') {
      const chain: MockChain = {
        select: jest.fn(() => chain),
        eq: jest.fn(() => chain),
        neq: jest.fn((col) => {
          if (col === 'id') {
            const siblingChain = createChain(siblingsData);
            siblingChain.then = (resolve: (value: unknown) => void) => resolve({ data: siblingsData, error: null });
            return siblingChain;
          }
          return chain;
        }),
        not: jest.fn(() => chain),
        update: jest.fn(() => chain),
        single: jest.fn(async () => ({ data: instanceData, error: null })),
        maybeSingle: jest.fn(async () => ({ data: instanceData, error: null })),
        then: (resolve: (value: unknown) => void) => resolve({ data: instanceData, error: null })
      };
      return chain;
    }
    if (table === 'hermes_subscriptions') {
      return createChain(subData);
    }
    if (table === 'hermes_hosts') {
      return createChain(hostData);
    }
    return createChain(null);
  });

  (supabaseAdmin!.from as jest.Mock) = fromMock;
}

describe('PATCH /api/instances/[id]/resize API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Note: this route was redesigned. It no longer takes {cpuLimit, ramLimit}
  // from the body — those decisions live in the tier-change-service, driven
  // by Stripe webhook (subscription.created/updated) or the token snapshot
  // cron. PATCH /resize re-applies the instance's current resource_tier
  // specs to the live VM. See dashboard/src/lib/services/tier-change-service.ts.
  //
  // Plan-budget validation moved out of this route; it lives in the
  // upgrade-flow UI (ChangePlanModal → /api/billing/change-plan) where
  // it actually matters — at the moment a user tries to upgrade, not at
  // every cap re-application.

  it('returns 401 when caller is not authenticated', async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
    const req = createMockRequest({});
    const res = await PATCH(req, { params: Promise.resolve({ id: 'inst-1' }) });
    expect(res.status).toBe(401);
  });

  it('returns 501 for non-Proxmox (Hetzner) instances — live resize not yet supported', async () => {
    // Regression: Hetzner live resize requires container recreate which
    // drops in-flight chats. MVP returns 501 so callers know to defer to
    // re-provisioning. Removing this guard would let warden's tier change
    // try to qm set a Hetzner-tracked instance and fail in confusing ways.
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: 'user-1' });
    mockSupabaseChain(
      {
        id: 'inst-htz',
        user_id: 'user-1',
        resource_tier: 'operator',
        config: null,
        hetzner_server_id: 12345,
        status: 'running',
      },
      null, null, []
    );
    const req = createMockRequest({});
    const res = await PATCH(req, { params: Promise.resolve({ id: 'inst-htz' }) });
    const json = await res.json();
    expect(res.status).toBe(501);
    expect(json.error).toMatch(/Proxmox/i);
  });

  it('returns 404 when the instance is not found or owned by another user', async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: 'user-1' });
    // mockSupabaseChain returns the data for any query; we have to return
    // null to simulate the not-found case.
    const fromMock = jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      neq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: { code: "PGRST116" } }),
    }));
    (supabaseAdmin!.from as jest.Mock) = fromMock;
    const req = createMockRequest({});
    const res = await PATCH(req, { params: Promise.resolve({ id: 'inst-not-mine' }) });
    expect(res.status).toBe(404);
  });
});
