/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react";

import { useHermesWorkspaceReadiness } from "../useHermesWorkspaceReady";

const notReady = () => Promise.resolve({ ok: false, json: async () => ({ retryAfterMs: 8_000 }) } as Response);

beforeEach(() => { jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] }); });
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

it("says when it has stopped checking, and checks again on request", async () => {
  const fetchMock = jest.fn(notReady);
  global.fetch = fetchMock as unknown as typeof fetch;
  const { result } = renderHook(() => useHermesWorkspaceReadiness("instance-1"));
  await flush();
  expect(result.current).toMatchObject({ ready: false, checking: true });

  // Past the 12-minute window the hook stops and no longer claims to check.
  for (let i = 0; i < 100 && result.current.checking; i++) {
    await act(async () => { jest.advanceTimersByTime(8_000); });
    await flush();
  }
  expect(result.current).toMatchObject({ ready: false, checking: false });
  const calls = fetchMock.mock.calls.length;
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(fetchMock.mock.calls.length).toBe(calls);

  // "Check again" starts a new bounded round.
  fetchMock.mockImplementation(() => Promise.resolve({ ok: true, json: async () => ({ url: "https://workspace.example.test/login" }) } as Response));
  act(() => { result.current.recheck(); });
  await flush();
  expect(fetchMock.mock.calls.length).toBe(calls + 1);
  expect(result.current).toMatchObject({ ready: true, checking: false });
});
