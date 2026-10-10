import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { POST } from "../route";
import { supabaseAdmin } from "@/lib/supabase";
import { isUserConnectedBankrWallet } from "@/lib/billing/bankr-instance-wallets";
import { withdrawForOwner } from "@/lib/billing/bankr-instance-withdraw";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => true }));
jest.mock("@/lib/hivra/bankr-skills-seed", () => ({ bankrSkillsDirForType: () => "/home/bux/.codex/skills" }));
jest.mock("@/lib/billing/bankr-instance-wallets", () => ({ isUserConnectedBankrWallet: jest.fn() }));
jest.mock("@/lib/billing/bankr-instance-withdraw", () => ({ withdrawForOwner: jest.fn() }));
jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: jest.fn(() => ({ success: true })),
  getIP: jest.fn(() => "127.0.0.1"),
}));

describe("POST /api/hivra/agents/[id]/bankr-wallet/withdraw", () => {
  const mockedAuth = auth as jest.MockedFunction<typeof auth>;
  const mockedFrom = supabaseAdmin!.from as jest.Mock;
  const mockedIsUserConnected = isUserConnectedBankrWallet as jest.MockedFunction<typeof isUserConnectedBankrWallet>;
  const mockedWithdraw = withdrawForOwner as jest.MockedFunction<typeof withdrawForOwner>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAuth.mockResolvedValue({ userId: "user_123" } as Awaited<ReturnType<typeof auth>>);
    mockedFrom.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { id: "agent_1", user_id: "user_123", type: "codex" }, error: null }),
    });
  });

  it("refuses to move funds from a user's own connected Bankr account", async () => {
    mockedIsUserConnected.mockResolvedValueOnce(true);

    const response = await POST(
      new NextRequest("http://localhost/api/hivra/agents/agent_1/bankr-wallet/withdraw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRecipient: "0x1111111111111111111111111111111111111111", amount: "1" }),
      }),
      { params: Promise.resolve({ id: "agent_1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/your own Bankr account/i);
    expect(mockedIsUserConnected).toHaveBeenCalledWith({ owner: { hivraAgentId: "agent_1" } });
    expect(mockedWithdraw).not.toHaveBeenCalled();
  });
});
