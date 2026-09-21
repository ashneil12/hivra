// hermes-webui API client. Used by Next.js route handlers (server-only).
// Replaces the dashboard's old gateway PATCH-001 overlay client.
//
// ⚠️ THIS CLIENT SPEAKS THE *LEGACY* hermes-webui HTTP CONTRACT.
//
// Contract verified against hermes-webui 12a8c05+ with hermes-agent ea01bdc.
// Fleet instances no longer run that server. Every bearer-authed /api/* request
// now lands on the agent image's own dashboard (`hermes_cli/web_server.py`,
// container `official-dashboard:9119`, reached via `dashboard-sidecar:9090`),
// which serves a DIFFERENT, smaller route set. Anything below that the agent
// dashboard does not implement falls through to its GET-only SPA catch-all →
// 404 on GET, 405 `Allow: GET` on POST.
//
// Endpoints that EXIST on the live agent image (safe for instance routes):
//   GET  /api/sessions                             → { sessions, cli_count }
//   GET  /api/status                               → runtime + gateway state
//   GET  /health                                   → SPA shell (liveness)
//
// The legacy-only chat/approval methods (startChat/streamChat/getSession/
// newSession/pendingApproval/respondApproval) were removed 2026-07-10 along
// with `/api/webui-dev/*`, the ops-admin harness that exercised them against
// a developer's own tunneled legacy webui. The box-side endpoints they spoke
// to (POST /api/chat/start, GET /api/chat/stream, /api/approval/*) 404/405
// fleet-wide (probed 2026-07-08 across 10 boxes / 7 hosts).
//
// Approvals + clarifications on the live agent are NOT pollable over HTTP.
// The agent pushes `approval.request` / `clarify.request` JSON-RPC events down
// the workspace iframe's /api/ws socket and blocks a worker thread on the
// reply; the client answers with `approval.respond` / `clarify.respond`.
// tui_gateway exposes no list/query method, so there is nothing to poll. The
// iframe owns that UX end to end. See ashneil12/hermesdeploy#529 (send-stream)
// for the same defect class.

import "server-only";

import { createHash } from "node:crypto";

import { buildGatewayProbeUrls } from "@/lib/gateway-probe";
import { fetchWithInsecureTLS } from "@/lib/insecure-fetch";
import { log } from "@/lib/logger";
import type {
  WebUIClientConfig,
  WebUIBackgroundTask,
  WebUICommand,
  WebUIFileEntry,
  WebUIFileReadResponse,
  WebUIChatAttachment,
  WebUIMemoryResponse,
  WebUIMessage,
  WebUIModelsResponse,
  WebUIPersonality,
  WebUIProfile,
  WebUIProject,
  WebUIProvider,
  WebUIReasoningStatus,
  WebUISession,
  WebUISkillListResponse,
  WebUIStatusResponse,
  WebUIWorkspace,
} from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_AUTH_COOKIE_CACHE_ENTRIES = 100;

const authCookieCache = new Map<string, string>();

export function __clearWebUIAuthCookieCacheForTests(): void {
  authCookieCache.clear();
}

export class WebUIError extends Error {
  readonly status: number;
  readonly body: string;
  // Network-level error code from the underlying fetch failure
  // (e.g. "ECONNRESET", "UND_ERR_SOCKET", "ETIMEDOUT"). The logger
  // serializes this verbatim alongside the error name without
  // exposing message/body content, so we can diagnose Vercel→origin
  // connectivity problems without leaking transcript fragments that
  // might appear in `message` or `body`. See logger.serializeError.
  readonly code?: string;
  constructor(message: string, opts: { status: number; body: string; code?: string }) {
    super(message);
    this.name = "WebUIError";
    this.status = opts.status;
    this.body = opts.body;
    if (opts.code) this.code = opts.code;
  }
}

function extractNetworkErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (err as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === "string") return causeCode;
  }
  // undici aggregates DNS failures into errors[]
  const errors = (err as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    for (const inner of errors) {
      const code = extractNetworkErrorCode(inner);
      if (code) return code;
    }
  }
  return undefined;
}

export class WebUIClient {
  private authCookie: string | null = null;

  constructor(private cfg: WebUIClientConfig) {
    this.authCookie = this.readCachedAuthCookie();
  }

  // ── Sessions ──────────────────────────────────────────────────────────
  async listSessions(opts: { profile?: string } = {}): Promise<WebUISession[]> {
    const json = await this.fetchJson<{ sessions: WebUISession[]; cli_count: number }>("/api/sessions", {
      profile: opts.profile,
    });
    return json.sessions ?? [];
  }

