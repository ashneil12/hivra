/**
 * Withdraw flow for the hermesos_lock wallet.
 *
 * Custody concern: Hivra provisions Bankr wallets per user. While
 * Bankr's MPC model means Hivra never holds the raw private key, a
 * user who deposits $HERMESOS for tier eligibility is functionally
 * trusting the platform to honor a withdraw request. This module is
 * that relief valve.
 *
 * Security model:
 *   1. Withdraw target is constrained to the user's "originating
 *      wallet" — the EOA that sent the most recent Transfer of
 *      $HERMESOS into their lock address. We discover this via
 *      Base eth_getLogs (no off-chain trust assumption).
 *   2. We mint a single-use Bankr API key scoped to that recipient
 *      via `allowedRecipients.evm = [originatingWallet]`. Even if the
 *      key leaks, it can only move funds to the rightful owner's
 *      address.
 *   2b. The destination (saved withdraw address, or the verified wallet
 *      for a move) must have been set at least
 *      WITHDRAW_DESTINATION_COOLDOWN_MS ago (withdraw-destination-policy.ts),
 *      so a session that has just changed it cannot empty the wallet.
 *   3. We transfer the FULL on-chain balance — partial withdraws are
 *      out of scope for V1; the spec is "all-or-nothing exit."
 *   4. After the Bankr transfer submits, we record a withdraw event so
 *      the eligibility evaluator knows to start the grace clock on
 *      the user's qualification rows.
 *
 * The endpoint is `/api/billing/bankr/wallet/withdraw` (POST). Caller
 * must be the authenticated owner of the lock wallet.
 */

import {
  BASE_CHAIN_ID,
  HERMESOS_TOKEN_ADDRESS,
  HERMESOS_TOKEN_DECIMALS,
  HERMESOS_TOKEN_SYMBOL,
  fetchHermesTokenBalance,
  formatRawTokenBalance,
  getHermesLockWallet,
  normalizeEvmAddress,
} from "./token-holdings";
import { getBankrPartnerConfig } from "./bankr-wallets";
import { getBankrDepositWalletCredentialForUser } from "./bankr-deposit-wallets";
import { getUserWithdrawAddress } from "./withdraw-address";
import {
  withdrawDestinationHeldMessage,
  withdrawDestinationHeldUntil,
} from "./withdraw-destination-policy";
import {
  ensureWalletHasGas,
  type EnsureWalletGasResult,
  type TreasuryGasClients,
} from "./treasury-gas";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export interface WithdrawResult {
  status:
    | "submitted"
    | "no_balance"
    | "no_wallet"
    | "no_withdraw_address"
    | "not_configured"
    | "transfer_failed"
    | "already_in_flight"
    | "no_verified_wallet";
  txHash?: string | null;
  /**
   * Set when the destination is still inside its cooldown: when it can first
   * receive funds. The status is then no_withdraw_address (or
   * no_verified_wallet for a move) with an errorMessage saying so, which the
   * route already answers with 422 and that message.
   */
  availableAt?: string;
  amountRaw?: string;
  amountDisplay?: string;
  recipientAddress?: string;
  errorMessage?: string;
  /**
   * Outcome of the just-in-time gas top-up that runs before the Bankr
   * transfer. Server telemetry only; never user-visible.
   */
  gasTopup?: EnsureWalletGasResult;
  /**
   * True when the transfer submit itself failed: Bankr may still have
   * broadcast it (a timeout or 5xx after the broadcast), so the tokens may
   * be moving. False or absent: nothing was sent.
   */
  transferMayHaveBeenSent?: boolean;
}

type JsonRpcFetch = typeof fetch;

// ────────────────────────────────────────────────────────────────────
// Bankr API helpers
// ────────────────────────────────────────────────────────────────────

interface MintApiKeyParams {
  bankrWalletId: string;
  recipientAddress: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: JsonRpcFetch;
}

/**
 * Mint a Bankr-side API key scoped to the lock wallet, restricted so
 * the only recipient it can move funds to is `recipientAddress`. This
 * is the secret used by the subsequent /wallet/transfer call.
 */
