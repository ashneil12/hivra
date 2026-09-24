/**
 * DigitalOcean Managed Agents (Harness Runtime) — thin REST + SSE client.
 *
 * Wire shapes follow DigitalOcean's own Go client (godo hosted_agents.go) and
 * doctl's renderer, which are the published reference for this preview API:
 * sessions under /v2/agents/sessions, a `{ session }` envelope, YAML manifests
 * (JSON is valid YAML, so Hivra sends JSON to avoid building YAML by hand), and
 * canonical session events on a text/event-stream endpoint.
 *
 * The token is a customer credential. It is passed per call, never logged, and
 * never included in an error message.
 */

import { createHash } from "node:crypto";

import { log } from "@/lib/logger";

const LOG_SOURCE = "digitalocean-managed-agents";

export const DIGITALOCEAN_API_BASE_URL = "https://api.digitalocean.com";
const SESSIONS_PATH = "/v2/agents/sessions";
const DEFAULT_TIMEOUT_MS = 15_000;
const ERROR_BODY_MAX_BYTES = 8 * 1024;
const RESPONSE_BODY_MAX_BYTES = 512 * 1024;
/** One SSE frame larger than this is not a chat event Hivra renders. */
const SSE_FRAME_MAX_BYTES = 256 * 1024;
/** Workspace downloads end with `DOWSSHA1<64 hex>\n` (godo workspaceDownloadBody). */
const WORKSPACE_FOOTER_PREFIX = "DOWSSHA1";
const WORKSPACE_FOOTER_LENGTH = WORKSPACE_FOOTER_PREFIX.length + 64 + 1;

export type DigitalOceanApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_request"
  | "payment_required"
  | "rate_limited"
  | "unavailable"
  | "timeout"
  | "response_invalid";

export class DigitalOceanApiError extends Error {
  constructor(
    public readonly code: DigitalOceanApiErrorCode,
    public readonly status: number | null,
    public readonly method: string,
    public readonly path: string,
    /** DigitalOcean's own short error id (e.g. "unauthorized"), never its message. */
    public readonly providerId: string | null = null,
  ) {
    super(
      code === "timeout"
        ? `DigitalOcean API ${method} ${path} timed out.`
        : `DigitalOcean API ${method} ${path} failed${status === null ? "" : ` with status ${status}`} (${code}).`,
    );
    this.name = "DigitalOceanApiError";
  }
}

export type DigitalOceanSessionStatus =
  | "SESSION_STATUS_UNSPECIFIED"
  | "SESSION_STATUS_PROVISIONING"
  | "SESSION_STATUS_READY"
  | "SESSION_STATUS_DETACHED"
  | "SESSION_STATUS_DESTROYING"
  | "SESSION_STATUS_DESTROYED"
  | "SESSION_STATUS_FAILED"
  | "SESSION_STATUS_PAUSED";

const SESSION_STATUSES = new Set<string>([
  "SESSION_STATUS_UNSPECIFIED",
  "SESSION_STATUS_PROVISIONING",
  "SESSION_STATUS_READY",
  "SESSION_STATUS_DETACHED",
  "SESSION_STATUS_DESTROYING",
  "SESSION_STATUS_DESTROYED",
  "SESSION_STATUS_FAILED",
  "SESSION_STATUS_PAUSED",
]);

export interface DigitalOceanSession {
  sessionId: string;
  name: string | null;
  agentKind: string;
  status: DigitalOceanSessionStatus;
  /** Open string per DigitalOcean: "manual", "idle", "low_balance", or newer. */
  pauseReason: string | null;
  createdAt: string | null;
  lastEventAt: string | null;
  configId: string | null;
  warnings: string[];
}

export interface DigitalOceanSandboxSize {
  slug: string;
  vcpus: number;
  memoryMb: number;
}

/** One canonical session event (godo HostedAgentEvent wire envelope). */
export interface DigitalOceanSessionEvent {
  eventId: string;
  runId: string | null;
  seq: number | null;
  at: string | null;
  type: string;
  data: Record<string, unknown>;
}

export type DigitalOceanHitlOutcome = "HITL_OUTCOME_APPROVE" | "HITL_OUTCOME_REJECT" | "HITL_OUTCOME_DEFER";

export interface DigitalOceanExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DigitalOceanWorkspaceDownload {
  /** Payload with DigitalOcean's integrity footer removed; errors if it does not verify. */
  body: ReadableStream<Uint8Array>;
  isArchive: boolean;
  /** DigitalOcean's size hint for the payload, or null when it sent none. */
  sizeBytes: number | null;
}

