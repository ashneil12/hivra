import { requireDb } from "@/lib/billing/db-utils";
import { randomBytes } from "crypto";
import { verifyMessage, type Address, type Hex } from "viem";
import { supabaseAdmin } from "@/lib/supabase";
import { livePlatformTokens } from "@/lib/billing/token-registry";
import {
  BASE_CHAIN_ID,
  getTokenVerificationWallet,
  normalizeEvmAddress,
} from "@/lib/billing/token-holdings";
import { reportOpsEvent } from "@/lib/ops-events";

type DbFilter = {
  eq: (...args: unknown[]) => DbFilter;
  select: (...args: unknown[]) => DbFilter;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  single: () => Promise<{ data: unknown; error: unknown }>;
};

type DbMutationFilter = {
  eq: (...args: unknown[]) => DbMutationFilter;
  select: (...args: unknown[]) => DbFilter;
  then: Promise<{ data: unknown; error: unknown }>["then"];
};

type DbListFilter = {
  eq: (...args: unknown[]) => DbListFilter;
  neq: (...args: unknown[]) => DbListFilter;
  then: Promise<{ data: unknown; error: unknown }>["then"];
};

type DbTable = DbFilter & {
  insert: (...args: unknown[]) => DbFilter;
  update: (...args: unknown[]) => DbMutationFilter;
  upsert: (...args: unknown[]) => DbFilter;
};

type SupabaseLike = {
  from: (name: string) => unknown;
};

interface WalletChallengeRow {
  id: string;
  user_id: string;
  chain_type: "evm";
  chain_id: number;
  address: string;
  normalized_address: string;
  nonce: string;
  message: string;
  status: "pending" | "verified" | "expired" | "failed";
  expires_at: string;
  verified_at: string | null;
  consumed_at: string | null;
  failure_reason: string | null;
  created_at: string;
}

interface UserWalletRow {
  id: string;
  user_id: string;
  address: string;
  normalized_address: string;
  chain_type: "evm";
  chain_id: number | null;
  is_primary: boolean;
  verified_at: string | null;
}

type VerifyMessageImpl = (params: {
  address: Address;
  message: string;
  signature: Hex;
}) => Promise<boolean>;

const WALLET_VERIFICATION_TTL_MS = 10 * 60 * 1000;

function table(db: SupabaseLike, name: string): DbTable {
  return db.from(name) as DbTable;
}

function asChallenge(row: WalletChallengeRow) {
  return {
    id: row.id,
    userId: row.user_id,
    chainType: row.chain_type,
    chainId: row.chain_id,
    address: row.address,
    normalizedAddress: row.normalized_address,
    nonce: row.nonce,
    message: row.message,
    status: row.status,
    expiresAt: row.expires_at,
    verifiedAt: row.verified_at,
    consumedAt: row.consumed_at,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
  };
}

function asWallet(row: UserWalletRow) {
  return {
    id: row.id,
    userId: row.user_id,
    address: row.address,
    normalizedAddress: row.normalized_address,
    chainType: row.chain_type,
    chainId: row.chain_id,
    isPrimary: row.is_primary,
    verifiedAt: row.verified_at,
  };
}

function createNonce() {
  return randomBytes(16).toString("hex");
}

interface DisplacedWalletClaimRow {
  id: string;
  user_id: string;
  is_primary: boolean;
  verified_at: string | null;
  metadata: unknown;
}

function listQuery(db: SupabaseLike, name: string, select: string): DbListFilter {
  return (db.from(name) as { select: (s: string) => unknown }).select(select) as DbListFilter;
}

/**
 * Rows on OTHER accounts that currently claim this address — either as their
 * primary verification wallet or as a lingering verified entry. These are the
 * rows a successful signature verification takes over.
 */
async function loadOtherAccountWalletClaims(params: {
  db: SupabaseLike;
  userId: string;
  normalizedAddress: string;
}): Promise<DisplacedWalletClaimRow[]> {
  const { data, error } = await listQuery(
    params.db,
    "user_wallets",
    "id, user_id, is_primary, verified_at, metadata"
  )
    .eq("chain_type", "evm")
    .eq("normalized_address", params.normalizedAddress)
    .neq("user_id", params.userId);

  if (error) {
    throw new Error("Failed to scan wallet claims across accounts");
  }

  const rows = Array.isArray(data) ? (data as DisplacedWalletClaimRow[]) : [];
  return rows.filter((row) => row.is_primary || row.verified_at);
}

