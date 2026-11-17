// Managed-Venice per-agent daily spend cap — a purely PROTECTIVE control, like
// the per-user monthly cap in managed-venice-spend-caps.ts. It can only block
// spend above a ceiling; it never charges, refunds, or moves money.
//
// Every managed agent computer bills through its own proxy key, so "per agent"
// is "per proxy key". The owner's limit lives in the key's metadata
// (`metadata.spendCap.dailyMicroUsd`), so no schema change is needed. An
// optional platform default (MANAGED_VENICE_AGENT_DAILY_SPEND_CAP_USD) applies
// to keys without their own limit.
//
// Off by default: with MANAGED_VENICE_AGENT_SPEND_CAPS_ENABLED unset every call
// is a no-op and behaviour is byte-identical to today. Enforced at reservation
// time next to the monthly cap, so chat, Responses, the Anthropic shim and
// media are all covered. A breach throws ManagedVeniceAgentSpendCapError (a
// ManagedVeniceSpendCapError), logs it, and stamps the key so Manage can show
// "limit reached today".

import { requireDb } from "@/lib/billing/db-utils";
import { ManagedVeniceSpendCapError } from "@/lib/billing/managed-venice-spend-caps";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { updateManagedVeniceProxyKeyMetadata } from "@/lib/venice/proxy-key-metadata";

type QueryError = { code?: string; message?: string } | null;

type DbChain = {
  select: (...args: unknown[]) => DbChain;
  eq: (...args: unknown[]) => DbChain;
  gte: (...args: unknown[]) => DbChain;
  in: (...args: unknown[]) => DbChain;
  maybeSingle: () => Promise<{ data: unknown; error: QueryError }>;
  then: Promise<{ data?: unknown; error: QueryError }>["then"];
};

type SupabaseLike = { from: (table: string) => unknown };

/** Highest daily limit an owner can set, in USD. Guards typos, not budgets. */
export const MAX_AGENT_DAILY_SPEND_CAP_USD = 10_000;

export class ManagedVeniceAgentSpendCapError extends ManagedVeniceSpendCapError {
  readonly proxyKeyId: string;
  constructor(proxyKeyId: string, capMicroUsd: number, spentMicroUsd: number) {
    super(capMicroUsd, spentMicroUsd);
    this.name = "ManagedVeniceAgentSpendCapError";
    this.message = "This agent's daily managed inference limit is reached";
    this.proxyKeyId = proxyKeyId;
  }
}

/** The user-facing sentence for a cap breach, monthly or per agent. */
export function managedVeniceSpendCapMessage(error: ManagedVeniceSpendCapError, manageUrl: string): string {
  if (error instanceof ManagedVeniceAgentSpendCapError) {
    return (
      `This agent reached its daily inference limit of ${formatUsd(error.capMicroUsd)}. ` +
      `It resets at 00:00 UTC, or the owner can raise it in Hivra under this agent's Manage › Inference.`
    );
  }
  return `Monthly managed Venice spend cap reached. Manage your limit in Hivra: ${manageUrl}`;
}

export interface ManagedVeniceAgentSpendCapConfig {
  enabled: boolean;
  /** Platform default daily cap per agent in microdollars, or null when unset. */
  defaultDailyMicroUsd: number | null;
}

function parseUsd(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value.trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1_000_000) : null;
}

export function resolveManagedVeniceAgentSpendCapConfig(
  env: Record<string, string | undefined> = process.env
): ManagedVeniceAgentSpendCapConfig {
  return {
    enabled: env.MANAGED_VENICE_AGENT_SPEND_CAPS_ENABLED === "true",
    defaultDailyMicroUsd: parseUsd(env.MANAGED_VENICE_AGENT_DAILY_SPEND_CAP_USD),
  };
}

export interface AgentSpendCapSetting {
  /** The owner's own daily limit, or null to use the platform default. */
  dailyMicroUsd: number | null;
  /** Last time a request was refused at the limit (ISO), or null. */
  lastReachedAt: string | null;
}

