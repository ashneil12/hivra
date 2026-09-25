/**
 * Changing where the lock wallet's balance is withdrawn to needs a fresh
 * sign-in check (Clerk reverification), and the address answer carries when a
 * newly saved address can first receive a withdrawal.
 */
import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
  reverificationErrorResponse: jest.requireActual("@clerk/nextjs/server").reverificationErrorResponse,
}));
jest.mock("@/lib/billing/billing-v2-availability", () => ({
  BILLING_V2_UNAVAILABLE_MESSAGE: "unavailable",
  isBillingV2ServerEnabled: () => true,
}));
jest.mock("@/lib/billing/withdraw-address", () => ({
  ...jest.requireActual("@/lib/billing/withdraw-address"),
  getUserWithdrawAddress: jest.fn(),
  setUserWithdrawAddress: jest.fn(),
}));

import { GET, PUT } from "../route";
import { getUserWithdrawAddress, setUserWithdrawAddress } from "@/lib/billing/withdraw-address";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const HOUR = 60 * 60 * 1000;

function put(body: unknown) {
  return new NextRequest("http://localhost/api/billing/bankr/wallet/withdraw-address", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

function record(setAt: string) {
  return {
    userId: "user_1",
    address: ADDRESS,
    normalizedAddress: ADDRESS,
    network: "base" as const,
    acknowledgedResponsibility: true,
    setAt,
    updatedAt: setAt,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

it("asks for reverification and saves nothing when the sign-in is not fresh", async () => {
  const has = jest.fn(() => false);
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_1", has });

  const response = await PUT(put({ address: ADDRESS, acknowledged: true }));

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    clerk_error: { type: "forbidden", reason: "reverification-error" },
  });
  expect(has).toHaveBeenCalledWith({ reverification: "strict" });
  expect(setUserWithdrawAddress).not.toHaveBeenCalled();
});

it("fails closed when the auth object cannot answer a reverification check", async () => {
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_1" });

  const response = await PUT(put({ address: ADDRESS, acknowledged: true }));

  expect(response.status).toBe(403);
  expect(setUserWithdrawAddress).not.toHaveBeenCalled();
});

it("saves after a fresh sign-in check and says when the address can receive a withdrawal", async () => {
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_1", has: () => true });
  const savedAt = new Date().toISOString();
  (setUserWithdrawAddress as jest.Mock).mockResolvedValue({ status: "saved", changed: true, record: record(savedAt) });

  const response = await PUT(put({ address: ADDRESS, acknowledged: true }));
  const body = await response.json();

  expect(response.status).toBe(200);
  expect(body.data).toMatchObject({ status: "saved", address: ADDRESS });
  expect(Date.parse(body.data.availableAt)).toBe(Date.parse(savedAt) + 24 * HOUR);
});

it("reports a hold on a recently saved address and none on an older one", async () => {
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_1", has: () => true });

  (getUserWithdrawAddress as jest.Mock).mockResolvedValueOnce(record(new Date(Date.now() - HOUR).toISOString()));
  const recent = await (await GET()).json();
  expect(Date.parse(recent.data.availableAt)).toBeGreaterThan(Date.now());

  (getUserWithdrawAddress as jest.Mock).mockResolvedValueOnce(record(new Date(Date.now() - 48 * HOUR).toISOString()));
  const settled = await (await GET()).json();
  expect(settled.data.availableAt).toBeNull();
});
