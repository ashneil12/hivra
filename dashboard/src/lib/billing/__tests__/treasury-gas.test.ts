import { ensureWalletHasGas, type TreasuryGasClients } from "@/lib/billing/treasury-gas";
import type { Address, Hex } from "viem";

// 32-byte hex private key for an Anvil/Foundry default account. Used
// only to derive a deterministic address inside parseTreasuryConfig —
// nothing is signed in the test, the clients seam intercepts every
// network call.
const TEST_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_KEY_ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

const TARGET_WALLET = "0x1234567890123456789012345678901234567890";

function makeClients(overrides: Partial<TreasuryGasClients> & { walletBalanceWei?: bigint; treasuryBalanceWei?: bigint } = {}): TreasuryGasClients {
  const walletBalanceWei = overrides.walletBalanceWei ?? 0n;
  const treasuryBalanceWei = overrides.treasuryBalanceWei ?? 1_000_000_000_000_000n; // 0.001 ETH

  return {
    treasuryAddress: TEST_KEY_ADDRESS as Address,
    getBalance: jest.fn(async (address: Address) => {
      if (address.toLowerCase() === TEST_KEY_ADDRESS.toLowerCase()) {
        return treasuryBalanceWei;
      }
      return walletBalanceWei;
    }),
    sendTopupTx: jest.fn(async () => "0xdeadbeef" as Hex),
    waitForReceipt: jest.fn(async () => undefined),
    ...overrides,
  };
}

