/**
 * Agent-wallet withdrawals go only to the wallet's saved withdrawal
 * destination, and only once that destination has been saved for the cooldown
 * (WITHDRAW_DESTINATION_COOLDOWN_MS).
 *
 * Before this rule, a signed-in session could send any Base token to any
 * address it typed, and could save a new destination and withdraw to it in
 * the same minute. Someone who took over an account could empty every agent
 * wallet at once.
 */
const mockGetWalletForOwner = jest.fn();
const mockGetWalletForInstance = jest.fn();
const mockDecryptApiKey = jest.fn();
const mockSummary = jest.fn();
const mockSetDestinationForOwner = jest.fn();
const mockUpsertWithdrawalRecipient = jest.fn();
const mockFetchHermesBalance = jest.fn();
const mockFetchTokenBalance = jest.fn();
const mockSubmitTransfer = jest.fn();

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

jest.mock("@/lib/billing/bankr-instance-wallets", () => ({
  decryptInstanceBankrApiKey: (...args: unknown[]) => mockDecryptApiKey(...args),
  getBankrWalletForOwner: (...args: unknown[]) => mockGetWalletForOwner(...args),
  getBankrWalletForInstance: (...args: unknown[]) => mockGetWalletForInstance(...args),
  instanceBankrWalletPublicSummary: (...args: unknown[]) => mockSummary(...args),
  setWithdrawalDestinationForOwner: (...args: unknown[]) => mockSetDestinationForOwner(...args),
  upsertWithdrawalRecipient: (...args: unknown[]) => mockUpsertWithdrawalRecipient(...args),
}));

jest.mock("@/lib/billing/token-holdings", () => ({
  ...jest.requireActual("@/lib/billing/token-holdings"),
  fetchHermesTokenBalance: (...args: unknown[]) => mockFetchHermesBalance(...args),
  fetchTokenBalance: (...args: unknown[]) => mockFetchTokenBalance(...args),
}));

jest.mock("@/lib/billing/bankr-withdraw", () => ({
  submitBankrTransfer: (...args: unknown[]) => mockSubmitTransfer(...args),
}));

