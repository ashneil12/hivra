import { requireDb } from "@/lib/billing/db-utils";
import { decryptApiKey, encryptApiKey, formatKeyPreview } from "@/lib/crypto";
import { supabaseAdmin } from "@/lib/supabase";
import {
  buildBankrPartnerResponseError,
  bankrPartnerFetch,
  BankrPartnerResponseError,
  getBankrPartnerConfig,
  parseBankrWalletApiKeySecret,
  parseBankrWalletResponse,
  type BankrPartnerFetch,
  type BankrWalletApiKeyRequest,
} from "@/lib/billing/bankr-wallets";
import {
  decodeUint256RpcResult,
  encodeErc20BalanceOfCallData,
  formatRawTokenBalance,
  isEvmAddress,
  normalizeEvmAddress,
} from "@/lib/billing/token-holdings";

type QueryError = { message?: string } | null;

type DbFilter = {
  select: (...args: unknown[]) => DbFilter;
  eq: (...args: unknown[]) => DbFilter;
  order: (...args: unknown[]) => DbFilter;
  limit: (...args: unknown[]) => DbFilter;
  maybeSingle: () => Promise<{ data: unknown; error: QueryError }>;
  single: () => Promise<{ data: unknown; error: QueryError }>;
};

type DbMutationFilter = {
  eq: (...args: unknown[]) => DbMutationFilter;
  select: (...args: unknown[]) => DbFilter;
  then: Promise<{ error: QueryError }>["then"];
};

type DbTable = {
  select: (...args: unknown[]) => DbFilter;
  insert: (...args: unknown[]) => DbFilter;
  upsert: (...args: unknown[]) => DbFilter;
  update: (...args: unknown[]) => DbMutationFilter;
};

export type SupabaseLike = {
  from: (name: string) => unknown;
};

