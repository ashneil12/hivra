import { requireDb } from "@/lib/billing/db-utils";
import { supabaseAdmin } from "@/lib/supabase";
import { BASE_CHAIN_ID, normalizeEvmAddress } from "@/lib/billing/token-holdings";
import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";

export const DEFAULT_BANKR_API_BASE_URL = "https://api.bankr.bot";

type DbMutationFilter = {
  eq: (...args: unknown[]) => DbMutationFilter;
  then: Promise<{ error: unknown }>["then"];
};

type DbFilter = {
  select: (...args: unknown[]) => DbFilter;
  eq: (...args: unknown[]) => DbFilter;
  order: (...args: unknown[]) => DbFilter;
  limit: (...args: unknown[]) => DbFilter;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  single: () => Promise<{ data: unknown; error: unknown }>;
};

type DbTable = {
  select: (...args: unknown[]) => DbFilter;
  update: (...args: unknown[]) => DbMutationFilter;
  upsert: (...args: unknown[]) => DbFilter;
};

type SupabaseLike = {
  from: (name: string) => unknown;
};

type BankrFetch = (
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
  text?: () => Promise<string>;
}>;

export type BankrPartnerFetch = BankrFetch;
type BankrPartnerResponse = Awaited<ReturnType<BankrFetch>>;

export interface BankrWalletApiKeyRequest {
  name?: string;
  permissions?: {
    walletApiEnabled?: boolean;
    agentApiEnabled?: boolean;
    llmGatewayEnabled?: boolean;
    tokenLaunchApiEnabled?: boolean;
    readOnly?: boolean;
  };
  allowedIps?: string[];
  allowedRecipients?: {
    evm?: string[];
    solana?: string[];
  };
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
  verification_reference: string | null;
}

interface ParsedBankrWalletResponse {
  bankrWalletId: string;
  evmAddress: string;
  normalizedEvmAddress: string;
  solAddress: string | null;
  status: string | null;
  createdAt: string | null;
  apiKeyReturned: boolean;
}

export interface BankrWalletApiKeySecret {
  secret: string;
  preview: string;
}

export interface BankrLinkedWallet {
  id: string;
  userId: string;
  address: string;
  normalizedAddress: string;
  chainId: number | null;
  isPrimary: boolean;
  verifiedAt: string | null;
  bankrWalletId: string | null;
}