export async function mintScopedTransferApiKey(params: MintApiKeyParams): Promise<string | null> {
  const config = getBankrPartnerConfig(params.env);
  if (!config.partnerKey) return null;
  const fetchImpl = params.fetchImpl || (fetch as unknown as JsonRpcFetch);

  const response = await fetchImpl(
    `${config.apiBaseUrl}/partner/wallets/${encodeURIComponent(params.bankrWalletId)}/api-keys`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Partner-Key": config.partnerKey,
      },
      // Bankr's permissions schema (mirrors BankrWalletApiKeyRequest in
      // bankr-wallets.ts):
      //   walletApiEnabled  — required for /wallet/transfer
      //   readOnly          — must be false to actually transfer
      //   agentApiEnabled / llmGatewayEnabled / tokenLaunchApiEnabled —
      //     unrelated to withdraw, all off
      //
      // Earlier failed attempts:
      //   ["transfer"]         → 400 "expected object, received array"
      //   { transfer: true }   → 200, but resulting key is "Read-only"
      body: JSON.stringify({
        name: "Hivra withdraw (single-use)",
        permissions: {
          walletApiEnabled: true,
          agentApiEnabled: false,
          llmGatewayEnabled: false,
          tokenLaunchApiEnabled: false,
          readOnly: false,
        },
        allowedRecipients: {
          evm: [normalizeEvmAddress(params.recipientAddress)],
          solana: [],
        },
      }),
    }
  );

  if (!response.ok) {
    // Surface the response body in runtime logs so 4xx debugging
    // doesn't require another redeploy. Body is NEVER returned to the
    // client.
    const detail = await response.text().catch(() => "<no body>");
    // The 20-key cap is a known, recurring business state: the cron
    // retries the same wallet every 5 minutes until a human revokes
    // stale Bankr keys. Log it as warn so it doesn't spike the error
    // dashboard ~288×/day per stuck wallet. Real failure modes still
    // log as error.
    const isKnownKeyCap =
      response.status === 400 && detail.includes("Maximum of 20 active API keys");
    if (process.env.NODE_ENV !== "test") {
      const line = `[bankr-withdraw] API key mint failed status=${response.status} body=${detail.slice(0, 400)}`;
      // eslint-disable-next-line no-console
      if (isKnownKeyCap) console.warn(line);
      // eslint-disable-next-line no-console
      else console.error(line);
    }
    // Per-wallet 20-key cap: return null so the caller treats this as
    // "no key available" (mark the sweep/withdraw as failed gracefully)
    // rather than throwing an uncaught error that 500s the whole route
    // or kills the cron loop. Resolving the cap requires Bankr-side
    // cleanup (revoke stale keys), which is out of scope for the hot
    // path.
    if (isKnownKeyCap) return null;
    throw new Error(`Bankr API key mint failed status=${response.status}`);
  }

  const payload = (await response.json()) as { apiKey?: string; secret?: string };
  return payload.apiKey || payload.secret || null;
}

interface SubmitTransferParams {
  apiKey: string;
  tokenAddress: string;
  recipientAddress: string;
  amountDisplay: string;
  isNativeToken?: boolean;
  env?: Record<string, string | undefined>;
  fetchImpl?: JsonRpcFetch;
}

/**
 * Bankr answered /wallet/transfer with a non-2xx status. Carries the status so
 * a caller can tell a refused request from one whose outcome is unknown.
 */
export class BankrTransferHttpError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`Bankr transfer failed status=${status} body=${detail.slice(0, 200)}`);
    this.name = "BankrTransferHttpError";
    this.status = status;
  }
}