type JsonRpcFetch = (
  input: string,
  init: {
    method: "POST";
    headers: { "Content-Type": "application/json" };
    body: string;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

type InstanceBankrWalletStatus = "active" | "pending" | "failed" | "revoked";
type InstanceBankrApiKeyStatus = "active" | "missing" | "revoked" | "rotating" | "failed";

interface InstanceBankrWalletRow {
  id: string;
  instance_id: string | null;
  hivra_agent_id: string | null;
  user_id: string;
  bankr_wallet_id: string;
  evm_address: string;
  normalized_evm_address?: string | null;
  api_key_encrypted?: string | null;
  api_key_preview?: string | null;
  api_key_status: InstanceBankrApiKeyStatus;
  withdrawal_destination_evm?: string | null;
  withdrawal_destination_set_at?: string | null;
  status: InstanceBankrWalletStatus;
  metadata?: unknown;
  created_at: string;
  updated_at: string;
}

interface InstanceBankrWalletRecipientRow {
  id: string;
  wallet_id: string;
  instance_id: string;
  user_id: string;
  address: string;
  normalized_address: string;
  label?: string | null;
  is_primary: boolean;
  use_count: number;
  first_used_at: string;
  last_used_at: string;
  created_at: string;
  updated_at: string;
}

export interface InstanceBankrWalletRecord {
  id: string;
  /** Owning Hermes instance, or null when this is a Hivra-lane wallet. */
  instanceId: string | null;
  /** Owning Hivra-catalog box, or null when this is a Hermes-lane wallet. */
  hivraAgentId: string | null;
  userId: string;
  bankrWalletId: string;
  evmAddress: string;
  normalizedEvmAddress: string;
  apiKeyPreview: string | null;
  apiKeyStatus: InstanceBankrApiKeyStatus;
  withdrawalDestinationEvm: string | null;
  withdrawalDestinationSetAt: string | null;
  status: InstanceBankrWalletStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface InstanceBankrWalletRecipientRecord {
  id: string;
  walletId: string;
  instanceId: string;
  userId: string;
  address: string;
  normalizedAddress: string;
  label: string | null;
  isPrimary: boolean;
  useCount: number;
  firstUsedAt: string;
  lastUsedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface InstanceBankrWalletRecipientPublicSummary {
  id: string;
  address: string;
  normalizedAddress: string;
  label: string | null;
  isPrimary: boolean;
  useCount: number;
  lastUsedAt: string;
}

export interface InstanceBankrWalletPublicSummary {
  evmAddress: string | null;
  bankrWalletId: string | null;
  status: InstanceBankrWalletRecord["status"];
  withdrawalDestinationEvm: string | null;
  apiKeyStatus: InstanceBankrWalletRecord["apiKeyStatus"];
}

export interface InstanceBankrAgentConfig {
  walletAddress: string;
  apiKey: string;
  walletId: string;
  withdrawalDestination: string | null;
}

interface InstanceBankrWalletBalance {
  tokenSymbol: string;
  balanceDisplay: string;
}

export interface InstanceBankrWalletTokenBalance extends InstanceBankrWalletBalance {
  chain: "Base";
  tokenAddress: string | null;
  tokenDecimals: number;
}

const PENDING_EVM_ADDRESS = "0x0000000000000000000000000000000000000000";
const BASE_USDC_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BASE_TRACKED_ERC20_TOKENS = [
  {
    symbol: "USDC",
    address: BASE_USDC_ADDRESS,
    decimals: 6,
  },
  {
    symbol: "HERMESOS",
    address: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3",
    decimals: 18,
  },
  {
    symbol: "BNKR",
    address: "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b",
    decimals: 18,
  },
  {
    symbol: "VVV",
    address: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf",
    decimals: 18,
  },
  {
    symbol: "DIEM",
    address: "0xf4d97f2da56e8c3098f3a8d538db630a2606a024",
    decimals: 18,
  },
] as const;
const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org";
const BALANCE_CACHE_TTL_MS = 60_000;
const balanceCache = new Map<string, { expiresAt: number; value: InstanceBankrWalletBalance }>();
const tokenBalanceCache = new Map<string, { expiresAt: number; value: InstanceBankrWalletTokenBalance[] }>();

const INSTANCE_BANKR_AGENT_API_KEY_REQUEST: BankrWalletApiKeyRequest = {
  name: "Hivra agent instance wallet",
  permissions: {
    walletApiEnabled: true,
    agentApiEnabled: false,
    llmGatewayEnabled: false,
    tokenLaunchApiEnabled: false,
    readOnly: false,
  },
};

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

function readStatus(value: unknown): InstanceBankrWalletStatus {
  return value === "pending" || value === "failed" || value === "revoked"
    ? value
    : "active";
}

function readApiKeyStatus(value: unknown): InstanceBankrApiKeyStatus {
  return value === "missing" ||
    value === "revoked" ||
    value === "rotating" ||
    value === "failed"
    ? value
    : "active";
}

function asInstanceBankrWalletRecord(row: InstanceBankrWalletRow): InstanceBankrWalletRecord {
  const metadata = asRecord(row.metadata);
  const normalized = row.normalized_evm_address || row.evm_address.toLowerCase();

  return {
    id: row.id,
    instanceId: row.instance_id ?? null,
    hivraAgentId: row.hivra_agent_id ?? null,
    userId: row.user_id,
    bankrWalletId: row.bankr_wallet_id,
    evmAddress: row.evm_address,
    normalizedEvmAddress: normalized,
    apiKeyPreview: row.api_key_preview || null,
    apiKeyStatus: readApiKeyStatus(row.api_key_status),
    withdrawalDestinationEvm: row.withdrawal_destination_evm || null,
    withdrawalDestinationSetAt: row.withdrawal_destination_set_at || null,
    status: readStatus(row.status),
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    apiKeyEncrypted: row.api_key_encrypted || null,
  } as InstanceBankrWalletRecord;
}

function asInstanceBankrWalletRecipientRecord(
  row: InstanceBankrWalletRecipientRow
): InstanceBankrWalletRecipientRecord {
  return {
    id: row.id,
    walletId: row.wallet_id,
    instanceId: row.instance_id,
    userId: row.user_id,
    address: row.address,
    normalizedAddress: row.normalized_address,
    label: row.label || null,
    isPrimary: row.is_primary === true,
    useCount: Number(row.use_count ?? 0),
    firstUsedAt: row.first_used_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function hiddenApiKeyEncrypted(record: InstanceBankrWalletRecord): string | null {
  return readString((record as InstanceBankrWalletRecord & { apiKeyEncrypted?: unknown }).apiKeyEncrypted);
}

/**
 * A Bankr wallet belongs to exactly one owner: a Hermes instance (instance_id)
 * OR a Hivra-catalog box (hivra_agent_id). The DB enforces exactly-one via the
 * instance_bankr_wallets_one_owner CHECK. All provisioning/storage is keyed off
 * this owner so the Hermes and Hivra lanes share one table + one code path; the
 * public Hermes functions stay thin `instanceId` wrappers, byte-identical in
 * signature + behaviour.
 */
export type BankrWalletOwner =
  | { instanceId: string; hivraAgentId?: undefined }
  | { hivraAgentId: string; instanceId?: undefined };

function ownerColumn(owner: BankrWalletOwner): "instance_id" | "hivra_agent_id" {
  return owner.hivraAgentId ? "hivra_agent_id" : "instance_id";
}
function ownerId(owner: BankrWalletOwner): string {
  return owner.hivraAgentId ?? (owner.instanceId as string);
}
/** Owner-unique label for the Bankr partner idempotency key + pending wallet ids. */
function ownerLabel(owner: BankrWalletOwner): string {
  return owner.hivraAgentId ? `hivra:${owner.hivraAgentId}` : `instance:${owner.instanceId}`;
}

function pendingWalletPayload(params: {
  owner: BankrWalletOwner;
  userId: string;
  now: Date;
  existing?: InstanceBankrWalletRecord | null;
  reason: "not_configured" | "bankr_unreachable" | "bankr_rejected";
  error?: unknown;
}) {
  const errorMessage = params.error instanceof Error ? params.error.message : readString(params.error) ?? null;
  const bankrResponseError = params.error instanceof BankrPartnerResponseError ? params.error : null;
  return {
    [ownerColumn(params.owner)]: ownerId(params.owner),
    user_id: params.userId,
    bankr_wallet_id: params.existing?.bankrWalletId || `pending:${ownerLabel(params.owner)}`,
    evm_address:
      params.existing?.evmAddress && isEvmAddress(params.existing.evmAddress)
        ? params.existing.evmAddress
        : PENDING_EVM_ADDRESS,
    api_key_encrypted: null,
    api_key_preview: null,
    api_key_status: "missing",
    status: "pending",
    metadata: {
      ...(params.existing?.metadata || {}),
      custodyModel: "bankr_custodied_agent_wallet",
      lastProvisionReason: params.reason,
      lastProvisionAttemptAt: params.now.toISOString(),
      ...(errorMessage ? { lastProvisionError: errorMessage } : {}),
      ...(bankrResponseError
        ? {
            lastProvisionHttpStatus: bankrResponseError.status,
            lastProvisionOperation: bankrResponseError.operation,
          }
        : {}),
    },
    updated_at: params.now.toISOString(),
  };
}

async function storePendingWallet(params: {
  db: SupabaseLike;
  owner: BankrWalletOwner;
  userId: string;
  now: Date;
  existing?: InstanceBankrWalletRecord | null;
  reason: "not_configured" | "bankr_unreachable" | "bankr_rejected";
  error?: unknown;
}): Promise<InstanceBankrWalletRecord> {
  const { data, error } = await table(params.db, "instance_bankr_wallets")
    .upsert(pendingWalletPayload(params), { onConflict: ownerColumn(params.owner) })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to store pending Bankr instance wallet");
  }

  return asInstanceBankrWalletRecord(data as InstanceBankrWalletRow);
}

async function storeActiveWallet(params: {
  db: SupabaseLike;
  owner: BankrWalletOwner;
  userId: string;
  bankrWalletId: string;
  evmAddress: string;
  apiKeySecret: string;
  apiKeyPreview?: string | null;
  now: Date;
  existing?: InstanceBankrWalletRecord | null;
}): Promise<InstanceBankrWalletRecord> {
  const normalizedAddress = normalizeEvmAddress(params.evmAddress);
  const encryptedSecret = encryptApiKey(params.apiKeySecret);
  const { data, error } = await table(params.db, "instance_bankr_wallets")
    .upsert(
      {
        [ownerColumn(params.owner)]: ownerId(params.owner),
        user_id: params.userId,
        bankr_wallet_id: params.bankrWalletId,
        evm_address: normalizedAddress,
        api_key_encrypted: encryptedSecret,
        api_key_preview: params.apiKeyPreview || formatKeyPreview(params.apiKeySecret),
        api_key_status: "active",
        status: "active",
        metadata: {
          ...(params.existing?.metadata || {}),
          custodyModel: "bankr_custodied_agent_wallet",
          permissions: INSTANCE_BANKR_AGENT_API_KEY_REQUEST.permissions,
          walletApiEnabled: true,
          llmGatewayEnabled: false,
          tokenLaunchApiEnabled: false,
          agentApiEnabled: false,
          readOnly: false,
          allowedRecipients: null,
          allowedIps: null,
          provisionedAt: params.now.toISOString(),
        },
        updated_at: params.now.toISOString(),
      },
      { onConflict: ownerColumn(params.owner) }
    )
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to store Bankr instance wallet");
  }

  return asInstanceBankrWalletRecord(data as InstanceBankrWalletRow);
}

async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  fetchImpl: JsonRpcFetch
): Promise<T> {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`Base RPC request failed with status ${response.status}`);
  }

  const payload = asRecord(await response.json());
  const error = asRecord(payload.error);
  if (error.message) {
    throw new Error(String(error.message));
  }

  return payload.result as T;
}

function getBaseRpcUrl(env: Record<string, string | undefined> = process.env) {
  return env.HERMES_BASE_RPC_URL?.trim() || env.BASE_RPC_URL?.trim() || DEFAULT_BASE_RPC_URL;
}

function formatEthDisplay(balanceRaw: string): string {
  const value = formatRawTokenBalance(balanceRaw, 18);
  const [whole, fraction = ""] = value.split(".");
  if (!fraction) return `${whole}.0000`;
  if (whole === "0") return `${whole}.${fraction.padEnd(4, "0").slice(0, Math.max(4, Math.min(6, fraction.length)))}`;
  return `${whole}.${fraction.slice(0, 4).replace(/0+$/, "") || "0"}`;
}

function formatAgentWalletTokenDisplay(balanceRaw: string, decimals: number): string {
  return balanceRaw === "0" ? "0.0000" : formatRawTokenBalance(balanceRaw, decimals);
}

function isNonZeroDisplay(value: string): boolean {
  return value !== "0" && value !== "0.0000";
}

export function instanceBankrWalletPublicSummary(
  record: InstanceBankrWalletRecord | null
): InstanceBankrWalletPublicSummary | null {
  if (!record) return null;

  const isActive = record.status === "active";
  return {
    evmAddress: isActive ? record.evmAddress : null,
    bankrWalletId: isActive ? record.bankrWalletId : null,
    status: record.status,
    withdrawalDestinationEvm: record.withdrawalDestinationEvm,
    apiKeyStatus: record.apiKeyStatus,
  };
}

function instanceBankrWalletRecipientPublicSummary(
  record: InstanceBankrWalletRecipientRecord
): InstanceBankrWalletRecipientPublicSummary {
  return {
    id: record.id,
    address: record.address,
    normalizedAddress: record.normalizedAddress,
    label: record.label,
    isPrimary: record.isPrimary,
    useCount: record.useCount,
    lastUsedAt: record.lastUsedAt,
  };
}

export async function getBankrWalletForOwner(params: {
  owner: BankrWalletOwner;
  db?: SupabaseLike | null;
}): Promise<InstanceBankrWalletRecord | null> {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const { data, error } = await table(admin, "instance_bankr_wallets")
    .select("*")
    .eq(ownerColumn(params.owner), ownerId(params.owner))
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Failed to load Bankr instance wallet");
  }

  return data ? asInstanceBankrWalletRecord(data as InstanceBankrWalletRow) : null;
}