export interface DigitalOceanManagedAgentsClient {
  listSandboxSizes(): Promise<DigitalOceanSandboxSize[]>;
  /** Manifest is a JSON document; DigitalOcean parses it as YAML 1.2. */
  createSessionFromManifest(manifest: Record<string, unknown>): Promise<DigitalOceanSession>;
  getSession(sessionId: string): Promise<DigitalOceanSession>;
  findSessionByName(name: string): Promise<DigitalOceanSession | null>;
  destroySession(sessionId: string): Promise<void>;
  pauseSession(sessionId: string): Promise<void>;
  resumeSession(sessionId: string): Promise<void>;
  sendInput(sessionId: string, text: string): Promise<{ runId: string | null }>;
  resolveHitl(sessionId: string, requestId: string, outcome: DigitalOceanHitlOutcome, reason?: string): Promise<void>;
  /** Run one argv (no shell unless argv names one) inside the session's sandbox. */
  execInSandbox(sessionId: string, input: { argv: string[]; workdir?: string; timeoutSeconds?: number }): Promise<DigitalOceanExecResult>;
  /** Stream one file, or a directory as a tar, from the session's /workspace. */
  downloadWorkspace(sessionId: string, input: { path: string; asArchive?: boolean; maxBytes?: number; signal?: AbortSignal }): Promise<DigitalOceanWorkspaceDownload>;
  /**
   * Open the session event stream. Live mode stays open (resume with
   * `replayFrom` as Last-Event-ID); replay-only ends at the last stored event.
   */
  streamEvents(
    sessionId: string,
    options: { replayOnly?: boolean; replayFrom?: string | null; before?: string | null; limit?: number; signal?: AbortSignal },
  ): AsyncGenerator<DigitalOceanSessionEvent, void, void>;
}

type FetchLike = typeof fetch;

type ClientOptions = {
  fetch?: FetchLike;
  baseUrl?: string;
  timeoutMs?: number;
};

function errorCodeForStatus(status: number): DigitalOceanApiErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 402) return "payment_required";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "invalid_request";
  return "unavailable";
}

