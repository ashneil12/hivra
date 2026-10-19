/**
 * The HIVRA asset selector at the withdraw route. While $HIVRA is dormant the
 * body schema is the original HERMESOS | ETH one, so { asset: "HIVRA" } fails
 * validation and nothing is withdrawn. Once live it reaches the $HIVRA
 * withdraw; HERMESOS and ETH still reach their own.
 */
import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { POST } from "../route";
import { supabaseAdmin } from "@/lib/supabase";
import {
  withdrawBaseEthForInstance,
  withdrawHermesTokensForInstance,
  withdrawHivraTokensForInstance,
} from "@/lib/billing/bankr-instance-withdraw";
import { isUserConnectedBankrWallet } from "@/lib/billing/bankr-instance-wallets";

const mockLaunch = { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" };
// A getter: the route module (and the registry) load before this const is set.
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  get HIVRA_TOKEN_LAUNCH() {
    return mockLaunch;
  },
}));

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));
jest.mock("@/lib/billing/bankr-instance-withdraw", () => ({
  withdrawBaseEthForInstance: jest.fn(),
  withdrawBaseTokenForInstance: jest.fn(),
  withdrawHermesTokensForInstance: jest.fn(),
  withdrawHivraTokensForInstance: jest.fn(),
}));
jest.mock("@/lib/billing/bankr-instance-wallets", () => ({ isUserConnectedBankrWallet: jest.fn() }));
jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: jest.fn(() => ({ success: true })),
  getIP: jest.fn(() => "127.0.0.1"),
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const DESTINATION = "0x1111111111111111111111111111111111111111";
const submitted = {
  status: "submitted" as const,
  txHash: "0xhivra",
  amountRaw: "2000000000000000000",
  amountDisplay: "2",
  recipientAddress: DESTINATION,
  wallet: null,
};

function makeReq(body: unknown) {
  return new NextRequest("http://localhost/api/instances/inst_123/bankr-wallet/withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ctx = { params: Promise.resolve({ id: "inst_123" }) };

describe("POST /api/instances/[id]/bankr-wallet/withdraw with asset HIVRA", () => {
  const mockedHivra = withdrawHivraTokensForInstance as jest.Mock;
  const mockedHermes = withdrawHermesTokensForInstance as jest.Mock;
  const mockedEth = withdrawBaseEthForInstance as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockLaunch.contractAddress = "";
    mockLaunch.poolId = "";
    mockLaunch.activatesAt = "";
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    (supabaseAdmin!.from as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { id: "inst_123" }, error: null }),
    });
    (isUserConnectedBankrWallet as jest.Mock).mockResolvedValue(false);
    mockedHivra.mockResolvedValue(submitted);
    mockedHermes.mockResolvedValue(submitted);
    mockedEth.mockResolvedValue(submitted);
  });

  it("rejects HIVRA as a validation error while $HIVRA is dormant", async () => {
    const response = await POST(makeReq({ amount: "2", asset: "HIVRA" }), ctx);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Validation failed");
    expect(mockedHivra).not.toHaveBeenCalled();
    expect(mockedHermes).not.toHaveBeenCalled();
  });

  it("routes HIVRA to the $HIVRA withdraw once $HIVRA is live", async () => {
    mockLaunch.contractAddress = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    mockLaunch.poolId = `0x${"cd".repeat(32)}`;
    mockLaunch.activatesAt = "2026-01-01T00:00:00Z";

    const response = await POST(makeReq({ amount: "2", asset: "HIVRA", expectedRecipient: DESTINATION }), ctx);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({ status: "submitted", asset: "HIVRA", amountDisplay: "2" });
    expect(mockedHivra).toHaveBeenCalledWith({
      instanceId: "inst_123",
      userId: "user_123",
      expectedRecipient: DESTINATION,
      amountDisplay: "2",
    });
    expect(mockedHermes).not.toHaveBeenCalled();
    expect(mockedEth).not.toHaveBeenCalled();
  });

  it("names $HIVRA in the no-balance message once live", async () => {
    mockLaunch.contractAddress = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
    mockLaunch.poolId = `0x${"cd".repeat(32)}`;
    mockLaunch.activatesAt = "2026-01-01T00:00:00Z";
    mockedHivra.mockResolvedValueOnce({ status: "no_balance" });

    const response = await POST(makeReq({ amount: "2", asset: "HIVRA" }), ctx);

    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe("No $HIVRA balance to withdraw from this agent wallet.");
  });

  it.each([
    ["dormant", false],
    ["live", true],
  ])("still routes HERMESOS and ETH to their own withdraws while $HIVRA is %s", async (_label, live) => {
    if (live) {
      mockLaunch.contractAddress = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
      mockLaunch.poolId = `0x${"cd".repeat(32)}`;
      mockLaunch.activatesAt = "2026-01-01T00:00:00Z";
    }
    expect((await POST(makeReq({ amount: "2" }), ctx)).status).toBe(200);
    expect((await POST(makeReq({ amount: "0.5", asset: "ETH" }), ctx)).status).toBe(200);
    expect(mockedHermes).toHaveBeenCalledTimes(1);
    expect(mockedEth).toHaveBeenCalledTimes(1);
    expect(mockedHivra).not.toHaveBeenCalled();
  });
});