export async function getBankrWalletForInstance(params: {
  instanceId: string;
  db?: SupabaseLike | null;
}): Promise<InstanceBankrWalletRecord | null> {
  return getBankrWalletForOwner({ owner: { instanceId: params.instanceId }, db: params.db });
}

export async function getBankrWalletForHivraAgent(params: {
  hivraAgentId: string;
  db?: SupabaseLike | null;
}): Promise<InstanceBankrWalletRecord | null> {
  return getBankrWalletForOwner({ owner: { hivraAgentId: params.hivraAgentId }, db: params.db });
}

export async function listWithdrawalRecipientsForInstance(params: {
  instanceId: string;
  userId: string;
  limit?: number;
  db?: SupabaseLike | null;
}): Promise<InstanceBankrWalletRecipientPublicSummary[]> {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const limit = Math.max(1, Math.min(12, Math.floor(params.limit ?? 6)));
  const { data, error } = await (table(admin, "instance_bankr_wallet_recipients")
    .select("*")
    .eq("instance_id", params.instanceId)
    .eq("user_id", params.userId)
    .order("is_primary", { ascending: false })
    .order("last_used_at", { ascending: false })
    .limit(limit) as unknown as Promise<{ data: unknown; error: QueryError }>);

  if (error) {
    throw new Error(error.message || "Failed to load withdrawal recipients");
  }

  return Array.isArray(data)
    ? (data as InstanceBankrWalletRecipientRow[])
        .map(asInstanceBankrWalletRecipientRecord)
        .sort((a, b) => {
          if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
          return Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt);
        })
        .slice(0, limit)
        .map(instanceBankrWalletRecipientPublicSummary)
    : [];
}