jest.mock("@/lib/logger", () => ({ log: { warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));

import {
  withdrawBaseTokenForInstance,
  withdrawForOwner,
  withdrawHermesTokensForInstance,
} from "../bankr-instance-withdraw";

const HOUR = 60 * 60 * 1000;
const SAVED = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const USDC = { symbol: "USDC", tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6 };

function claimDb() {
  const single = jest.fn(async () => ({ data: { id: "claim_1" }, error: null }));
  const insert = jest.fn(() => ({ select: () => ({ single }) }));
  const update = jest.fn(() => ({ eq: async () => ({ error: null }) }));
  return { db: { from: jest.fn(() => ({ insert, update })) } as never, insert };
}

function wallet(overrides: Record<string, unknown> = {}) {
  return {
    id: "row_1",
    instanceId: "inst_1",
    hivraAgentId: null,
    userId: "user_1",
    bankrWalletId: "wlt_1",
    evmAddress: "0x000000000000000000000000000000000000ba5e",
    normalizedEvmAddress: "0x000000000000000000000000000000000000ba5e",
    apiKeyPreview: null,
    apiKeyStatus: "active",
    withdrawalDestinationEvm: SAVED,
    // Saved well before the cooldown: withdrawals to it are allowed.
    withdrawalDestinationSetAt: new Date(Date.now() - 72 * HOUR).toISOString(),
    status: "active",
    metadata: {},
    createdAt: "2026-05-02T00:00:00.000Z",
    updatedAt: "2026-05-02T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetWalletForInstance.mockResolvedValue(wallet());
  mockGetWalletForOwner.mockResolvedValue(wallet({ instanceId: null, hivraAgentId: "agent_1" }));
  mockDecryptApiKey.mockResolvedValue("bk_secret");
  mockSummary.mockReturnValue(null);
  mockFetchHermesBalance.mockResolvedValue({ balanceRaw: "10000000000000000000", balanceDisplay: "10" });
  mockFetchTokenBalance.mockResolvedValue({ balanceRaw: "12500000", balanceDisplay: "12.5" });
  mockSubmitTransfer.mockResolvedValue("0xsent");
  mockUpsertWithdrawalRecipient.mockResolvedValue(null);
  mockSetDestinationForOwner.mockResolvedValue(null);
});

describe("token withdrawals go only to the saved destination", () => {
  it("refuses a recipient that is not the saved destination and sends nothing (Hermes lane)", async () => {
    const { db, insert } = claimDb();
    const result = await withdrawBaseTokenForInstance({
      instanceId: "inst_1",
      userId: "user_1",
      recipientAddress: OTHER,
      amountDisplay: "2.5",
      token: USDC,
      db,
    });

    expect(result.status).toBe("recipient_not_destination");
    expect(insert).not.toHaveBeenCalled();
    expect(mockSubmitTransfer).not.toHaveBeenCalled();
    expect(mockUpsertWithdrawalRecipient).not.toHaveBeenCalled();
  });

  it("refuses a recipient that is not the saved destination and sends nothing (Hivra lane)", async () => {
    const { db } = claimDb();
    const result = await withdrawForOwner({
      owner: { hivraAgentId: "agent_1" },
      userId: "user_1",
      recipientAddress: OTHER,
      amountDisplay: "2.5",
      token: USDC,
      db,
    });

    expect(result.status).toBe("recipient_not_destination");
    expect(mockSubmitTransfer).not.toHaveBeenCalled();
    expect(mockSetDestinationForOwner).not.toHaveBeenCalled();
  });

  it("refuses a token withdrawal when no destination is saved, instead of saving the typed address", async () => {
    mockGetWalletForInstance.mockResolvedValue(wallet({ withdrawalDestinationEvm: null, withdrawalDestinationSetAt: null }));
    const { db } = claimDb();
    const result = await withdrawBaseTokenForInstance({
      instanceId: "inst_1",
      userId: "user_1",
      recipientAddress: OTHER,
      amountDisplay: "2.5",
      token: USDC,
      db,
    });

    expect(result.status).toBe("no_withdrawal_destination");
    expect(mockSubmitTransfer).not.toHaveBeenCalled();
    expect(mockUpsertWithdrawalRecipient).not.toHaveBeenCalled();
  });

  it("sends to the saved destination and never changes the destination from a withdrawal", async () => {
    const { db } = claimDb();
    const result = await withdrawBaseTokenForInstance({
      instanceId: "inst_1",
      userId: "user_1",
      recipientAddress: SAVED,
      amountDisplay: "2.5",
      token: USDC,
      db,
    });

    expect(result).toMatchObject({ status: "submitted", recipientAddress: SAVED });
    expect(mockSubmitTransfer).toHaveBeenCalledWith(expect.objectContaining({ recipientAddress: SAVED }));
    // Recipient history still counts the use, but never flips the primary.
    expect(mockUpsertWithdrawalRecipient).toHaveBeenCalledWith(
      expect.objectContaining({ address: SAVED, setPrimary: false })
    );
  });
});

describe("a newly saved destination is held for the cooldown", () => {
  it("holds a $HERMESOS withdrawal to a destination saved an hour ago and sends nothing", async () => {
    mockGetWalletForInstance.mockResolvedValue(
      wallet({ withdrawalDestinationSetAt: new Date(Date.now() - HOUR).toISOString() })
    );
    const { db, insert } = claimDb();
    const result = await withdrawHermesTokensForInstance({
      instanceId: "inst_1",
      userId: "user_1",
      amountDisplay: "1",
      db,
    });

    expect(result.status).toBe("destination_cooling_down");
    expect(Date.parse((result as { availableAt?: string }).availableAt ?? "")).toBeGreaterThan(Date.now());
    expect(insert).not.toHaveBeenCalled();
    expect(mockSubmitTransfer).not.toHaveBeenCalled();
  });

  it("holds a token withdrawal to a destination saved an hour ago (Hivra lane)", async () => {
    mockGetWalletForOwner.mockResolvedValue(
      wallet({ instanceId: null, hivraAgentId: "agent_1", withdrawalDestinationSetAt: new Date(Date.now() - HOUR).toISOString() })
    );
    const { db } = claimDb();
    const result = await withdrawForOwner({
      owner: { hivraAgentId: "agent_1" },
      userId: "user_1",
      recipientAddress: SAVED,
      amountDisplay: "2.5",
      token: USDC,
      db,
    });

    expect(result.status).toBe("destination_cooling_down");
    expect(mockSubmitTransfer).not.toHaveBeenCalled();
  });

  it("keeps a destination saved before the cooldown working", async () => {
    const { db } = claimDb();
    const result = await withdrawForOwner({
      owner: { hivraAgentId: "agent_1" },
      userId: "user_1",
      amountDisplay: "1",
      asset: "HERMESOS",
      db,
    });

    expect(result.status).toBe("submitted");
    expect(mockSubmitTransfer).toHaveBeenCalledWith(expect.objectContaining({ recipientAddress: SAVED }));
  });

  it("keeps a legacy destination with no recorded save time working", async () => {
    mockGetWalletForInstance.mockResolvedValue(wallet({ withdrawalDestinationSetAt: null }));
    const { db } = claimDb();
    const result = await withdrawHermesTokensForInstance({
      instanceId: "inst_1",
      userId: "user_1",
      amountDisplay: "1",
      db,
    });

    expect(result.status).toBe("submitted");
  });
});
