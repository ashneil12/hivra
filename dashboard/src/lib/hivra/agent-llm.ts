// Hivra agent LLM provider config — the shared layer that lets catalog agents
// (codex today; claude-code after the Anthropic shim ships) run inference
// through an alternative provider instead of their native vendor login.
//
// Two modes:
//   byok    — the user's own Venice API key; the box calls api.venice.ai directly.
//   managed — Hivra mints a managed-Venice proxy key (hven_live_*) and the box
//             calls the dashboard's /api/managed-venice/v1 gateway, billed to
//             the user's managed-Venice wallet.
//
// Storage: hivra_agents.llm_config (jsonb, key-free metadata) +
// hivra_agents.llm_api_key_encrypted (the plaintext key encrypted at rest —
// Hermes-lane custody model, so a box rebuild can re-seed without re-asking).
// Delivery: ~/.hivra/llm-provider.json on the box (bootstrap seed at provision,
// box /api/llm for post-launch changes); the chat server reads it per spawn.

import { getManagedVeniceProxyBaseUrl } from "@/lib/venice/managed-endpoints";
import { getAgent } from "./agent-catalog";
import { publicHivraAgentActivity } from "./agent-authority";
import { ModelKeySelectionSchema, VENICE_DEFAULT_MODEL } from "./model-key-selection";
export { VENICE_DEFAULT_MODEL } from "./model-key-selection";

export const VENICE_DIRECT_BASE_URL = "https://api.venice.ai/api/v1";

// Same charset clamp as the box's model override (server.js MODEL_RE).
const MODEL_RE = /^[A-Za-z0-9._:\/\[\]-]{1,64}$/;

export type LlmMode = "byok" | "managed";
type LlmWalletType = "hermesos" | "card";

/** What callers may submit at launch or via the [id]/llm route. */
interface LlmConfigInput {
  provider: "venice";
  mode: LlmMode;
  /** BYOK only — the user's own Venice API key. */
  apiKey?: string;
  model?: string;
  /** Managed only — which wallet the proxy key debits. */
  walletType?: LlmWalletType;
}

/** Key-free metadata persisted in hivra_agents.llm_config. */
export interface StoredLlmConfig {
  provider: "venice";
  mode: LlmMode;
  model: string | null;
  /** Managed only. */
  proxyKeyId?: string;
  keyPrefix?: string;
  walletType?: LlmWalletType;
  enabledAt: string;
}

/** What the box persists at ~/.hivra/llm-provider.json (includes the key). */
export interface BoxLlmPayload {
  provider: "venice";
  baseUrl: string;
  apiKey: string;
  model: string | null;
}

export interface LlmValidation {
  ok: boolean;
  error?: string;
  input?: LlmConfigInput;
}

// Validate a raw request body's `llm` field against the agent type's declared
// capability. Returns a normalized input or a user-facing error.
export function validateLlmInput(raw: unknown, agentType: string): LlmValidation {
  if (raw == null) return { ok: true };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "llm must be an object" };
  const o = raw as Record<string, unknown>;
  const provider = o.provider;
  // Preserve the explicit empty native selector, but never silently discard a
  // supplied credential, model, wallet or unknown field behind that selector.
  if ((provider === undefined || provider === "") && Object.keys(o).every(key => key === "provider")) return { ok: true };
  if (provider !== "venice") return { ok: false, error: "Unsupported LLM provider" };

  const def = getAgent(agentType);
  if (!def?.llm || !def.llm.providers.includes("venice")) {
    return { ok: false, error: `${def?.name || agentType} doesn't support an alternative LLM provider yet` };
  }

  const mode = o.mode === "managed" ? "managed" : o.mode === "byok" ? "byok" : null;
  if (!mode) return { ok: false, error: "llm.mode must be byok or managed" };

  if (mode === "byok" && (typeof o.apiKey !== "string" || !o.apiKey.trim())) {
    return { ok: false, error: "A Venice API key is required for bring-your-own-key" };
  }
  const parsed = ModelKeySelectionSchema.safeParse(o);
  if (!parsed.success || !parsed.data) return { ok: false, error: "Check the model settings, API key and selected wallet before launching." };
  const selection = parsed.data;
  return {
    ok: true,
    input: {
      provider: "venice",
      mode,
      apiKey: selection.mode === "byok" ? selection.apiKey : undefined,
      // Preserve existing stored-metadata semantics for native/legacy installers;
      // durable delivery resolves the same shared default at admission.
      model: typeof o.model === "string" && o.model.trim() ? selection.model : undefined,
      walletType: selection.mode === "managed" ? selection.walletType : undefined,
    },
  };
}