export async function upsertWithdrawalRecipient(params: {
  instanceId: string;
  userId: string;
  address: string;
  label?: string | null;
  setPrimary?: boolean;
  incrementUseCount?: boolean;
  db?: SupabaseLike | null;
  now?: Date;
}): Promise<InstanceBankrWalletRecipientPublicSummary> {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const normalizedAddress = normalizeEvmAddress(params.address);
  const wallet = await getBankrWalletForInstance({
    instanceId: params.instanceId,
    db: admin,
  });
  if (!wallet || wallet.userId !== params.userId || wallet.status !== "active") {
    throw new Error("No active agent wallet found for withdrawal recipient");
  }

  const now = params.now ?? new Date();
  const timestamp = now.toISOString();
  const incrementUseCount = params.incrementUseCount !== false;
  const { data: existing, error: existingError } = await table(admin, "instance_bankr_wallet_recipients")
    .select("*")
    .eq("wallet_id", wallet.id)
    .eq("normalized_address", normalizedAddress)
    .maybeSingle();

  if (existingError) {
    throw new Error(existingError.message || "Failed to load withdrawal recipient");
  }

  if (params.setPrimary) {
    await table(admin, "instance_bankr_wallet_recipients")
      .update({
        is_primary: false,
        updated_at: timestamp,
      })
      .eq("wallet_id", wallet.id);
  }

  const existingRecord = existing
    ? asInstanceBankrWalletRecipientRecord(existing as InstanceBankrWalletRecipientRow)
    : null;
  const label = readString(params.label) ?? existingRecord?.label ?? null;
  const rowPatch = {
    wallet_id: wallet.id,
    instance_id: params.instanceId,
    user_id: params.userId,
    address: normalizedAddress,
    normalized_address: normalizedAddress,
    label,
    is_primary: params.setPrimary ? true : existingRecord?.isPrimary ?? false,
    use_count: (existingRecord?.useCount ?? 0) + (incrementUseCount ? 1 : 0),
    first_used_at: existingRecord?.firstUsedAt ?? timestamp,
    last_used_at: timestamp,
    updated_at: timestamp,
  };

  const mutation = existingRecord
    ? table(admin, "instance_bankr_wallet_recipients")
        .update(rowPatch)
        .eq("id", existingRecord.id)
        .select("*")
    : table(admin, "instance_bankr_wallet_recipients")
        .insert({
          ...rowPatch,
          created_at: timestamp,
        })
        .select("*");
  const { data, error } = await mutation.single();

  if (error || !data) {
    throw new Error(error?.message || "Failed to save withdrawal recipient");
  }

  if (params.setPrimary) {
    const { error: walletError } = await table(admin, "instance_bankr_wallets")
      .update({
        withdrawal_destination_evm: normalizedAddress,
        withdrawal_destination_set_at: timestamp,
        updated_at: timestamp,
      })
      .eq("id", wallet.id);
    if (walletError) {
      throw new Error(walletError.message || "Failed to update primary withdrawal recipient");
    }
  }

  return instanceBankrWalletRecipientPublicSummary(
    asInstanceBankrWalletRecipientRecord(data as InstanceBankrWalletRecipientRow)
  );
}

