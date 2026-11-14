/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react";

import { useAgentsDeployedPolling } from "../useAgentsDeployedPolling";

const fetchMock = jest.fn();

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.useFakeTimers();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

function answer(total: number) {
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ total, last24h: 0, last7d: 0 }) } as Response);
}

describe("useAgentsDeployedPolling", () => {
  it("bumps when the total grows, clears the bump after its duration, and clears its timer on unmount", async () => {
    answer(5);
    const { result, unmount } = renderHook(() =>
      useAgentsDeployedPolling({ pollMs: 60_000, bumpDurationMs: 1200 }),
    );
    await waitFor(() => expect(result.current.stats?.total).toBe(5));
    expect(result.current.bumped).toBe(false);

    answer(6);
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    await waitFor(() => expect(result.current.stats?.total).toBe(6));
    expect(result.current.bumped).toBe(true);

    await act(async () => {
      jest.advanceTimersByTime(1200);
    });
    expect(result.current.bumped).toBe(false);

    answer(7);
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    await waitFor(() => expect(result.current.bumped).toBe(true));

    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("does not bump on the first answer or when the total stays the same", async () => {
    answer(5);
    const { result } = renderHook(() => useAgentsDeployedPolling({ pollMs: 60_000 }));
    await waitFor(() => expect(result.current.stats?.total).toBe(5));

    answer(5);
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.bumped).toBe(false);
  });
});