export function llmBaseUrl(mode: LlmMode): string {
  return mode === "managed" ? getManagedVeniceProxyBaseUrl() : VENICE_DIRECT_BASE_URL;
}

// The box-side payload for a stored config + its plaintext key.
export function buildBoxLlmPayload(config: StoredLlmConfig, plaintextKey: string): BoxLlmPayload {
  return {
    provider: config.provider,
    baseUrl: llmBaseUrl(config.mode),
    apiKey: plaintextKey,
    model: config.model ?? VENICE_DEFAULT_MODEL,
  };
}

// Parse the jsonb column defensively — rows written by future versions must
// never crash older readers.
export function readStoredLlmConfig(raw: unknown): StoredLlmConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.provider !== "venice") return null;
  const mode = o.mode === "managed" ? "managed" : o.mode === "byok" ? "byok" : null;
  if (!mode) return null;
  return {
    provider: "venice",
    mode,
    model: typeof o.model === "string" && MODEL_RE.test(o.model) ? o.model : null,
    proxyKeyId: typeof o.proxyKeyId === "string" ? o.proxyKeyId : undefined,
    keyPrefix: typeof o.keyPrefix === "string" ? o.keyPrefix : undefined,
    walletType: o.walletType === "card" ? "card" : o.walletType === "hermesos" ? "hermesos" : undefined,
    enabledAt: typeof o.enabledAt === "string" ? o.enabledAt : new Date(0).toISOString(),
  };
}

/** Key-free summary safe to return to the dashboard client. */
export function publicLlmConfig(config: StoredLlmConfig | null) {
  if (!config) return null;
  return {
    provider: config.provider,
    mode: config.mode,
    model: config.model,
    keyPrefix: config.keyPrefix ?? null,
    walletType: config.walletType ?? null,
    enabledAt: config.enabledAt,
  };
}

// Strip the encrypted key column and normalize llm_config before an agent row
// leaves the server. Every route that returns hivra_agents rows goes through
// this — the ciphertext must never reach the browser.
type PrivateHivraAgentColumn =
  | "llm_api_key_encrypted"
  | "infrastructure_binding_token_hash"
  | "infrastructure_binding_token_enforced"
  | "allocation_operation_id"
  | "operation_id"
  | "operation_kind"
  | "operation_started_at"
  | "operation_payload"
  | "managed_provisioner_channel"
  | "provider_install_not_after"
  | "provider_install_identity"
  | "provider_install_dispatched_at"
  | "provider_install_stopped_at"
  | "provider_install_outcome";

type PublicAgentSummaries = {
  llm_config: ReturnType<typeof publicLlmConfig>;
  activity: ReturnType<typeof publicHivraAgentActivity>;
};

export function sanitizeHivraAgentRow<T extends Record<string, unknown>>(row: T): Omit<T, PrivateHivraAgentColumn> & PublicAgentSummaries {
  const rest = { ...row } as Record<string, unknown>;
  delete rest.llm_api_key_encrypted;
  delete rest.infrastructure_binding_token_hash;
  delete rest.infrastructure_binding_token_enforced;
  delete rest.allocation_operation_id;
  delete rest.operation_id;
  delete rest.operation_kind;
  delete rest.operation_started_at;
  delete rest.operation_payload;
  delete rest.managed_provisioner_channel;
  delete rest.provider_install_not_after;
  delete rest.provider_install_identity;
  delete rest.provider_install_dispatched_at;
  delete rest.provider_install_stopped_at;
  delete rest.provider_install_outcome;
  return {
    ...rest,
    activity: publicHivraAgentActivity(row),
    llm_config: publicLlmConfig(readStoredLlmConfig(row.llm_config)),
  } as Omit<T, PrivateHivraAgentColumn> & PublicAgentSummaries;
}
