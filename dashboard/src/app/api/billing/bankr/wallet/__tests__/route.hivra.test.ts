/**
 * GET /api/billing/bankr/wallet and the lock wallet's $HIVRA. While $HIVRA is
 * dormant nothing is read and the response has no tokenLockHivra field. Once
 * live, the lock wallet's live $HIVRA balance is reported, and a lock wallet
 * that holds only $HIVRA still shows so its owner can withdraw it.
 */
import { auth } from "@clerk/nextjs/server";
import { GET } from "../route";
import { getBankrWalletForUser } from "@/lib/billing/bankr-wallets";
import {
  bankrDepositWalletPublicSummary,
  getBankrDepositWalletCredentialForUser,
} from "@/lib/billing/bankr-deposit-wallets";
import {
  fetchTokenBalance,
  getLatestHermesTokenHoldingSnapshotForWallet,
} from "@/lib/billing/token-holdings";

const mockLaunch = { contractAddress: "", decimals: 18, poolId: "", activatesAt: "" };
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  get HIVRA_TOKEN_LAUNCH() {
    return mockLaunch;
  },
}));
jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }));
jest.mock("@/lib/billing/bankr-wallets", () => ({
  ...jest.requireActual("@/lib/billing/bankr-wallets"),
  getBankrWalletForUser: jest.fn(),
}));
jest.mock("@/lib/billing/bankr-deposit-wallets", () => ({
  bankrDepositWalletPublicSummary: jest.fn(),
  ensureBankrDepositWalletForUser: jest.fn(),
  getBankrDepositWalletCredentialForUser: jest.fn(),
}));
jest.mock("@/lib/billing/token-holdings", () => ({
  ...jest.requireActual("@/lib/billing/token-holdings"),
  fetchTokenBalance: jest.fn(),
  getLatestHermesTokenHoldingSnapshotForWallet: jest.fn(),
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const HIVRA_PUBLISHED = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const LOCK_ADDRESS = "0x000000000000000000000000000000000000beef";
const lockCredential = { normalizedEvmAddress: LOCK_ADDRESS, bankrWalletId: "bw_lock" };

function goLive() {
  mockLaunch.contractAddress = HIVRA_PUBLISHED;
  mockLaunch.poolId = `0x${"cd".repeat(32)}`;
  mockLaunch.activatesAt = "2026-01-01T00:00:00Z";
}

async function getData() {
  const response = await GET();
  expect(response.status).toBe(200);
  return (await response.json()).data as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLaunch.contractAddress = "";
  mockLaunch.poolId = "";
  mockLaunch.activatesAt = "";
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_1" });
  (getBankrWalletForUser as jest.Mock).mockResolvedValue(null);
  (getBankrDepositWalletCredentialForUser as jest.Mock).mockImplementation(
    async ({ purpose }: { purpose: string }) => (purpose === "hermesos_lock" ? lockCredential : null)
  );
  (bankrDepositWalletPublicSummary as jest.Mock).mockImplementation((credential: unknown) =>
    credential ? { address: LOCK_ADDRESS } : null
  );
  (getLatestHermesTokenHoldingSnapshotForWallet as jest.Mock).mockResolvedValue({ balanceRaw: "0" });
});

it("reads no $HIVRA and adds no field while $HIVRA is dormant", async () => {
  const data = await getData();
  expect(data).not.toHaveProperty("tokenLockHivra");
  expect(data).not.toHaveProperty("tokenLockHoldsHermes");
  expect(data.tokenLockWallet).toBeNull();
  expect(data.custodyMode).toBe("self_custody");
  expect(fetchTokenBalance).not.toHaveBeenCalled();
});

it("once live, shows a lock wallet that holds only $HIVRA, with its exact balance", async () => {
  goLive();
  (fetchTokenBalance as jest.Mock).mockResolvedValue({
    balanceRaw: "3000000000000000001",
    balanceDisplay: "3.000000000000000001",
  });

  const data = await getData();

  expect(fetchTokenBalance).toHaveBeenCalledWith({
    token: expect.objectContaining({ tokenAddress: HIVRA_PUBLISHED.toLowerCase(), tokenSymbol: "HIVRA" }),
    walletAddress: LOCK_ADDRESS,
  });
  // Not legacy custody: no $HermesOS panels, only the $HIVRA withdraw.
  expect(data.custodyMode).toBe("self_custody");
  expect(data.status).toBe("self_custody_required");
  expect(data.tokenLockHoldsHermes).toBe(false);
  expect(data.tokenLockWallet).toEqual({ address: LOCK_ADDRESS });
  expect(data.tokenLockHivra).toEqual({
    tokenSymbol: "HIVRA",
    tokenAddress: HIVRA_PUBLISHED.toLowerCase(),
    tokenDecimals: 18,
    balanceRaw: "3000000000000000001",
    balanceDisplay: "3.000000000000000001",
  });
});

it("once live, reports no $HIVRA (and no lock wallet) when it holds neither token", async () => {
  goLive();
  (fetchTokenBalance as jest.Mock).mockResolvedValue({ balanceRaw: "0", balanceDisplay: "0" });
  const data = await getData();
  expect(data.tokenLockHivra).toBeNull();
  expect(data.tokenLockWallet).toBeNull();
});

it("still loads the page when the $HIVRA read fails", async () => {
  goLive();
  (getLatestHermesTokenHoldingSnapshotForWallet as jest.Mock).mockResolvedValue({ balanceRaw: "9" });
  (fetchTokenBalance as jest.Mock).mockRejectedValue(new Error("rpc down"));
  const data = await getData();
  expect(data.tokenLockHivra).toBeNull();
  expect(data.custodyMode).toBe("legacy_custody");
  expect(data.tokenLockHoldsHermes).toBe(true);
});

it("once live, a lock wallet holding both tokens stays legacy custody and reports both", async () => {
  goLive();
  (getLatestHermesTokenHoldingSnapshotForWallet as jest.Mock).mockResolvedValue({ balanceRaw: "5" });
  (fetchTokenBalance as jest.Mock).mockResolvedValue({ balanceRaw: "7", balanceDisplay: "0.000000000000000007" });
  const data = await getData();
  expect(data.custodyMode).toBe("legacy_custody");
  expect(data.status).toBe("existing");
  expect(data.tokenLockHoldsHermes).toBe(true);
  expect(data.tokenLockWallet).toEqual({ address: LOCK_ADDRESS });
  expect(data.tokenLockHivra).toEqual(expect.objectContaining({ balanceRaw: "7" }));
});

it("while dormant, a lock wallet holding $HermesOS is legacy custody with no new field", async () => {
  (getLatestHermesTokenHoldingSnapshotForWallet as jest.Mock).mockResolvedValue({ balanceRaw: "5" });
  const data = await getData();
  expect(data.custodyMode).toBe("legacy_custody");
  expect(data.status).toBe("existing");
  expect(data).not.toHaveProperty("tokenLockHoldsHermes");
  expect(fetchTokenBalance).not.toHaveBeenCalled();
});
