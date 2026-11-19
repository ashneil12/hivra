// "Private models only" for one agent on the managed gateway.
//
// Venice marks each model it serves as private (Venice says it does not keep
// the request) or anonymized (the request passes through a third-party
// provider). See model-privacy.ts. With this setting on, an agent's managed
// inference key refuses every model Venice does not mark private, before any
// hold is placed and before anything is sent. It covers chat, Responses, the
// Anthropic-format route and every media route (images, video, audio,
// embeddings), because they all bill through the same key.
//
// What it is NOT: it does not change what a private model is, what Venice
// keeps, or what Hivra stores. It only narrows which models this key may call.
//
// Like the daily spend limit, the setting lives in the key's metadata
// (`metadata.privateOnly.enabled`), so there is no schema change. Only the
// signed-in owner can change it, from the dashboard; the key itself cannot.
//
// Off by default: with MANAGED_VENICE_AGENT_PRIVATE_ONLY_ENABLED unset every
// check allows the request without reading anything, the dashboard route
// answers 404, and behaviour is identical to today.

import { requireDb } from "@/lib/billing/db-utils";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { isPrivateVenicePrivacy, type VenicePrivacy } from "@/lib/venice/model-privacy";
import { getVeniceModelPrivacyLookup, resolveVeniceModelPrivacy } from "@/lib/venice/model-privacy-live";
import { updateManagedVeniceProxyKeyMetadata } from "@/lib/venice/proxy-key-metadata";

type SupabaseLike = { from: (table: string) => unknown };

/** Error code on every refusal, in the OpenAI-format and Anthropic-format bodies alike. */
export const MANAGED_VENICE_PRIVATE_ONLY_CODE = "managed_venice_private_models_only";

export interface ManagedVeniceAgentPrivateOnlyConfig {
  enabled: boolean;
}

export function resolveManagedVeniceAgentPrivateOnlyConfig(
  env: Record<string, string | undefined> = process.env
): ManagedVeniceAgentPrivateOnlyConfig {
  return { enabled: env.MANAGED_VENICE_AGENT_PRIVATE_ONLY_ENABLED === "true" };
}

export interface AgentPrivateOnlySetting {
  /** True only when the owner turned the setting on. */
  enabled: boolean;
  /** When the owner last changed it (ISO), or null if never. */
  updatedAt: string | null;
}

