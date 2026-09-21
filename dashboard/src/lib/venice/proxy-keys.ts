import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import {
  ensureManagedVeniceWalletAccount,
  getManagedVeniceWalletSummary,
  type ManagedVeniceWalletType,
} from "@/lib/billing/managed-venice-wallets";
import {
  grantManagedVeniceStarterCredit,
  isManagedVeniceStarterCreditEnabled,
} from "@/lib/venice/managed-venice-starter-credit";

export type ManagedVeniceProxyKeyStatus = "active" | "revoked" | "paused";

type QueryError = { code?: string; message?: string } | null;

type DbChain = {
  select: (...args: unknown[]) => DbChain;
  eq: (...args: unknown[]) => DbChain;
  order: (...args: unknown[]) => DbChain;
  single: () => Promise<{ data: unknown; error: QueryError }>;
  maybeSingle: () => Promise<{ data: unknown; error: QueryError }>;
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

type DbInsertChain = {
  select: (...args: unknown[]) => {
    single: () => Promise<{ data: unknown; error: QueryError }>;
  };
};

type DbUpdateFilter = {
  eq: (...args: unknown[]) => DbUpdateFilter;
  select: (...args: unknown[]) => {
    single: () => Promise<{ data: unknown; error: QueryError }>;
  };
  then: Promise<{ error: QueryError }>["then"];
};

type DbTable = {
  insert: (...args: unknown[]) => DbInsertChain;
  select: (...args: unknown[]) => DbChain;
  update: (...args: unknown[]) => DbUpdateFilter;
};

type SupabaseLike = {
  from: (table: string) => unknown;
};

interface ProxyKeyRow {
  id: string;
  account_id: string;
  user_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  status: ManagedVeniceProxyKeyStatus;
  paused_reason?: string | null;
  last_used_at?: string | null;
  revoked_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

const SELECT_COLUMNS =
  "id, account_id, user_id, name, key_hash, key_prefix, status, paused_reason, " +
  "last_used_at, revoked_at, created_at, updated_at, metadata";

function requireDb(db: SupabaseLike | null | undefined): SupabaseLike {
  if (!db) throw new Error("Database not configured");
  return db;
}

function table(db: SupabaseLike, name: string): DbTable {
  return db.from(name) as DbTable;
}

function requireUserId(userId: string) {
  if (!userId.trim()) {
    throw new Error("Managed Venice proxy key user ID is required");
  }
}

function requirePepper(env: Record<string, string | undefined> = process.env) {
  const pepper = env.MANAGED_VENICE_PROXY_KEY_PEPPER?.trim();
  if (!pepper) {
    throw new Error("MANAGED_VENICE_PROXY_KEY_PEPPER is required");
  }
  return pepper;
}

function keyName(name: string | null | undefined) {
  const trimmed = name?.trim();
  return trimmed || "Managed Venice key";
}

function asPublicKey(row: ProxyKeyRow) {
  const defaultWalletType = readDefaultWalletType(row.metadata);
  return {
    id: row.id,
    accountId: row.account_id,
    userId: row.user_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    status: row.status,
    pausedReason: row.paused_reason || null,
    lastUsedAt: row.last_used_at || null,
    revokedAt: row.revoked_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    defaultWalletType,
  };
}

function asVerifiedKey(row: ProxyKeyRow) {
  return {
    ...asPublicKey(row),
    keyHash: row.key_hash,
  };
}

function readDefaultWalletType(
  metadata: Record<string, unknown> | null | undefined
): ManagedVeniceWalletType {
  return metadata?.defaultWalletType === "card" ? "card" : "hermesos";
}

export function hashManagedVeniceProxyKey(
  plaintextKey: string,
  env: Record<string, string | undefined> = process.env
) {
  const pepper = requirePepper(env);
  return createHash("sha256").update(plaintextKey).update(pepper).digest("hex");
}

export function generateManagedVenicePlaintextKey(
  randomBytes: (size: number) => Buffer = nodeRandomBytes
) {
  return `hven_live_${randomBytes(32).toString("base64url")}`;
}

/**
 * Pick the wallet a NEWLY MINTED key will bill, for deploy paths where the
 * requested wallet is an implicit client-side default rather than a deliberate
 * user choice.
 *
 * THE RULE — one-directional, hermesos → card, and only off a PROVABLY EMPTY
 * wallet:
 *
 *   requested = card                      -> card       (never overridden)
 *   requested = hermesos, hermesos funded -> hermesos   (never overridden)
 *   requested = hermesos, hermesos == 0, card > 0 -> card
 *   requested = hermesos, both == 0       -> hermesos   (nothing to pick)
 *
 * WHY ONE-DIRECTIONAL. The hermesos wallet is backed by $HermesOS token lots
 * the user bought and holds; the card wallet is USD the user (or we) put there
 * expressly to spend on managed Venice. Falling hermesos → card only ever
 * spends money already earmarked for inference. Falling the other way (card →
 * hermesos) would liquidate a token holder's lots to pay for inference they
 * asked to bill to a card — so we never do it, even though it would "work".
 * `WelcomeFlow` already applies exactly this one-directional rule client-side
 * (it flips the picker hermesos → card when hermesos is empty and card is
 * funded); this is the same rule, evaluated server-side at mint time where it
 * can actually see a starter credit granted moments earlier in this same call.
 *
 * WHY "PROVABLY EMPTY" AND NOT "INSUFFICIENT". We switch only when the
 * requested wallet has zero available balance — never on a merely-small one.
 * A key bound to a zero-balance wallet is a brick: every request 402s, forever.
 * A key bound to a low-balance wallet is a normal, recoverable state that the
 * user resolves by topping up the wallet they chose. Overriding the latter
 * would silently move spend between wallets on users who have both funded.
 *
 * Never throws: a balance-read failure degrades to the requested wallet, which
 * is exactly today's behavior. Callers are on the deploy hot path.
 */
async function resolveFundedWalletType(
  params: { userId: string; requested: ManagedVeniceWalletType },
  db: SupabaseLike
): Promise<ManagedVeniceWalletType> {
  // Card was explicitly asked for — nothing to resolve, and we never fall back
  // to hermesos (that would spend token lots the user didn't offer).
  if (params.requested === "card") return "card";

  try {
    const summary = await getManagedVeniceWalletSummary(params.userId, db);
    if (
      summary.hermesos.availableMicroUsd <= 0 &&
      summary.card.availableMicroUsd > 0
    ) {
      log.info("managed Venice key bound to card wallet — hermesos wallet is empty", {
        source: "managed-venice-proxy-keys",
        failureType: "managed_venice_key_wallet_autoselected",
        userId: params.userId,
        requestedWalletType: params.requested,
        effectiveWalletType: "card",
        cardAvailableMicroUsd: summary.card.availableMicroUsd,
      });
      return "card";
    }
  } catch (error) {
    // Balance unknown ⇒ honor the request. Same binding as before this fix.
    log.warn("managed Venice wallet balance read failed during key mint", {
      source: "managed-venice-proxy-keys",
      failureType: "managed_venice_key_wallet_autoselect_failed",
      userId: params.userId,
      requestedWalletType: params.requested,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  return params.requested;
}

export async function createManagedVeniceProxyKey(
  params: {
    userId: string;
    name?: string | null;
    randomBytes?: (size: number) => Buffer;
    env?: Record<string, string | undefined>;
    defaultWalletType?: ManagedVeniceWalletType;
    /**
     * Deploy paths only. When the caller's `defaultWalletType` is an implicit
     * default (the deploy card ships 'hermesos' unless the user's card wallet
     * was ALREADY funded at page load) rather than a deliberate pick, let the
     * mint re-resolve it against real balances — including a starter credit
     * granted microseconds ago, below. See `resolveFundedWalletType`.
     *
     * Defaults to false: explicit key-minting surfaces (the billing UI's key
     * form, managed-WebUI enable, the per-agent LLM re-enable) carry a real
     * wallet picker and must be honored verbatim.
     */
    autoSelectFundedWallet?: boolean;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  requireUserId(params.userId);
  const client = requireDb(db);
  const account = await ensureManagedVeniceWalletAccount(params.userId, client);
  const plaintextKey = generateManagedVenicePlaintextKey(params.randomBytes);
  // Hash BEFORE the starter grant so a missing pepper still fails fast, without
  // having handed out a credit for a key we were never going to be able to mint.
  const keyHash = hashManagedVeniceProxyKey(plaintextKey, params.env);
  const keyPrefix = plaintextKey.slice(0, 14);
  const requestedWalletType = params.defaultWalletType === "card" ? "card" : "hermesos";

  // First managed deploy ⇒ try the one-time abuse-gated starter credit. The
  // grant is flag-gated OFF by default, deduped one-per-user, and best-effort:
  // it must never block (or fail) a deploy, so a granted result is informative
  // only and any error is swallowed by the grant itself. Skip the call entirely
  // when the flag is off to avoid a needless DB round-trip on the hot path.
  //
  // ORDERING IS LOAD-BEARING (2026-07-08): the grant lands in the CARD wallet
  // and MUST settle before `resolveFundedWalletType` reads balances below —
  // otherwise a brand-new free user's key binds to the empty hermesos wallet
  // and their first message 402s against a credit they were just given. It also
  // means a later mint failure can leave a granted-but-unused credit; that is
  // fine and deliberate (the grant is the user's, is deduped per-user, and a
  // retried deploy will mint against it rather than double-grant).
  if (isManagedVeniceStarterCreditEnabled()) {
    try {
      await grantManagedVeniceStarterCredit({ userId: params.userId }, client);
    } catch (starterError) {
      // grantManagedVeniceStarterCredit is already no-throw, but belt-and-braces:
      // a starter-credit failure can never break a managed deploy.
      log.warn("managed Venice starter credit threw during proxy-key create", {
        source: "managed-venice-proxy-keys",
        failureType: "managed_venice_starter_credit_threw",
        userId: params.userId,
        errorMessage:
          starterError instanceof Error ? starterError.message : String(starterError),
      });
    }
  }

  // The wallet this key bills, for its whole life, across every managed-Venice
  // endpoint (chat, embeddings, images, audio, video, augment, anthropic). It
  // is read back out of `metadata.defaultWalletType` on every request, so it
  // must be right at mint time — there is no cross-wallet fallback downstream.
  const defaultWalletType = params.autoSelectFundedWallet
    ? await resolveFundedWalletType(
        { userId: params.userId, requested: requestedWalletType },
        client
      )
    : requestedWalletType;

  const { data, error } = await table(client, "managed_venice_proxy_keys")
    .insert({
      account_id: account.id,
      user_id: params.userId,
      name: keyName(params.name),
      key_hash: keyHash,
      key_prefix: keyPrefix,
      status: "active" satisfies ManagedVeniceProxyKeyStatus,
      metadata: { defaultWalletType },
    })
    .select(SELECT_COLUMNS)
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to create managed Venice proxy key");
  }

  // `defaultWalletType` on the returned key is the EFFECTIVE wallet, which may
  // differ from `params.defaultWalletType`. Callers that persist a wallet into
  // an instance/agent config must record THIS value, not what they asked for,
  // or the stored config drifts from what the key actually bills.
  return {
    ...asPublicKey(data as ProxyKeyRow),
    plaintextKey,
  };
}

export async function listManagedVeniceProxyKeys(
  userId: string,
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  requireUserId(userId);
  const client = requireDb(db);
  const { data, error } = await table(client, "managed_venice_proxy_keys")
    .select(SELECT_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message || "Failed to list managed Venice proxy keys");
  }

  return Array.isArray(data) ? (data as ProxyKeyRow[]).map(asPublicKey) : [];
}

export async function verifyManagedVeniceProxyKey(
  params: {
    plaintextKey: string;
    now?: Date;
    env?: Record<string, string | undefined>;
  },
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  if (!params.plaintextKey.startsWith("hven_live_")) {
    return null;
  }
  const client = requireDb(db);
  const keyHash = hashManagedVeniceProxyKey(params.plaintextKey, params.env);
  const { data, error } = await table(client, "managed_venice_proxy_keys")
    .select(SELECT_COLUMNS)
    .eq("key_hash", keyHash)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to verify managed Venice proxy key");
  }
  if (!data) return null;
  const row = data as ProxyKeyRow;
  if (row.status !== "active") return null;

  const now = params.now ?? new Date();
  const { data: updated, error: updateError } = await table(
    client,
    "managed_venice_proxy_keys"
  )
    .update({ last_used_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("id", row.id)
    .select(SELECT_COLUMNS)
    .single();

  if (updateError || !updated) {
    throw new Error(updateError?.message || "Failed to update managed Venice proxy key usage");
  }

  return asVerifiedKey(updated as ProxyKeyRow);
}

export class AgentModelKeyInUseError extends Error {
  constructor() {
    super("This key is bound to an agent computer. Open its Manage → Inference settings to finish any pending change, replace the key, or use native sign-in. If the computer is no longer needed, remove it from Hivra to complete key cleanup.");
  }
}

export async function revokeManagedVeniceProxyKey(
  params: { userId: string; keyId: string },
  db: SupabaseLike | null | undefined = supabaseAdmin
) {
  requireUserId(params.userId);
  if (!params.keyId.trim()) {
    throw new Error("Managed Venice proxy key ID is required");
  }
  const client = requireDb(db);
  const now = new Date().toISOString();
  const { data, error } = await table(client, "managed_venice_proxy_keys")
    .update({
      status: "revoked" satisfies ManagedVeniceProxyKeyStatus,
      revoked_at: now,
      updated_at: now,
    })
    .eq("id", params.keyId)
    .eq("user_id", params.userId)
    .select(SELECT_COLUMNS)
    .single();

  if (error || !data) {
    if (error?.code === "55000") throw new AgentModelKeyInUseError();
    throw new Error(error?.message || "Failed to revoke managed Venice proxy key");
  }

  return { revoked: true, key: asPublicKey(data as ProxyKeyRow) };
}