/**
 * Challenge-time hint for the UI: verifying this address will move it off
 * another account (see the takeover logic in verifyWalletChallenge).
 */
export async function isWalletClaimedByAnotherAccount(params: {
  userId: string;
  address: string;
  db?: SupabaseLike | null;
}): Promise<boolean> {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const claims = await loadOtherAccountWalletClaims({
    db: admin,
    userId: params.userId,
    normalizedAddress: normalizeEvmAddress(params.address),
  });
  return claims.length > 0;
}

async function demoteDisplacedWalletClaims(params: {
  db: SupabaseLike;
  claims: DisplacedWalletClaimRow[];
  challengeId: string;
  now: Date;
}) {
  for (const claim of params.claims) {
    const baseMetadata =
      claim.metadata && typeof claim.metadata === "object" && !Array.isArray(claim.metadata)
        ? (claim.metadata as Record<string, unknown>)
        : {};
    const result = await table(params.db, "user_wallets")
      .update({
        is_primary: false,
        verified_at: null,
        metadata: {
          ...baseMetadata,
          wallet_takeover: {
            reason: "reverified_by_another_account",
            challenge_id: params.challengeId,
            was_primary: claim.is_primary,
            demoted_at: params.now.toISOString(),
          },
        },
      })
      .eq("id", claim.id);
    if (result.error) {
      throw new Error("Failed to release wallet from its previous account");
    }
  }
}

export type RevokeDisplacedTokenEntitlements = (params: {
  userId: string;
  normalizedAddress: string;
  challengeId: string;
  db: SupabaseLike;
  now: Date;
}) => Promise<void>;

/**
 * Strip token-tier standing from an account whose verification wallet was
 * just taken over by a different account. Without this the displaced account
 * keeps qualifying off state that no longer has a wallet behind it:
 *
 *   - refresh-token-tiers honours its latest holding snapshot for up to 30
 *     days, so token_base would survive on the old balance;
 *   - token_tier_qualifications / venice_compute_boost_qualifications rows are
 *     only re-evaluated for users the holdings cron can refresh, and that cron
 *     enumerates primary wallets — a user with no primary is never swept, so
 *     `currently_eligible = true` would stick forever.
 */
export const revokeDisplacedTokenEntitlements: RevokeDisplacedTokenEntitlements = async (
  params
) => {
  // The displaced account may still qualify through a different wallet (its
  // primary can be another address, or a grandfathered Bankr lock wallet).
  const remainingWallet = await getTokenVerificationWallet(params.userId, params.db);
  if (remainingWallet) return;

  // Zero-balance snapshots (one per live platform token) so the tier cron
  // stops honouring the taken-over wallet's old balances. The normal 48h
  // downgrade grace applies from each snapshot's checked_at.
  for (const token of livePlatformTokens(params.now)) {
    const snapshot = await table(params.db, "token_holding_snapshots")
      .insert({
        user_id: params.userId,
        wallet_id: null,
        wallet_address: params.normalizedAddress,
        normalized_wallet_address: params.normalizedAddress,
        chain_id: BASE_CHAIN_ID,
        token_address: token.address,
        token_symbol: token.symbol,
        token_decimals: token.decimals,
        balance_raw: "0",
        balance_display: "0",
        qualifies_base_tier: false,
        source: "admin",
        metadata: { reason: "wallet_takeover", challenge_id: params.challengeId },
        checked_at: params.now.toISOString(),
      })
      .select("id")
      .single();
    if (snapshot.error) {
      throw new Error("Failed to record zero-balance snapshot for displaced account");
    }
  }

  // Breach (not delete) the Pro/Power qualifications: instance-entitlement
  // gates on the strict currently_eligible boolean, and last_breach_at keeps
  // the normal grace-recovery path open if the wallet is verified back.
  const quals = await table(params.db, "token_tier_qualifications")
    .update({ currently_eligible: false, last_breach_at: params.now.toISOString() })
    .eq("user_id", params.userId)
    .eq("currently_eligible", true);
  if (quals.error) {
    throw new Error("Failed to suspend displaced token tier qualification");
  }

  // The Venice compute boost rides the same verification wallet.
  const boost = await table(params.db, "venice_compute_boost_qualifications")
    .update({ currently_eligible: false, last_breach_at: null })
    .eq("user_id", params.userId)
    .eq("currently_eligible", true);
  if (boost.error) {
    throw new Error("Failed to suspend displaced Venice boost qualification");
  }
};

