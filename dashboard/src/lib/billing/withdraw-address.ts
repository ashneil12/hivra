/**
 * User-set withdraw destination for the hermesos_lock wallet.
 *
 * Users explicitly set one Base-network address they control. Withdraws
 * always send the lock wallet's full balance to this stored address —
 * the V1 chain-history auto-detect was unsafe because deposits via
 * bundlers/relayers/exchanges show those proxies as the on-chain
 * sender, not a wallet the user controls.
 *
 * Changing the address emails the owner, and a new address cannot receive a
 * withdrawal until WITHDRAW_DESTINATION_COOLDOWN_MS after `set_at`
 * (withdraw-destination-policy.ts). `set_at` is the time the CURRENT address
 * was saved: it is rewritten whenever the address changes and left alone when
 * the same address is saved again, so re-saving never restarts the cooldown.
 * Rows saved before this rule kept `set_at` at their first save, so an
 * address replaced before it is not held.
 */

import { supabaseAdmin } from "@/lib/supabase";
import { normalizeEvmAddress } from "./token-holdings";
import { noticeWithdrawDestinationChange } from "./withdraw-destination-notice";
import { withdrawDestinationAvailableAt } from "./withdraw-destination-policy";

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export interface UserWithdrawAddress {
  userId: string;
  address: string;
  normalizedAddress: string;
  network: "base";
  acknowledgedResponsibility: boolean;
  setAt: string;
  updatedAt: string;
}

interface WithdrawAddressRow {
  user_id: string;
  address: string;
  normalized_address: string;
  network: "base";
  acknowledged_responsibility: boolean;
  set_at: string;
  updated_at: string;
}

function asWithdrawAddress(row: WithdrawAddressRow): UserWithdrawAddress {
  return {
    userId: row.user_id,
    address: row.address,
    normalizedAddress: row.normalized_address,
    network: row.network,
    acknowledgedResponsibility: row.acknowledged_responsibility,
    setAt: row.set_at,
    updatedAt: row.updated_at,
  };
}

function isValidEvmAddress(value: string): boolean {
  return EVM_ADDRESS_RE.test(value.trim());
}

/**
 * Looks up the user's currently-set withdraw destination. Returns null
 * when the user has never set one; callers must surface that to the UI
 * so the user can configure it before any withdraw attempt.
 */
export async function getUserWithdrawAddress(
  userId: string
): Promise<UserWithdrawAddress | null> {
  if (!supabaseAdmin) throw new Error("Database not configured");
  const { data, error } = await supabaseAdmin
    .from("user_withdraw_addresses")
    .select(
      "user_id, address, normalized_address, network, acknowledged_responsibility, set_at, updated_at"
    )
    .eq("user_id", userId)
    .maybeSingle<WithdrawAddressRow>();

  if (error) {
    throw new Error(`Failed to load withdraw address: ${error.message}`);
  }
  return data ? asWithdrawAddress(data) : null;
}

interface SetParams {
  userId: string;
  address: string;
  acknowledged: boolean;
  now?: Date;
}

export type SetWithdrawAddressResult =
  | {
      status: "saved";
      record: UserWithdrawAddress;
      /** False when the same address was saved again: nothing was written. */
      changed: boolean;
    }
  | { status: "invalid_address" }
  | { status: "missing_acknowledgement" };

/**
 * Persists (or replaces) the user's withdraw destination. Refuses to
 * save if the address is malformed or if the user did not check the
 * "I accept responsibility for this address" box in the UI.
 *
 * A new or different address is stored with `set_at` = now (its cooldown
 * starts) and the owner is emailed. The same address again is a no-op.
 * The caller must already have required a fresh sign-in check.
 */
export async function setUserWithdrawAddress(
  params: SetParams
): Promise<SetWithdrawAddressResult> {
  if (!supabaseAdmin) throw new Error("Database not configured");

  const trimmed = params.address.trim();
  if (!isValidEvmAddress(trimmed)) {
    return { status: "invalid_address" };
  }
  if (!params.acknowledged) {
    return { status: "missing_acknowledgement" };
  }

  const normalized = normalizeEvmAddress(trimmed);
  const existing = await getUserWithdrawAddress(params.userId);
  if (existing && existing.normalizedAddress === normalized) {
    return { status: "saved", record: existing, changed: false };
  }

  const changedAt = params.now ?? new Date();
  const now = changedAt.toISOString();

  const { data, error } = await supabaseAdmin
    .from("user_withdraw_addresses")
    .upsert(
      {
        user_id: params.userId,
        address: trimmed,
        normalized_address: normalized,
        network: "base",
        acknowledged_responsibility: true,
        // The time THIS address was saved: the cooldown runs from here.
        set_at: now,
        updated_at: now,
      },
      { onConflict: "user_id" }
    )
    .select(
      "user_id, address, normalized_address, network, acknowledged_responsibility, set_at, updated_at"
    )
    .single<WithdrawAddressRow>();

  if (error || !data) {
    throw new Error(`Failed to save withdraw address: ${error?.message ?? "unknown error"}`);
  }

  const record = asWithdrawAddress(data);
  await noticeWithdrawDestinationChange({
    userId: params.userId,
    kind: "lock_wallet",
    previousAddress: existing?.normalizedAddress ?? null,
    newAddress: record.normalizedAddress,
    changedAt,
    availableAt: withdrawDestinationAvailableAt(changedAt),
  });

  return { status: "saved", record, changed: true };
}
