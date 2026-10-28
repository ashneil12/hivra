/**
 * The public receipts ledger (/token/receipts): one entry per Base transaction
 * that keeps a promise made to holders.
 *
 *   fee-claim       Hivra's share of the $HIVRA pool's trading fees arriving in
 *                   the treasury Safe (HIVRA_MIGRATION.treasurySafe).
 *   liquidity-add   the Safe adding fee money to the pool's liquidity.
 *   liquidity-lock  the Safe locking a liquidity position. `lock` is required.
 *   founder-sale    the founder wallet selling legacy $HermesOS in the weekly
 *                   sell-down (HIVRA_MIGRATION.founder).
 *   founder-burn    the founder wallet sending the unsold rest of its $HermesOS
 *                   to the burn address (HIVRA_MIGRATION.founder.burnAddress).
 *
 * Only the transaction hash, its UTC date and the kind are entered here. Every
 * amount on the page is read from the transaction's own logs on Base when the
 * page renders (token-receipts-chain.ts), never typed in. An entry whose
 * transaction failed, is dated on another UTC day, or does not move what its
 * kind says (no fee reaching the Safe, no $HermesOS leaving the founder wallet,
 * nothing executed by the Safe, nothing touching the named locker) is dropped and
 * logged ("Token receipts rejected"), never shown.
 *
 * Add entries by a reviewed pull request as transactions confirm. The same
 * transaction may appear under two kinds (an add and a lock in one call).
 * Liquidity and founder entries also appear on /token/migration, so they are
 * entered here only, not again in HIVRA_MIGRATION.receipts.
 *
 * Fields:
 *   date    UTC date ("2026-11-04") or instant ("2026-11-04T16:00:00Z") the
 *           transaction confirmed. It must be the same UTC day as its block.
 *   kind    one of the kinds above.
 *   txHash  0x + 64 hex.
 *   note    a short plain-English line (at most 280 characters), or null.
 *   lock    liquidity-lock only:
 *             locker         the locker's public name, e.g. "UNCX";
 *             lockerAddress  the locker contract on Base (EIP-55 or lowercase).
 *                            The transaction must emit a log from it or move a
 *                            position from the Safe to it;
 *             url            the public lock page (plain https), or null;
 *             unlocksAt      UTC date or instant the lock ends, or "never".
 *
 * Client-safe: no imports.
 */
export type TokenReceiptKind = "fee-claim" | "liquidity-add" | "liquidity-lock" | "founder-sale" | "founder-burn";

export type TokenReceiptLock = {
  locker: string;
  lockerAddress: string;
  url: string | null;
  unlocksAt: string;
};

export type TokenReceiptEntry = {
  date: string;
  kind: TokenReceiptKind;
  txHash: string;
  note: string | null;
  lock?: TokenReceiptLock;
};

export const TOKEN_RECEIPTS: readonly TokenReceiptEntry[] = [];
