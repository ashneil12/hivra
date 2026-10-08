/**
 * Changing an agent wallet's withdrawal destination (Hermes lane) needs a
 * fresh sign-in check (Clerk reverification) before anything is written.
 */
import { auth } from "@clerk/nextjs/server";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
  reverificationErrorResponse: jest.requireActual("@clerk/nextjs/server").reverificationErrorResponse,
}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/billing/bankr-instance-wallets", () => ({
  instanceBankrWalletPublicSummary: jest.fn(() => ({ withdrawalDestinationEvm: "0x2222222222222222222222222222222222222222" })),
  listWithdrawalRecipientsForInstance: jest.fn(async () => []),
  setWithdrawalDestination: jest.fn(async () => ({ id: "wallet_1" })),
}));

import { PUT } from "../route";
import { supabaseAdmin } from "@/lib/supabase";
import { setWithdrawalDestination } from "@/lib/billing/bankr-instance-wallets";

const DESTINATION = "0x2222222222222222222222222222222222222222";

function put() {
  return new Request("http://localhost/api/instances/inst_1/bankr-wallet/withdraw-destination", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ destination: DESTINATION }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (supabaseAdmin!.from as jest.Mock).mockReturnValue({
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: { id: "inst_1" }, error: null }),
  });
});

it("asks for reverification and writes nothing when the sign-in is not fresh", async () => {
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_1", has: () => false });

  const response = await PUT(put(), { params: Promise.resolve({ id: "inst_1" }) });

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ clerk_error: { reason: "reverification-error" } });
  expect(setWithdrawalDestination).not.toHaveBeenCalled();
});

it("saves the destination after a fresh sign-in check", async () => {
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_1", has: () => true });

  const response = await PUT(put(), { params: Promise.resolve({ id: "inst_1" }) });

  expect(response.status).toBe(200);
  expect(setWithdrawalDestination).toHaveBeenCalledWith({
    instanceId: "inst_1",
    userId: "user_1",
    destinationEvm: DESTINATION,
  });
});