function table(db: SupabaseLike, name: string): DbTable {
  return db.from(name) as DbTable;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readEnvValue(value: string | undefined): string | null {
  if (typeof value !== "string") return null;

  let normalized = value.trim();
  if (!normalized) return null;

  const quote = normalized[0];
  if (
    (quote === '"' || quote === "'") &&
    normalized.endsWith(quote)
  ) {
    normalized = normalized.slice(1, -1).trim();
  }

  return normalized || null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asWallet(row: UserWalletRow): BankrLinkedWallet {
  return {
    id: row.id,
    userId: row.user_id,
    address: row.address,
    normalizedAddress: row.normalized_address,
    chainId: row.chain_id,
    isPrimary: row.is_primary,
    verifiedAt: row.verified_at,
    bankrWalletId: row.verification_reference,
  };
}

function bankrWalletPayload(wallet: BankrLinkedWallet) {
  return {
    id: wallet.bankrWalletId || wallet.id,
    evmAddress: wallet.normalizedAddress || wallet.address,
    solAddress: null,
    status: "active",
    createdAt: null,
  };
}

function bankrApiKeySecretPayload(payload: unknown): BankrWalletApiKeySecret | null {
  const apiKey = readString(asRecord(payload)?.apiKey);
  if (!apiKey) return null;

  return {
    secret: apiKey,
    preview: apiKey.length <= 12
      ? `${apiKey.slice(0, 6)}...`
      : `${apiKey.slice(0, 10)}...${apiKey.slice(-4)}`,
  };
}

function buildCreateWalletPayload(params: {
  idempotencyKey: string;
  apiKey?: BankrWalletApiKeyRequest | null;
}) {
  return {
    idempotencyKey: params.idempotencyKey,
    ...(params.apiKey ? { apiKey: params.apiKey } : {}),
  };
}

async function makeExistingBankrWalletPrimary(params: {
  db: SupabaseLike;
  userId: string;
  wallet: BankrLinkedWallet;
}) {
  if (params.wallet.isPrimary) {
    return params.wallet;
  }

  const clearPrimaryResult = await table(params.db, "user_wallets")
    .update({ is_primary: false })
    .eq("user_id", params.userId)
    .eq("chain_type", "evm");

  if (clearPrimaryResult.error) {
    throw new Error("Failed to clear primary wallet");
  }

  const makePrimaryResult = await table(params.db, "user_wallets")
    .update({ is_primary: true })
    .eq("id", params.wallet.id)
    .eq("user_id", params.userId);

  if (makePrimaryResult.error) {
    throw new Error("Failed to mark Bankr wallet as primary");
  }

  return {
    ...params.wallet,
    isPrimary: true,
  };
}

export function getBankrPartnerConfig(
  env: Record<string, string | undefined> = process.env
) {
  const partnerKey =
    readEnvValue(env.BANKR_PARTNER_KEY) ||
    readEnvValue(env.BANKR_PARTNER_API_KEY) ||
    null;
  const apiBaseUrl = (
    readEnvValue(env.BANKR_API_BASE_URL) || DEFAULT_BANKR_API_BASE_URL
  ).replace(/\/+$/, "");

  return {
    configured: Boolean(partnerKey),
    partnerKey,
    apiBaseUrl,
  };
}

export function buildBankrWalletIdempotencyKey(userId: string, purpose?: string): string {
  const trimmedUserId = userId.trim();
  const trimmedPurpose = purpose?.trim();
  const idempotencyKey = trimmedPurpose ? `${trimmedUserId}:${trimmedPurpose}` : trimmedUserId;
  if (!idempotencyKey) {
    throw new Error("Bankr wallet user ID is required");
  }

  if (idempotencyKey.length > 128) {
    throw new Error("Bankr wallet user ID is too long");
  }

  return idempotencyKey;
}

export function parseBankrWalletResponse(payload: unknown): ParsedBankrWalletResponse {
  const record = asRecord(payload);
  const bankrWalletId = readString(record?.id);
  const evmAddress = readString(record?.evmAddress);

  if (!bankrWalletId || !evmAddress) {
    throw new Error("Bankr wallet response is missing required fields");
  }

  return {
    bankrWalletId,
    evmAddress,
    normalizedEvmAddress: normalizeEvmAddress(evmAddress),
    solAddress: readString(record?.solAddress),
    status: readString(record?.status),
    createdAt: readString(record?.createdAt),
    apiKeyReturned: Boolean(readString(record?.apiKey)),
  };
}

export function parseBankrWalletApiKeySecret(payload: unknown): BankrWalletApiKeySecret | null {
  return bankrApiKeySecretPayload(payload);
}

const BANKR_ERROR_BODY_MAX_LENGTH = 800;

export class BankrPartnerResponseError extends Error {
  readonly operation: string;
  readonly status: number;
  readonly responseBody: string | null;

  constructor(params: {
    operation: string;
    status: number;
    responseBody: string | null;
  }) {
    super(`${params.operation} failed with status ${params.status}${params.responseBody ? `: ${params.responseBody}` : ""}`);
    this.name = "BankrPartnerResponseError";
    this.operation = params.operation;
    this.status = params.status;
    this.responseBody = params.responseBody;
  }
}

function stringifyBankrErrorPayload(payload: unknown): string | null {
  if (typeof payload === "string") return payload;

  try {
    return JSON.stringify(payload);
  } catch {
    return null;
  }
}

async function readBankrErrorBody(response: Pick<BankrPartnerResponse, "json" | "text">): Promise<string | null> {
  let body: string | null = null;

  if (typeof response.text === "function") {
    try {
      body = await response.text();
    } catch {
      body = null;
    }
  }

  if (!body) {
    try {
      body = stringifyBankrErrorPayload(await response.json());
    } catch {
      body = null;
    }
  }

  const trimmed = body?.trim();
  if (!trimmed) return null;

  return redactSensitiveCommandOutput(trimmed, BANKR_ERROR_BODY_MAX_LENGTH);
}

export async function buildBankrPartnerResponseError(
  operation: string,
  response: Pick<BankrPartnerResponse, "status" | "json" | "text">
): Promise<BankrPartnerResponseError> {
  const body = await readBankrErrorBody(response);
  return new BankrPartnerResponseError({
    operation,
    status: response.status,
    responseBody: body,
  });
}

export async function bankrPartnerFetch(params: {
  path: string;
  body: unknown;
  env?: Record<string, string | undefined>;
  fetchImpl?: BankrFetch;
}) {
  const config = getBankrPartnerConfig(params.env);
  if (!config.partnerKey) {
    throw new Error("Bankr partner key is not configured");
  }

  const fetchImpl = params.fetchImpl || (fetch as unknown as BankrFetch);
  const path = params.path.startsWith("/") ? params.path : `/${params.path}`;
  return fetchImpl(`${config.apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Partner-Key": config.partnerKey,
    },
    body: JSON.stringify(params.body),
  });
}

export async function provisionBankrWalletForUser(params: {
  userId: string;
  db?: SupabaseLike | null;
  env?: Record<string, string | undefined>;
  fetchImpl?: BankrFetch;
  now?: Date;
  makePrimary?: boolean;
  apiKey?: BankrWalletApiKeyRequest | null;
  walletPurpose?: string;
}) {
  const config = getBankrPartnerConfig(params.env);
  if (!config.partnerKey) {
    return { status: "not_configured" as const };
  }

  const admin = requireDb(params.db ?? supabaseAdmin);
  const existingWallet = await getBankrWalletForUser({
    userId: params.userId,
    db: admin,
    purpose: params.walletPurpose,
  });

  if (existingWallet) {
    const wallet = params.makePrimary
      ? await makeExistingBankrWalletPrimary({
          db: admin,
          userId: params.userId,
          wallet: existingWallet,
        })
      : existingWallet;

    return {
      status: "existing" as const,
      wallet,
      bankrWallet: bankrWalletPayload(wallet),
    };
  }

  const idempotencyKey = buildBankrWalletIdempotencyKey(params.userId, params.walletPurpose);
  const response = await bankrPartnerFetch({
    path: "/partner/wallets",
    env: params.env,
    fetchImpl: params.fetchImpl,
    body: buildCreateWalletPayload({
      idempotencyKey,
      apiKey: params.apiKey ?? null,
    }),
  });

  if (!response.ok) {
    throw await buildBankrPartnerResponseError("Bankr wallet provisioning", response);
  }

  const bankrPayload = await response.json();
  const bankrWallet = parseBankrWalletResponse(bankrPayload);
  const bankrApiKey = params.apiKey ? bankrApiKeySecretPayload(bankrPayload) : null;
  const now = params.now ?? new Date();
  const walletRecord: Record<string, unknown> = {
    user_id: params.userId,
    chain_type: "evm",
    chain_id: BASE_CHAIN_ID,
    address: bankrWallet.normalizedEvmAddress,
    normalized_address: bankrWallet.normalizedEvmAddress,
    label: params.walletPurpose === "hermesos_lock" ? "Bankr Hivra lock wallet" : "Bankr wallet",
    verified_at: now.toISOString(),
    verification_method: "bankr",
    verification_reference: bankrWallet.bankrWalletId,
    metadata: {
      bankr: {
        walletId: bankrWallet.bankrWalletId,
        status: bankrWallet.status,
        solAddress: bankrWallet.solAddress,
        createdAt: bankrWallet.createdAt,
        provisionedAt: now.toISOString(),
        apiKeyReturned: bankrWallet.apiKeyReturned,
        ...(params.walletPurpose ? { purpose: params.walletPurpose } : {}),
      },
    },
  };

  if (params.makePrimary) {
    const clearPrimaryResult = await table(admin, "user_wallets")
      .update({ is_primary: false })
      .eq("user_id", params.userId)
      .eq("chain_type", "evm");

    if (clearPrimaryResult.error) {
      throw new Error("Failed to clear primary wallet");
    }

    walletRecord.is_primary = true;
  }

  const { data, error } = await table(admin, "user_wallets")
    .upsert(walletRecord, { onConflict: "user_id,chain_type,normalized_address" })
    .select("id, user_id, address, normalized_address, chain_type, chain_id, is_primary, verified_at, verification_reference")
    .single();

  if (error || !data) {
    throw new Error("Failed to store Bankr wallet");
  }

  return {
    status: "provisioned" as const,
    wallet: asWallet(data as UserWalletRow),
    bankrWallet: {
      id: bankrWallet.bankrWalletId,
      evmAddress: bankrWallet.normalizedEvmAddress,
      solAddress: bankrWallet.solAddress,
      status: bankrWallet.status,
      createdAt: bankrWallet.createdAt,
    },
    ...(bankrApiKey ? { bankrApiKey } : {}),
  };
}

export async function getBankrWalletForUser(params: {
  userId: string;
  db?: SupabaseLike | null;
  purpose?: string;
}) {
  const admin = requireDb(params.db ?? supabaseAdmin);
  let query = table(admin, "user_wallets")
    .select("id, user_id, address, normalized_address, chain_type, chain_id, is_primary, verified_at, verification_reference")
    .eq("user_id", params.userId)
    .eq("chain_type", "evm")
    .eq("verification_method", "bankr");
  if (params.purpose) {
    query = query.eq("metadata->bankr->>purpose", params.purpose);
  }
  const { data, error } = await query
    .order("verified_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error("Failed to load Bankr wallet");
  }

  return data ? asWallet(data as UserWalletRow) : null;
}
