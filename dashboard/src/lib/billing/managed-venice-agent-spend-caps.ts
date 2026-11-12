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

type QueryError = { code?: string; message?: string } | null;

type DbChain = {
  select: (...args: unknown[]) => DbChain;
  eq: (...args: unknown[]) => DbChain;
  gte: (...args: unknown[]) => DbChain;
  update: (...args: unknown[]) => DbChain;
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

async function getAgentDailySpendMicroUsd(client: SupabaseLike, userId: string, proxyKeyId: string, now: Date) {
  const byDay = await getAgentSpendByDayMicroUsd({ userId, proxyKeyId, sinceIso: dayStartIso(now) }, client);
  let total = 0;
  for (const v of byDay.values()) total += v;
  return total;
}

// Throw if charging `addMicroUsd` would push this key's spend today over its
// daily limit. No-op when the flag is off, there is no key, or no limit applies.
export async function assertManagedVeniceAgentWithinSpendCap(
  params: { userId: string; proxyKeyId: string | null | undefined; addMicroUsd: number; now?: Date },
  db: SupabaseLike | null | undefined = supabaseAdmin,
  env: Record<string, string | undefined> = process.env
): Promise<void> {
  const config = resolveManagedVeniceAgentSpendCapConfig(env);
  if (!config.enabled || !params.proxyKeyId) return;
  const client = requireDb(db) as SupabaseLike;
  const metadata = await readKeyMetadata(client, params.userId, params.proxyKeyId);
  if (metadata === null) return;
  const setting = readAgentSpendCap(metadata);
  const cap = effectiveDailyCapMicroUsd(setting, config);
  if (cap === null) return;
  const now = params.now ?? new Date();
  const spent = await getAgentDailySpendMicroUsd(client, params.userId, params.proxyKeyId, now);
  if (spent + Math.max(0, params.addMicroUsd) <= cap) return;

  log.warn("Managed Venice request blocked by the agent's daily spend limit", {
    source: "managed-venice-agent-spend-cap",
    failureType: "managed_venice_agent_spend_cap_reached",
    userId: params.userId,
    proxyKeyId: params.proxyKeyId,
    capMicroUsd: cap,
    spentMicroUsd: spent,
    requestedMicroUsd: params.addMicroUsd,
    capSource: setting.dailyMicroUsd !== null ? "owner" : "platform_default",
  });
  // Stamp the key once per day so Manage can say the limit was reached. Best
  // effort: the refusal stands even if this write fails.
  if (!setting.lastReachedAt || setting.lastReachedAt < dayStartIso(now)) {
    try {
      const meta = metadata as Record<string, unknown>;
      const spendCap = meta.spendCap && typeof meta.spendCap === "object" ? (meta.spendCap as Record<string, unknown>) : {};
      await (client.from("managed_venice_proxy_keys") as DbChain)
        .update({ metadata: { ...meta, spendCap: { ...spendCap, lastReachedAt: now.toISOString() } } })
        .eq("id", params.proxyKeyId)
        .eq("user_id", params.userId);
    } catch (error) {
      log.warn("Could not record that an agent reached its spend limit", {
        source: "managed-venice-agent-spend-cap",
        failureType: "managed_venice_agent_spend_cap_mark_failed",
        proxyKeyId: params.proxyKeyId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw new ManagedVeniceAgentSpendCapError(params.proxyKeyId, cap, spent);
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
  const metadata = await readKeyMetadata(client, params.userId, params.proxyKeyId);
  if (metadata === null) throw new AgentSpendCapKeyNotFoundError();
  const meta = metadata as Record<string, unknown>;
  const current = meta.spendCap && typeof meta.spendCap === "object" ? (meta.spendCap as Record<string, unknown>) : {};
  const dailyMicroUsd = dailyUsd === null ? null : Math.round(dailyUsd * 1_000_000);
  const nextSpendCap = { ...current, dailyMicroUsd };
  const { error } = await (client.from("managed_venice_proxy_keys") as DbChain)
    .update({ metadata: { ...meta, spendCap: nextSpendCap }, updated_at: new Date().toISOString() })
    .eq("id", params.proxyKeyId)
    .eq("user_id", params.userId);
  if (error) throw new Error(error.message || "Failed to save the agent's daily limit");
  return readAgentSpendCap({ spendCap: nextSpendCap });
}
