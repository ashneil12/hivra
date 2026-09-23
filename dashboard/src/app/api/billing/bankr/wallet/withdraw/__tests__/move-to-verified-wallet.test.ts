/**
 * "Move to my own wallet": a legacy lock-wallet holder moves their tokens to
 * their signature-verified primary wallet. Unlike a withdraw (an exit), this
 * must not start the breach clock: eligibility is evaluated only on the
 * verified wallet's balance after the transfer is mined, never on the empty
 * lock wallet.
 */
import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/billing/billing-v2-availability", () => ({
  BILLING_V2_UNAVAILABLE_MESSAGE: "unavailable",
  isBillingV2ServerEnabled: () => true,
}));
jest.mock("@/lib/rate-limit", () => ({ enforceRateLimit: () => ({ success: true }) }));
jest.mock("@/lib/billing/bankr-withdraw", () => ({
  withdrawAllHermesTokensForUser: jest.fn(),
  waitForTransferReceipt: jest.fn(),
  getSelfCustodyPrimaryWallet: jest.fn(),
}));
jest.mock("@/lib/billing/token-tier-eligibility", () => ({
  evaluateAndRecordTokenTierEligibility: jest.fn(async () => ({ configured: true, warnings: [], pro: null, power: null })),
  holdTierBreachesUntil: jest.fn(async () => undefined),
  clearTierBreachHold: jest.fn(async () => undefined),
}));
jest.mock("@/lib/billing/token-holdings", () => ({
  fetchHermesTokenBalance: jest.fn(),
  getHermesLockWallet: jest.fn(),
  refreshPrimaryHermesTokenHolding: jest.fn(),
  refreshPrimaryVerifiedTokenHoldings: jest.fn(),
}));

import { POST } from "../route";
import {
  getSelfCustodyPrimaryWallet,
  waitForTransferReceipt,
  withdrawAllHermesTokensForUser,
} from "@/lib/billing/bankr-withdraw";
import {
  clearTierBreachHold,
  evaluateAndRecordTokenTierEligibility,
  holdTierBreachesUntil,
} from "@/lib/billing/token-tier-eligibility";
import {
  getHermesLockWallet,
  refreshPrimaryHermesTokenHolding,
  refreshPrimaryVerifiedTokenHoldings,
} from "@/lib/billing/token-holdings";

const LOCK = { id: "lock", address: "0x00000000000000000000000000000000000010c4", normalizedAddress: "0x00000000000000000000000000000000000010c4" };
const OWN = { id: "own", address: "0x0000000000000000000000000000000000000abc", normalizedAddress: "0x0000000000000000000000000000000000000abc" };
const HELD = 5_000_000n * 10n ** 18n;

function post(body: unknown) {
  return new NextRequest("http://localhost/api/billing/bankr/wallet/withdraw", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_1" });
  (withdrawAllHermesTokensForUser as jest.Mock).mockImplementation(async (params) => {
    await params.beforeTransfer?.(HELD);
    return {
    status: "submitted",
    txHash: "0xmove",
    amountRaw: HELD.toString(),
    amountDisplay: "5000000",
    recipientAddress: OWN.normalizedAddress,
    };
  });
  (getHermesLockWallet as jest.Mock).mockResolvedValue(LOCK);
  (getSelfCustodyPrimaryWallet as jest.Mock).mockResolvedValue(OWN);
  (refreshPrimaryVerifiedTokenHoldings as jest.Mock).mockImplementation(async ({ wallet }) => ({
    status: "refreshed",
    snapshot: { balanceRaw: wallet.id === "own" ? HELD.toString() : "0" },
    snapshots: [],
    balances: { hermesos: wallet.id === "own" ? HELD : 0n },
  }));
});

