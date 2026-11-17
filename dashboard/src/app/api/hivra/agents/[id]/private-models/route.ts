// An agent's "private models only" setting (Manage › Inference).
//
// GET reads the setting and whether the agent's saved model is a private one;
// PUT turns it on or off. Owner-scoped: another owner's agent, a deleted one
// or a malformed id is a 404. Only agents on the managed gateway have a key
// to restrict; others get 409. While MANAGED_VENICE_AGENT_PRIVATE_ONLY_ENABLED
// is off the route answers 404 so the dashboard hides the control.
//
// The setting can only be changed here, by the signed-in owner from the
// dashboard. An agent's own inference key cannot change it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit, RATE_LIMIT_PRESETS } from "@/lib/authenticated-rate-limit";
import { supabaseAdmin } from "@/lib/supabase";
import { readStoredLlmConfig } from "@/lib/hivra/agent-llm";
import { VENICE_DEFAULT_MODEL } from "@/lib/hivra/model-key-selection";
import {
  AgentPrivateOnlyKeyNotFoundError,
  readAgentPrivateOnly,
  resolveManagedVeniceAgentPrivateOnlyConfig,
  setManagedVeniceAgentPrivateOnly,
} from "@/lib/venice/agent-private-only";
import { isPrivateVenicePrivacy } from "@/lib/venice/model-privacy";
import { resolveVeniceModelPrivacy } from "@/lib/venice/model-privacy-live";
import { ProxyKeyMetadataConflictError } from "@/lib/venice/proxy-key-metadata";
import { hasStrictJsonContentType, isSameOriginMutationRequest, readBoundedJson } from "@/app/api/infrastructure/connections/request-security";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Body = z.object({ enabled: z.boolean() }).strict();

function noStore(response: Response) {
  response.headers.set("Cache-Control", "no-store, private");
  return response;
}

type Resolved = { proxyKeyId: string; savedModel: string } | { response: Response };

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
    return { response: apiError("This agent doesn't use the managed gateway, so there are no managed models to restrict.", 409, undefined, { code: "not_managed" }) };
  }
  return { proxyKeyId: llm.proxyKeyId, savedModel: llm.model ?? VENICE_DEFAULT_MODEL };
}

async function view(userId: string, key: { proxyKeyId: string; savedModel: string }) {
  const { data, error } = await supabaseAdmin!
    .from("managed_venice_proxy_keys")
    .select("metadata")
    .eq("id", key.proxyKeyId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message || "Could not read this agent's setting");
  if (!data) throw new AgentPrivateOnlyKeyNotFoundError();
  const setting = readAgentPrivateOnly((data as { metadata?: unknown }).metadata);
  const privacy = await resolveVeniceModelPrivacy(key.savedModel);
  return {
    enabled: setting.enabled,
    updatedAt: setting.updatedAt,
    // Hivra's saved model for this agent, and whether a request to it would
    // pass with the setting on. The agent's own interface may use another.
    savedModel: key.savedModel,
    savedModelIsPrivate: isPrivateVenicePrivacy(privacy),
  };
}

function disabled() {
  return noStore(apiError("Not found", 404, undefined, { code: "feature_disabled" }));
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!resolveManagedVeniceAgentPrivateOnlyConfig().enabled) return disabled();
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    const { id } = await params;
    const key = await resolveKey(userId, id);
    if ("response" in key) return noStore(key.response);
    return noStore(apiSuccess(await view(userId, key)));
  } catch (err) {
    if (err instanceof AgentPrivateOnlyKeyNotFoundError) return noStore(apiError(err.message, 409, undefined, { code: "not_managed" }));
    return noStore(handleApiError(err));
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!resolveManagedVeniceAgentPrivateOnlyConfig().enabled) return disabled();
    const { userId } = await auth();
    if (!userId) return noStore(apiError("Unauthorized", 401));
    if (!isSameOriginMutationRequest(req)) return noStore(apiError("Change this setting from the Hivra dashboard.", 403));
    if (!hasStrictJsonContentType(req)) return noStore(apiError("Send the setting as JSON.", 415));
    const limited = enforceAuthenticatedRouteRateLimit(req, { routeKey: "hivra_agent_private_models", userId, ...RATE_LIMIT_PRESETS.secretWrite });
    if (limited) return noStore(limited);
    const body = await readBoundedJson(req, 256, 5000);
    if (!body.ok) return noStore(apiError("Send a setting request of at most 256 bytes.", body.reason === "too_large" ? 413 : 400));
    const parsed = Body.safeParse(body.body);
    if (!parsed.success) return noStore(apiError('Send {"enabled": true} or {"enabled": false}.', 400));
    const { id } = await params;
    const key = await resolveKey(userId, id);
    if ("response" in key) return noStore(key.response);
    await setManagedVeniceAgentPrivateOnly({ userId, proxyKeyId: key.proxyKeyId, enabled: parsed.data.enabled });
    return noStore(apiSuccess(await view(userId, key)));
  } catch (err) {
    if (err instanceof AgentPrivateOnlyKeyNotFoundError) return noStore(apiError(err.message, 409, undefined, { code: "not_managed" }));
    if (err instanceof ProxyKeyMetadataConflictError) return noStore(apiError(err.message, 409, undefined, { code: "conflict" }));
    return noStore(handleApiError(err));
  }
}
