const mockLogError = jest.fn();
const mockCredential = jest.fn();
const mockMintKey = jest.fn();
const mockSubmitTransfer = jest.fn();
const mockEnsureGas = jest.fn();
const mockUpdateEq = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      update: jest.fn(() => ({ eq: (...args: unknown[]) => mockUpdateEq(...args) })),
    })),
  },
}));

jest.mock("@/lib/logger", () => ({
  log: {
    error: (...args: unknown[]) => mockLogError(...args),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock("../bankr-deposit-wallets", () => ({
  getBankrDepositWalletCredentialForUser: (...args: unknown[]) => mockCredential(...args),
}));

jest.mock("../bankr-withdraw", () => ({
  mintScopedTransferApiKey: (...args: unknown[]) => mockMintKey(...args),
  submitBankrTransfer: (...args: unknown[]) => mockSubmitTransfer(...args),
}));

jest.mock("../treasury-gas", () => ({
  ensureWalletHasGas: (...args: unknown[]) => mockEnsureGas(...args),
}));

jest.mock("../bankr-wallets", () => ({
  getBankrPartnerConfig: () => ({ partnerKey: "pk_test" }),
}));

import { sweepCreditDepositReceipt } from "../credit-deposit-sweep";
import { USDC_BASE_TOKEN_ADDRESS } from "../crypto-topups";

function uint256(value: bigint | number) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

describe("sweepCreditDepositReceipt", () => {
  const env = {
    HERMES_TREASURY_ADDRESS: `0x${"a".repeat(40)}`,
    HERMES_BASE_RPC_URL: "https://base.example.test",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCredential.mockResolvedValue({
      bankrWalletId: "wlt_1",
      evmAddress: `0x${"b".repeat(40)}`,
    });
    mockEnsureGas.mockResolvedValue(undefined);
    mockMintKey.mockResolvedValue("scoped_key");
    mockSubmitTransfer.mockResolvedValue("0xsweeptx");
  });

  it("surfaces (does not swallow) a failed 'swept' write after the transfer succeeded", async () => {
    // The on-chain sweep happens, but recording it fails. Previously the error
    // was discarded, leaving the receipt selectable so the next run would
    // re-attempt the (already-done) sweep.
    mockUpdateEq.mockResolvedValue({ error: { message: "mark boom" } });
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: uint256(10_000_000_000n) }),
    }));

    const result = await sweepCreditDepositReceipt(
      {
        id: "rcpt_1",
        user_id: "user_1",
        amount_minor: 5_000_000,
        normalized_deposit_address: `0x${"c".repeat(40)}`,
        token_address: USDC_BASE_TOKEN_ADDRESS,
      },
      { now: new Date("2026-06-23T00:00:00.000Z"), fetchImpl: fetchImpl as never, env }
    );

    // Transfer succeeded → still reported as swept.
    expect(result.outcome).toBe("swept");
    expect(result.txHash).toBe("0xsweeptx");
    // The failed mark-swept write is logged with the tx hash for reconciliation.
    expect(mockLogError).toHaveBeenCalledWith(
      "credit-deposit sweep transfer succeeded but marking the receipt swept failed",
      expect.objectContaining({ message: "mark boom" }),
      expect.objectContaining({
        failureType: "credit_deposit_sweep_mark_swept_failed",
        receiptId: "rcpt_1",
        sweepTxHash: "0xsweeptx",
      })
    );
  });

  it("does not log a mark-swept error on the happy path", async () => {
    mockUpdateEq.mockResolvedValue({ error: null });
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: "2.0", id: 1, result: uint256(10_000_000_000n) }),
    }));

    const result = await sweepCreditDepositReceipt(
      {
        id: "rcpt_2",
        user_id: "user_1",
        amount_minor: 5_000_000,
        normalized_deposit_address: `0x${"c".repeat(40)}`,
        token_address: USDC_BASE_TOKEN_ADDRESS,
      },
      { now: new Date("2026-06-23T00:00:00.000Z"), fetchImpl: fetchImpl as never, env }
    );

    expect(result.outcome).toBe("swept");
    expect(mockLogError).not.toHaveBeenCalled();
  });
});