export function readAgentSpendCap(metadata: unknown): AgentSpendCapSetting {
  const meta = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
  const raw = meta.spendCap && typeof meta.spendCap === "object" ? (meta.spendCap as Record<string, unknown>) : {};
  const daily = raw.dailyMicroUsd;
  return {
    dailyMicroUsd: typeof daily === "number" && Number.isInteger(daily) && daily > 0 ? daily : null,
    lastReachedAt: typeof raw.lastReachedAt === "string" ? raw.lastReachedAt : null,
  };
}

function spendCapObject(metadata: Record<string, unknown>): Record<string, unknown> {
  const raw = metadata.spendCap;
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

/** The limit that applies to a key: its own, else the platform default. */
export function effectiveDailyCapMicroUsd(
  setting: AgentSpendCapSetting,
  config: ManagedVeniceAgentSpendCapConfig
): number | null {
  return setting.dailyMicroUsd ?? config.defaultDailyMicroUsd;
}

/** First instant of the current UTC day, as an ISO string. */
export function dayStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

function formatUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}

async function readKeyMetadata(client: SupabaseLike, userId: string, proxyKeyId: string) {
  const { data, error } = await (client.from("managed_venice_proxy_keys") as DbChain)
    .select("id, metadata")
    .eq("id", proxyKeyId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message || "Failed to read managed Venice key limit");
  return data ? ((data as { metadata?: unknown }).metadata ?? {}) : null;
}

