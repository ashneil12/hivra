/**
 * A small yearly $HermesOS "world" for route-level tests: an in-memory
 * Supabase with the yearly tables, a Base chain fake holding the user's
 * shared credit_deposit wallet, and Bankr transfer fakes that move tokens on
 * that chain (and refuse to overdraw, like a real transfer would).
 */

import { BankrTransferHttpError } from "@/lib/billing/bankr-withdraw";
import { parseTokenAmountToRaw } from "@/lib/billing/token-holdings";
import { createBaseRpcFake } from "@/test-utils/base-rpc-fake";
import {
  createYearlyTokenMemoryDb,
  depositCredentialRow,
  TEST_DEPOSIT_ADDRESS,
  txHash,
} from "@/test-utils/yearly-token-memory-db";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const YEAR_MS = 365 * DAY_MS;

export function createYearlyTokenWorld(options: { nowMs?: number; blockTimeSec?: number } = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const chain = createBaseRpcFake({
    latestBlock: 20_000_000,
    latestTimestamp: new Date(Math.floor(nowMs / 1000) * 1000).toISOString(),
    // Base makes a block every 2 s; other spacings make the scanner's block
    // estimate miss, so its block range is padded like on a real chain.
    blockTimeSec: options.blockTimeSec,
  });
  const memory = createYearlyTokenMemoryDb({
    bankr_deposit_wallet_credentials: [depositCredentialRow()],
  });

  const submitted: Array<{ from: string; to: string; amountRaw: bigint; txHash: string }> = [];
  let sweepSequence = 0;

  const bankr = {
    mintScopedTransferApiKey: jest.fn(async (params: { bankrWalletId: string }) => `key:${params.bankrWalletId}`),
    submitBankrTransfer: jest.fn(
      async (params: { apiKey: string; recipientAddress: string; amountDisplay: string }) => {
        const walletId = params.apiKey.replace(/^key:/, "");
        const credential = memory.tables.bankr_deposit_wallet_credentials.find(
          (row) => row.bankr_wallet_id === walletId
        );
        if (!credential) throw new BankrTransferHttpError(404, `unknown wallet ${walletId}`);
        const from = String(credential.evm_address).toLowerCase();
        const amountRaw = parseTokenAmountToRaw(params.amountDisplay, 18);
        if (chain.balanceOf(from) < amountRaw) {
          throw new BankrTransferHttpError(400, "insufficient token balance");
        }
        sweepSequence += 1;
        const hash = txHash(0xa000 + sweepSequence);
        chain.addTransfer({ txHash: hash, amountRaw, block: chain.latestBlock(), from, to: params.recipientAddress });
        submitted.push({ from, to: params.recipientAddress.toLowerCase(), amountRaw, txHash: hash });
        return hash;
      }
    ),
  };

  return {
    nowMs,
    chain,
    memory,
    bankr,
    submitted,
    at(offsetMs: number) {
      return new Date(nowMs + offsetMs).toISOString();
    },
    blockAt(offsetMs: number) {
      return chain.blockAt(nowMs + offsetMs);
    },
    /** A $HermesOS transfer into the deposit wallet `offsetMs` from now. */
    pay(params: { tx: string; amountRaw: bigint | string; offsetMs: number; logIndex?: number; to?: string }) {
      chain.addTransfer({
        txHash: params.tx,
        amountRaw: params.amountRaw,
        block: chain.blockAt(nowMs + params.offsetMs),
        logIndex: params.logIndex,
        to: params.to ?? TEST_DEPOSIT_ADDRESS,
      });
    },
    subscriptions() {
      return memory.tables.yearly_token_subscriptions;
    },
    quote(id: string) {
      return memory.tables.yearly_token_quotes.find((row) => row.id === id);
    },
    items() {
      return memory.tables.yearly_token_reconciliation_items;
    },
  };
}

export type YearlyTokenWorld = ReturnType<typeof createYearlyTokenWorld>;
