/** @jest-environment node */
/**
 * The yearly treasury sweep checks and moves the token the subscription was
 * paid in: a $HIVRA year sweeps $HIVRA, never $HermesOS.
 */
jest.mock("@/lib/billing/hivra-token-launch", () => ({
  HIVRA_TOKEN_LAUNCH: {
    contractAddress: "0x2222222222222222222222222222222222222222",
    decimals: 18,
    poolId: `0x${"cd".repeat(32)}`,
    activatesAt: "2026-01-01T00:00:00Z",
  },
}));
jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn(),
}));

import { sweepYearlyTokenSubscription, type YearlySweepOptions } from "@/lib/billing/yearly-sweep";
import { HERMESOS_TOKEN_ADDRESS } from "@/lib/billing/token-holdings";
import { TEST_DEPOSIT_ADDRESS, TEST_TREASURY_ADDRESS, txHash, yearlySubscriptionRow } from "@/test-utils/yearly-token-memory-db";
import { createYearlyTokenWorld, MINUTE_MS } from "@/test-utils/yearly-token-world";

const HIVRA = "0x2222222222222222222222222222222222222222";
const REQUIRED = 1_000n * 10n ** 18n;

function setup(opts: { hivraInWallet: bigint; hermesosInWallet: bigint }) {
  const world = createYearlyTokenWorld();
  world.memory.insertRow(
    "yearly_token_subscriptions",
    yearlySubscriptionRow({
      id: "ys_1",
      paid_at: world.at(-1 * MINUTE_MS),
      deposit_tx_hash: txHash(1),
      deposit_log_index: 0,
      amount_received_raw: REQUIRED.toString(),
      sweep_status: "pending",
      token_key: "hivra",
      token_address: HIVRA,
    })
  );
  const block = world.chain.blockAt(world.nowMs - 2 * MINUTE_MS);
  if (opts.hivraInWallet > 0n) {
    world.chain.addTransfer({ txHash: txHash(1), amountRaw: opts.hivraInWallet, block, to: TEST_DEPOSIT_ADDRESS, tokenAddress: HIVRA });
  }
  if (opts.hermesosInWallet > 0n) {
    world.chain.addTransfer({ txHash: txHash(2), amountRaw: opts.hermesosInWallet, block, to: TEST_DEPOSIT_ADDRESS, tokenAddress: HERMESOS_TOKEN_ADDRESS });
  }
  const submitTransfer = jest.fn(async () => txHash(0xabc));
  const options: YearlySweepOptions = {
    db: world.memory.db,
    now: new Date(world.nowMs),
    env: { HERMES_TREASURY_ADDRESS: TEST_TREASURY_ADDRESS, HERMES_BASE_RPC_URL: "https://base.test" },
    fetchImpl: world.chain.fetchImpl as unknown as YearlySweepOptions["fetchImpl"],
    ensureGas: async () => ({ status: "already_funded" }),
    mintApiKey: world.bankr.mintScopedTransferApiKey as unknown as YearlySweepOptions["mintApiKey"],
    submitTransfer: submitTransfer as unknown as YearlySweepOptions["submitTransfer"],
  };
  return { world, options, submitTransfer };
}

it("sweeps a $HIVRA subscription in $HIVRA after checking the $HIVRA balance", async () => {
  const { options, submitTransfer } = setup({ hivraInWallet: REQUIRED, hermesosInWallet: 0n });
  const result = await sweepYearlyTokenSubscription({ id: "ys_1", user_id: "user_1" }, options);
  expect(result).toMatchObject({ outcome: "swept" });
  expect(submitTransfer).toHaveBeenCalledWith(expect.objectContaining({ tokenAddress: HIVRA, amountDisplay: "1000" }));
});

it("does not sweep a $HIVRA subscription against a $HermesOS balance", async () => {
  // Only $HermesOS sits in the wallet: the $HIVRA balance check fails.
  const { options, submitTransfer } = setup({ hivraInWallet: 0n, hermesosInWallet: REQUIRED * 10n });
  const result = await sweepYearlyTokenSubscription({ id: "ys_1", user_id: "user_1" }, options);
  expect(result.outcome).not.toBe("swept");
  expect(submitTransfer).not.toHaveBeenCalled();
});