async function readBounded(response: Response, maxBytes: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function providerErrorId(response: Response): Promise<string | null> {
  try {
    const text = await readBounded(response, ERROR_BODY_MAX_BYTES);
    if (!text) return null;
    const parsed = JSON.parse(text) as { id?: unknown };
    return typeof parsed.id === "string" && /^[a-z0-9_]{1,64}$/.test(parsed.id) ? parsed.id : null;
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function parseDigitalOceanSession(value: unknown): DigitalOceanSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const sessionId = stringOrNull(raw.session_id);
  const status = typeof raw.status === "string" && SESSION_STATUSES.has(raw.status)
    ? raw.status as DigitalOceanSessionStatus
    : null;
  if (!sessionId || !/^[A-Za-z0-9_.:-]{1,128}$/.test(sessionId) || !status) return null;
  return {
    sessionId,
    name: stringOrNull(raw.name),
    agentKind: typeof raw.agent_kind === "string" ? raw.agent_kind : "AGENT_KIND_UNSPECIFIED",
    status,
    pauseReason: stringOrNull(raw.pause_reason),
    createdAt: stringOrNull(raw.created_at),
    lastEventAt: stringOrNull(raw.last_event_at),
    configId: stringOrNull(raw.config_id),
    warnings: Array.isArray(raw.warnings)
      ? raw.warnings.filter((w): w is string => typeof w === "string").slice(0, 10).map((w) => w.slice(0, 500))
      : [],
  };
}

/** Parse one SSE `data:` payload into a canonical event, or null to skip it. */
export function parseDigitalOceanSessionEvent(data: string, sseId: string | null): DigitalOceanSessionEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const envelope = raw as Record<string, unknown>;
  const type = typeof envelope.type === "string" ? envelope.type : "";
  if (!/^[a-z_]+(\.[a-z_]+)+$/.test(type)) return null;
  const eventId = stringOrNull(envelope.event_id) ?? sseId;
  if (!eventId) return null;
  const body = envelope.data;
  return {
    eventId: eventId.slice(0, 200),
    runId: stringOrNull(envelope.run_id),
    seq: typeof envelope.seq === "number" && Number.isSafeInteger(envelope.seq) ? envelope.seq : null,
    at: stringOrNull(envelope.timestamp),
    type,
    data: body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {},
  };
}

/**
 * Minimal text/event-stream parser (WHATWG dispatch rules): `data:` lines join
 * with "\n", a blank line dispatches, `:` lines are comments, and `id:` sets
 * the cursor. Bare-CR terminators are not supported (DigitalOcean emits LF).
 */
export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ id: string | null; event: string | null; data: string }, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let eventName: string | null = null;
  let lastId: string | null = null;
  let frameBytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      // Like godo's reader, a last line without its terminator still counts.
      if (done && buffer && !buffer.endsWith("\n")) buffer += "\n";
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          if (dataLines.length) yield { id: lastId, event: eventName, data: dataLines.join("\n") };
          dataLines = [];
          eventName = null;
          frameBytes = 0;
          continue;
        }
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let fieldValue = colon < 0 ? "" : line.slice(colon + 1);
        if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
        if (field === "data") {
          frameBytes += fieldValue.length;
          if (frameBytes > SSE_FRAME_MAX_BYTES) {
            // Drop an oversized frame whole rather than dispatching a torn one.
            dataLines = [];
            continue;
          }
          dataLines.push(fieldValue);
        } else if (field === "event") {
          eventName = fieldValue;
        } else if (field === "id" && !fieldValue.includes("\u0000")) {
          lastId = fieldValue;
        }
      }
      if (buffer.length > SSE_FRAME_MAX_BYTES) buffer = "";
      if (done) {
        if (dataLines.length) yield { id: lastId, event: eventName, data: dataLines.join("\n") };
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export const DIGITALOCEAN_INFERENCE_BASE_URL = "https://inference.do-ai.run";
const INFERENCE_MODEL_LIMIT = 300;

/**
 * Model ids DigitalOcean Serverless Inference offers this team. The endpoint
 * accepts the account API token, so Hivra can fill a model list without
 * asking for the model access key first.
 */
export async function listDigitalOceanInferenceModels(
  apiToken: string,
  options: { fetch?: FetchLike; baseUrl?: string; timeoutMs?: number } = {},
): Promise<string[]> {
  const fetchImpl = options.fetch ?? fetch;
  const url = `${(options.baseUrl ?? DIGITALOCEAN_INFERENCE_BASE_URL).replace(/\/$/, "")}/v1/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiToken}`, Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
  } catch {
    throw new DigitalOceanApiError(controller.signal.aborted ? "timeout" : "unavailable", null, "GET", "/v1/models");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    log.warn("DigitalOcean inference model list was rejected", {
      source: LOG_SOURCE, failureType: "digitalocean_inference_models_rejected", status: response.status,
    });
    throw new DigitalOceanApiError(errorCodeForStatus(response.status), response.status, "GET", "/v1/models");
  }
  const text = await readBounded(response, RESPONSE_BODY_MAX_BYTES);
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new DigitalOceanApiError("response_invalid", response.status, "GET", "/v1/models");
  const ids = new Set<string>();
  for (const entry of data) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id === "string" && /^[A-Za-z0-9._:/-]{1,128}$/.test(id)) ids.add(id);
    if (ids.size >= INFERENCE_MODEL_LIMIT) break;
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

/**
 * Strip and verify DigitalOcean's workspace download footer while streaming:
 * hold back the last footer-length bytes, hash everything before them, and
 * error the stream at the end unless the footer names that exact digest.
 */
export function verifyWorkspaceDownloadBody(
  source: ReadableStream<Uint8Array>,
  options: { maxBytes?: number; method?: string; path?: string } = {},
): ReadableStream<Uint8Array> {
  const hasher = createHash("sha256");
  let pending = new Uint8Array(0);
  let delivered = 0;
  const fail = () => new DigitalOceanApiError("response_invalid", null, options.method ?? "GET", options.path ?? SESSIONS_PATH);
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const joined = new Uint8Array(pending.byteLength + chunk.byteLength);
      joined.set(pending, 0);
      joined.set(chunk, pending.byteLength);
      const releasable = joined.byteLength - WORKSPACE_FOOTER_LENGTH;
      if (releasable <= 0) {
        pending = joined;
        return;
      }
      const out = joined.slice(0, releasable);
      pending = joined.slice(releasable);
      delivered += out.byteLength;
      if (options.maxBytes !== undefined && delivered > options.maxBytes) {
        controller.error(fail());
        return;
      }
      hasher.update(out);
      controller.enqueue(out);
    },
    flush(controller) {
      const footer = new TextDecoder().decode(pending);
      const match = /^DOWSSHA1([0-9a-fA-F]{64})\n$/.exec(footer);
      if (pending.byteLength !== WORKSPACE_FOOTER_LENGTH || !match
        || match[1].toLowerCase() !== hasher.digest("hex")) {
        log.warn("DigitalOcean workspace download failed its integrity check", {
          source: LOG_SOURCE,
          failureType: "digitalocean_workspace_download_unverified",
          footerPresent: Boolean(match),
        });
        controller.error(fail());
      }
    },
  }));
}