/** Charged spend per UTC day for one key since `sinceIso` (charged, not actual, like the monthly cap). */
export async function getAgentSpendByDayMicroUsd(
  params: { userId: string; proxyKeyId: string; sinceIso: string },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<Map<string, number>> {
  const client = requireDb(db) as SupabaseLike;
  const { data, error } = await (client.from("managed_venice_usage_events") as DbChain)
    .select("charged_micro_usd, created_at")
    .eq("user_id", params.userId)
    .eq("proxy_key_id", params.proxyKeyId)
    .gte("created_at", params.sinceIso);
  if (error) throw new Error(error.message || "Failed to read managed Venice agent spend");
  const byDay = new Map<string, number>();
  for (const row of (Array.isArray(data) ? data : []) as Array<{ charged_micro_usd?: unknown; created_at?: unknown }>) {
    const v = row.charged_micro_usd;
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const day = typeof row.created_at === "string" ? row.created_at.slice(0, 10) : "";
    byDay.set(day, (byDay.get(day) ?? 0) + v);
  }
  return byDay;
}

/** Error text the database guard raises when a hold would cross an agent's daily limit. */
export const AGENT_SPEND_CAP_DB_ERROR = "managed_venice_agent_spend_cap";

/** The agent's limit, carried on the hold so the database guard checks it in the same transaction. */
export type AgentSpendCapStamp = { agentDailyCapMicroUsd: number };

/**
 * What one agent key has used today, counting money not yet settled:
 * charged spend recorded today, holds still open (requests running now), and
 * holds captured today whose usage row is not written yet. Mirrors the
 * database guard (migration 20261117233000), which is the real stop; this
 * read only sizes and explains.
 */
export async function getAgentCommittedTodayMicroUsd(
  params: { userId: string; proxyKeyId: string; now: Date },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<number> {
  const client = requireDb(db) as SupabaseLike;
  const dayStart = dayStartIso(params.now);
  const byDay = await getAgentSpendByDayMicroUsd({ userId: params.userId, proxyKeyId: params.proxyKeyId, sinceIso: dayStart }, client);
  let total = 0;
  for (const v of byDay.values()) total += v;

  const { data: holds, error } = await (client.from("managed_venice_reservations") as DbChain)
    .select("reference_id, status, reserved_micro_usd, captured_micro_usd, captured_at, proxy_key_id, metadata")
    .eq("user_id", params.userId)
    .in("status", ["active", "captured"]);
  if (error) throw new Error(error.message || "Failed to read managed Venice holds");
  const capturedRefs: Array<{ ref: string; amount: number }> = [];
  for (const row of (Array.isArray(holds) ? holds : []) as Array<Record<string, unknown>>) {
    const meta = row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : {};
    const key = typeof row.proxy_key_id === "string" ? row.proxy_key_id : typeof meta.proxyKeyId === "string" ? meta.proxyKeyId : null;
    if (key !== params.proxyKeyId) continue;
    if (row.status === "active") total += Number(row.reserved_micro_usd) || 0;
    else if (typeof row.captured_at === "string" && row.captured_at >= dayStart && typeof row.reference_id === "string") {
      capturedRefs.push({ ref: row.reference_id, amount: Number(row.captured_micro_usd) || 0 });
    }
  }
  for (let i = 0; i < capturedRefs.length; i += 200) {
    const slice = capturedRefs.slice(i, i + 200);
    const { data: recorded, error: usageError } = await (client.from("managed_venice_usage_events") as DbChain)
      .select("reference_id")
      .eq("user_id", params.userId)
      .in("reference_id", slice.map((c) => c.ref));
    if (usageError) throw new Error(usageError.message || "Failed to read managed Venice usage");
    const seen = new Set(((Array.isArray(recorded) ? recorded : []) as Array<{ reference_id?: unknown }>).map((r) => r.reference_id));
    for (const c of slice) if (!seen.has(c.ref)) total += c.amount;
  }
  return total;
}

export interface AgentDailyAllowance {
  capMicroUsd: number;
  /** Spent today plus what open holds may still spend. */
  committedMicroUsd: number;
  remainingMicroUsd: number;
  capSource: "owner" | "platform_default";
  lastReachedAt: string | null;
}

/** The agent's limit today and how much of it is left, or null when no limit applies. */
export async function readAgentDailyAllowance(
  params: { userId: string; proxyKeyId: string | null | undefined; now?: Date },
  db: SupabaseLike | null | undefined = supabaseAdmin,
  env: Record<string, string | undefined> = process.env
): Promise<AgentDailyAllowance | null> {
  const config = resolveManagedVeniceAgentSpendCapConfig(env);
  if (!config.enabled || !params.proxyKeyId) return null;
  const client = requireDb(db) as SupabaseLike;
  const metadata = await readKeyMetadata(client, params.userId, params.proxyKeyId);
  if (metadata === null) return null;
  const setting = readAgentSpendCap(metadata);
  const cap = effectiveDailyCapMicroUsd(setting, config);
  if (cap === null) return null;
  const committed = await getAgentCommittedTodayMicroUsd(
    { userId: params.userId, proxyKeyId: params.proxyKeyId, now: params.now ?? new Date() },
    client
  );
  return {
    capMicroUsd: cap,
    committedMicroUsd: committed,
    remainingMicroUsd: Math.max(0, cap - committed),
    capSource: setting.dailyMicroUsd !== null ? "owner" : "platform_default",
    lastReachedAt: setting.lastReachedAt,
  };
}

/**
 * Log a refusal at the agent's limit, stamp the key once a day so Manage can
 * say so, and return the error to throw.
 */
export async function agentSpendCapReached(
  params: { userId: string; proxyKeyId: string; allowance: AgentDailyAllowance; requestedMicroUsd: number; now?: Date },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<ManagedVeniceAgentSpendCapError> {
  const { allowance } = params;
  const now = params.now ?? new Date();
  log.warn("Managed Venice request blocked by the agent's daily spend limit", {
    source: "managed-venice-agent-spend-cap",
    failureType: "managed_venice_agent_spend_cap_reached",
    userId: params.userId,
    proxyKeyId: params.proxyKeyId,
    capMicroUsd: allowance.capMicroUsd,
    spentMicroUsd: allowance.committedMicroUsd,
    requestedMicroUsd: params.requestedMicroUsd,
    capSource: allowance.capSource,
  });
  // Best effort: the refusal stands even if this write fails.
  if (!allowance.lastReachedAt || allowance.lastReachedAt < dayStartIso(now)) {
    try {
      // Through the shared writer, so this stamp cannot undo another setting
      // (the owner's limit, "private models only") saved a moment earlier.
      await updateManagedVeniceProxyKeyMetadata(
        requireDb(db) as SupabaseLike,
        { userId: params.userId, proxyKeyId: params.proxyKeyId },
        (meta) => ({ ...meta, spendCap: { ...spendCapObject(meta), lastReachedAt: now.toISOString() } })
      );
    } catch (error) {
      log.warn("Could not record that an agent reached its spend limit", {
        source: "managed-venice-agent-spend-cap",
        failureType: "managed_venice_agent_spend_cap_mark_failed",
        proxyKeyId: params.proxyKeyId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return new ManagedVeniceAgentSpendCapError(params.proxyKeyId, allowance.capMicroUsd, allowance.committedMicroUsd);
}

// Throw if a hold of `addMicroUsd` would take this key past its daily limit,
// counting what requests still running may spend. Returns the stamp to put on
// the hold, so the database guard re-checks it atomically with the insert, or
// null when the flag is off, there is no key, or no limit applies.
export async function assertManagedVeniceAgentWithinSpendCap(
  params: { userId: string; proxyKeyId: string | null | undefined; addMicroUsd: number; now?: Date },
  db: SupabaseLike | null | undefined = supabaseAdmin,
  env: Record<string, string | undefined> = process.env
): Promise<AgentSpendCapStamp | null> {
  const allowance = await readAgentDailyAllowance(params, db, env);
  if (!allowance || !params.proxyKeyId) return null;
  const requested = Math.max(0, params.addMicroUsd);
  if (requested <= allowance.remainingMicroUsd) return { agentDailyCapMicroUsd: allowance.capMicroUsd };
  throw await agentSpendCapReached(
    { userId: params.userId, proxyKeyId: params.proxyKeyId, allowance, requestedMicroUsd: requested, now: params.now },
    db
  );
}

/** The database guard's refusal as the error the routes already turn into a 402, or null for any other error. */
export function agentSpendCapErrorFromDb(
  error: { message?: string } | null | undefined,
  proxyKeyId: string | null | undefined
): ManagedVeniceAgentSpendCapError | null {
  const message = error?.message ?? "";
  if (!message.includes(AGENT_SPEND_CAP_DB_ERROR)) return null;
  const cap = Number(/cap=(\d+)/.exec(message)?.[1] ?? 0);
  const spent = Number(/spent=(\d+)/.exec(message)?.[1] ?? 0);
  return new ManagedVeniceAgentSpendCapError(proxyKeyId ?? "", cap, spent);
}

export class AgentSpendCapKeyNotFoundError extends Error {
  constructor() {
    super("This agent has no managed inference key");
  }
}

/** Set (or clear, with null) an agent key's own daily limit. Keeps every other metadata field. */
export async function setManagedVeniceAgentDailySpendCap(
  params: { userId: string; proxyKeyId: string; dailyUsd: number | null },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<AgentSpendCapSetting> {
  const { dailyUsd } = params;
  if (dailyUsd !== null && !(Number.isFinite(dailyUsd) && dailyUsd > 0 && dailyUsd <= MAX_AGENT_DAILY_SPEND_CAP_USD)) {
    throw new RangeError(`Daily limit must be between $0.01 and $${MAX_AGENT_DAILY_SPEND_CAP_USD}`);
  }
  const client = requireDb(db) as SupabaseLike;
  const dailyMicroUsd = dailyUsd === null ? null : Math.round(dailyUsd * 1_000_000);
  const stored = await updateManagedVeniceProxyKeyMetadata(
    client,
    { userId: params.userId, proxyKeyId: params.proxyKeyId },
    (meta) => ({ ...meta, spendCap: { ...spendCapObject(meta), dailyMicroUsd } })
  );
  if (stored === null) throw new AgentSpendCapKeyNotFoundError();
  return readAgentSpendCap(stored);
}
