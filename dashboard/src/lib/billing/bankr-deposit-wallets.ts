import { requireDb } from "@/lib/billing/db-utils";
import { encryptApiKey, decryptApiKey, formatKeyPreview } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase";
import {
  getBankrPartnerConfig,
  getBankrWalletForUser,
  parseBankrWalletApiKeySecret,
  provisionBankrWalletForUser,
  type BankrLinkedWallet,
  type BankrWalletApiKeyRequest,
} from "@/lib/billing/bankr-wallets";
import { normalizeEvmAddress } from "@/lib/billing/token-holdings";

type QueryError = { message?: string } | null;

type DbFilter = {
  select: (...args: unknown[]) => DbFilter;
  eq: (...args: unknown[]) => DbFilter;
  in: (...args: unknown[]) => DbFilter;
  order: (...args: unknown[]) => DbFilter;
  limit: (...args: unknown[]) => DbFilter;
  maybeSingle: () => Promise<{ data: unknown; error: QueryError }>;
  single: () => Promise<{ data: unknown; error: QueryError }>;
};

type DbMutationFilter = {
  eq: (...args: unknown[]) => DbMutationFilter;
  then: Promise<{ error: QueryError }>["then"];
};

type DbTable = {
  select: (...args: unknown[]) => DbFilter;
  upsert: (...args: unknown[]) => DbFilter;
  update: (...args: unknown[]) => DbMutationFilter;
  insert: (...args: unknown[]) => Promise<{ error: QueryError }>;
};

type SupabaseLike = {
  from: (name: string) => unknown;
};

