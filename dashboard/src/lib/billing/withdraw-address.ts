/**
 * User-set withdraw destination for the hermesos_lock wallet.
 *
 * Users explicitly set one Base-network address they control. Withdraws
 * always send the lock wallet's full balance to this stored address —
 * the V1 chain-history auto-detect was unsafe because deposits via
 * bundlers/relayers/exchanges show those proxies as the on-chain
 * sender, not a wallet the user controls.
 */

import { supabaseAdmin } from "@/lib/supabase";
import { normalizeEvmAddress } from "./token-holdings";

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
}

export type SetWithdrawAddressResult =
  | { status: "saved"; record: UserWithdrawAddress }
  | { status: "invalid_address" }
  | { status: "missing_acknowledgement" };

/**
 * Persists (or replaces) the user's withdraw destination. Refuses to
 * save if the address is malformed or if the user did not check the
 * "I accept responsibility for this address" box in the UI.
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
  const now = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("user_withdraw_addresses")
    .upsert(
      {
        user_id: params.userId,
        address: trimmed,
        normalized_address: normalized,
        network: "base",
        acknowledged_responsibility: true,
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

  return { status: "saved", record: asWithdrawAddress(data) };
}
