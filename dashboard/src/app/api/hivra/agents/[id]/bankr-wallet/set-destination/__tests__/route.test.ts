/**
 * Changing an agent wallet's withdrawal destination (Hivra lane) needs a
 * fresh sign-in check (Clerk reverification) before anything is written.
 */
import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
  reverificationErrorResponse: jest.requireActual("@clerk/nextjs/server").reverificationErrorResponse,
}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/hivra/hivra-flag", () => ({ isHivraApiAllowed: () => true }));
jest.mock("@/lib/hivra/bankr-skills-seed", () => ({ bankrSkillsDirForType: () => "/home/bux/.codex/skills" }));
jest.mock("@/lib/billing/bankr-instance-wallets", () => ({
  instanceBankrWalletPublicSummary: jest.fn(() => ({ withdrawalDestinationEvm: "0x2222222222222222222222222222222222222222" })),
  setWithdrawalDestinationForOwner: jest.fn(async () => ({ id: "wallet_1" })),
}));

import { POST } from "../route";
import { supabaseAdmin } from "@/lib/supabase";
import { setWithdrawalDestinationForOwner } from "@/lib/billing/bankr-instance-wallets";

const DESTINATION = "0x2222222222222222222222222222222222222222";

function post() {
  return new NextRequest("http://localhost/api/hivra/agents/agent_1/bankr-wallet/set-destination", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ evmAddress: DESTINATION }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (supabaseAdmin!.from as jest.Mock).mockReturnValue({
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: { id: "agent_1", user_id: "user_1", type: "codex" }, error: null }),
  });
});

it("asks for reverification and writes nothing when the sign-in is not fresh", async () => {
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_1", has: () => false });

  const response = await POST(post(), { params: Promise.resolve({ id: "agent_1" }) });

  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ clerk_error: { reason: "reverification-error" } });
  expect(setWithdrawalDestinationForOwner).not.toHaveBeenCalled();
});

it("saves the destination after a fresh sign-in check", async () => {
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_1", has: () => true });

  const response = await POST(post(), { params: Promise.resolve({ id: "agent_1" }) });

  expect(response.status).toBe(200);
  expect(setWithdrawalDestinationForOwner).toHaveBeenCalledWith({
    owner: { hivraAgentId: "agent_1" },
    userId: "user_1",
    destinationEvm: DESTINATION,
  });
});
