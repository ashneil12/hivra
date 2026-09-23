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
import { HERMESOS_TOKEN } from "@/lib/billing/token-registry";
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

type BankrUserFetch = (
  input: string,
  init: {
    method: "GET" | "DELETE";
    headers: Record<string, string>;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

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

/**
 * Who owns the Bankr account behind an agent wallet.
 *
 * - `hivra_provisioned`: Hivra created the wallet through its Bankr partner
 *   account. Bankr holds the private keys; Hivra holds this wallet's API key
 *   and its partner key can mint more keys for the wallet. Kept only for
 *   agents that already have one.
 * - `user_connected`: the user's own Bankr account. The user created the API
 *   key at bankr.bot, set its permissions and the wallet's spending limits
 *   there, and can revoke it there. Hivra's partner key has no access to it.
 *   Every new agent wallet is this kind.
 */
export type AgentWalletCustody = "hivra_provisioned" | "user_connected";

/** metadata.custodyModel written on Hivra-provisioned rows (unchanged since May 2026). */
export const HIVRA_PROVISIONED_CUSTODY_MODEL = "bankr_custodied_agent_wallet";
/** metadata.custodyModel written on rows holding a key from the user's own Bankr account. */
export const USER_CONNECTED_CUSTODY_MODEL = "user_owned_bankr_account";
/** Bumped whenever the consent wording in the connect dialog changes. */
export const AGENT_WALLET_CONNECT_CONSENT_VERSION = "2026-09-23";

export interface InstanceBankrWalletPublicSummary {
  evmAddress: string | null;
  bankrWalletId: string | null;
  status: InstanceBankrWalletRecord["status"];
  withdrawalDestinationEvm: string | null;
  apiKeyStatus: InstanceBankrWalletRecord["apiKeyStatus"];
  custody: AgentWalletCustody;
  /** Preview of the key the user pasted; null for Hivra-provisioned wallets. */
  apiKeyPreview: string | null;
  connectedAt: string | null;
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
    address: HERMESOS_TOKEN.address,
    decimals: HERMESOS_TOKEN.decimals,
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

export function agentWalletCustody(record: Pick<InstanceBankrWalletRecord, "metadata">): AgentWalletCustody {
  return record.metadata.custodyModel === USER_CONNECTED_CUSTODY_MODEL ? "user_connected" : "hivra_provisioned";
}

/**
 * True when the row points at a real wallet Hivra created through its Bankr
 * partner account. Rows whose partner call never succeeded carry a
 * `pending:` placeholder id and the zero address: no Bankr wallet exists for
 * them, so there is nothing to keep working and they get the connect flow.
 */
function hasHivraProvisionedWallet(record: InstanceBankrWalletRecord): boolean {
  return (
    agentWalletCustody(record) === "hivra_provisioned" &&
    record.status !== "revoked" &&
    !record.bankrWalletId.startsWith("pending:")
  );
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
      custodyModel: HIVRA_PROVISIONED_CUSTODY_MODEL,
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
          custodyModel: HIVRA_PROVISIONED_CUSTODY_MODEL,
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
  const custody = agentWalletCustody(record);
  return {
    evmAddress: isActive ? record.evmAddress : null,
    bankrWalletId: isActive ? record.bankrWalletId : null,
    status: record.status,
    withdrawalDestinationEvm: record.withdrawalDestinationEvm,
    apiKeyStatus: record.apiKeyStatus,
    custody,
    apiKeyPreview: custody === "user_connected" && isActive ? record.apiKeyPreview : null,
    connectedAt: custody === "user_connected" ? readString(record.metadata.connectedAt) : null,
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

export type ProvisionBankrWalletStatus =
  | "existing"
  | "provisioned"
  | "pending"
  | "not_configured"
  | "connect_required";

/**
 * Keep an existing Hivra-provisioned agent wallet working (retry a missing
 * API key on a wallet Bankr already created). It never creates a new
 * Hivra-provisioned wallet: an agent without one gets `connect_required` and
 * no Bankr call is made, because new agent wallets connect to the user's own
 * Bankr account instead (connectUserBankrWalletForOwner).
 */
async function provisionBankrWalletForOwner(params: {
  owner: BankrWalletOwner;
  userId: string;
  db?: SupabaseLike | null;
  env?: Record<string, string | undefined>;
  fetchImpl?: BankrPartnerFetch;
  now?: Date;
}): Promise<{
  status: ProvisionBankrWalletStatus;
  record: InstanceBankrWalletRecord | null;
}> {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const now = params.now ?? new Date();
  const existing = await getBankrWalletForOwner({ owner: params.owner, db: admin });

  if (existing?.status === "active" && existing.apiKeyStatus === "active" && hiddenApiKeyEncrypted(existing)) {
    return { status: "existing", record: existing };
  }

  if (!existing || !hasHivraProvisionedWallet(existing)) {
    return { status: "connect_required", record: existing };
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
  status: ProvisionBankrWalletStatus;
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
  status: ProvisionBankrWalletStatus;
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

export type AgentWalletConnectErrorCode =
  | "invalid_key"
  | "partner_key"
  | "bankr_rejected"
  | "bankr_unreachable"
  | "hivra_provisioned_address"
  | "replace_not_confirmed"
  | "balance_not_empty"
  | "balance_unavailable"
  | "not_connected";

/** A refusal the connect/disconnect routes return to the user as-is. */
export class AgentWalletConnectError extends Error {
  readonly code: AgentWalletConnectErrorCode;
  readonly httpStatus: number;

  constructor(code: AgentWalletConnectErrorCode, message: string, httpStatus: number) {
    super(message);
    this.name = "AgentWalletConnectError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const BANKR_USER_KEY_PATTERN = /^bk_[A-Za-z0-9_-]{8,256}$/;
const BANKR_KEY_CHECK_TIMEOUT_MS = 10_000;
// Partner wallets start with no ETH, and a withdrawal needs gas, so Hivra's
// treasury tops them up with 0.0001 ETH (treasury-gas.ts). What is left of
// that top-up can't be withdrawn without more gas, so it doesn't block a
// switch; any other balance does.
const HIVRA_GAS_TOPUP_ETH = 0.0001;

function bankrUserFetchImpl(fetchImpl?: BankrUserFetch): BankrUserFetch {
  return fetchImpl || (fetch as unknown as BankrUserFetch);
}

/**
 * Ask Bankr which wallet a user-supplied API key belongs to. GET /wallet/me
 * accepts any valid key (read-only included) and returns the account's
 * addresses, so it proves the key works without moving anything.
 */
export async function lookupBankrApiKeyWallet(params: {
  apiKey: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: BankrUserFetch;
}): Promise<{ evmAddress: string }> {
  const apiKey = params.apiKey.trim();
  if (apiKey.startsWith("bk_ptr_")) {
    throw new AgentWalletConnectError(
      "partner_key",
      "That is a Bankr partner key. Create a key for your own wallet at bankr.bot/api-keys.",
      400
    );
  }
  if (!BANKR_USER_KEY_PATTERN.test(apiKey)) {
    throw new AgentWalletConnectError(
      "invalid_key",
      "That doesn't look like a Bankr API key. Keys from bankr.bot/api-keys start with bk_.",
      400
    );
  }

  const { apiBaseUrl } = getBankrPartnerConfig(params.env);
  let response: Awaited<ReturnType<BankrUserFetch>>;
  try {
    response = await bankrUserFetchImpl(params.fetchImpl)(`${apiBaseUrl}/wallet/me`, {
      method: "GET",
      headers: { "X-API-Key": apiKey },
      signal: AbortSignal.timeout(BANKR_KEY_CHECK_TIMEOUT_MS),
    });
  } catch {
    throw new AgentWalletConnectError("bankr_unreachable", "Couldn't reach Bankr to check the key. Try again.", 503);
  }

  if (response.status === 401 || response.status === 403) {
    throw new AgentWalletConnectError(
      "bankr_rejected",
      "Bankr didn't accept this key. Check it at bankr.bot/api-keys, including its IP allowlist.",
      400
    );
  }
  if (!response.ok) {
    throw new AgentWalletConnectError("bankr_unreachable", `Bankr returned ${response.status} while checking the key. Try again.`, 503);
  }

  const payload = asRecord(await response.json().catch(() => null));
  const wallets = Array.isArray(payload.wallets) ? payload.wallets : [];
  const evm = wallets.map(asRecord).find((wallet) => wallet.chain === "evm");
  const evmAddress = readString(evm?.address);
  if (!evmAddress || !isEvmAddress(evmAddress)) {
    throw new AgentWalletConnectError("bankr_rejected", "Bankr didn't return an EVM wallet for this key.", 400);
  }
  return { evmAddress: normalizeEvmAddress(evmAddress) };
}

/**
 * A wallet Hivra created through its Bankr partner account must never be
 * relabelled as the user's own. On Hivra boxes the agent's key sits in a file
 * the user can read, so this check is what stops that key being pasted back
 * in as "your Bankr account". It covers every agent wallet Hivra created,
 * including ones an agent has since switched away from, and every Bankr
 * payment or lock address.
 */
async function isHivraProvisionedBankrAddress(db: SupabaseLike, normalizedAddress: string): Promise<boolean> {
  const rows = async (tableName: string, column: string, extra?: [string, string]) => {
    let query = table(db, tableName).select("id, metadata").eq(column, normalizedAddress);
    if (extra) query = query.eq(extra[0], extra[1]);
    const { data, error } = await (query as unknown as Promise<{ data: unknown; error: QueryError }>);
    if (error) {
      throw new Error(error.message || `Failed to check ${tableName} ownership`);
    }
    return Array.isArray(data) ? data : [];
  };

  const agentRows = await rows("instance_bankr_wallets", "normalized_evm_address");
  if (agentRows.some((row) => asRecord(asRecord(row).metadata).custodyModel !== USER_CONNECTED_CUSTODY_MODEL)) {
    return true;
  }
  if ((await rows("instance_bankr_wallets", "metadata->replacedProvisionedWallet->>evmAddress")).length > 0) {
    return true;
  }
  return (await rows("user_wallets", "normalized_address", ["verification_method", "bankr"])).length > 0;
}

/**
 * Everything the old Hivra-created wallet still holds, across every chain
 * Bankr supports, including tokens under $1 and NFTs (GET /wallet/portfolio,
 * read with that wallet's own key). Up to 0.0001 ETH on Base is left over
 * from Hivra's gas top-up and doesn't count. Fails closed: a field that is
 * missing, renamed or not a number blocks the switch rather than reading as
 * zero.
 */
async function listProvisionedWalletHoldings(params: {
  record: InstanceBankrWalletRecord;
  env?: Record<string, string | undefined>;
  fetchImpl?: BankrUserFetch;
}): Promise<string[]> {
  const unavailable = () =>
    new AgentWalletConnectError(
      "balance_unavailable",
      "Couldn't confirm the current wallet is empty. Try again in a minute.",
      503
    );
  const apiKey = await decryptInstanceBankrRuntimeApiKey(params.record);
  if (!apiKey) {
    throw new AgentWalletConnectError(
      "balance_unavailable",
      "Hivra can't read this wallet's balances because its key isn't active. Contact support to switch.",
      409
    );
  }

  const { apiBaseUrl } = getBankrPartnerConfig(params.env);
  let payload: Record<string, unknown>;
  try {
    const response = await bankrUserFetchImpl(params.fetchImpl)(
      `${apiBaseUrl}/wallet/portfolio?showLowValueTokens=true&include=nfts`,
      {
        method: "GET",
        headers: { "X-API-Key": apiKey },
        signal: AbortSignal.timeout(BANKR_KEY_CHECK_TIMEOUT_MS),
      }
    );
    if (!response.ok) throw unavailable();
    payload = asRecord(await response.json());
  } catch {
    throw unavailable();
  }

  const balances = payload.balances;
  if (!balances || typeof balances !== "object" || Array.isArray(balances)) throw unavailable();
  // Base is where Hivra wallets live; a response without it proves nothing.
  if (!("base" in balances)) throw unavailable();

  // Bankr documents amounts as decimal strings; anything else is unreadable.
  const amountOf = (value: unknown): number => {
    const amount = typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
    if (!Number.isFinite(amount) || amount < 0) throw unavailable();
    return amount;
  };

  const holdings: string[] = [];
  for (const [chain, entryValue] of Object.entries(balances as Record<string, unknown>)) {
    const entry = asRecord(entryValue);
    if (amountOf(entry.nativeBalance) > (chain === "base" ? HIVRA_GAS_TOPUP_ETH : 0)) {
      holdings.push(`${entry.nativeBalance} native on ${chain}`);
    }
    if (!Array.isArray(entry.tokenBalances)) throw unavailable();
    for (const tokenValue of entry.tokenBalances) {
      const token = asRecord(asRecord(tokenValue).token);
      if (amountOf(token.balance) > 0) {
        holdings.push(`${token.balance} ${readString(asRecord(token.baseToken).symbol) ?? "tokens"} on ${chain}`);
      }
    }
  }
  // Requested with include=nfts, so a missing list means the response isn't the documented one.
  if (!Array.isArray(payload.nfts)) throw unavailable();
  if (payload.nfts.length > 0) holdings.push(`${payload.nfts.length} NFT${payload.nfts.length === 1 ? "" : "s"}`);
  return holdings;
}

async function revokeAllPartnerWalletApiKeys(params: {
  bankrWalletId: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: BankrUserFetch;
}): Promise<{ revoked: boolean; error?: string }> {
  const config = getBankrPartnerConfig(params.env);
  if (!config.partnerKey) return { revoked: false, error: "Bankr partner key is not configured" };
  try {
    const response = await bankrUserFetchImpl(params.fetchImpl)(
      `${config.apiBaseUrl}/partner/wallets/${encodeURIComponent(params.bankrWalletId)}/api-keys`,
      {
        method: "DELETE",
        headers: { "X-Partner-Key": config.partnerKey },
        signal: AbortSignal.timeout(BANKR_KEY_CHECK_TIMEOUT_MS),
      }
    );
    return response.ok ? { revoked: true } : { revoked: false, error: `Bankr returned ${response.status}` };
  } catch (error) {
    return { revoked: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function writeWalletRow(params: {
  db: SupabaseLike;
  owner: BankrWalletOwner;
  existing: InstanceBankrWalletRecord | null;
  payload: Record<string, unknown>;
}): Promise<InstanceBankrWalletRecord> {
  // Select-then-write by id rather than upsert: the owner columns carry
  // partial unique indexes, which ON CONFLICT cannot target by column alone.
  const write = (existing: InstanceBankrWalletRecord | null) =>
    (existing
      ? table(params.db, "instance_bankr_wallets").update(params.payload).eq("id", existing.id).select("*")
      : table(params.db, "instance_bankr_wallets").insert(params.payload).select("*")
    ).single();
  let { data, error } = await write(params.existing);
  const duplicate = (error as { code?: string } | null)?.code === "23505" || /duplicate key/i.test(error?.message ?? "");
  if (error && !params.existing && duplicate) {
    // A concurrent connect for the same agent inserted first: update that row.
    const winner = await getBankrWalletForOwner({ owner: params.owner, db: params.db });
    if (winner) ({ data, error } = await write(winner));
  }
  if (error || !data) {
    throw new Error(error?.message || "Failed to store agent wallet");
  }
  return asInstanceBankrWalletRecord(data as InstanceBankrWalletRow);
}

export interface ConnectUserBankrWalletResult {
  record: InstanceBankrWalletRecord;
  replacedProvisionedWallet: boolean;
  /** Set only when this call switched off a Hivra-created wallet. */
  oldKeysRevoked: boolean | null;
}

/**
 * Connect an agent to the user's own Bankr account with an API key the user
 * created at bankr.bot and chose to hand to this agent.
 *
 * Hivra stores the key encrypted (like any other user-supplied key) and sends
 * it to the agent runtime. The user controls it at Bankr: the key's
 * permissions and recipient allowlist, the wallet's daily and per-transaction
 * limits (which an API key cannot change), and revocation.
 *
 * Replacing an existing Hivra-provisioned wallet needs `replaceProvisionedWallet`
 * and a wallet Bankr reports as empty on every chain, so no funds are left
 * behind. The old wallet stays recorded on the row for good, and every API key
 * on it is then revoked at Bankr; the caller reports a failed revocation.
 */
export async function connectUserBankrWalletForOwner(params: {
  owner: BankrWalletOwner;
  userId: string;
  apiKey: string;
  replaceProvisionedWallet?: boolean;
  db?: SupabaseLike | null;
  env?: Record<string, string | undefined>;
  fetchImpl?: BankrUserFetch;
  now?: Date;
}): Promise<ConnectUserBankrWalletResult> {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const now = params.now ?? new Date();
  const apiKey = params.apiKey.trim();
  const { evmAddress } = await lookupBankrApiKeyWallet({ apiKey, env: params.env, fetchImpl: params.fetchImpl });

  if (await isHivraProvisionedBankrAddress(admin, evmAddress)) {
    throw new AgentWalletConnectError(
      "hivra_provisioned_address",
      "This key belongs to a wallet Hivra created, not your own Bankr account. Create a key at bankr.bot/api-keys while signed in to your account.",
      400
    );
  }

  const existing = await getBankrWalletForOwner({ owner: params.owner, db: admin });
  if (existing && existing.userId !== params.userId) {
    throw new Error("Agent wallet belongs to a different user");
  }

  // Only one Hivra-created wallet can ever sit behind an agent, so a single
  // record, carried across every later reconnect, is the full history.
  let replacedProvisionedWallet: Record<string, unknown> | null =
    existing && Object.keys(asRecord(existing.metadata.replacedProvisionedWallet)).length > 0
      ? asRecord(existing.metadata.replacedProvisionedWallet)
      : null;
  const replacingNow = existing ? hasHivraProvisionedWallet(existing) : false;
  if (existing && replacingNow) {
    if (!params.replaceProvisionedWallet) {
      throw new AgentWalletConnectError(
        "replace_not_confirmed",
        "This agent already has a wallet Hivra created. Confirm the switch to replace it with your Bankr account.",
        409
      );
    }
    const holdings = await listProvisionedWalletHoldings({
      record: existing,
      env: params.env,
      fetchImpl: params.fetchImpl,
    });
    if (holdings.length > 0) {
      throw new AgentWalletConnectError(
        "balance_not_empty",
        `Withdraw everything from the current wallet first (${holdings.slice(0, 5).join(", ")}${
          holdings.length > 5 ? ", …" : ""
        }). Contact support for anything you can't withdraw here, such as funds on another chain.`,
        409
      );
    }
    replacedProvisionedWallet = {
      bankrWalletId: existing.bankrWalletId,
      evmAddress: existing.normalizedEvmAddress,
      replacedAt: now.toISOString(),
    };
  }

  const record = await writeWalletRow({
    db: admin,
    owner: params.owner,
    existing,
    payload: {
      [ownerColumn(params.owner)]: ownerId(params.owner),
      user_id: params.userId,
      bankr_wallet_id: `user:${evmAddress}`,
      evm_address: evmAddress,
      api_key_encrypted: encryptApiKey(apiKey),
      api_key_preview: formatKeyPreview(apiKey),
      api_key_status: "active",
      status: "active",
      withdrawal_destination_evm: null,
      withdrawal_destination_set_at: null,
      metadata: {
        custodyModel: USER_CONNECTED_CUSTODY_MODEL,
        connectedAt: now.toISOString(),
        consent: { version: AGENT_WALLET_CONNECT_CONSENT_VERSION, acceptedAt: now.toISOString() },
        ...(existing?.metadata.bankrSuiteSeeded === true
          ? { bankrSuiteSeeded: true, bankrSuiteSeededAt: existing.metadata.bankrSuiteSeededAt ?? null }
          : {}),
        ...(replacedProvisionedWallet ? { replacedProvisionedWallet } : {}),
      },
      updated_at: now.toISOString(),
    },
  });

  if (!replacingNow || !replacedProvisionedWallet) {
    return { record, replacedProvisionedWallet: false, oldKeysRevoked: null };
  }

  const revocation = await revokeAllPartnerWalletApiKeys({
    bankrWalletId: String(replacedProvisionedWallet.bankrWalletId),
    env: params.env,
    fetchImpl: params.fetchImpl,
  });
  const withRevocation = await writeWalletRow({
    db: admin,
    owner: params.owner,
    existing: record,
    payload: {
      metadata: {
        ...record.metadata,
        replacedProvisionedWallet: {
          ...replacedProvisionedWallet,
          oldKeysRevoked: revocation.revoked,
          ...(revocation.error ? { oldKeysRevokeError: revocation.error } : {}),
        },
      },
      updated_at: now.toISOString(),
    },
  });
  return { record: withRevocation, replacedProvisionedWallet: true, oldKeysRevoked: revocation.revoked };
}

/**
 * Delete Hivra's copy of a key the user connected. The runtime copy is removed
 * by the caller's lane sync; the key itself stays valid at Bankr until the
 * user revokes it at bankr.bot/api-keys, which Hivra cannot do for them.
 */
export async function disconnectUserBankrWalletForOwner(params: {
  owner: BankrWalletOwner;
  userId: string;
  db?: SupabaseLike | null;
  now?: Date;
}): Promise<InstanceBankrWalletRecord> {
  const admin = requireDb(params.db ?? supabaseAdmin);
  const now = params.now ?? new Date();
  const existing = await getBankrWalletForOwner({ owner: params.owner, db: admin });
  if (
    !existing ||
    existing.userId !== params.userId ||
    agentWalletCustody(existing) !== "user_connected" ||
    existing.status === "revoked"
  ) {
    throw new AgentWalletConnectError("not_connected", "This agent isn't connected to your Bankr account.", 409);
  }

  return writeWalletRow({
    db: admin,
    owner: params.owner,
    existing,
    payload: {
      api_key_encrypted: null,
      api_key_preview: null,
      api_key_status: "revoked",
      status: "revoked",
      metadata: { ...existing.metadata, disconnectedAt: now.toISOString() },
      updated_at: now.toISOString(),
    },
  });
}

/** Hivra never initiates transfers from a user's own Bankr account. */
export async function isUserConnectedBankrWallet(params: {
  owner: BankrWalletOwner;
  db?: SupabaseLike | null;
}): Promise<boolean> {
  const record = await getBankrWalletForOwner({ owner: params.owner, db: params.db });
  return Boolean(record && agentWalletCustody(record) === "user_connected");
}

/**
 * The key Hivra itself may use to move funds (withdrawals). Always null for a
 * user's own Bankr account: Hivra never initiates transfers from one, and
 * refusing here also covers a withdrawal that loaded the wallet just after
 * the user switched it to their own account.
 */
export async function decryptInstanceBankrApiKey(
  record: InstanceBankrWalletRecord
): Promise<string | null> {
  if (agentWalletCustody(record) === "user_connected") return null;
  return decryptInstanceBankrRuntimeApiKey(record);
}

/** The key delivered to the agent runtime, for either kind of wallet. */
export async function decryptInstanceBankrRuntimeApiKey(
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

  const apiKey = await decryptInstanceBankrRuntimeApiKey(record);
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
