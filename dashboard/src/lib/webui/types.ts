// Shared types for hermes-webui's API contract.
// Endpoints live on each Hetzner instance running the hermes-webui Docker image.
import type { LogContext } from "@/lib/logger";

export interface WebUISession {
  session_id: string;
  title: string;
  workspace: string;
  model: string;
  message_count: number;
  created_at: number;
  updated_at: number;
  pinned?: boolean;
  archived?: boolean;
  project_id?: string | null;
  profile?: string;
  source?: string;
  source_tag?: string;
  is_cli_session?: boolean;
  input_tokens?: number;
  output_tokens?: number;
  estimated_cost?: number | null;
  personality?: string | null;
}

type WebUIMessageRole = "user" | "assistant" | "tool" | "system";

export interface WebUIMessage {
  id?: number | string;
  role: WebUIMessageRole;
  content: string | Array<unknown>;
  tool_calls?: Array<unknown> | null;
  tool_call_id?: string | null;
  tool_name?: string | null;
  timestamp?: number;
  token_count?: number | null;
  finish_reason?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
}

export interface WebUIProvider {
  id: string;
  display_name?: string;
  has_key?: boolean;
  configurable?: boolean;
  key_source?: string;
  models?: Array<{ id: string; label?: string }>;
  [key: string]: unknown;
}

export interface WebUIModelsResponse {
  active_provider?: string;
  default_model?: string;
  groups?: Array<{
    provider: string;
    provider_id?: string;
    models: Array<{ id: string; label?: string }>;
  }>;
  [key: string]: unknown;
}

// GET /api/status on the agent dashboard (hermes_cli/web_server.py). This is
// the registered, bearer-authed status route that REPLACES the legacy
// hermes-webui `/health` JSON endpoint — the current agent image serves the
// SPA HTML shell at /health, so the old health() call throws "response was not
// JSON". Only the fields the dashboard reads are typed; the box returns more.
export interface WebUIStatusResponse {
  gateway_running?: boolean;
  gateway_state?: string;
  gateway_busy?: boolean;
  // Count of agents actively producing output right now — the "responding"
  // signal that hermes-webui used to expose as `active_streams`.
  active_agents?: number;
  active_sessions?: number;
  version?: string;
  [key: string]: unknown;
}

export interface WebUIProfile {
  name: string;
  path?: string;
  is_default?: boolean;
  is_active?: boolean;
  gateway_running?: boolean;
  model?: string | null;
  provider?: string | null;
  has_env?: boolean;
  skill_count?: number;
  [key: string]: unknown;
}

export interface WebUIProject {
  project_id: string;
  name: string;
  color?: string | null;
  created_at?: number;
  [key: string]: unknown;
}

export interface WebUIWorkspace {
  path: string;
  name: string;
  [key: string]: unknown;
}

export interface WebUIMemoryResponse {
  memory: string;
  user: string;
  memory_path?: string;
  user_path?: string;
  memory_mtime?: number | null;
  user_mtime?: number | null;
}

export interface WebUIPersonality {
  name: string;
  description?: string;
}

export interface WebUICommand {
  name: string;
  description?: string;
  category?: string;
  aliases?: string[];
  args_hint?: string;
  subcommands?: string[];
  cli_only?: boolean;
  gateway_only?: boolean;
  [key: string]: unknown;
}

export interface WebUIReasoningStatus {
  show_reasoning?: boolean;
  reasoning_effort?: string;
  [key: string]: unknown;
}

export interface WebUIBackgroundTask {
  task_id?: string;
  stream_id?: string;
  session_id?: string;
  status?: string;
  prompt?: string;
  result?: string;
  [key: string]: unknown;
}

export interface WebUIFileEntry {
  name: string;
  path: string;
  type: "dir" | "file" | string;
  size?: number | null;
}

export interface WebUIFileReadResponse {
  path: string;
  content: string;
  size: number;
  lines?: number;
}

export interface WebUIChatAttachment {
  name?: string;
  filename?: string;
  path: string;
  mime?: string;
  size?: number;
  is_image?: boolean;
}

export interface WebUISkillListResponse {
  skills: Array<{
    name: string;
    description?: string;
    category?: string | null;
    enabled?: boolean;
    [key: string]: unknown;
  }>;
}

export interface WebUIClientConfig {
  /** Base URL of the WebUI instance, e.g. https://<ip>.sslip.io */
  baseUrl: string;
  /** Optional bearer token for reverse-proxy protected instances */
  bearer?: string;
  /** Optional HERMES_WEBUI_PASSWORD value; exchanged for WebUI's auth cookie */
  password?: string;
  /** Optional host IPv4 fallback when the public WebUI hostname has DNS/TLS/network trouble */
  instanceIpv4?: string;
  /** Per-request timeout in ms (default 30s, ignored for streaming endpoints) */
  timeoutMs?: number;
  /**
   * Per-request correlation id propagated as `X-Request-Id` on every fetch
   * this client makes. Lets the WebUI log line for the upstream call line
   * up with the dashboard log line that initiated it.
   */
  requestId?: string;
  staleBearerRecovery?: WebUIStaleBearerRecoveryConfig;
}

interface WebUIStaleBearerRecoveryResult {
  apiServerKey: string;
  instanceIpv4?: string | null;
}

interface WebUIStaleBearerRecoveryConfig {
  failureTypePrefix: string;
  logCtx: LogContext;
  recover: (input: {
    currentBearer: string;
    path: string;
    upstreamStatus: number;
    upstreamBody: string;
  }) => Promise<WebUIStaleBearerRecoveryResult | null>;
}
