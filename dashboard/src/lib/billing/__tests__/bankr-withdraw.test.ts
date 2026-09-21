jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: null,
}));

import {
  submitBankrTransfer,
  withdrawAllHermesTokensForUser,
} from "../bankr-withdraw";

describe("withdrawAllHermesTokensForUser", () => {
  it("refuses to withdraw when the service-role client is unconfigured, so the cross-process in-flight lock can never be skipped", async () => {
    // supabaseAdmin is mocked to null for this file (see jest.mock above).
    // The DB `bankr_withdrawals` claim row is the only cross-Node lock, so
    // the function must fail closed rather than mint a Bankr key + transfer.
    const result = await withdrawAllHermesTokensForUser({ userId: "user_x" });

    expect(result.status).toBe("transfer_failed");
    expect(result.errorMessage).toMatch(/database not configured/i);
    expect(result.txHash).toBeUndefined();
  });
});

describe("submitBankrTransfer", () => {
  it("submits native Base transfers without undocumented chain fields", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ txHash: "0xwithdraw" }),
    }));

    const params = {
      apiKey: "bk_agent_secret",
      tokenAddress: "0x0000000000000000000000000000000000000000",
      recipientAddress: "0x1111111111111111111111111111111111111111",
      amountDisplay: "0.01",
      isNativeToken: true,
      chain: "base",
      env: { BANKR_API_BASE_URL: "https://bankr.example.test" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    } as unknown as Parameters<typeof submitBankrTransfer>[0];

    const txHash = await submitBankrTransfer(params);

    expect(txHash).toBe("0xwithdraw");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://bankr.example.test/wallet/transfer",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          tokenAddress: "0x0000000000000000000000000000000000000000",
          recipientAddress: "0x1111111111111111111111111111111111111111",
          amount: "0.01",
          isNativeToken: true,
        }),
      })
    );
  });
});