describe("ensureWalletHasGas", () => {
  it("returns not_configured when treasury private key env is unset", async () => {
    const clients = makeClients();

    const result = await ensureWalletHasGas({
      walletAddress: TARGET_WALLET,
      env: {},
      clients,
    });

    expect(result.status).toBe("not_configured");
    expect(clients.getBalance).not.toHaveBeenCalled();
  });

  it("returns already_funded and skips signing when balance >= threshold", async () => {
    // Default min balance is 0.00003 ETH = 3e13 wei
    const clients = makeClients({ walletBalanceWei: 100_000_000_000_000n }); // 0.0001 ETH

    const result = await ensureWalletHasGas({
      walletAddress: TARGET_WALLET,
      env: { HERMES_TREASURY_BASE_PRIVATE_KEY: TEST_KEY },
      clients,
    });

    expect(result.status).toBe("already_funded");
    expect(result.balanceWei).toBe("100000000000000");
    expect(clients.sendTopupTx).not.toHaveBeenCalled();
    expect(clients.waitForReceipt).not.toHaveBeenCalled();
  });

  it("tops up when wallet balance is below threshold", async () => {
    // Wallet has 0, treasury has plenty
    const clients = makeClients({ walletBalanceWei: 0n });
    // After topup, the third getBalance() call should report the new balance.
    let calls = 0;
    (clients.getBalance as jest.Mock).mockImplementation(async (address: Address) => {
      calls += 1;
      if (address.toLowerCase() === TEST_KEY_ADDRESS.toLowerCase()) {
        return 1_000_000_000_000_000n; // treasury balance
      }
      // First call (pre-topup) returns 0; second call (post-topup) returns topup amount.
      return calls > 2 ? 100_000_000_000_000n : 0n;
    });

    const result = await ensureWalletHasGas({
      walletAddress: TARGET_WALLET,
      env: { HERMES_TREASURY_BASE_PRIVATE_KEY: TEST_KEY },
      clients,
    });

    expect(result.status).toBe("topped_up");
    expect(result.txHash).toBe("0xdeadbeef");
    expect(clients.sendTopupTx).toHaveBeenCalledWith({
      to: TARGET_WALLET.toLowerCase(),
      value: 100_000_000_000_000n, // default topup = 0.0001 ETH
    });
    expect(clients.waitForReceipt).toHaveBeenCalledWith("0xdeadbeef");
  });

  it("returns treasury_drained when treasury can't cover topup", async () => {
    const clients = makeClients({
      walletBalanceWei: 0n,
      treasuryBalanceWei: 1n, // 1 wei — way less than topup
    });

    const result = await ensureWalletHasGas({
      walletAddress: TARGET_WALLET,
      env: { HERMES_TREASURY_BASE_PRIVATE_KEY: TEST_KEY },
      clients,
    });

    expect(result.status).toBe("treasury_drained");
    expect(clients.sendTopupTx).not.toHaveBeenCalled();
  });

  it("rejects a malformed private key", async () => {
    await expect(
      ensureWalletHasGas({
        walletAddress: TARGET_WALLET,
        env: { HERMES_TREASURY_BASE_PRIVATE_KEY: "not-a-real-key" },
      })
    ).rejects.toThrow(/32-byte hex string/);
  });

  it("rejects when explicit treasury address mismatches the derived key", async () => {
    await expect(
      ensureWalletHasGas({
        walletAddress: TARGET_WALLET,
        env: {
          HERMES_TREASURY_BASE_PRIVATE_KEY: TEST_KEY,
          HERMES_TREASURY_BASE_ADDRESS: "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead",
        },
      })
    ).rejects.toThrow(/does not derive/);
  });

  it("respects custom topup + threshold env overrides", async () => {
    // Set min threshold to 1 wei, so any non-zero balance counts as funded.
    const clients = makeClients({ walletBalanceWei: 1n });

    const result = await ensureWalletHasGas({
      walletAddress: TARGET_WALLET,
      env: {
        HERMES_TREASURY_BASE_PRIVATE_KEY: TEST_KEY,
        HERMES_TREASURY_GAS_MIN_BALANCE_WEI: "1",
      },
      clients,
    });

    expect(result.status).toBe("already_funded");
  });

  it("sends one top-up when two calls for the same wallet overlap", async () => {
    // Regression: both calls used to read the same low balance before either
    // top-up landed, so both sent a transfer. The second call must wait for the
    // first and then see the funded balance.
    const WALLET = "0x2222222222222222222222222222222222222222";
    let walletFunded = false;
    const clients = makeClients({
      sendTopupTx: jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        walletFunded = true;
        return "0xbeef" as Hex;
      }),
    });
    (clients.getBalance as jest.Mock).mockImplementation(async (address: Address) => {
      if (address.toLowerCase() === TEST_KEY_ADDRESS.toLowerCase()) {
        return 1_000_000_000_000_000n;
      }
      return walletFunded ? 100_000_000_000_000n : 0n;
    });
    const env = { HERMES_TREASURY_BASE_PRIVATE_KEY: TEST_KEY };

    const [first, second] = await Promise.all([
      ensureWalletHasGas({ walletAddress: WALLET, env, clients }),
      ensureWalletHasGas({ walletAddress: WALLET, env, clients }),
    ]);

    expect(clients.sendTopupTx).toHaveBeenCalledTimes(1);
    expect([first.status, second.status].sort()).toEqual(["already_funded", "topped_up"]);
  });

  it("keeps the wallet held when the top-up receipt is unknown instead of sending again", async () => {
    // Regression: a failed receipt wait used to leave nothing recorded, so the
    // next call sent a second top-up for a transfer that may already be out.
    const WALLET = "0x3333333333333333333333333333333333333333";
    const clients = makeClients({
      waitForReceipt: jest.fn(async () => {
        throw new Error("receipt timeout");
      }),
    });
    const env = { HERMES_TREASURY_BASE_PRIVATE_KEY: TEST_KEY };

    await expect(
      ensureWalletHasGas({ walletAddress: WALLET, env, clients })
    ).rejects.toThrow("receipt timeout");
    await expect(
      ensureWalletHasGas({ walletAddress: WALLET, env, clients })
    ).rejects.toThrow(/not confirmed yet/);

    expect(clients.sendTopupTx).toHaveBeenCalledTimes(1);
  });
});
