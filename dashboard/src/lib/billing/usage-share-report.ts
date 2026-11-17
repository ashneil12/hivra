// Loads one month of the operator usage and margins report: who pays, what the
// servers cost, how many hours each agent type worked, and what a share of the
// remainder would come to if it were split by use. Read-only; nothing here
// bills, pays or stores anything.

import type { SupabaseClient } from "@supabase/supabase-js";

import { PLANS } from "@/lib/subscription";
import {
  computeUsageSharePreview,
  type UsageShareAssumptions,
  type UsageSharePreview,
  type UsageShareSubscriber,
  type UsageShareUsageRow,
} from "@/lib/billing/usage-share";

const PAGE = 1000;
const MAX_PAGES = 200;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export interface UsageShareMonth {
  /** YYYY-MM, UTC. */
  label: string;
  from: Date;
  to: Date;
}

export interface UsageShareInputs {
  sharePercent: number;
  feePercent: number;
  feeFixedMinor: number;
  /** The App Store's cut of a payment made through it, in percent. */
  appStoreFeePercent: number;
  /** How many US dollars one unit of another currency buys, by currency code. */
  usdRates: Record<string, number>;
}

export interface UsageShareServerCosts {
  /** Server costs counted in the sums, in US cents. */
  includedMinorUsd: number;
  /** Monthly server costs as entered, per currency, in minor units. */
  byCurrency: Record<string, number>;
  /** Currencies with costs but no rate, so left out of the sums. */
  missingRates: string[];
  hostsPriced: number;
  /** Active servers Hivra knows of, or null when that could not be read. */
  activeHosts: number | null;
  /** Active servers with no price entered. */
  unpricedHosts: string[];
}

export interface UsageShareReport {
  month: UsageShareMonth;
  inputs: UsageShareInputs;
  preview: UsageSharePreview;
  serverCosts: UsageShareServerCosts;
  /** People on a paid plan with no card or App Store subscription on record; counted at 0. */
  unbilledPaidPlans: number;
}

interface QueryResult<T> {
  data: T[] | null;
  error: { message?: string } | null;
}

interface RangedQuery<T> {
  range(from: number, to: number): PromiseLike<QueryResult<T>>;
}

export function parseUsageShareMonth(input: string | undefined, now: Date = new Date()): UsageShareMonth {
  const match = input ? MONTH.exec(input) : null;
  const year = match ? Number(match[1]) : now.getUTCFullYear();
  const month = match ? Number(match[2]) - 1 : now.getUTCMonth();
  const from = new Date(Date.UTC(year, month, 1));
  const to = new Date(Date.UTC(year, month + 1, 1));
  return { label: `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, "0")}`, from, to };
}

