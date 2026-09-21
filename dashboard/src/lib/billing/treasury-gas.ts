/**
 * Just-in-time gas sponsorship for Bankr-provisioned wallets.
 *
 * Why: Bankr provisions wallets with 0 native ETH. Any /wallet/transfer
 * we need to send out (user lock-wallet withdraw, yearly subscription
 * sweep, credit-deposit sweep) therefore fails with
 * "insufficient_funds_for_gas" until we top up. Rather than pre-fund
 * every wallet at provisioning, we sponsor gas at transfer time from a
 * treasury hot wallet.
 *
 * Flow:
 *   1. eth_getBalance(wallet)
 *   2. If >= MIN_BALANCE_WEI → noop ("already_funded")
 *   3. Otherwise sign+broadcast a treasury → wallet ETH transfer
 *      using HERMES_TREASURY_BASE_PRIVATE_KEY
 *   4. Wait 1 confirmation (Base ≈ 2s) so the subsequent Bankr
 *      /wallet/transfer sees the new balance
 *
 * Caller proceeds with the Bankr transfer regardless of status. If
 * treasury env is unset we return "not_configured" silently so the
 * downstream Bankr error surfaces in dev/preview without us trying to
 * sign with a key we don't have.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { normalizeEvmAddress } from "./token-holdings";

// ~$0.30 at $3000 ETH; covers a Base ERC-20 transfer with safety margin.
const DEFAULT_TOPUP_WEI = parseEther("0.0001");
// One Base ERC-20 transfer worth of gas at typical prices (~$0.10).
const DEFAULT_MIN_BALANCE_WEI = parseEther("0.00003");

const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org";

type GasTopupStatus =
  | "already_funded"
  | "topped_up"
  | "not_configured"
  | "treasury_drained";

export interface EnsureWalletGasParams {
  walletAddress: string;
  rpcUrl?: string;
  env?: Record<string, string | undefined>;
  /** Test-injection seam. Production code never passes this. */
  clients?: TreasuryGasClients;
}

export interface EnsureWalletGasResult {
  status: GasTopupStatus;
  /** Native balance after the call, in wei (decimal string). */
  balanceWei?: string;
  /** Funding tx hash. Set only when status = "topped_up". */
  txHash?: Hex;
  /** Diagnostic note for server logs. Never user-visible. */
  reason?: string;
}

export interface TreasuryGasClients {
  getBalance(address: Address): Promise<bigint>;
  sendTopupTx(args: { to: Address; value: bigint }): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<void>;
  treasuryAddress: Address;
}

interface ParsedTreasuryConfig {
  privateKey: Hex;
  account: Address;
  topupWei: bigint;
  minBalanceWei: bigint;
}

function parseTreasuryConfig(
  env: Record<string, string | undefined>
): ParsedTreasuryConfig | null {
  const rawKey = env.HERMES_TREASURY_BASE_PRIVATE_KEY?.trim();
  if (!rawKey) return null;

  const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    throw new Error(
      "HERMES_TREASURY_BASE_PRIVATE_KEY must be a 32-byte hex string"
    );
  }

  const account = privateKeyToAccount(privateKey).address;

  // If the operator pinned an explicit treasury address, sanity-check
  // that it matches the key. Catches "wrong env paired together"
  // misconfiguration before we sign anything.
  const expectedAddress = env.HERMES_TREASURY_BASE_ADDRESS?.trim();
  if (expectedAddress) {
    const normalizedExpected = normalizeEvmAddress(expectedAddress);
    const normalizedDerived = normalizeEvmAddress(account);
    if (normalizedExpected !== normalizedDerived) {
      throw new Error(
        "HERMES_TREASURY_BASE_PRIVATE_KEY does not derive to HERMES_TREASURY_BASE_ADDRESS"
      );
    }
  }

  return {
    privateKey,
    account,
    topupWei: parseWeiEnv(
      env.HERMES_TREASURY_GAS_TOPUP_WEI,
      DEFAULT_TOPUP_WEI
    ),
    minBalanceWei: parseWeiEnv(
      env.HERMES_TREASURY_GAS_MIN_BALANCE_WEI,
      DEFAULT_MIN_BALANCE_WEI
    ),
  };
}

function parseWeiEnv(value: string | undefined, fallback: bigint): bigint {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  try {
    return BigInt(trimmed);
  } catch {
    throw new Error(`Invalid wei value: ${value}`);
  }
}

function resolveRpcUrl(
  explicit: string | undefined,
  env: Record<string, string | undefined>
): string {
  return (
    explicit?.trim() ||
    env.HERMES_BASE_RPC_URL?.trim() ||
    env.BASE_RPC_URL?.trim() ||
    DEFAULT_BASE_RPC_URL
  );
}

function makeViemClients(
  rpcUrl: string,
  config: ParsedTreasuryConfig
): TreasuryGasClients {
  const transport = http(rpcUrl);
  const account = privateKeyToAccount(config.privateKey);
  const publicClient = createPublicClient({
    chain: base,
    transport,
  });
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport,
  });

  return {
    treasuryAddress: account.address,
    async getBalance(address) {
      return publicClient.getBalance({ address });
    },
    async sendTopupTx({ to, value }) {
      return walletClient.sendTransaction({
        account,
        chain: base,
        to,
        value,
      });
    },
    async waitForReceipt(hash) {
      await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });
    },
  };
}

export async function ensureWalletHasGas(
  params: EnsureWalletGasParams
): Promise<EnsureWalletGasResult> {
  const env = params.env ?? process.env;
  const config = parseTreasuryConfig(env);

  if (!config) {
    return {
      status: "not_configured",
      reason: "HERMES_TREASURY_BASE_PRIVATE_KEY not set",
    };
  }

  const wallet = normalizeEvmAddress(params.walletAddress) as Address;
  const clients =
    params.clients ?? makeViemClients(resolveRpcUrl(params.rpcUrl, env), config);

  const balance = await clients.getBalance(wallet);
  if (balance >= config.minBalanceWei) {
    return {
      status: "already_funded",
      balanceWei: balance.toString(),
      reason: `${balance} wei >= ${config.minBalanceWei} wei threshold`,
    };
  }

  const treasuryBalance = await clients.getBalance(clients.treasuryAddress);
  if (treasuryBalance < config.topupWei) {
    return {
      status: "treasury_drained",
      balanceWei: balance.toString(),
      reason: `treasury ${treasuryBalance} wei < topup ${config.topupWei} wei`,
    };
  }

  const txHash = await clients.sendTopupTx({
    to: wallet,
    value: config.topupWei,
  });
  await clients.waitForReceipt(txHash);

  const newBalance = await clients.getBalance(wallet);
  return {
    status: "topped_up",
    txHash,
    balanceWei: newBalance.toString(),
  };
}