export async function submitBankrTransfer(params: SubmitTransferParams): Promise<string | null> {
  const config = getBankrPartnerConfig(params.env);
  const fetchImpl = params.fetchImpl || (fetch as unknown as JsonRpcFetch);
  const response = await fetchImpl(`${config.apiBaseUrl}/wallet/transfer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": params.apiKey,
    },
    // Bankr's transfer endpoint is Base-only today; sending an extra
    // `chain` field can make provider-side validation ambiguous.
    body: JSON.stringify({
      tokenAddress: params.tokenAddress,
      recipientAddress: normalizeEvmAddress(params.recipientAddress),
      amount: params.amountDisplay,
      isNativeToken: params.isNativeToken ?? false,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new BankrTransferHttpError(response.status, detail);
  }

  const payload = (await response.json().catch(() => ({}))) as {
    txHash?: string;
    transactionHash?: string;
    hash?: string;
  };
  return payload.txHash || payload.transactionHash || payload.hash || null;
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

interface WithdrawParams {
  userId: string;
  /**
   * Optional client-side echo of the destination address. When supplied,
   * the value MUST match the user's stored withdraw address — otherwise
   * the withdraw is rejected. Defends against a stale UI that has the
   * wrong destination cached.
   */
  expectedRecipient?: string;
  /**
   * Where the full balance goes:
   *   - "withdraw_address" (default): the user's saved withdraw address. An
   *     exit: eligibility is re-evaluated at once and the breach clock starts.
   *   - "verified_wallet": the user's signature-verified primary wallet, which
   *     is the wallet tier eligibility reads once the lock wallet is empty. A
   *     move, not an exit: the tier keeps counting the same tokens.
   */
  destination?: "withdraw_address" | "verified_wallet";
  /**
   * Runs once the amount is known and the claim row is held, just before the
   * transfer is submitted, with the claim id. A throw cancels the withdraw:
   * nothing is sent.
   */
  beforeTransfer?: (amountRaw: bigint, claimId: string) => Promise<void>;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  env?: Record<string, string | undefined>;
  /** Test-injection seam for treasury-gas. Production code never sets this. */
  treasuryGasClients?: TreasuryGasClients;
}

/**
 * The user's self-custody wallet for a lock-wallet move: the PRIMARY wallet,
 * verified by signature (or by an admin). Tier eligibility reads the primary
 * wallet once the lock wallet is empty, so a move here keeps the tier.
 */
export async function getSelfCustodyPrimaryWallet(userId: string) {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const { data, error } = await supabaseAdmin
    .from("user_wallets")
    .select("id, address, normalized_address, verification_method, verified_at")
    .eq("user_id", userId)
    .eq("chain_type", "evm")
    .eq("is_primary", true)
    .in("verification_method", ["signature", "admin"])
    .not("verified_at", "is", null)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the verified wallet: ${error.message}`);
  const row = data as
    | { id: string; address: string; normalized_address: string; verified_at?: string | null }
    | null;
  return row
    ? {
        id: row.id,
        address: row.address,
        normalizedAddress: row.normalized_address,
        verifiedAt: row.verified_at ?? null,
      }
    : null;
}