it("moves to the verified wallet and evaluates only its balance once mined", async () => {
  (waitForTransferReceipt as jest.Mock).mockResolvedValue("mined");
  const response = await POST(post({ destination: "verified_wallet" }));
  expect(response.status).toBe(200);
  expect(withdrawAllHermesTokensForUser).toHaveBeenCalledWith(
    expect.objectContaining({ userId: "user_1", destination: "verified_wallet" })
  );
  // Both wallets' real balances are recorded: the lock wallet's first.
  expect((refreshPrimaryVerifiedTokenHoldings as jest.Mock).mock.calls.map((call) => call[0].wallet.id)).toEqual(["lock", "own"]);
  // Eligibility sees the tokens where they now are: no breach.
  expect(evaluateAndRecordTokenTierEligibility).toHaveBeenCalledTimes(1);
  expect(evaluateAndRecordTokenTierEligibility).toHaveBeenCalledWith({ userId: "user_1", balances: { hermesos: HELD } });
  // The exit path's lock-wallet re-evaluation never runs.
  expect(refreshPrimaryHermesTokenHolding).not.toHaveBeenCalled();
  // The hold lapses on its own: a lagging reader may still see neither wallet.
  expect(clearTierBreachHold).not.toHaveBeenCalled();
});

it("holds new breaches for the moved amount while the move is in flight, and evaluates nothing until it is mined", async () => {
  (waitForTransferReceipt as jest.Mock).mockResolvedValue("pending");
  const body = await (await POST(post({ destination: "verified_wallet" }))).json();
  expect(holdTierBreachesUntil).toHaveBeenCalledWith(
    expect.objectContaining({ userId: "user_1", movingRaw: HELD, reason: "lock_wallet_move_to_verified_wallet" })
  );
  expect(clearTierBreachHold).not.toHaveBeenCalled();
  const until = (holdTierBreachesUntil as jest.Mock).mock.calls[0][0].until as Date;
  expect(until.getTime() - Date.now()).toBeGreaterThan(25 * 60 * 1000);
  expect(body.data.postWithdrawEligibility).toEqual({ evaluated: false, reason: "move_pending" });
  expect(evaluateAndRecordTokenTierEligibility).not.toHaveBeenCalled();
  expect(refreshPrimaryHermesTokenHolding).not.toHaveBeenCalled();
});

it("does not evaluate on a lagging RPC read that does not show the moved tokens yet", async () => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
  (waitForTransferReceipt as jest.Mock).mockResolvedValue("mined");
  (refreshPrimaryVerifiedTokenHoldings as jest.Mock).mockImplementation(async () => ({
    status: "refreshed",
    snapshot: { balanceRaw: "0" },
    snapshots: [],
    balances: { hermesos: 0n },
  }));
  const pending = POST(post({ destination: "verified_wallet" }));
  await jest.runAllTimersAsync();
  const body = await (await pending).json();
  jest.useRealTimers();
  expect(body.data.postWithdrawEligibility).toEqual({ evaluated: false, reason: "move_balance_not_visible_yet" });
  expect(evaluateAndRecordTokenTierEligibility).not.toHaveBeenCalled();
});

it("drops the hold when the move is not sent", async () => {
  (withdrawAllHermesTokensForUser as jest.Mock).mockImplementation(async (params) => {
    await params.beforeTransfer?.(HELD);
    return { status: "transfer_failed", errorMessage: "bankr down" };
  });
  expect((await POST(post({ destination: "verified_wallet" }))).status).toBe(502);
  expect(holdTierBreachesUntil).toHaveBeenCalledTimes(1);
  expect(clearTierBreachHold).toHaveBeenCalledWith({ userId: "user_1" });
  expect(evaluateAndRecordTokenTierEligibility).not.toHaveBeenCalled();
});

it("leaves another attempt's hold alone when this one never wrote one", async () => {
  (withdrawAllHermesTokensForUser as jest.Mock).mockResolvedValue({ status: "already_in_flight" });
  expect((await POST(post({ destination: "verified_wallet" }))).status).toBe(409);
  expect(clearTierBreachHold).not.toHaveBeenCalled();
});

it("writes no hold for a withdraw (an exit)", async () => {
  (refreshPrimaryHermesTokenHolding as jest.Mock).mockResolvedValue({ status: "refreshed", snapshot: { balanceRaw: "0" } });
  await POST(post({}));
  expect(holdTierBreachesUntil).not.toHaveBeenCalled();
});

it("asks for a verified wallet when there is none", async () => {
  (withdrawAllHermesTokensForUser as jest.Mock).mockResolvedValue({ status: "no_verified_wallet" });
  const response = await POST(post({ destination: "verified_wallet" }));
  expect(response.status).toBe(422);
});

it("rejects an unknown destination", async () => {
  expect((await POST(post({ destination: "elsewhere" }))).status).toBe(400);
});