type BankrPartnerFetch = (
  input: string,
  init: {
    method: "POST";
    headers: {
      "Content-Type": "application/json";
      "X-Partner-Key": string;
    };
    body: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

type BankrWalletFetch = (
  input: string,
  init: {
    method: "POST";
    headers: {
      "Content-Type": "application/json";
      "X-API-Key": string;
    };
    body: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

interface BankrDepositWalletCredentialRow {
  id: string;
  user_id: string;
  purpose?: BankrDepositWalletPurpose;
  wallet_id: string | null;
  bankr_wallet_id: string;
  evm_address: string;
  normalized_evm_address: string;
  api_key_encrypted?: string | null;
  api_key_preview?: string | null;
  api_key_status: "active" | "missing" | "revoked" | "rotating" | "failed";
  allowed_recipient_evm?: string | null;
  allowed_ips?: unknown;
  permissions?: unknown;
  metadata?: unknown;
  created_at?: string;
  updated_at?: string;
}

export interface BankrDepositWalletCredential {
  id: string;
  userId: string;
  purpose: BankrDepositWalletPurpose;
  walletId: string | null;
  bankrWalletId: string;
  evmAddress: string;
  normalizedEvmAddress: string;
  apiKeyEncrypted: string | null;
  apiKeyPreview: string | null;
  apiKeyStatus: BankrDepositWalletCredentialRow["api_key_status"];
  allowedRecipientEvm: string | null;
  allowedIps: string[];
  permissions: Record<string, unknown>;
}

export interface BankrDepositWalletResult {
  status: "existing" | "provisioned" | "credential_created" | "not_configured";
  wallet: BankrLinkedWallet;
  bankrWallet: {
    id: string;
    evmAddress: string;
    solAddress: string | null;
    status: string | null;
    createdAt: string | null;
  };
  credential: BankrDepositWalletCredential | null;
}

export interface BankrTreasuryConfig {
  treasuryAddress: string | null;
  sweepEnabled: boolean;
  allowedIps: string[];
}

export type BankrDepositWalletPurpose =
  | "credit_deposit"
  | "hermesos_lock"
  // 2026-05-01: third purpose introduced for the yearly Pro/Power
  // payment flow. Tokens land here, the cron sweeps them to
  // HERMES_TREASURY_ADDRESS, and the wallet is intentionally hidden
  // from the main /dashboard/wallet UI — it's only used during the
  // "Pay yearly with $HermesOS" modal to keep subscription revenue
  // separate from credit-deposit accounting.
  | "yearly_subscription"
  // Receives $HERMESOS deposits that become managed Venice prepaid
  // inference-credit lots after quote settlement. Kept separate from
  // open platform credits and yearly subscription revenue.
  | "managed_venice_inference";

interface CryptoDepositReceiptForSweep {
  id: string;
  userId: string;
  chainId: number;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  depositAddress: string;
  normalizedDepositAddress: string;
  amountRaw: string;
  txHash: string;
  logIndex: number;
  depositMode: "checkout" | "open_credit" | "hermesos_lock_deposit";
}

function table(db: SupabaseLike, name: string): DbTable {
  return db.from(name) as DbTable;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readEnvValue(value: string | undefined): string | null {
  if (typeof value !== "string") return null;

  let normalized = value.trim();
  if (!normalized) return null;

  const quote = normalized[0];
  if ((quote === '"' || quote === "'") && normalized.endsWith(quote)) {
    normalized = normalized.slice(1, -1).trim();
  }

  return normalized || null;
}

function readAllowedIps(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function asCredential(row: BankrDepositWalletCredentialRow): BankrDepositWalletCredential {
  return {
    id: row.id,
    userId: row.user_id,
    purpose:
      row.purpose === "hermesos_lock" ||
      row.purpose === "yearly_subscription" ||
      row.purpose === "managed_venice_inference"
        ? row.purpose
        : "credit_deposit",
    walletId: row.wallet_id,
    bankrWalletId: row.bankr_wallet_id,
    evmAddress: row.evm_address,
    normalizedEvmAddress: row.normalized_evm_address,
    apiKeyEncrypted: row.api_key_encrypted || null,
    apiKeyPreview: row.api_key_preview || null,
    apiKeyStatus: row.api_key_status,
    allowedRecipientEvm: row.allowed_recipient_evm || null,
    allowedIps: readAllowedIps(row.allowed_ips),
    permissions: asRecord(row.permissions),
  };
}

function toBankrWalletPayload(wallet: BankrLinkedWallet) {
  return {
    id: wallet.bankrWalletId || wallet.id,
    evmAddress: wallet.normalizedAddress || wallet.address,
    solAddress: null,
    status: "active",
    createdAt: null,
  };
}

export function getBankrTreasuryConfig(
  env: Record<string, string | undefined> = process.env,
  purpose: BankrDepositWalletPurpose = "credit_deposit"
): BankrTreasuryConfig {
  const treasuryAddress = resolveDepositWalletTreasuryAddress(env, purpose);
  const allowedIps = env.BANKR_DEPOSIT_WALLET_ALLOWED_IPS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean) ?? [];

  return {
    treasuryAddress,
    sweepEnabled: env.BANKR_DEPOSIT_SWEEP_ENABLED === "true",
    allowedIps,
  };
}

function resolveDepositWalletTreasuryAddress(
  env: Record<string, string | undefined>,
  purpose: BankrDepositWalletPurpose
) {
  const candidateNames =
    purpose === "managed_venice_inference"
      ? [
          "MANAGED_VENICE_TREASURY_BASE_ADDRESS",
          "HERMES_TREASURY_BASE_ADDRESS",
          "HERMES_TREASURY_ADDRESS",
        ]
      : ["HERMES_TREASURY_BASE_ADDRESS", "HERMES_TREASURY_ADDRESS"];

  for (const name of candidateNames) {
    const value = readEnvValue(env[name]);
    if (value) return normalizeEvmAddress(value);
  }

  return null;
}

export function buildBankrDepositWalletApiKeyRequest(
  config: BankrTreasuryConfig,
  purpose: BankrDepositWalletPurpose = "credit_deposit"
): BankrWalletApiKeyRequest | null {
  if (!config.treasuryAddress) return null;

  return {
    name:
      purpose === "managed_venice_inference"
        ? "Hivra managed Venice treasury sweeper"
        : "Hivra deposit sweeper",
    permissions: {
      walletApiEnabled: true,
      agentApiEnabled: false,
      llmGatewayEnabled: false,
      tokenLaunchApiEnabled: false,
      readOnly: false,
    },
    allowedIps: config.allowedIps,
    allowedRecipients: {
      evm: [config.treasuryAddress],
      solana: [],
    },
  };
}

export async function getBankrDepositWalletCredentialForUser(params: {
  userId: string;
  purpose?: BankrDepositWalletPurpose;
  db?: SupabaseLike | null;
}) {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const { data, error } = await table(admin, "bankr_deposit_wallet_credentials")
    .select("*")
    .eq("user_id", params.userId)
    .eq("purpose", params.purpose ?? "credit_deposit")
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to load Bankr deposit wallet credential");
  }

  return data ? asCredential(data as BankrDepositWalletCredentialRow) : null;
}

export async function getBankrDepositWalletCredentialForAddress(params: {
  address: string;
  db?: SupabaseLike | null;
}) {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const normalizedAddress = normalizeEvmAddress(params.address);
  const { data, error } = await table(admin, "bankr_deposit_wallet_credentials")
    .select("*")
    .eq("normalized_evm_address", normalizedAddress)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to load Bankr deposit wallet credential");
  }

  return data ? asCredential(data as BankrDepositWalletCredentialRow) : null;
}

async function storeBankrDepositWalletCredential(params: {
  db: SupabaseLike;
  userId: string;
  purpose: BankrDepositWalletPurpose;
  wallet: BankrLinkedWallet;
  bankrWalletId: string;
  apiKeySecret?: string | null;
  apiKeyPreview?: string | null;
  apiKeyRequest: BankrWalletApiKeyRequest | null;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const normalizedAddress = normalizeEvmAddress(params.wallet.normalizedAddress || params.wallet.address);
  const encryptedSecret = params.apiKeySecret ? encryptApiKey(params.apiKeySecret) : null;
  const allowedRecipient = params.apiKeyRequest?.allowedRecipients?.evm?.[0]
    ? normalizeEvmAddress(params.apiKeyRequest.allowedRecipients.evm[0])
    : null;
  const query = table(params.db, "bankr_deposit_wallet_credentials").upsert(
    {
      user_id: params.userId,
      purpose: params.purpose,
      wallet_id: params.wallet.id,
      bankr_wallet_id: params.bankrWalletId,
      evm_address: normalizedAddress,
      normalized_evm_address: normalizedAddress,
      api_key_encrypted: encryptedSecret,
      api_key_preview: params.apiKeySecret
        ? (params.apiKeyPreview || formatKeyPreview(params.apiKeySecret))
        : null,
      api_key_status: params.apiKeySecret ? "active" : "missing",
      allowed_recipient_evm: allowedRecipient,
      allowed_ips: params.apiKeyRequest?.allowedIps ?? [],
      permissions: params.apiKeyRequest?.permissions ?? {},
      metadata: {
        purpose: params.purpose,
        custodyModel: "platform_deposit_address",
        updatedAt: now.toISOString(),
      },
      updated_at: now.toISOString(),
    },
    { onConflict: "user_id,purpose" }
  );
  const { data, error } = await query.select("*").single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to store Bankr deposit wallet credential");
  }

  return asCredential(data as BankrDepositWalletCredentialRow);
}

async function createBankrWalletApiKey(params: {
  bankrWalletId: string;
  apiKeyRequest: BankrWalletApiKeyRequest;
  env?: Record<string, string | undefined>;
  fetchImpl?: BankrPartnerFetch;
}) {
  const config = getBankrPartnerConfig(params.env);
  if (!config.partnerKey) {
    return null;
  }

  const fetchImpl = params.fetchImpl || (fetch as unknown as BankrPartnerFetch);
  const response = await fetchImpl(
    `${config.apiBaseUrl}/partner/wallets/${encodeURIComponent(params.bankrWalletId)}/api-keys`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Partner-Key": config.partnerKey,
      },
      body: JSON.stringify(params.apiKeyRequest),
    }
  );

  if (!response.ok) {
    // Surface Bankr's response body so we can tell apart cap-exceeded,
    // auth issues, validation errors, etc. without a redeploy. NEVER
    // returned to the client. BankrPartnerFetch only exposes .json(),
    // not .text(), so we stringify the parsed JSON.
    let detail = "<no body>";
    try {
      const body = await response.json();
      detail = JSON.stringify(body).slice(0, 400);
    } catch {
      // Non-JSON body or already consumed — keep "<no body>" placeholder.
    }
    if (process.env.NODE_ENV !== "test") {
      // eslint-disable-next-line no-console
      console.error(
        `[bankr-deposit-wallets] API key creation failed status=${response.status} body=${detail}`
      );
    }
    // Per-wallet 20-key cap: don't crash the wallet-provision route. The
    // credential row will store apiKeySecret=null and we can mint later
    // (or after a Bankr cleanup) without blocking the user's signup.
    if (response.status === 400 && detail.includes("Maximum of 20 active API keys")) {
      return null;
    }
    throw new Error(`Bankr deposit wallet API key creation failed with status ${response.status}`);
  }

  return parseBankrWalletApiKeySecret(await response.json());
}

export async function ensureBankrDepositWalletForUser(params: {
  userId: string;
  purpose?: BankrDepositWalletPurpose;
  db?: SupabaseLike | null;
  env?: Record<string, string | undefined>;
  fetchImpl?: BankrPartnerFetch;
  now?: Date;
  makePrimary?: boolean;
}): Promise<BankrDepositWalletResult | { status: "not_configured" }> {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const purpose = params.purpose ?? "credit_deposit";
  const treasuryConfig = getBankrTreasuryConfig(params.env, purpose);
  const apiKeyRequest = buildBankrDepositWalletApiKeyRequest(treasuryConfig, purpose);
  const existingCredential = await getBankrDepositWalletCredentialForUser({
    userId: params.userId,
    purpose,
    db: admin,
  });
  const existingWallet = await getBankrWalletForUser({
    userId: params.userId,
    db: admin,
    purpose,
  });

  if (existingCredential && existingWallet) {
    if (existingCredential.apiKeyEncrypted || !apiKeyRequest) {
      return {
        status: "existing",
        wallet: existingWallet,
        bankrWallet: toBankrWalletPayload(existingWallet),
        credential: existingCredential,
      };
    }
  }

  const provisionResult = await provisionBankrWalletForUser({
    userId: params.userId,
    db: admin,
    env: params.env,
    fetchImpl: params.fetchImpl,
    now: params.now,
    makePrimary: params.makePrimary ?? true,
    walletPurpose: purpose,
    apiKey: existingWallet ? null : apiKeyRequest,
  });

  if (provisionResult.status === "not_configured") {
    return { status: "not_configured" };
  }

  let bankrApiKey = "bankrApiKey" in provisionResult ? provisionResult.bankrApiKey : null;
  if (!bankrApiKey && apiKeyRequest) {
    bankrApiKey = await createBankrWalletApiKey({
      bankrWalletId: provisionResult.bankrWallet.id,
      apiKeyRequest,
      env: params.env,
      fetchImpl: params.fetchImpl,
    });
  }

  const credential = await storeBankrDepositWalletCredential({
    db: admin,
    userId: params.userId,
    purpose,
    wallet: provisionResult.wallet,
    bankrWalletId: provisionResult.bankrWallet.id,
    apiKeySecret: bankrApiKey?.secret ?? null,
    apiKeyPreview: bankrApiKey?.preview ?? null,
    apiKeyRequest,
    now: params.now,
  });

  return {
    status: existingCredential ? "credential_created" : provisionResult.status,
    wallet: provisionResult.wallet,
    bankrWallet: provisionResult.bankrWallet,
    credential,
  };
}

function parseBankrTransferTxHash(payload: unknown): string | null {
  const record = asRecord(payload);
  return (
    readString(record.transactionHash) ||
    readString(record.txHash) ||
    readString(record.hash)
  );
}

async function markSweepFailed(params: {
  db: SupabaseLike;
  receiptId: string;
  message: string;
  now: Date;
}) {
  await table(params.db, "crypto_wallet_sweeps")
    .update({
      status: "failed",
      last_error: params.message,
      updated_at: params.now.toISOString(),
    })
    .eq("crypto_deposit_receipt_id", params.receiptId);

  await table(params.db, "crypto_deposit_receipts")
    .update({
      sweep_status: "failed",
      updated_at: params.now.toISOString(),
    })
    .eq("id", params.receiptId);
}

function formatRawTokenAmount(raw: string, decimals: number) {
  const value = BigInt(raw);
  const padded = value.toString().padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals) || "0";
  const fractional = padded.slice(-decimals).replace(/0+$/, "");
  return fractional ? `${whole}.${fractional}` : whole;
}

export function bankrDepositWalletPublicSummary(credential: BankrDepositWalletCredential | null) {
  if (!credential) return null;

  return {
    custodyModel: "platform_deposit_address",
    purpose: credential.purpose,
    address: credential.evmAddress,
    normalizedAddress: credential.normalizedEvmAddress,
    bankrWalletId: credential.bankrWalletId,
    sweepReady: credential.apiKeyStatus === "active",
    allowedRecipientEvm: credential.allowedRecipientEvm,
  };
}