async function provisionBankrWalletForOwner(params: {
  owner: BankrWalletOwner;
  userId: string;
  db?: SupabaseLike | null;
  env?: Record<string, string | undefined>;
  fetchImpl?: BankrPartnerFetch;
  now?: Date;
}): Promise<{
  status: "existing" | "provisioned" | "pending" | "not_configured";
  record: InstanceBankrWalletRecord | null;
}> {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const now = params.now ?? new Date();
  const existing = await getBankrWalletForOwner({ owner: params.owner, db: admin });

  if (existing?.status === "active" && existing.apiKeyStatus === "active" && hiddenApiKeyEncrypted(existing)) {
    return { status: "existing", record: existing };
  }

  const config = getBankrPartnerConfig(params.env);
  if (!config.partnerKey) {
    const record = await storePendingWallet({
      db: admin,
      owner: params.owner,
      userId: params.userId,
      now,
      existing,
      reason: "not_configured",
    });
    return { status: "not_configured", record };
  }

  try {
    const walletResponse = await bankrPartnerFetch({
      path: "/partner/wallets",
      env: params.env,
      fetchImpl: params.fetchImpl,
      body: {
        idempotencyKey: ownerLabel(params.owner),
      },
    });

    if (!walletResponse.ok) {
      throw await buildBankrPartnerResponseError("Bankr wallet provisioning", walletResponse);
    }

    const wallet = parseBankrWalletResponse(await walletResponse.json());
    const apiKeyResponse = await bankrPartnerFetch({
      path: `/partner/wallets/${encodeURIComponent(wallet.bankrWalletId)}/api-keys`,
      env: params.env,
      fetchImpl: params.fetchImpl,
      body: INSTANCE_BANKR_AGENT_API_KEY_REQUEST,
    });

    if (!apiKeyResponse.ok) {
      throw await buildBankrPartnerResponseError("Bankr wallet API key creation", apiKeyResponse);
    }

    const apiKey = parseBankrWalletApiKeySecret(await apiKeyResponse.json());
    if (!apiKey?.secret) {
      throw new Error("Bankr wallet API key response is missing apiKey");
    }

    const record = await storeActiveWallet({
      db: admin,
      owner: params.owner,
      userId: params.userId,
      bankrWalletId: wallet.bankrWalletId,
      evmAddress: wallet.evmAddress,
      apiKeySecret: apiKey.secret,
      apiKeyPreview: apiKey.preview,
      now,
      existing,
    });

    return { status: "provisioned", record };
  } catch (error) {
    const reason =
      error instanceof BankrPartnerResponseError && error.status >= 400 && error.status < 500
        ? "bankr_rejected"
        : "bankr_unreachable";
    const record = await storePendingWallet({
      db: admin,
      owner: params.owner,
      userId: params.userId,
      now,
      existing,
      reason,
      error,
    });
    return { status: "pending", record };
  }
}