  /**
   * Materialize a CLI-backed session as a real WebUI session by writing a
   * JSON file to SESSION_DIR. Idempotent — if the session is already
   * imported, the agent refreshes its messages from the CLI store and
   * returns the existing record. Mirrors the import_cli call hermes-webui's
   * own UI fires when a user taps a CLI session in the sidebar
   * (static/sessions.js:1789-1794). Without this, every move/rename/pin/
   * archive against a CLI session fails with "Session not found" because
   * `Session.load` can only read JSON files, not the SQLite-backed CLI
   * store.
   */
  async importCliSession(
    sessionId: string,
    opts: { profile?: string } = {},
  ): Promise<{ session: WebUISession & { messages: WebUIMessage[]; is_cli_session?: boolean }; imported: boolean }> {
    return this.fetchJson("/api/session/import_cli", {
      method: "POST",
      body: { session_id: sessionId },
      profile: opts.profile,
    });
  }

  async deleteSession(sessionId: string, opts: { profile?: string } = {}): Promise<void> {
    await this.fetchJson("/api/session/delete", {
      method: "POST",
      body: { session_id: sessionId },
      profile: opts.profile,
    });
  }

  async renameSession(sessionId: string, title: string, opts: { profile?: string } = {}): Promise<void> {
    await this.fetchJson("/api/session/rename", {
      method: "POST",
      body: { session_id: sessionId, title },
      profile: opts.profile,
    });
  }

  async pinSession(sessionId: string, pinned: boolean, opts: { profile?: string } = {}): Promise<WebUISession> {
    const json = await this.fetchJson<{ ok?: boolean; session: WebUISession }>("/api/session/pin", {
      method: "POST",
      body: { session_id: sessionId, pinned },
      profile: opts.profile,
    });
    return json.session;
  }

  async archiveSession(sessionId: string, archived: boolean, opts: { profile?: string } = {}): Promise<WebUISession> {
    const json = await this.fetchJson<{ ok?: boolean; session: WebUISession }>("/api/session/archive", {
      method: "POST",
      body: { session_id: sessionId, archived },
      profile: opts.profile,
    });
    return json.session;
  }

  async moveSession(sessionId: string, projectId: string | null, opts: { profile?: string } = {}): Promise<WebUISession> {
    // The agent's /api/session/move handler currently does a global session
    // lookup (api/routes.py:1798) so the profile cookie is not strictly
    // required today. We forward it anyway so per-profile state-dir variants
    // and any future profile-scoped session storage Just Work without the
    // dashboard silently mutating the wrong tenant.
    const json = await this.fetchJson<{ ok?: boolean; session: WebUISession }>("/api/session/move", {
      method: "POST",
      body: { session_id: sessionId, project_id: projectId },
      profile: opts.profile,
    });
    return json.session;
  }

  // ── Chat ──────────────────────────────────────────────────────────────
  async uploadChatAttachment(
    sessionId: string,
    file: File,
    opts: { profile?: string } = {},
  ): Promise<WebUIChatAttachment> {
    const form = new FormData();
    form.set("session_id", sessionId);
    form.set("file", file);
    const uploaded = await this.fetchFormJson<WebUIChatAttachment>("/api/upload", form, {
      profile: opts.profile,
    });
    return {
      ...uploaded,
      name: uploaded.name || uploaded.filename || file.name,
    };
  }

  // ── Status ────────────────────────────────────────────────────────────
  /**
   * Runtime status from the agent dashboard's `/api/status`. This REPLACES the
   * legacy hermes-webui `/health` JSON endpoint, which the fleet agent image
   * does NOT serve — a bare GET /health returns the SPA HTML shell, so the old
   * health() call threw "response was not JSON" on every box and made the
   * command-center activity digest report every running agent as "unreachable".
   * /api/status is the registered, bearer-authed status route. Enforced by the
   * agent-endpoint-contract guard.
   */
  async status(): Promise<WebUIStatusResponse> {
    return this.fetchJson("/api/status");
  }

