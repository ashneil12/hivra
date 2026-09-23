/** @jest-environment jsdom */
/**
 * After $HIVRA activation the payment label follows the server's answer for
 * this user (a grandfathered user keeps $HermesOS). While dormant, nothing is
 * requested and the label is $HermesOS.
 */
import { renderHook, waitFor } from "@testing-library/react";

const mockLaunch = { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" };
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  get HIVRA_TOKEN_LAUNCH() {
    return mockLaunch;
  },
}));

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