export function createDigitalOceanManagedAgentsClient(
  apiToken: string,
  options: ClientOptions = {},
): DigitalOceanManagedAgentsClient {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = (options.baseUrl ?? DIGITALOCEAN_API_BASE_URL).replace(/\/$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(
    method: string,
    path: string,
    init: { body?: string; contentType?: string; accept?: string; headers?: Record<string, string>; signal?: AbortSignal; stream?: boolean } = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = init.stream ? null : setTimeout(() => controller.abort(), timeoutMs);
    const abortFromCaller = () => controller.abort();
    init.signal?.addEventListener("abort", abortFromCaller, { once: true });
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiToken}`,
          Accept: init.accept ?? "application/json",
          ...(init.body !== undefined ? { "Content-Type": init.contentType ?? "application/json" } : {}),
          ...init.headers,
        },
        body: init.body,
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      if (timer) clearTimeout(timer);
      init.signal?.removeEventListener("abort", abortFromCaller);
      if (init.signal?.aborted) throw error;
      const timedOut = controller.signal.aborted;
      log.warn("DigitalOcean API request did not complete", {
        source: LOG_SOURCE,
        failureType: timedOut ? "digitalocean_api_timeout" : "digitalocean_api_transport_failed",
        method,
        path: path.split("?")[0],
      });
      throw new DigitalOceanApiError(timedOut ? "timeout" : "unavailable", null, method, path.split("?")[0]);
    }
    if (timer) clearTimeout(timer);
    if (!init.stream) init.signal?.removeEventListener("abort", abortFromCaller);
    if (!response.ok) {
      const providerId = await providerErrorId(response);
      const code = errorCodeForStatus(response.status);
      log.warn("DigitalOcean API request was rejected", {
        source: LOG_SOURCE,
        failureType: "digitalocean_api_rejected",
        method,
        path: path.split("?")[0],
        status: response.status,
        providerId,
      });
      throw new DigitalOceanApiError(code, response.status, method, path.split("?")[0], providerId);
    }
    return response;
  }

  async function json(method: string, path: string, init: Parameters<typeof request>[2] = {}): Promise<unknown> {
    const response = await request(method, path, init);
    if (response.status === 204) return null;
    const text = await readBounded(response, RESPONSE_BODY_MAX_BYTES);
    if (text === null) throw new DigitalOceanApiError("response_invalid", response.status, method, path.split("?")[0]);
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new DigitalOceanApiError("response_invalid", response.status, method, path.split("?")[0]);
    }
  }

  function sessionFrom(body: unknown, method: string, path: string): DigitalOceanSession {
    const session = parseDigitalOceanSession((body as { session?: unknown } | null)?.session);
    if (!session) throw new DigitalOceanApiError("response_invalid", null, method, path);
    return session;
  }

  const sessionPath = (sessionId: string) => `${SESSIONS_PATH}/${encodeURIComponent(sessionId)}`;

  return {
    async listSandboxSizes() {
      const path = `${SESSIONS_PATH}/sandbox/sizes`;
      const body = await json("GET", path);
      const sizes = (body as { sizes?: unknown } | null)?.sizes;
      if (!Array.isArray(sizes)) throw new DigitalOceanApiError("response_invalid", null, "GET", path);
      return sizes.flatMap((size): DigitalOceanSandboxSize[] => {
        if (!size || typeof size !== "object") return [];
        const raw = size as Record<string, unknown>;
        if (typeof raw.slug !== "string" || !/^[a-z0-9-]{1,64}$/.test(raw.slug)) return [];
        return [{
          slug: raw.slug,
          vcpus: typeof raw.vcpus === "number" ? raw.vcpus : 0,
          memoryMb: typeof raw.memory_mb === "number" ? raw.memory_mb : 0,
        }];
      });
    },

    async createSessionFromManifest(manifest) {
      const body = await json("POST", SESSIONS_PATH, {
        body: JSON.stringify(manifest),
        contentType: "application/x-yaml",
      });
      return sessionFrom(body, "POST", SESSIONS_PATH);
    },

    async getSession(sessionId) {
      const path = sessionPath(sessionId);
      return sessionFrom(await json("GET", path), "GET", SESSIONS_PATH);
    },

    async findSessionByName(name) {
      const path = `${SESSIONS_PATH}?${new URLSearchParams({ name, page_size: "5" })}`;
      const body = await json("GET", path);
      const sessions = (body as { sessions?: unknown } | null)?.sessions;
      if (!Array.isArray(sessions)) throw new DigitalOceanApiError("response_invalid", null, "GET", SESSIONS_PATH);
      const matches = sessions
        .map(parseDigitalOceanSession)
        .filter((session): session is DigitalOceanSession => session !== null && session.name === name);
      return matches[0] ?? null;
    },

    async destroySession(sessionId) {
      await json("DELETE", sessionPath(sessionId));
    },

    async pauseSession(sessionId) {
      await json("POST", `${sessionPath(sessionId)}/pause`, { body: "{}" });
    },

    async resumeSession(sessionId) {
      await json("POST", `${sessionPath(sessionId)}/resume`, { body: "{}" });
    },

    async sendInput(sessionId, text) {
      const body = await json("POST", `${sessionPath(sessionId)}/input`, { body: JSON.stringify({ text }) });
      const runId = stringOrNull((body as { run_id?: unknown } | null)?.run_id);
      return { runId: runId && /^[A-Za-z0-9_.:-]{1,128}$/.test(runId) ? runId : null };
    },

    async resolveHitl(sessionId, requestId, outcome, reason) {
      await json("POST", `${sessionPath(sessionId)}/hitl/${encodeURIComponent(requestId)}`, {
        body: JSON.stringify({
          outcome,
          source: "RESOLUTION_SOURCE_OUT_OF_BAND",
          ...(reason ? { reason: reason.slice(0, 500) } : {}),
        }),
      });
    },

    async execInSandbox(sessionId, input) {
      const path = `${sessionPath(sessionId)}/sandbox/exec`;
      const body = await json("POST", path, {
        body: JSON.stringify({
          argv: input.argv,
          ...(input.workdir ? { workdir: input.workdir } : {}),
          ...(input.timeoutSeconds ? { timeout_seconds: input.timeoutSeconds } : {}),
        }),
      });
      const raw = (body ?? {}) as { exit_code?: unknown; stdout?: unknown; stderr?: unknown };
      if (typeof raw.exit_code !== "number" || !Number.isInteger(raw.exit_code)) {
        throw new DigitalOceanApiError("response_invalid", null, "POST", `${SESSIONS_PATH}/sandbox/exec`);
      }
      return {
        exitCode: raw.exit_code,
        stdout: typeof raw.stdout === "string" ? raw.stdout : "",
        stderr: typeof raw.stderr === "string" ? raw.stderr.slice(0, 4_000) : "",
      };
    },

    async downloadWorkspace(sessionId, input) {
      const query = new URLSearchParams({ path: input.path });
      if (input.asArchive) query.set("as_archive", "true");
      const path = `${sessionPath(sessionId)}/workspace/download?${query}`;
      const response = await request("GET", path, {
        accept: "application/octet-stream",
        signal: input.signal,
        stream: true,
      });
      if (!response.body) throw new DigitalOceanApiError("response_invalid", response.status, "GET", `${SESSIONS_PATH}/workspace/download`);
      const hint = Number.parseInt(response.headers.get("X-Workspace-Size-Bytes")?.trim() ?? "", 10);
      return {
        body: verifyWorkspaceDownloadBody(response.body, { maxBytes: input.maxBytes, path: `${SESSIONS_PATH}/workspace/download` }),
        isArchive: response.headers.get("X-Workspace-Is-Archive")?.trim().toLowerCase() === "true",
        sizeBytes: Number.isSafeInteger(hint) && hint >= 0 ? hint : null,
      };
    },

    async *streamEvents(sessionId, streamOptions) {
      const query = new URLSearchParams();
      const headers: Record<string, string> = { "Cache-Control": "no-cache" };
      if (streamOptions.replayOnly) {
        query.set("replay_only", "true");
        if (streamOptions.replayFrom) query.set("replay_from", streamOptions.replayFrom);
        if (streamOptions.before) query.set("before", streamOptions.before);
        if (streamOptions.limit) query.set("limit", String(streamOptions.limit));
      } else if (streamOptions.replayFrom) {
        headers["Last-Event-ID"] = streamOptions.replayFrom;
      }
      const encoded = query.toString();
      const suffix = encoded ? `?${encoded}` : "";
      const response = await request("GET", `${sessionPath(sessionId)}/events${suffix}`, {
        accept: "text/event-stream",
        headers,
        signal: streamOptions.signal,
        stream: true,
      });
      if (!response.body) throw new DigitalOceanApiError("response_invalid", response.status, "GET", SESSIONS_PATH);
      for await (const frame of readServerSentEvents(response.body)) {
        const event = parseDigitalOceanSessionEvent(frame.data, frame.id);
        if (event) yield event;
      }
    },
  };
}