export async function provisionBankrWalletForInstance(params: {
  instanceId: string;
  userId: string;
  db?: SupabaseLike | null;
  env?: Record<string, string | undefined>;
  fetchImpl?: BankrPartnerFetch;
  now?: Date;
}): Promise<{
  status: "existing" | "provisioned" | "pending" | "not_configured";
  record: InstanceBankrWalletRecord | null;
}> {
  const { instanceId, ...rest } = params;
  return provisionBankrWalletForOwner({ owner: { instanceId }, ...rest });
}

export async function provisionBankrWalletForHivraAgent(params: {
  hivraAgentId: string;
  userId: string;
  db?: SupabaseLike | null;
  env?: Record<string, string | undefined>;
  fetchImpl?: BankrPartnerFetch;
  now?: Date;
}): Promise<{
  status: "existing" | "provisioned" | "pending" | "not_configured";
  record: InstanceBankrWalletRecord | null;
}> {
  const { hivraAgentId, ...rest } = params;
  return provisionBankrWalletForOwner({ owner: { hivraAgentId }, ...rest });
}

export async function setWithdrawalDestination(params: {
  instanceId: string;
  userId: string;
  destinationEvm: string;
  db?: SupabaseLike | null;
}): Promise<InstanceBankrWalletRecord> {
  const admin = requireDb(params.db ?? supabaseAdmin);
  await upsertWithdrawalRecipient({
    instanceId: params.instanceId,
    userId: params.userId,
    address: params.destinationEvm,
    setPrimary: true,
    incrementUseCount: false,
    db: admin,
  });
  const record = await getBankrWalletForInstance({ instanceId: params.instanceId, db: admin });
  if (!record || record.userId !== params.userId) {
    throw new Error("Failed to update withdrawal destination");
  }

  return record;
}

