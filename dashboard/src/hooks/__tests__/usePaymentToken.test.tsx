/** @jest-environment jsdom */
/**
 * After $HIVRA activation the payment label follows the server's answer for
 * this user (a grandfathered user keeps $HermesOS). While dormant, nothing is
 * requested and the label is $HermesOS.
 */
import { act, renderHook, waitFor } from "@testing-library/react";

const mockLaunch = { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" };
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  get HIVRA_TOKEN_LAUNCH() {
    return mockLaunch;
  },
}));

let mockUserId: string | null = "user_1";
jest.mock("@clerk/nextjs", () => ({ useAuth: () => ({ userId: mockUserId }) }));

import { _resetPaymentTokenForTests, usePaymentTokenUnit } from "../usePaymentToken";

const ACTIVE = {
  contractAddress: "0x3333333333333333333333333333333333333333",
  decimals: 18,
  poolId: `0x${"ab".repeat(32)}`,
  activatesAt: "2026-01-01T00:00:00Z",
};

function answer(paymentToken: string, ok = true) {
  return jest.fn(async () => ({ ok, json: async () => ({ success: true, data: { paymentToken } }) }));
}

beforeEach(() => {
  mockUserId = "user_1";
  _resetPaymentTokenForTests();
  Object.assign(mockLaunch, { contractAddress: "", poolId: "", activatesAt: "" });
});

it("is $HermesOS while $HIVRA is dormant, without a request", () => {
  const fetchMock = answer("hivra");
  global.fetch = fetchMock as never;
  const { result } = renderHook(() => usePaymentTokenUnit());
  expect(result.current).toBe("$HermesOS");
  expect(fetchMock).not.toHaveBeenCalled();
});

it("shows $HermesOS to a grandfathered user once $HIVRA is live", async () => {
  Object.assign(mockLaunch, ACTIVE);
  global.fetch = answer("hermesos") as never;
  const { result } = renderHook(() => usePaymentTokenUnit());
  expect(result.current).toBe("$HIVRA");
  await waitFor(() => expect(result.current).toBe("$HermesOS"));
});

it("keeps $HIVRA for a new user, and when the server cannot answer", async () => {
  Object.assign(mockLaunch, ACTIVE);
  const fetchMock = answer("hivra", false);
  global.fetch = fetchMock as never;
  const { result } = renderHook(() => usePaymentTokenUnit());
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(result.current).toBe("$HIVRA");
});

it("retries after a failed answer instead of keeping it", async () => {
  Object.assign(mockLaunch, ACTIVE);
  const failing = answer("hermesos", false);
  global.fetch = failing as never;
  const first = renderHook(() => usePaymentTokenUnit());
  await waitFor(() => expect(failing).toHaveBeenCalledTimes(1));
  first.unmount();
  const ok = answer("hermesos");
  global.fetch = ok as never;
  const { result } = renderHook(() => usePaymentTokenUnit());
  await waitFor(() => expect(result.current).toBe("$HermesOS"));
});

it("never shares one user's answer with another user", async () => {
  Object.assign(mockLaunch, ACTIVE);
  global.fetch = answer("hermesos") as never;
  const first = renderHook(() => usePaymentTokenUnit());
  await waitFor(() => expect(first.result.current).toBe("$HermesOS"));
  first.unmount();
  mockUserId = "user_2";
  const fetchMock = answer("hivra");
  global.fetch = fetchMock as never;
  const { result } = renderHook(() => usePaymentTokenUnit());
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  expect(result.current).toBe("$HIVRA");
});

it("asks at the activation instant when the page was opened before it", async () => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
  try {
    const activatesAt = new Date(Date.now() + 60_000);
    Object.assign(mockLaunch, { ...ACTIVE, activatesAt: activatesAt.toISOString().slice(0, 19) + "Z" });
    const fetchMock = answer("hermesos");
    global.fetch = fetchMock as never;
    const { result } = renderHook(() => usePaymentTokenUnit());
    expect(result.current).toBe("$HermesOS");
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(62_000);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current).toBe("$HermesOS"));
  } finally {
    jest.useRealTimers();
  }
});
