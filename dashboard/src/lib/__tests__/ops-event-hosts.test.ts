import { extractOpsEventHostIp, resolveOpsEventHostIpMap } from '../ops-event-hosts';
import { supabaseAdmin } from '@/lib/supabase';

jest.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    from: jest.fn(),
  },
}));

describe('ops-event-hosts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('extracts a host ip from supported metadata fields', () => {
    expect(extractOpsEventHostIp({ hostIp: '203.0.113.10' })).toBe('203.0.113.10');
    expect(extractOpsEventHostIp({ details: { instanceIpv4: '198.51.100.7' } })).toBe('198.51.100.7');
    expect(extractOpsEventHostIp({ ip: 'not-an-ip' })).toBeNull();
  });

  it('resolves host ips from instance and host records', async () => {
    const instanceIn = jest.fn().mockReturnThis();
    const hostIn = jest.fn().mockReturnThis();

    (supabaseAdmin!.from as jest.Mock)
      .mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        in: instanceIn.mockResolvedValue({
          data: [
            { id: 'inst-direct', host_id: null, ipv4_address: '203.0.113.10' },
            { id: 'inst-hosted', host_id: 'host-123', ipv4_address: null },
          ],
          error: null,
        }),
      })
      .mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        in: hostIn.mockResolvedValue({
          data: [
            { id: 'host-123', ipv4_address: '198.51.100.7' },
          ],
          error: null,
        }),
      });

    const resolved = await resolveOpsEventHostIpMap(['inst-direct', 'inst-hosted']);

    expect(instanceIn).toHaveBeenCalledWith('id', ['inst-direct', 'inst-hosted']);
    expect(hostIn).toHaveBeenCalledWith('id', ['host-123']);
    expect(resolved.get('inst-direct')).toBe('203.0.113.10');
    expect(resolved.get('inst-hosted')).toBe('198.51.100.7');
  });

  it('looks up a large instance list a few hundred ids per request', async () => {
    const instanceIn = jest.fn().mockResolvedValue({ data: [], error: null });
    (supabaseAdmin!.from as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnThis(),
      in: instanceIn,
    });
    const ids = Array.from({ length: 450 }, (_, index) => `inst-${index}`);

    await resolveOpsEventHostIpMap(ids);

    expect(instanceIn.mock.calls.map(([, chunk]) => (chunk as string[]).length)).toEqual([200, 200, 50]);
  });
});