/**
 * Owner-agnostic withdrawal-destination setter.
 *
 * The Hermes-lane `setWithdrawalDestination` routes through
 * `upsertWithdrawalRecipient`, which writes `instance_bankr_wallet_recipients`
 * (a table whose `instance_id` is NOT NULL with an FK to `hermes_instances`).
 * That path CANNOT be used for a Hivra-catalog box: the recipient insert would
 * fail the FK. So this owner-agnostic variant skips the recipient-history table
 * entirely and persists the destination directly on the owner-agnostic
 * `instance_bankr_wallets.withdrawal_destination_evm` column — the same column
 * the withdraw flow reads. No migration required; works for both lanes.
 */
export async function setWithdrawalDestinationForOwner(params: {
  owner: BankrWalletOwner;
  userId: string;
  destinationEvm: string;
  db?: SupabaseLike | null;
  now?: Date;
}): Promise<InstanceBankrWalletRecord> {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const normalizedAddress = normalizeEvmAddress(params.destinationEvm);

  const wallet = await getBankrWalletForOwner({ owner: params.owner, db: admin });
  if (!wallet || wallet.userId !== params.userId || wallet.status !== "active") {
    throw new Error("No active agent wallet found for withdrawal destination");
  }

  const timestamp = (params.now ?? new Date()).toISOString();
  const { error } = await table(admin, "instance_bankr_wallets")
    .update({
      withdrawal_destination_evm: normalizedAddress,
      withdrawal_destination_set_at: timestamp,
      updated_at: timestamp,
    })
    .eq("id", wallet.id);
  if (error) {
    throw new Error(error.message || "Failed to update withdrawal destination");
  }

  const record = await getBankrWalletForOwner({ owner: params.owner, db: admin });
  if (!record || record.userId !== params.userId) {
    throw new Error("Failed to update withdrawal destination");
  }

  return record;
}