export function buildWalletVerificationMessage(params: {
  address: string;
  chainId?: number;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}) {
  const normalizedAddress = normalizeEvmAddress(params.address);
  const chainId = params.chainId ?? BASE_CHAIN_ID;

  return [
    "Hivra wallet verification",
    "",
    "Sign this message to prove you control this wallet.",
    "",
    `Wallet: ${normalizedAddress}`,
    `Network: Base (${chainId})`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
    `Expires At: ${params.expiresAt}`,
    "",
    "This signature does not authorize a transaction or move funds.",
  ].join("\n");
}

export async function createWalletVerificationChallenge(params: {
  userId: string;
  address: string;
  chainId?: number;
  db?: SupabaseLike | null;
  now?: Date;
  nonce?: string;
}) {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const chainId = params.chainId ?? BASE_CHAIN_ID;
  if (chainId !== BASE_CHAIN_ID) {
    throw new Error("Unsupported wallet verification chain");
  }

  const normalizedAddress = normalizeEvmAddress(params.address);
  const issuedAt = params.now ?? new Date();
  const expiresAt = new Date(issuedAt.getTime() + WALLET_VERIFICATION_TTL_MS);
  const nonce = params.nonce ?? createNonce();
  const message = buildWalletVerificationMessage({
    address: normalizedAddress,
    chainId,
    nonce,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });

  const { data, error } = await table(admin, "wallet_verification_challenges")
    .insert({
      user_id: params.userId,
      chain_type: "evm",
      chain_id: chainId,
      address: normalizedAddress,
      normalized_address: normalizedAddress,
      nonce,
      message,
      status: "pending",
      expires_at: expiresAt.toISOString(),
      metadata: {},
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error("Failed to create wallet verification challenge");
  }

  return asChallenge(data as WalletChallengeRow);
}

async function markChallenge(params: {
  db: SupabaseLike;
  challengeId: string;
  status: "verified" | "expired" | "failed";
  now: Date;
  failureReason?: string;
}) {
  const patch: Record<string, unknown> = {
    status: params.status,
    consumed_at: params.now.toISOString(),
  };

  if (params.status === "verified") {
    patch.verified_at = params.now.toISOString();
  }

  if (params.failureReason) {
    patch.failure_reason = params.failureReason;
  }

  const { data, error } = await table(params.db, "wallet_verification_challenges")
    .update(patch)
    .eq("id", params.challengeId)
    .select("*")
    .single();

  if (error || !data) {
    throw new Error("Failed to update wallet verification challenge");
  }

  return asChallenge(data as WalletChallengeRow);
}

export async function verifyWalletChallenge(params: {
  userId: string;
  challengeId: string;
  signature: string;
  db?: SupabaseLike | null;
  now?: Date;
  verifyMessageImpl?: VerifyMessageImpl;
  revokeDisplacedEntitlementsImpl?: RevokeDisplacedTokenEntitlements;
}) {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const now = params.now ?? new Date();
  const verifier = params.verifyMessageImpl ?? verifyMessage;

  const { data, error } = await table(admin, "wallet_verification_challenges")
    .select("*")
    .eq("id", params.challengeId)
    .eq("user_id", params.userId)
    .maybeSingle();

  if (error) {
    throw new Error("Failed to load wallet verification challenge");
  }

  if (!data) {
    return { status: "not_found" as const };
  }

  const challenge = data as WalletChallengeRow;
  if (challenge.status !== "pending") {
    return { status: "already_used" as const, challenge: asChallenge(challenge) };
  }

  if (new Date(challenge.expires_at).getTime() <= now.getTime()) {
    const marked = await markChallenge({
      db: admin,
      challengeId: challenge.id,
      status: "expired",
      now,
      failureReason: "expired",
    });
    return { status: "expired" as const, challenge: marked };
  }

  let verified = false;
  try {
    verified = await verifier({
      address: challenge.normalized_address as Address,
      message: challenge.message,
      signature: params.signature as Hex,
    });
  } catch {
    verified = false;
  }

  if (!verified) {
    const marked = await markChallenge({
      db: admin,
      challengeId: challenge.id,
      status: "failed",
      now,
      failureReason: "invalid_signature",
    });
    return { status: "invalid_signature" as const, challenge: marked };
  }

  // ── Sybil guard: one account per wallet ────────────────────────────────
  // A valid signature proves control of the address, so the signer's account
  // becomes its sole owner. Any other account that previously verified this
  // address is demoted here (and its token entitlements revoked further down)
  // — otherwise one whale wallet could sig-verify N accounts and every one of
  // them would qualify for token tiers off the same on-chain balance. The
  // partial unique index user_wallets_primary_address_uniq backstops this at
  // the DB level.
  const displacedClaims = await loadOtherAccountWalletClaims({
    db: admin,
    userId: params.userId,
    normalizedAddress: challenge.normalized_address,
  });
  if (displacedClaims.length > 0) {
    await demoteDisplacedWalletClaims({
      db: admin,
      claims: displacedClaims,
      challengeId: challenge.id,
      now,
    });
  }

  const clearPrimaryResult = await table(admin, "user_wallets")
    .update({ is_primary: false })
    .eq("user_id", params.userId)
    .eq("chain_type", "evm");

  if (clearPrimaryResult.error) {
    throw new Error("Failed to clear primary wallet");
  }

  let walletRow: UserWalletRow | null = null;
  for (let attempt = 0; attempt < 2 && !walletRow; attempt++) {
    const { data: walletData, error: walletError } = await table(admin, "user_wallets")
      .upsert(
        {
          user_id: params.userId,
          chain_type: "evm",
          chain_id: challenge.chain_id,
          address: challenge.normalized_address,
          normalized_address: challenge.normalized_address,
          is_primary: true,
          verified_at: now.toISOString(),
          verification_method: "signature",
          verification_reference: challenge.id,
          metadata: {},
        },
        { onConflict: "user_id,chain_type,normalized_address" }
      )
      .select("id, user_id, address, normalized_address, chain_type, chain_id, is_primary, verified_at")
      .single();

    if (!walletError && walletData) {
      walletRow = walletData as UserWalletRow;
      break;
    }

    // A concurrent verification on another account can slip its primary row in
    // between our demote pass and this upsert; the global partial unique index
    // rejects ours with 23505. Demote the late claim and retry once.
    const code = (walletError as { code?: string } | null)?.code;
    if (attempt === 0 && code === "23505") {
      const lateClaims = await loadOtherAccountWalletClaims({
        db: admin,
        userId: params.userId,
        normalizedAddress: challenge.normalized_address,
      });
      if (lateClaims.length > 0) {
        await demoteDisplacedWalletClaims({
          db: admin,
          claims: lateClaims,
          challengeId: challenge.id,
          now,
        });
        displacedClaims.push(...lateClaims);
      }
      continue;
    }

    throw new Error("Failed to store verified wallet");
  }

  if (!walletRow) {
    throw new Error("Failed to store verified wallet");
  }

  const marked = await markChallenge({
    db: admin,
    challengeId: challenge.id,
    status: "verified",
    now,
  });

  // Revoke the displaced accounts' token entitlements AFTER the verification
  // itself is committed: the wallet rows are already consistent (demoted +
  // unique index), so a failure here must not surface as a failed
  // verification — the challenge is consumed and can't be retried. Leftovers
  // go to the ops feed instead.
  const displacedUserIds = Array.from(new Set(displacedClaims.map((claim) => claim.user_id)));
  const revoke = params.revokeDisplacedEntitlementsImpl ?? revokeDisplacedTokenEntitlements;
  for (const displacedUserId of displacedUserIds) {
    try {
      await revoke({
        userId: displacedUserId,
        normalizedAddress: challenge.normalized_address,
        challengeId: challenge.id,
        db: admin,
        now,
      });
    } catch (error) {
      await reportOpsEvent({
        source: "billing.wallet-verification",
        severity: "warn",
        title: "Wallet takeover: displaced account entitlement revocation failed",
        message:
          `Wallet ${challenge.normalized_address} moved to another account, but revoking the ` +
          `displaced account's token-tier standing failed. That account may keep token ` +
          `entitlements without a wallet behind them until fixed manually.`,
        userId: displacedUserId,
        metadata: {
          failureType: "wallet_takeover_revocation_failed",
          challengeId: challenge.id,
          normalizedAddress: challenge.normalized_address,
          cause: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  return {
    status: "verified" as const,
    challenge: marked,
    wallet: asWallet(walletRow),
    takeover: displacedUserIds.length > 0 ? { displacedUserIds } : null,
  };
}
