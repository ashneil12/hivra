/**
 * The spend guarantee: an agent on Hivra AI cannot cost its owner more than the
 * daily limit set for it. If one does (requests already running when the limit
 * is reached, a reply that costs more than its estimate), Hivra pays the
 * difference: once a day, for the UTC day just ended, every key's charged
 * spend above its limit is credited back to the owner's balance.
 *
 * MANAGED_VENICE_SPEND_GUARANTEE: unset/anything else does nothing; `dry`
 * reports what it would credit; `on` credits. A single key-day credit above
 * MANAGED_VENICE_SPEND_GUARANTEE_REVIEW_USD (default 50) is held for a person
 * to look at instead of being paid automatically.
 *
 * The credit is idempotent per key and day (its reference), so a re-run never
 * pays twice.
 */
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { refundManagedVeniceOvercharge } from "@/lib/billing/managed-venice-wallets";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  effectiveDailyCapMicroUsd,
  readAgentSpendCap,
  resolveManagedVeniceAgentSpendCapConfig,
} from "@/lib/billing/managed-venice-agent-spend-caps";

type EnvLike = Record<string, string | undefined>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the admin client is untyped here, as in the sweeps
type Db = any;

const PAGE = 1000;
const MAX_ROWS = 200_000;

export type SpendGuaranteeMode = "off" | "dry" | "on";

export function spendGuaranteeMode(env: EnvLike = process.env): SpendGuaranteeMode {
  const value = env.MANAGED_VENICE_SPEND_GUARANTEE?.trim().toLowerCase();
  return value === "dry" || value === "on" ? value : "off";
}

function reviewThresholdMicroUsd(env: EnvLike): number {
  const n = Number(env.MANAGED_VENICE_SPEND_GUARANTEE_REVIEW_USD?.trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1_000_000) : 50_000_000;
}

/** The UTC day before `now`, as [startIso, endIso, "YYYY-MM-DD"]. */
export function previousUtcDay(now: Date): { start: string; end: string; day: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - 86_400_000);
  return { start: start.toISOString(), end: end.toISOString(), day: start.toISOString().slice(0, 10) };
}

export type GuaranteeCredit = { keyId: string; userId: string; capMicroUsd: number; chargedMicroUsd: number; creditMicroUsd: number };

/** Pure: which key-days went over their limit, and by how much. */
export function guaranteeCredits(
  spend: Map<string, { userId: string; charged: number }>,
  caps: Map<string, number>,
): GuaranteeCredit[] {
  const out: GuaranteeCredit[] = [];
  for (const [keyId, { userId, charged }] of spend) {
    const cap = caps.get(keyId);
    if (cap === undefined || cap <= 0) continue;
    const over = Math.floor(charged - cap);
    if (over > 0) out.push({ keyId, userId, capMicroUsd: cap, chargedMicroUsd: charged, creditMicroUsd: over });
  }
  return out.sort((a, b) => a.keyId.localeCompare(b.keyId));
}

export type SpendGuaranteeSummary = {
  skipped: boolean;
  reason?: string;
  mode: SpendGuaranteeMode;
  day?: string;
  keysOver: number;
  credited: number;
  creditedMicroUsd: number;
  heldForReview: number;
  errors: number;
  plan?: Array<{ keyId: string; creditMicroUsd: number }>;
};

export async function runSpendGuarantee(deps: {
  db?: Db; env?: EnvLike; now?: () => Date; refund?: typeof refundManagedVeniceOvercharge;
} = {}): Promise<SpendGuaranteeSummary> {
  const env = deps.env ?? process.env;
  const mode = spendGuaranteeMode(env);
  const summary: SpendGuaranteeSummary = { skipped: false, mode, keysOver: 0, credited: 0, creditedMicroUsd: 0, heldForReview: 0, errors: 0 };
  if (mode === "off") return { ...summary, skipped: true, reason: "flag_off" };
  const capConfig = resolveManagedVeniceAgentSpendCapConfig(env);
  // Without per-agent limits on there is no limit to guarantee.
  if (!capConfig.enabled) return { ...summary, skipped: true, reason: "limits_off" };
  const db = deps.db ?? supabaseAdmin;
  if (!db) return { ...summary, skipped: true, reason: "no_database" };
  const refund = deps.refund ?? refundManagedVeniceOvercharge;
  const { start, end, day } = previousUtcDay((deps.now ?? (() => new Date()))());
  summary.day = day;

  // Charged spend per key for the day.
  const spend = new Map<string, { userId: string; charged: number }>();
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const { data, error } = await db
      .from("managed_venice_usage_events")
      .select("id, user_id, proxy_key_id, charged_micro_usd")
      .gte("created_at", start)
      .lt("created_at", end)
      .not("proxy_key_id", "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) return { ...summary, errors: 1, reason: "usage_query_failed" };
    const rows = (data ?? []) as Array<{ user_id: string; proxy_key_id: string; charged_micro_usd: unknown }>;
    for (const row of rows) {
      const v = typeof row.charged_micro_usd === "number" && Number.isFinite(row.charged_micro_usd) ? row.charged_micro_usd : 0;
      const current = spend.get(row.proxy_key_id) ?? { userId: row.user_id, charged: 0 };
      current.charged += v;
      spend.set(row.proxy_key_id, current);
    }
    if (rows.length < PAGE) break;
  }
  if (spend.size === 0) return summary;

  // The limit each key had: its own, else the platform default.
  const caps = new Map<string, number>();
  const ids = [...spend.keys()];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.from("managed_venice_proxy_keys").select("id, metadata").in("id", ids.slice(i, i + 200));
    if (error) return { ...summary, errors: 1, reason: "keys_query_failed" };
    for (const row of (data ?? []) as Array<{ id: string; metadata: unknown }>) {
      const cap = effectiveDailyCapMicroUsd(readAgentSpendCap(row.metadata), capConfig);
      if (cap !== null) caps.set(row.id, cap);
    }
  }

  const credits = guaranteeCredits(spend, caps);
  summary.keysOver = credits.length;
  const review = reviewThresholdMicroUsd(env);
  if (mode === "dry") summary.plan = credits.map((c) => ({ keyId: c.keyId, creditMicroUsd: c.creditMicroUsd }));
  for (const credit of credits) {
    if (credit.creditMicroUsd > review) {
      summary.heldForReview += 1;
      await reportOpsEvent({
        source: "managed-venice-spend-guarantee",
        severity: "warn",
        title: "Spend guarantee credit held for review",
        message: `day=${day} key=${credit.keyId} cap_micro_usd=${credit.capMicroUsd} charged_micro_usd=${credit.chargedMicroUsd} credit_micro_usd=${credit.creditMicroUsd}`,
        userId: credit.userId,
      }).catch(() => undefined);
      continue;
    }
    if (mode === "dry") continue;
    try {
      const result = await refund({
        userId: credit.userId,
        amountMicroUsd: credit.creditMicroUsd,
        referenceId: `spend_guarantee:${credit.keyId}:${day}`,
        metadata: { kind: "spend_guarantee", day, proxyKeyId: credit.keyId, capMicroUsd: credit.capMicroUsd, chargedMicroUsd: credit.chargedMicroUsd },
      }, db);
      if (!result.alreadyRefunded) {
        summary.credited += 1;
        summary.creditedMicroUsd += credit.creditMicroUsd;
      }
    } catch (error) {
      summary.errors += 1;
      log.warn("spend guarantee credit failed", {
        source: "managed-venice-spend-guarantee", failureType: "spend_guarantee_credit_failed", userId: credit.userId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return summary;
}
