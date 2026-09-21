/** @jest-environment jsdom */
import { act, renderHook, waitFor } from '@testing-library/react';
import { useDashboardResources } from '../useDashboardResources';
import { isHivraEnabled } from '@/lib/hivra/hivra-flag';

jest.mock('@/lib/hivra/hivra-flag', () => ({ isHivraEnabled: jest.fn(() => true) }));

const originalFetch = global.fetch;
const response = (data: unknown) => ({ ok: true, json: async () => ({ success: true, data }) }) as Response;
const hermes = [{ id: 'writer', name: 'Writer', status: 'running' }];
const hivra = { agents: [{ id: 'desktop', name: 'Desktop', type: 'linux-desktop', status: 'stopped' }] };

afterAll(() => { global.fetch = originalFetch; });
beforeEach(() => { (isHivraEnabled as jest.Mock).mockReturnValue(true); });

describe('useDashboardResources', () => {
  it('does not fetch a disabled Hivra source or report it as a failure', async () => {
    (isHivraEnabled as jest.Mock).mockReturnValue(false);
    global.fetch = jest.fn().mockResolvedValue(response(hermes));
    const { result } = renderHook(() => useDashboardResources('one'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith('/api/instances?summary=true', expect.objectContaining({ cache: 'no-store' }));
    expect(result.current.resources.map((resource) => resource.uid)).toEqual(['h-writer']);
    expect(result.current.errors).toEqual({ hermes: null, hivra: null });
  });

  it('shows a successful source before the other finishes, then reports partial failure', async () => {
    let rejectHivra!: (reason: Error) => void;
    global.fetch = jest.fn((url) => url === '/api/instances?summary=true' ? Promise.resolve(response(hermes)) : new Promise((_, reject) => { rejectHivra = reject; })) as jest.Mock;
    const { result } = renderHook(() => useDashboardResources('one'));
    await waitFor(() => expect(result.current.resources.map((item) => item.uid)).toEqual(['h-writer']));
    expect(result.current.loading).toBe(true);
    await act(async () => rejectHivra(new Error('Unavailable')));
    expect(result.current.errors.hivra).toMatch(/could not be refreshed/);
    expect(result.current.resources).toHaveLength(1);
    expect(result.current.loading).toBe(false);
    expect((global.fetch as jest.Mock).mock.calls.every(([, options]) => !options.method && options.cache === 'no-store')).toBe(true);
  });

  it('retains last-known data after a failed refresh and clears the error after recovery', async () => {
    const fetchMock = jest.fn((url) => Promise.resolve(response(url === '/api/instances?summary=true' ? hermes : hivra)));
    global.fetch = fetchMock as jest.Mock;
    const { result } = renderHook(() => useDashboardResources('one'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    fetchMock.mockRejectedValue(new Error('Disconnected'));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.errors.hermes).toBeTruthy());
    expect(result.current.resources).toHaveLength(2);
    fetchMock.mockImplementation((url) => Promise.resolve(response(url === '/api/instances?summary=true' ? [] : { agents: [] })));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.errors.hermes).toBeNull());
    expect(result.current.resources).toEqual([]);
  });

  it('clears the previous owner immediately and ignores late responses after switching accounts', async () => {
    const pending: Array<{ resolve: (response: Response) => void; signal: AbortSignal }> = [];
    global.fetch = jest.fn((_url, options) => new Promise((resolve) => pending.push({ resolve, signal: options.signal }))) as jest.Mock;
    const { result, rerender } = renderHook(({ owner }) => useDashboardResources(owner), { initialProps: { owner: 'one' } });
    await act(async () => pending[0].resolve(response(hermes)));
    expect(result.current.resources).toHaveLength(1);
    rerender({ owner: 'two' });
    expect(result.current.resources).toEqual([]);
    expect(pending[1].signal.aborted).toBe(true);
    await act(async () => pending[1].resolve(response(hivra)));
    expect(result.current.resources).toEqual([]);
    await act(async () => {
      pending[2].resolve(response([])); pending[3].resolve(response({ agents: [] }));
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.resources).toEqual([]);
  });
});