  async onboardingStatus(): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/onboarding/status");
  }

  // ── Models / Settings / Providers ────────────────────────────────────
  async models(opts: { profile?: string } = {}): Promise<WebUIModelsResponse> {
    return this.fetchJson("/api/models", {
      profile: opts.profile,
    });
  }

  async setDefaultModel(model: string, opts: { profile?: string } = {}): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/default-model", {
      method: "POST",
      body: { model },
      profile: opts.profile,
    });
  }

  async liveModels(provider?: string): Promise<Record<string, unknown>> {
    const query = provider ? `?provider=${encodeURIComponent(provider)}` : "";
    return this.fetchJson(`/api/models/live${query}`);
  }

  async providers(): Promise<WebUIProvider[]> {
    const json = await this.fetchJson<{ providers: WebUIProvider[] }>("/api/providers");
    return json.providers ?? [];
  }

  async setProviderKey(provider: string, apiKey: string | null, opts: { profile?: string } = {}): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/providers", {
      method: "POST",
      body: { provider, api_key: apiKey },
      profile: opts.profile,
    });
  }

  async deleteProviderKey(provider: string): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/providers/delete", {
      method: "POST",
      body: { provider },
    });
  }

  async settings(opts: { profile?: string } = {}): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/settings", {
      profile: opts.profile,
    });
  }

  async saveSettings(settings: Record<string, unknown>, opts: { profile?: string } = {}): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/settings", {
      method: "POST",
      body: settings,
      profile: opts.profile,
    });
  }

  // ── Profiles ─────────────────────────────────────────────────────────
  async profiles(): Promise<{ profiles: WebUIProfile[]; active: string }> {
    return this.fetchJson("/api/profiles");
  }

  async createProfile(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/profile/create", {
      method: "POST",
      body,
    });
  }

  async deleteProfile(name: string): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/profile/delete", {
      method: "POST",
      body: { name },
    });
  }

  async switchProfile(name: string): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/profile/switch", {
      method: "POST",
      body: { name },
    });
  }

  // ── Projects / Workspaces ───────────────────────────────────────────
  async projects(): Promise<WebUIProject[]> {
    const json = await this.fetchJson<{ projects: WebUIProject[] }>("/api/projects");
    return json.projects ?? [];
  }

  async createProject(body: { name: string; color?: string | null }): Promise<WebUIProject> {
    const json = await this.fetchJson<{ ok?: boolean; project: WebUIProject }>("/api/projects/create", {
      method: "POST",
      body,
    });
    return json.project;
  }

  async renameProject(projectId: string, body: { name: string; color?: string | null }): Promise<WebUIProject> {
    const json = await this.fetchJson<{ ok?: boolean; project: WebUIProject }>("/api/projects/rename", {
      method: "POST",
      body: { project_id: projectId, ...body },
    });
    return json.project;
  }

  async deleteProject(projectId: string): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/projects/delete", {
      method: "POST",
      body: { project_id: projectId },
    });
  }

  async workspaces(): Promise<{ workspaces: WebUIWorkspace[]; last?: string | null }> {
    const json = await this.fetchJson<{ workspaces: WebUIWorkspace[]; last?: string | null }>("/api/workspaces");
    return {
      workspaces: json.workspaces ?? [],
      last: json.last ?? null,
    };
  }

  async suggestWorkspaces(prefix = ""): Promise<{ suggestions: WebUIWorkspace[]; prefix: string }> {
    const json = await this.fetchJson<{ suggestions: WebUIWorkspace[]; prefix: string }>(
      `/api/workspaces/suggest?prefix=${encodeURIComponent(prefix)}`
    );
    return {
      suggestions: json.suggestions ?? [],
      prefix: json.prefix ?? prefix,
    };
  }

  async addWorkspace(body: { path: string; name?: string; create?: boolean }): Promise<{ workspaces: WebUIWorkspace[] }> {
    return this.fetchJson("/api/workspaces/add", {
      method: "POST",
      body,
    });
  }

  async removeWorkspace(path: string): Promise<{ workspaces: WebUIWorkspace[] }> {
    return this.fetchJson("/api/workspaces/remove", {
      method: "POST",
      body: { path },
    });
  }

  async renameWorkspace(path: string, name: string): Promise<{ workspaces: WebUIWorkspace[] }> {
    return this.fetchJson("/api/workspaces/rename", {
      method: "POST",
      body: { path, name },
    });
  }

  // ── Memory / Runtime Surfaces ───────────────────────────────────────
  async memory(): Promise<WebUIMemoryResponse> {
    return this.fetchJson("/api/memory");
  }

  async writeMemory(section: "memory" | "user", content: string): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/memory/write", {
      method: "POST",
      body: { section, content },
    });
  }

  async personalities(): Promise<WebUIPersonality[]> {
    const json = await this.fetchJson<{ personalities: WebUIPersonality[] }>("/api/personalities");
    return json.personalities ?? [];
  }

  async commands(): Promise<WebUICommand[]> {
    const json = await this.fetchJson<{ commands: WebUICommand[] }>("/api/commands");
    return json.commands ?? [];
  }

  async reasoningStatus(opts: { profile?: string } = {}): Promise<WebUIReasoningStatus> {
    return this.fetchJson("/api/reasoning", {
      profile: opts.profile,
    });
  }

  async setReasoning(
    body: { display?: string; effort?: string },
    opts: { profile?: string } = {},
  ): Promise<WebUIReasoningStatus> {
    return this.fetchJson("/api/reasoning", {
      method: "POST",
      body,
      profile: opts.profile,
    });
  }

  async backgroundStatus(sessionId: string, opts: { profile?: string } = {}): Promise<{ results: WebUIBackgroundTask[] }> {
    const json = await this.fetchJson<{ results: WebUIBackgroundTask[] }>(
      `/api/background/status?session_id=${encodeURIComponent(sessionId)}`,
      { profile: opts.profile },
    );
    return { results: json.results ?? [] };
  }

  async startBackground(
    sessionId: string,
    prompt: string,
    opts: { profile?: string } = {},
  ): Promise<WebUIBackgroundTask> {
    return this.fetchJson("/api/background", {
      method: "POST",
      body: { session_id: sessionId, prompt },
      profile: opts.profile,
    });
  }

  async checkUpdates(force = false): Promise<Record<string, unknown>> {
    return this.fetchJson(`/api/updates/check${force ? "?force=1" : ""}`);
  }

  // ── Skills ───────────────────────────────────────────────────────────
  async skills(): Promise<WebUISkillListResponse> {
    return this.fetchJson("/api/skills");
  }

  async skillContent(name: string, file?: string): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ name });
    if (file) {
      query.set("file", file);
    }
    return this.fetchJson(`/api/skills/content?${query.toString()}`);
  }

  async saveSkill(body: { name: string; content: string; category?: string }): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/skills/save", {
      method: "POST",
      body,
    });
  }

  async deleteSkill(name: string): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/skills/delete", {
      method: "POST",
      body: { name },
    });
  }

  // ── Workspace Files ──────────────────────────────────────────────────
  async listFiles(sessionId: string, relativePath = "."): Promise<WebUIFileEntry[]> {
    const json = await this.fetchJson<{ entries: WebUIFileEntry[] }>(
      `/api/list?session_id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(relativePath)}`
    );
    return json.entries ?? [];
  }

  async readFile(sessionId: string, relativePath: string): Promise<WebUIFileReadResponse> {
    return this.fetchJson(
      `/api/file?session_id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(relativePath)}`
    );
  }

  async saveFile(sessionId: string, relativePath: string, content: string): Promise<Record<string, unknown>> {
    return this.fetchJson("/api/file/save", {
      method: "POST",
      body: { session_id: sessionId, path: relativePath, content },
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────
  private normalizedBaseUrl(): string {
    return this.cfg.baseUrl.replace(/\/+$/, "");
  }

  private urlsForPath(path: string): string[] {
    if (!this.cfg.instanceIpv4?.trim()) {
      return [`${this.normalizedBaseUrl()}${path}`];
    }

    return buildGatewayProbeUrls(this.normalizedBaseUrl(), path, {
      instanceIpv4: this.cfg.instanceIpv4,
    });
  }

  private logCandidateFailure(path: string, url: string, nextUrl: string | undefined, error: unknown): void {
    if (!nextUrl) return;

    const current = new URL(url);
    const next = new URL(nextUrl);
    log.warn("webui gateway candidate failed; trying fallback", {
      source: "webui-client",
      requestId: this.cfg.requestId,
      route: current.pathname,
      failureType: "webui_gateway_candidate_failed",
      upstreamHost: current.host,
      fallbackHost: next.host,
      fallbackScheme: next.protocol.replace(":", ""),
      pathHasQuery: path.includes("?"),
      verboseErrors: true,
    }, error);
  }

  private authCacheKey(): string | null {
    const password = this.cfg.password?.trim();
    if (!password) {
      return null;
    }
    const passwordHash = createHash("sha256").update(password).digest("hex");
    return `${this.normalizedBaseUrl()}::${passwordHash}`;
  }

  private readCachedAuthCookie(): string | null {
    const key = this.authCacheKey();
    if (!key) {
      return null;
    }
    return authCookieCache.get(key) ?? null;
  }

  private writeCachedAuthCookie(cookie: string): void {
    const key = this.authCacheKey();
    if (!key) {
      return;
    }
    if (!authCookieCache.has(key) && authCookieCache.size >= MAX_AUTH_COOKIE_CACHE_ENTRIES) {
      const oldestKey = authCookieCache.keys().next().value as string | undefined;
      if (oldestKey) {
        authCookieCache.delete(oldestKey);
      }
    }
    authCookieCache.set(key, cookie);
  }

  private clearCachedAuthCookie(): void {
    const key = this.authCacheKey();
    if (key) {
      authCookieCache.delete(key);
    }
    this.authCookie = null;
  }

  private async headers(extra?: Record<string, string>, opts: { profile?: string } = {}): Promise<HeadersInit> {
    const h: Record<string, string> = { ...(extra ?? {}) };
    if (this.cfg.bearer) h.Authorization = `Bearer ${this.cfg.bearer}`;
    this.authCookie ??= this.readCachedAuthCookie();
    if (this.authCookie) h.Cookie = this.authCookie;
    if (opts.profile?.trim()) {
      const profileCookie = `hermes_profile=${encodeURIComponent(opts.profile.trim())}`;
      h.Cookie = h.Cookie ? `${h.Cookie}; ${profileCookie}` : profileCookie;
    }
    if (this.cfg.requestId && !h["X-Request-Id"]) {
      h["X-Request-Id"] = this.cfg.requestId;
    }
    return h;
  }

  private buildRecoveredBearerHeaders(headersInit: HeadersInit | undefined): Headers {
    const headers = new Headers(headersInit);
    if (this.cfg.bearer) {
      headers.set("Authorization", `Bearer ${this.cfg.bearer}`);
    } else {
      headers.delete("Authorization");
    }

    const profileCookie = headers.get("Cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("hermes_profile="));

    if (profileCookie) {
      headers.set("Cookie", profileCookie);
    } else {
      headers.delete("Cookie");
    }

    return headers;
  }

  private async tryRecoverStaleBearer(path: string, upstreamBody: string): Promise<boolean> {
    const recovery = this.cfg.staleBearerRecovery;
    if (!recovery) return false;

    const currentBearer = this.cfg.bearer || "";
    try {
      const recovered = await recovery.recover({
        currentBearer,
        path,
        upstreamStatus: 401,
        upstreamBody,
      });

      if (!recovered?.apiServerKey || recovered.apiServerKey === currentBearer) {
        log.warn("WebUI bearer recovery unavailable after upstream 401", {
          ...recovery.logCtx,
          failureType: `${recovery.failureTypePrefix}_stale_bearer_recovery_unavailable`,
          upstreamStatus: 401,
          upstreamRoute: path.split("?")[0],
          pathHasQuery: path.includes("?"),
        });
        return false;
      }

      this.clearCachedAuthCookie();
      this.cfg = {
        ...this.cfg,
        bearer: recovered.apiServerKey,
        password: recovered.apiServerKey,
        instanceIpv4: recovered.instanceIpv4 || this.cfg.instanceIpv4,
      };
      this.authCookie = null;

      log.warn("WebUI bearer recovered after upstream 401; retrying request", {
        ...recovery.logCtx,
        failureType: `${recovery.failureTypePrefix}_stale_bearer_recovered`,
        upstreamStatus: 401,
        upstreamRoute: path.split("?")[0],
        pathHasQuery: path.includes("?"),
      });

      return true;
    } catch (error) {
      log.warn("WebUI bearer recovery threw after upstream 401", {
        ...recovery.logCtx,
        failureType: `${recovery.failureTypePrefix}_stale_bearer_recovery_threw`,
        upstreamStatus: 401,
        upstreamRoute: path.split("?")[0],
        pathHasQuery: path.includes("?"),
      }, error);
      return false;
    }
  }

  private async login(): Promise<void> {
    const password = this.cfg.password?.trim();
    if (!password) {
      return;
    }

    let res: Response | null = null;
    let lastError: unknown = null;
    const urls = this.urlsForPath("/api/auth/login");
    for (let idx = 0; idx < urls.length; idx += 1) {
      const url = urls[idx];
      try {
        const fetchFn = url.startsWith("https://") ? fetchWithInsecureTLS : fetch;
        res = await fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
          signal: AbortSignal.timeout(this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
        break;
      } catch (error) {
        lastError = error;
        this.logCandidateFailure("/api/auth/login", url, urls[idx + 1], error);
      }
    }

    if (!res) {
      throw new WebUIError(`auth network: ${(lastError as Error)?.message || "fetch failed"}`, {
        status: 0,
        body: "",
      });
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new WebUIError(`auth ${res.status}`, { status: res.status, body });
    }

    const setCookie = res.headers.get("set-cookie");
    const cookie = setCookie?.split(";")[0]?.trim();
    if (!cookie) {
      throw new WebUIError("auth: missing session cookie", { status: 502, body: "" });
    }
    this.authCookie = cookie;
    this.writeCachedAuthCookie(cookie);
  }

  private async fetchWithAuthPath(path: string, init: RequestInit, isStream = false): Promise<Response> {
    let lastError: unknown = null;

    const urls = this.urlsForPath(path);
    for (let idx = 0; idx < urls.length; idx += 1) {
      const url = urls[idx];
      const fetchFn = url.startsWith("https://") ? fetchWithInsecureTLS : fetch;
      let res: Response;
      try {
        res = await fetchFn(url, init);
      } catch (error) {
        lastError = error;
        this.logCandidateFailure(path, url, urls[idx + 1], error);
        continue;
      }

      if (res.status !== 401 || !this.cfg.password) {
        return res;
      }

      if (this.cfg.staleBearerRecovery) {
        const upstreamBody = await res.clone().text().catch(() => "");
        await res.body?.cancel().catch(() => {});
        const recovered = await this.tryRecoverStaleBearer(path, upstreamBody.slice(0, 1000));
        if (recovered) {
          const headers = this.buildRecoveredBearerHeaders(init.headers);
          try {
            return await fetchFn(url, {
              ...init,
              headers,
              ...(isStream ? {} : { signal: init.signal }),
            });
          } catch (error) {
            lastError = error;
          }
          continue;
        }
      }

      await res.body?.cancel().catch(() => {});
      this.clearCachedAuthCookie();
      await this.login();

      const headers = new Headers(init.headers);
      const previousCookie = headers.get("Cookie");
      const profileCookie = previousCookie
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("hermes_profile="));
      if (this.authCookie) {
        headers.set(
          "Cookie",
          [this.authCookie, profileCookie].filter(Boolean).join("; ")
        );
      }

      try {
        return await fetchFn(url, {
          ...init,
          headers,
          ...(isStream ? {} : { signal: init.signal }),
        });
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("WebUI request failed");
  }

  private async fetchJson<T = unknown>(
    path: string,
    opts: { method?: string; body?: unknown; profile?: string } = {},
  ): Promise<T> {
    const init: RequestInit = {
      method: opts.method ?? "GET",
      headers: await this.headers(
        opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
        { profile: opts.profile }
      ),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

    let res: Response;
    try {
      res = await this.fetchWithAuthPath(path, init);
    } catch (err) {
      if (err instanceof WebUIError) {
        throw err;
      }
      throw new WebUIError(`network: ${(err as Error).message}`, {
        status: 0,
        body: "",
        code: extractNetworkErrorCode(err),
      });
    }
    const text = await res.text();
    if (!res.ok) {
      throw new WebUIError(`${opts.method ?? "GET"} ${path} ${res.status}`, {
        status: res.status,
        body: text.slice(0, 1000),
      });
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new WebUIError(`${path}: response was not JSON`, {
        status: 502,
        body: text.slice(0, 1000),
      });
    }
  }

  private async fetchFormJson<T = unknown>(
    path: string,
    body: FormData,
    opts: { method?: string; profile?: string } = {},
  ): Promise<T> {
    const init: RequestInit = {
      method: opts.method ?? "POST",
      headers: await this.headers(undefined, { profile: opts.profile }),
      body,
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    };

    let res: Response;
    try {
      res = await this.fetchWithAuthPath(path, init);
    } catch (err) {
      if (err instanceof WebUIError) {
        throw err;
      }
      throw new WebUIError(`network: ${(err as Error).message}`, {
        status: 0,
        body: "",
        code: extractNetworkErrorCode(err),
      });
    }
    const text = await res.text();
    if (!res.ok) {
      throw new WebUIError(`${opts.method ?? "POST"} ${path} ${res.status}`, {
        status: res.status,
        body: text.slice(0, 1000),
      });
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new WebUIError(`${path}: response was not JSON`, {
        status: 502,
        body: text.slice(0, 1000),
      });
    }
  }
}
