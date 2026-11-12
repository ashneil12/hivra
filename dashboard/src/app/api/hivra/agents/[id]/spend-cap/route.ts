// An agent's daily limit on managed inference spend (Manage › Inference).
//
// GET reads the limit, today's charged spend and the last 7 days; PUT sets or
// clears the owner's own limit. Owner-scoped: another owner's agent, a deleted
// one or a malformed id is a 404. Only agents on the managed gateway have a
// key to limit; others get 409. While MANAGED_VENICE_AGENT_SPEND_CAPS_ENABLED
// is off the route answers 404 so the dashboard hides the control.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit, RATE_LIMIT_PRESETS } from "@/lib/authenticated-rate-limit";
import { supabaseAdmin } from "@/lib/supabase";
import { readStoredLlmConfig } from "@/lib/hivra/agent-llm";
import {
  AgentSpendCapKeyNotFoundError,
  MAX_AGENT_DAILY_SPEND_CAP_USD,
  dayStartIso,
  effectiveDailyCapMicroUsd,
  getAgentSpendByDayMicroUsd,
  readAgentSpendCap,
  resolveManagedVeniceAgentSpendCapConfig,
  setManagedVeniceAgentDailySpendCap,
} from "@/lib/billing/managed-venice-agent-spend-caps";
import { hasStrictJsonContentType, isSameOriginMutationRequest, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HISTORY_DAYS = 7;
const Body = z.object({
  dailyLimitUsd: z.number().positive().max(MAX_AGENT_DAILY_SPEND_CAP_USD).nullable(),
}).strict();

function noStore(response: Response) {
  response.headers.set("Cache-Control", "no-store, private");
  return response;
}

const usd = (micro: number | null) => (micro === null ? null : Math.round(micro / 10_000) / 100);

type Resolved = { proxyKeyId: string } | { response: Response };

async function resolveKey(userId: string, id: string): Promise<Resolved> {
  if (!supabaseAdmin) return { response: apiError("Database not configured", 500) };
  if (!UUID.test(id)) return { response: apiError("Agent not found", 404) };
  const { data, error } = await supabaseAdmin
    .from("hivra_agents")
    .select("id, status, llm_config")
    .eq("id", id)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return { response: apiError("Could not load this agent", 500) };
  const row = data as { status?: string; llm_config?: unknown } | null;
  if (!row || row.status === "deleted") return { response: apiError("Agent not found", 404) };
  const llm = readStoredLlmConfig(row.llm_config);
  if (llm?.mode !== "managed" || !llm.proxyKeyId) {
    return { response: apiError("This agent doesn't use the managed gateway, so there is no spend to limit.", 409, undefined, { code: "not_managed" }) };
  }
  return { proxyKeyId: llm.proxyKeyId };
}

async function view(userId: string, proxyKeyId: string, now = new Date()) {
  const config = resolveManagedVeniceAgentSpendCapConfig();
  const { data, error } = await supabaseAdmin!
    .from("managed_venice_proxy_keys")
    .select("metadata")
    .eq("id", proxyKeyId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message || "Could not read this agent's limit");
  if (!data) throw new AgentSpendCapKeyNotFoundError();
  const setting = readAgentSpendCap((data as { metadata?: unknown }).metadata);
  const since = new Date(Date.parse(dayStartIso(now)) - (HISTORY_DAYS - 1) * 86_400_000);
  const byDay = await getAgentSpendByDayMicroUsd({ userId, proxyKeyId, sinceIso: since.toISOString() });
  const days = Array.from({ length: HISTORY_DAYS }, (_, i) => {
    const day = new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    return { day, spentUsd: usd(byDay.get(day) ?? 0)! };
  });
  const today = dayStartIso(now);
  return {
    dailyLimitUsd: usd(setting.dailyMicroUsd),
    defaultDailyLimitUsd: usd(config.defaultDailyMicroUsd),
    effectiveDailyLimitUsd: usd(effectiveDailyCapMicroUsd(setting, config)),
    spentTodayUsd: days[days.length - 1].spentUsd,
    reachedToday: !!setting.lastReachedAt && setting.lastReachedAt >= today,
    lastReachedAt: setting.lastReachedAt,
    resetsAt: new Date(Date.parse(today) + 86_400_000).toISOString(),
    days,
  };
}

function disabled() {
  return noStore(apiError("Not found", 404, undefined, { code: "feature_disabled" }));
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!resolveManagedVeniceAgentSpendCapConfig().enabled) return disabled();
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    const { id } = await params;
    const key = await resolveKey(userId, id);
    if ("response" in key) return noStore(key.response);
    return noStore(apiSuccess(await view(userId, key.proxyKeyId)));
  } catch (err) {
    if (err instanceof AgentSpendCapKeyNotFoundError) return noStore(apiError(err.message, 409, undefined, { code: "not_managed" }));
    return noStore(handleApiError(err));
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!resolveManagedVeniceAgentSpendCapConfig().enabled) return disabled();
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!isSameOriginMutationRequest(req)) return noStore(apiError("Change this limit from the Hivra dashboard.", 403));
    if (!hasStrictJsonContentType(req)) return noStore(apiError("Send the limit as JSON.", 415));
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra_agent_spend_cap", userId, ...RATE_LIMIT_PRESETS.secretWrite });
    if (limited) return noStore(limited);
    const body = await readBoundedJson(req, 512, 5000);
    if (!body.ok) return noStore(apiError("Send a limit request of at most 512 bytes.", body.reason === "too_large" ? 413 : 400));
    const parsed = Body.safeParse(body.body);
    if (!parsed.success) {
      return noStore(apiError(`Set a daily limit between $0.01 and $${MAX_AGENT_DAILY_SPEND_CAP_USD}, or null for no limit of its own.`, 400));
    }
    const { id } = await params;
    const key = await resolveKey(userId, id);
    if ("response" in key) return noStore(key.response);
    await setManagedVeniceAgentDailySpendCap({ userId, proxyKeyId: key.proxyKeyId, dailyUsd: parsed.data.dailyLimitUsd });
    return noStore(apiSuccess(await view(userId, key.proxyKeyId)));
  } catch (err) {
    if (err instanceof AgentSpendCapKeyNotFoundError) return noStore(apiError(err.message, 409, undefined, { code: "not_managed" }));
    if (err instanceof RangeError) return noStore(apiError(err.message, 400));
    return noStore(handleApiError(err));
  }
}