export async function withdrawAllHermesTokensForUser(
  params: WithdrawParams
): Promise<WithdrawResult> {
  // Fail closed if the service-role client is unavailable. The ONLY
  // cross-process double-withdraw guard is the `bankr_withdrawals`
  // in-flight claim row inserted below, and that insert is gated on
  // `supabaseAdmin`. Without it the per-process in-memory lock in the
  // route is the sole protection — which two concurrent requests on
  // different Node instances bypass, both minting a Bankr key and
  // transferring the user's full balance. Refuse rather than transfer
  // money without the lock.
  if (!supabaseAdmin) {
    return {
      status: "transfer_failed",
      errorMessage:
        "Withdrawals are temporarily unavailable (database not configured).",
    };
  }

  const wallet = await getHermesLockWallet(params.userId);
  if (!wallet) {
    return { status: "no_wallet" };
  }

  let recipient: string;
  // When the destination was set: a destination set within the cooldown
  // cannot receive anything yet.
  let destinationSetAt: string | null;
  if (params.destination === "verified_wallet") {
    // A move to the wallet the user proved they control by signature.
    const verified = await getSelfCustodyPrimaryWallet(params.userId);
    if (!verified || verified.normalizedAddress === normalizeEvmAddress(wallet.address)) {
      return {
        status: "no_verified_wallet",
        errorMessage: "Verify your own wallet first. It becomes the wallet your tier reads.",
      };
    }
    recipient = verified.normalizedAddress;
    destinationSetAt = verified.verifiedAt;
  } else {
    // The user must have explicitly set a withdraw destination. We do
    // NOT auto-detect from chain history — bundlers, exchanges, MEV
    // relays show as the on-chain sender on inbound transfers but the
    // user does not control those addresses, so withdrawing back there
    // can lose funds. This is a hard refusal until the user sets one.
    const stored = await getUserWithdrawAddress(params.userId);
    if (!stored) {
      return { status: "no_withdraw_address" };
    }
    recipient = stored.normalizedAddress;
    destinationSetAt = stored.setAt;
  }

  if (
    params.expectedRecipient &&
    normalizeEvmAddress(params.expectedRecipient) !== recipient
  ) {
    return {
      status: params.destination === "verified_wallet" ? "no_verified_wallet" : "no_withdraw_address",
      errorMessage:
        "Confirmation address does not match your saved withdraw address. Refresh the page and try again.",
    };
  }

  // A destination set within the cooldown is held: nothing is claimed,
  // minted or sent until it has been in place long enough for the owner to
  // see the change email.
  const heldUntil = withdrawDestinationHeldUntil(destinationSetAt);
  if (heldUntil) {
    return {
      status: params.destination === "verified_wallet" ? "no_verified_wallet" : "no_withdraw_address",
      availableAt: heldUntil.toISOString(),
      recipientAddress: recipient,
      errorMessage: withdrawDestinationHeldMessage(
        heldUntil,
        params.destination === "verified_wallet" ? "Your wallet" : "Your withdraw address",
        params.destination === "verified_wallet" ? "verified" : "saved"
      ),
    };
  }

  // Read live on-chain balance — never trust DB-cached values for a
  // financial operation.
  const balance = await fetchHermesTokenBalance({
    walletAddress: wallet.address,
    rpcUrl: params.rpcUrl,
    fetchImpl: params.fetchImpl,
    env: params.env,
  });
  if (BigInt(balance.balanceRaw) === 0n) {
    return { status: "no_balance" };
  }

  // Pull the bankrWalletId from the credential row — that's the
  // canonical place for the Bankr-side identifier.
  const credential = await getBankrDepositWalletCredentialForUser({
    userId: params.userId,
    purpose: "hermesos_lock",
  });
  if (!credential?.bankrWalletId) {
    return {
      status: "not_configured",
      errorMessage: "Bankr lock wallet credential not found.",
    };
  }
  const bankrWalletId = credential.bankrWalletId;

  // ────────────────────────────────────────────────────────────────────
  // Cross-process claim row. The route already has a per-user in-process
  // lock + rate limit, but two near-simultaneous POSTs hitting different
  // Node instances could both mint a Bankr API key and submit a
  // transfer. The partial unique index
  // `uq_bankr_withdrawals_one_in_flight_per_user` (see migration
  // 20260502120000) makes the second concurrent insert fail with 23505,
  // so only one transfer can be in flight per user at a time.
  // ────────────────────────────────────────────────────────────────────
  let claimId: string | null = null;
  if (supabaseAdmin) {
    const { data: claim, error: claimErr } = await supabaseAdmin
      .from("bankr_withdrawals")
      .insert({
        user_id: params.userId,
        status: "in_flight",
        amount_raw: balance.balanceRaw,
        recipient,
      })
      .select("id")
      .single();
    if (claimErr) {
      // 23505 = unique_violation on the in-flight partial index.
      if (claimErr.code === "23505") {
        return {
          status: "already_in_flight",
          errorMessage:
            "A withdraw is already in flight for this account. Wait for it to settle before retrying.",
        };
      }
      // Any other DB failure is a hard refusal — don't proceed to mint
      // a Bankr key without a claim row, otherwise the cross-process
      // lock guarantee evaporates.
      return {
        status: "transfer_failed",
        errorMessage: `Failed to record withdrawal claim: ${claimErr.message}`,
      };
    }
    claimId = (claim as { id: string }).id;
  }

  const finalizeClaim = async (
    finalStatus: "submitted" | "failed" | "cancelled",
    fields: { tx_hash?: string | null; error_message?: string | null } = {}
  ) => {
    if (!supabaseAdmin || !claimId) return;
    const { error } = await supabaseAdmin
      .from("bankr_withdrawals")
      .update({
        status: finalStatus,
        tx_hash: fields.tx_hash ?? null,
        error_message: fields.error_message ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", claimId);

    if (error) {
      // This update is the only thing that frees the durable per-user
      // in_flight lock; supabase-js resolves (not throws) on error, so a
      // failed release was silently swallowed, permanently wedging the user's
      // withdraw lock. Surface it (do not throw — on 'submitted' the transfer
      // already succeeded). A TTL/on-chain reconciler is the recommended
      // follow-up to auto-clear stale in_flight rows.
      log.error(
        "hermesos withdrawal claim release failed; in_flight lock may be stuck",
        error,
        {
          source: "bankr-withdraw",
          failureType: "withdrawal_claim_release_failed",
          claimId,
          finalStatus,
          txHash: fields.tx_hash ?? null,
        }
      );
    }
  };

  // Mint a single-use API key scoped to the user's stored withdraw
  // address only.
  const apiKey = await mintScopedTransferApiKey({
    bankrWalletId,
    recipientAddress: recipient,
    env: params.env,
    fetchImpl: params.fetchImpl,
  });
  if (!apiKey) {
    await finalizeClaim("cancelled", {
      error_message: "Bankr partner not configured (api key mint failed)",
    });
    return { status: "not_configured", errorMessage: "Bankr partner not configured." };
  }

  // Just-in-time gas sponsorship. Bankr lock wallets get 0 native ETH
  // at provisioning, so /wallet/transfer fails with
  // "insufficient_funds_for_gas" until we top up. If treasury env is
  // unset we get status="not_configured" and let the Bankr error
  // surface untouched (preview/dev clue that prod env vars are needed).
  let gasTopup: EnsureWalletGasResult;
  try {
    gasTopup = await ensureWalletHasGas({
      walletAddress: wallet.address,
      rpcUrl: params.rpcUrl,
      env: params.env,
      clients: params.treasuryGasClients,
    });
  } catch (gasErr) {
    const gasErrorMessage =
      gasErr instanceof Error
        ? `Gas sponsorship failed: ${gasErr.message}`
        : String(gasErr);
    await finalizeClaim("failed", { error_message: gasErrorMessage });
    return {
      status: "transfer_failed",
      errorMessage: gasErrorMessage,
      recipientAddress: recipient,
      amountRaw: balance.balanceRaw,
      amountDisplay: balance.balanceDisplay,
    };
  }

  if (params.beforeTransfer) {
    try {
      if (!claimId) throw new Error("Withdrawal claim was not recorded");
      await params.beforeTransfer(BigInt(balance.balanceRaw), claimId);
    } catch (prepareErr) {
      const prepareErrorMessage =
        prepareErr instanceof Error ? prepareErr.message : String(prepareErr);
      await finalizeClaim("cancelled", { error_message: prepareErrorMessage });
      return {
        status: "transfer_failed",
        errorMessage: prepareErrorMessage,
        recipientAddress: recipient,
        amountRaw: balance.balanceRaw,
        amountDisplay: balance.balanceDisplay,
        gasTopup,
      };
    }
  }

  let txHash: string | null;
  try {
    txHash = await submitBankrTransfer({
      apiKey,
      tokenAddress: HERMESOS_TOKEN_ADDRESS,
      recipientAddress: recipient,
      amountDisplay: balance.balanceDisplay,
      env: params.env,
      fetchImpl: params.fetchImpl,
    });
  } catch (transferErr) {
    const transferErrorMessage =
      transferErr instanceof Error ? transferErr.message : String(transferErr);
    await finalizeClaim("failed", { error_message: transferErrorMessage });
    return {
      status: "transfer_failed",
      errorMessage: transferErrorMessage,
      recipientAddress: recipient,
      amountRaw: balance.balanceRaw,
      amountDisplay: balance.balanceDisplay,
      gasTopup,
      transferMayHaveBeenSent: true,
    };
  }

  await finalizeClaim("submitted", { tx_hash: txHash });
  return {
    status: "submitted",
    txHash,
    amountRaw: balance.balanceRaw,
    amountDisplay: balance.balanceDisplay,
    recipientAddress: recipient,
    gasTopup,
  };
}

// Re-export consts so the API route can build response shapes without
// reaching back into token-holdings just for these.
export {
  BASE_CHAIN_ID,
  HERMESOS_TOKEN_ADDRESS,
  HERMESOS_TOKEN_DECIMALS,
  HERMESOS_TOKEN_SYMBOL,
  formatRawTokenBalance,
};

/**
 * Wait (bounded) for a submitted transfer to be mined successfully. Returns
 * "mined", "failed" (reverted) or "pending" (not mined within the budget).
 */
export async function waitForTransferReceipt(params: {
  txHash: string;
  rpcUrl?: string;
  fetchImpl?: JsonRpcFetch;
  sleepImpl?: (ms: number) => Promise<void>;
  attempts?: number;
  intervalMs?: number;
}): Promise<"mined" | "failed" | "pending"> {
  const fetchImpl = params.fetchImpl ?? (fetch as unknown as JsonRpcFetch);
  const rpcUrl = params.rpcUrl || process.env.HERMES_BASE_RPC_URL?.trim() || process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";
  const sleepImpl = params.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = params.attempts ?? 10;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleepImpl(params.intervalMs ?? 2_000);
    try {
      const response = await fetchImpl(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [params.txHash] }),
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as { result?: { status?: string } | null };
      const status = payload.result?.status;
      if (typeof status === "string") return /^0x0*1$/i.test(status) ? "mined" : "failed";
    } catch {
      // Transient RPC failure: try again within the budget.
    }
  }
  return "pending";
}