export async function decryptInstanceBankrApiKey(
  record: InstanceBankrWalletRecord
): Promise<string | null> {
  if (record.status !== "active" || record.apiKeyStatus !== "active") {
    return null;
  }

  const encrypted = hiddenApiKeyEncrypted(record);
  if (!encrypted) return null;
  return decryptApiKey(encrypted);
}

export async function markBankrSuiteSeeded(params: {
  instanceId: string;
  seeded: boolean;
  db?: SupabaseLike | null;
  error?: unknown;
}): Promise<void> {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const existing = await getBankrWalletForInstance({
    instanceId: params.instanceId,
    db: admin,
  });

  if (!existing) return;

  const errorMessage = params.error instanceof Error ? params.error.message : readString(params.error) ?? null;
  await table(admin, "instance_bankr_wallets")
    .update({
      metadata: {
        ...existing.metadata,
        bankrSuiteSeeded: params.seeded,
        bankrSuiteSeededAt: new Date().toISOString(),
        ...(errorMessage ? { bankrSuiteSeedError: errorMessage } : {}),
      },
      updated_at: new Date().toISOString(),
    })
    .eq("instance_id", params.instanceId);
}

export async function buildInstanceBankrAgentConfig(
  record: InstanceBankrWalletRecord | null
): Promise<InstanceBankrAgentConfig | null> {
  if (!record || record.status !== "active") {
    return null;
  }

  const apiKey = await decryptInstanceBankrApiKey(record);
  if (!apiKey) return null;

  return {
    walletAddress: record.evmAddress,
    apiKey,
    walletId: record.bankrWalletId,
    withdrawalDestination: record.withdrawalDestinationEvm,
  };
}

export async function readInstanceBankrWalletBalances(params: {
  walletAddress: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: JsonRpcFetch;
}): Promise<InstanceBankrWalletTokenBalance[]> {
  const normalizedAddress = normalizeEvmAddress(params.walletAddress);
  const cached = tokenBalanceCache.get(normalizedAddress);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const rpcUrl = getBaseRpcUrl(params.env);
  const fetchImpl = params.fetchImpl || (fetch as unknown as JsonRpcFetch);
  const ethResult = await rpcCall<string>(rpcUrl, "eth_getBalance", [normalizedAddress, "latest"], fetchImpl);
  if (!/^0x[a-fA-F0-9]+$/.test(ethResult)) {
    throw new Error("Invalid Base balance RPC result");
  }

  const tokenBalances = await Promise.all(
    BASE_TRACKED_ERC20_TOKENS.map(async (token) => {
      const raw = decodeUint256RpcResult(
        await rpcCall<string>(
          rpcUrl,
          "eth_call",
          [
            {
              to: token.address,
              data: encodeErc20BalanceOfCallData(normalizedAddress),
            },
            "latest",
          ],
          fetchImpl
        )
      );

      return {
        chain: "Base" as const,
        tokenSymbol: token.symbol,
        tokenAddress: token.address,
        tokenDecimals: token.decimals,
        balanceDisplay: formatAgentWalletTokenDisplay(raw, token.decimals),
      };
    })
  );

  const balances: InstanceBankrWalletTokenBalance[] = [
    {
      chain: "Base",
      tokenSymbol: "ETH",
      tokenAddress: null,
      tokenDecimals: 18,
      balanceDisplay: formatEthDisplay(BigInt(ethResult).toString()),
    },
    ...tokenBalances,
  ];

  tokenBalanceCache.set(normalizedAddress, {
    value: balances,
    expiresAt: Date.now() + BALANCE_CACHE_TTL_MS,
  });
  return balances;
}