function numberFrom(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Read the what-if inputs from the page address. The share has no default on
 * purpose: the report shows usage and margins until someone types one in.
 */
export function parseUsageShareInputs(params: Record<string, string | undefined>): UsageShareInputs {
  const usdRates: Record<string, number> = { USD: 1 };
  const eur = numberFrom(params.eur, 0, 0, 100);
  const gbp = numberFrom(params.gbp, 0, 0, 100);
  if (eur > 0) usdRates.EUR = eur;
  if (gbp > 0) usdRates.GBP = gbp;
  return {
    sharePercent: numberFrom(params.share, 0, 0, 100),
    feePercent: numberFrom(params.fee, 2.9, 0, 100),
    feeFixedMinor: Math.round(numberFrom(params.fixed, 0.3, 0, 100) * 100),
    appStoreFeePercent: numberFrom(params.appfee, 30, 0, 100),
    usdRates,
  };
}

async function readAll<T>(label: string, build: () => unknown): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await (build() as RangedQuery<T>).range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message ?? "read failed"}`);
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
  throw new Error(`${label}: too many rows`);
}

function planPriceMinor(plan: string): number {
  const def = (PLANS as Record<string, { price?: number } | undefined>)[plan];
  return typeof def?.price === "number" && def.price > 0 ? def.price : 0;
}

export async function loadUsageShareReport(
  db: SupabaseClient,
  month: UsageShareMonth,
  inputs: UsageShareInputs,
): Promise<UsageShareReport> {
  const toIso = month.to.toISOString();
  const lastDay = new Date(month.to.getTime() - 86_400_000).toISOString().slice(0, 10);

  const [subscriptionRows, appleRows, usageRows, costRows, hostRows] = await Promise.all([
    readAll<{ user_id: string; plan: string; stripe_subscription_id: string | null }>("subscriptions", () =>
      db.from("hermes_subscriptions").select("user_id, plan, stripe_subscription_id")
        .eq("status", "active").neq("plan", "free").lt("created_at", toIso).order("user_id", { ascending: true })),
    readAll<{ user_id: string }>("app store subscriptions", () =>
      db.from("apple_iap_subscriptions").select("user_id")
        .in("status", ["active", "grace_period"]).order("user_id", { ascending: true })),
    readAll<{
      user_id: string; agent_type: string; agents: number; active_hours: number; inference_requests: number | string;
      inference_charged_micro_usd: number | string; inference_cost_micro_usd: number | string; run_events: number | string;
    }>("usage", () => db.rpc("hivra_usage_by_user_and_type", { p_from: month.from.toISOString(), p_to: toIso })),
    readAll<{ host_id: string; monthly_cost_minor: number; currency: string; effective_from: string }>("server costs", () =>
      db.from("hivra_host_costs").select("host_id, monthly_cost_minor, currency, effective_from")
        .lte("effective_from", lastDay).order("effective_from", { ascending: false }).order("host_id", { ascending: true })),
    readAll<{ id: string; status: string }>("servers", () =>
      db.from("proxmox_hosts").select("id, status").order("id", { ascending: true }))
      .catch(() => null),
  ]);

  const appleUsers = new Set(appleRows.map((row) => row.user_id));
  let unbilledPaidPlans = 0;
  const subscribers: UsageShareSubscriber[] = subscriptionRows.map((row) => {
    const viaAppStore = !row.stripe_subscription_id && appleUsers.has(row.user_id);
    const billed = Boolean(row.stripe_subscription_id) || viaAppStore;
    if (!billed) unbilledPaidPlans += 1;
    return { userId: row.user_id, priceMinor: billed ? planPriceMinor(row.plan) : 0, viaAppStore };
  });

  const usage: UsageShareUsageRow[] = usageRows.map((row) => ({
    userId: row.user_id,
    agentType: row.agent_type,
    agents: Number(row.agents) || 0,
    activeHours: Number(row.active_hours) || 0,
    inferenceRequests: Number(row.inference_requests) || 0,
    inferenceChargedMicroUsd: Number(row.inference_charged_micro_usd) || 0,
    inferenceCostMicroUsd: Number(row.inference_cost_micro_usd) || 0,
    runEvents: Number(row.run_events) || 0,
  }));

  // The newest price on or before the month's last day, per server.
  const priceByHost = new Map<string, { minor: number; currency: string }>();
  for (const row of costRows) {
    if (!priceByHost.has(row.host_id)) priceByHost.set(row.host_id, { minor: Number(row.monthly_cost_minor) || 0, currency: row.currency });
  }
  const byCurrency: Record<string, number> = {};
  for (const { minor, currency } of priceByHost.values()) byCurrency[currency] = (byCurrency[currency] ?? 0) + minor;
  const missingRates: string[] = [];
  let includedMinorUsd = 0;
  for (const [currency, minor] of Object.entries(byCurrency)) {
    const rate = inputs.usdRates[currency];
    if (rate && rate > 0) includedMinorUsd += minor * rate;
    else if (minor > 0) missingRates.push(currency);
  }
  const activeHostIds = hostRows ? hostRows.filter((row) => row.status === "active").map((row) => row.id) : null;

  const assumptions: UsageShareAssumptions = {
    sharePercent: inputs.sharePercent,
    feePercent: inputs.feePercent,
    feeFixedMinor: inputs.feeFixedMinor,
    appStoreFeePercent: inputs.appStoreFeePercent,
    serverCostMinor: includedMinorUsd,
  };
  return {
    month,
    inputs,
    preview: computeUsageSharePreview(subscribers, usage, assumptions),
    serverCosts: {
      includedMinorUsd: Math.round(includedMinorUsd),
      byCurrency,
      missingRates: missingRates.sort(),
      hostsPriced: priceByHost.size,
      activeHosts: activeHostIds ? activeHostIds.length : null,
      unpricedHosts: activeHostIds ? activeHostIds.filter((id) => !priceByHost.has(id)).sort() : [],
    },
    unbilledPaidPlans,
  };
}