/** Reads the setting defensively: anything but a stored `true` is off. */
export function readAgentPrivateOnly(metadata: unknown): AgentPrivateOnlySetting {
  const meta = metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
  const raw = meta.privateOnly && typeof meta.privateOnly === "object" ? (meta.privateOnly as Record<string, unknown>) : {};
  return {
    enabled: raw.enabled === true,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

export class AgentPrivateOnlyKeyNotFoundError extends Error {
  constructor() {
    super("This agent has no managed inference key");
    this.name = "AgentPrivateOnlyKeyNotFoundError";
  }
}

/** Turn the setting on or off for one agent key. Keeps every other metadata field. */
export async function setManagedVeniceAgentPrivateOnly(
  params: { userId: string; proxyKeyId: string; enabled: boolean; now?: Date },
  db: SupabaseLike | null | undefined = supabaseAdmin
): Promise<AgentPrivateOnlySetting> {
  const client = requireDb(db) as SupabaseLike;
  const privateOnly = { enabled: params.enabled === true, updatedAt: (params.now ?? new Date()).toISOString() };
  const stored = await updateManagedVeniceProxyKeyMetadata(
    client,
    { userId: params.userId, proxyKeyId: params.proxyKeyId },
    (current) => ({ ...current, privateOnly })
  );
  if (stored === null) throw new AgentPrivateOnlyKeyNotFoundError();
  return readAgentPrivateOnly(stored);
}

// Paid operations with no AI model behind them: a web search, fetching a page,
// parsing a document, listing voices, a blockchain lookup. The setting is
// about models, so these stay available. (Search and page fetching reach the
// public web by their nature.)
const MODEL_FREE_ENDPOINTS = new Set([
  "/api/v1/augment/search",
  "/api/v1/augment/scrape",
  "/api/v1/augment/text-parser",
  "/api/v1/audio/voices",
]);
const MODEL_FREE_ENDPOINT_PREFIXES = ["/api/v1/crypto/rpc/"];

export function isModelFreeManagedVeniceEndpoint(endpoint: string): boolean {
  return MODEL_FREE_ENDPOINTS.has(endpoint) || MODEL_FREE_ENDPOINT_PREFIXES.some((prefix) => endpoint.startsWith(prefix));
}

// Hivra's own billing labels for operations whose Venice model has another id.
const VENICE_MODEL_ID_FOR_LABEL: Record<string, string> = {
  "venice-upscaler": "upscaler",
};

export interface ManagedVenicePrivateOnlyKey {
  id: string;
  userId: string;
  /** From the verified key (proxy-keys.ts). Absent means off. */
  privateModelsOnly?: boolean;
}

export type ManagedVenicePrivateOnlyVerdict =
  | { allowed: true }
  | {
      allowed: false;
      /** The model as the caller named it, shortened for messages and logs. */
      model: string;
      /** What is known about it: "anonymized", or null when nothing is. */
      privacy: VenicePrivacy | null;
      message: string;
    };

const ALLOWED: ManagedVenicePrivateOnlyVerdict = { allowed: true };

function refusalMessage(model: string, privacy: VenicePrivacy | null): string {
  const reason = privacy === "anonymized"
    ? `Venice does not mark "${model}" as private`
    : `Hivra could not confirm that "${model}" is a private model on Venice`;
  return (
    `This agent is set to private models only. ${reason}, so the request was not sent and nothing was charged. ` +
    "Choose a private model, or the owner can turn this setting off in Hivra under this agent's Manage › Inference."
  );
}

/**
 * May this key call this model? Allowed straight away when the feature is
 * off or the key does not have the setting on. Otherwise allowed only for an
 * operation with no model behind it, or a model known to be private; an
 * anonymized or unknown model is refused. Call it after the request is
 * validated and before any hold or upstream fetch.
 */
export async function checkManagedVeniceAgentPrivateOnly(
  params: {
    key: ManagedVenicePrivateOnlyKey;
    model: string | null | undefined;
    /** Venice endpoint label, e.g. "/api/v1/chat/completions". */
    endpoint: string;
    /** Log source, e.g. "managed-venice-chat". */
    source: string;
  },
  env: Record<string, string | undefined> = process.env
): Promise<ManagedVenicePrivateOnlyVerdict> {
  if (!resolveManagedVeniceAgentPrivateOnlyConfig(env).enabled) return ALLOWED;
  if (params.key.privateModelsOnly !== true) return ALLOWED;
  if (isModelFreeManagedVeniceEndpoint(params.endpoint)) return ALLOWED;

  const named = typeof params.model === "string" ? params.model.trim() : "";
  const privacy = named ? await resolveVeniceModelPrivacy(VENICE_MODEL_ID_FOR_LABEL[named] ?? named) : null;
  if (isPrivateVenicePrivacy(privacy)) return ALLOWED;

  const model = (named || "this operation").slice(0, 80);
  log.warn("Managed Venice request refused: this agent is set to private models only", {
    source: params.source,
    route: params.endpoint,
    failureType: "managed_venice_private_only_refused",
    userId: params.key.userId,
    proxyKeyId: params.key.id,
    model,
    privacy: privacy ?? "unknown",
  });
  return { allowed: false, model, privacy, message: refusalMessage(model, privacy) };
}

/**
 * For a model list served to this key: a test that keeps only the models the
 * key may call, or null when the list should be served whole (feature off, or
 * the key does not have the setting on).
 */
export async function managedVenicePrivateOnlyModelFilter(
  key: ManagedVenicePrivateOnlyKey,
  env: Record<string, string | undefined> = process.env
): Promise<((modelId: string) => boolean) | null> {
  if (!resolveManagedVeniceAgentPrivateOnlyConfig(env).enabled) return null;
  if (key.privateModelsOnly !== true) return null;
  const privacyOf = await getVeniceModelPrivacyLookup();
  return (modelId: string) => isPrivateVenicePrivacy(privacyOf(VENICE_MODEL_ID_FOR_LABEL[modelId] ?? modelId));
}

/**
 * The refusal as an OpenAI-format error response (chat, Responses and media
 * routes). It is a 400, like the gateway's other "this model is not available
 * here" answers, and deliberately not a 403: the off-Vercel Worker reads a 403
 * from the authorize call as its own shared secret being wrong and would hide
 * this message behind a 502.
 */
export function managedVenicePrivateOnlyResponse(verdict: { message: string }): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: verdict.message,
        type: "invalid_request_error",
        param: "model",
        code: MANAGED_VENICE_PRIVATE_ONLY_CODE,
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
  );
}
