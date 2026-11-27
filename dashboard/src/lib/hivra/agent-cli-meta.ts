import "server-only";

// Reads an agent's software state from its computer, on the server: the
// connection service's public /api/meta first, and only when that proves a
// current Hivra connection service of the right kind, the same endpoint again
// with the computer's bearer (which adds the Claude Code / Codex version, or
// the Aeon / OpenClaw / Agent Zero app version, and update progress). The bearer never leaves the server for this and is never
// returned or logged. The automatic-update sweep also asks, with the bearer,
// whether a reply is being written or an agent terminal is attached.
//
// Every request is marked as a Hivra background read (./background-read), so
// a computer behind the host wake proxy neither counts it as use nor wakes for
// it. Every request goes to the computer's own validated origin (the stored
// chat_url, bound to its named tunnel hostname) through the SSRF-safe fetch,
// without redirects or cookies, bounded in time and size.

import { ssrfSafeFetch } from "@/lib/ssrf-safe-fetch";
import { checkOutboundUrlSafety } from "@/lib/url-safety";
import { validateHivraChatOrigin } from "./agent-host-result";
import { parseAgentCliMeta, type AgentCliMetaReport, type AgentSoftwareSubject } from "./agent-cli-status";
import { AGENT_COMPUTER_READ_TIMEOUT_MS } from "./lifecycle-timeouts";
import { HIVRA_BACKGROUND_HEADERS } from "./background-read";

const DEADLINE_MS = AGENT_COMPUTER_READ_TIMEOUT_MS;
const MAX_RESPONSE_BYTES = 8_192;
/** Chat run lists hold up to a few dozen short summaries. */
const MAX_RUNS_RESPONSE_BYTES = 64 * 1024;
const API_TOKEN = /^[0-9a-f]{64}$/;
const BOOT_ID = /^[a-f0-9]{32}$/;

export interface AgentSoftwareBoxTarget {
  chatUrl: unknown;
  cfHostname: unknown;
  apiToken: unknown;
  subject: AgentSoftwareSubject;
}

export type AgentSoftwareReading =
  | { observation: "reported"; report: AgentCliMetaReport }
  | { observation: "checking" | "version_unreadable" | "older_connection_service" | "unreachable" | "not_reported" };

type Fetcher = typeof ssrfSafeFetch;

class ReadFailed extends Error {}

function originOf(target: { chatUrl: unknown; cfHostname: unknown }): string | null {
  const named = typeof target.cfHostname === "string" && target.cfHostname ? target.cfHostname : null;
  const origin = validateHivraChatOrigin(target.chatUrl, named);
  if (!origin || !checkOutboundUrlSafety(origin).ok) return null;
  return origin;
}

/** Drops an unread response body so its connection is released. */
export function discard(response: Response) {
  void response.body?.cancel().catch(() => undefined);
}

function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new ReadFailed("deadline"));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

async function readJson(response: Response, signal: AbortSignal, limit: number): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    discard(response);
    throw new ReadFailed("type");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ReadFailed("body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await bounded(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new ReadFailed("size");
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ReadFailed("json");
  }
}

/** One GET to the computer's own origin; anything but a plain 200 JSON reply fails. */
function client(origin: string, apiToken: string | null, fetcher: Fetcher) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  const signal = controller.signal;
  return {
    async get(path: string, authenticated: boolean, limit = MAX_RESPONSE_BYTES): Promise<unknown> {
      if (authenticated && !apiToken) throw new ReadFailed("token");
      const response = await bounded(fetcher(origin + path, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        credentials: "omit",
        signal,
        // Every read here is Hivra's own observation, never the owner's use: marked so the host wake
        // proxy neither keeps the computer from napping for it nor wakes a napped one.
        headers: { Accept: "application/json", ...HIVRA_BACKGROUND_HEADERS, ...(authenticated ? { Authorization: `Bearer ${apiToken}` } : {}) },
      }), signal);
      if (response.redirected || response.status !== 200) {
        discard(response);
        throw new ReadFailed(`status ${response.status}`);
      }
      return readJson(response, signal, limit);
    },
    close() {
      clearTimeout(timer);
      controller.abort();
    },
  };
}

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * What the computer says about its agent software. Never throws: an origin
 * that doesn't validate, a connection service of another kind, a redirect,
 * an error status, an oversized or malformed reply and a timeout all read as
 * unreachable, and the bearer is sent only after the public reply proves a
 * current connection service of this agent's kind.
 */
export async function readAgentSoftwareFromBox(target: AgentSoftwareBoxTarget, fetcher: Fetcher = ssrfSafeFetch): Promise<AgentSoftwareReading> {
  const origin = originOf(target);
  if (!origin) return { observation: "unreachable" };
  const apiToken = typeof target.apiToken === "string" && API_TOKEN.test(target.apiToken) ? target.apiToken : null;
  const box = client(origin, apiToken, fetcher);
  try {
    const publicMeta = objectOf(await box.get("/api/meta", false));
    if (!publicMeta || publicMeta.agentKind !== target.subject.gatewayKind) return { observation: "unreachable" };
    // bootId ships with the release that also reports the CLI version.
    if (publicMeta.surfaceAuth !== "post-cookie-v1" || typeof publicMeta.bootId !== "string" || !BOOT_ID.test(publicMeta.bootId)) {
      return { observation: "older_connection_service" };
    }
    const { cli, app, software } = target.subject;
    if (!apiToken) return { observation: "unreachable" };
    const privateMeta = objectOf(await box.get("/api/meta", true));
    if (!privateMeta || privateMeta.agentKind !== target.subject.gatewayKind) return { observation: "unreachable" };
    const field = cli ? privateMeta.agentCli : app ? privateMeta.agentApp : undefined;
    // A CLI's version is left out until the connection service has read it
    // once after it started. App agents always get agentApp (checking while
    // OpenClaw is first asked), so without it the connection service predates
    // app versions.
    if (field === undefined) return { observation: cli ? "checking" : "not_reported" };
    if (app && objectOf(field)?.checking === true) return { observation: "checking" };
    const report = parseAgentCliMeta(field, software);
    return report ? { observation: "reported", report } : { observation: "version_unreadable" };
  } catch {
    return { observation: "unreachable" };
  } finally {
    box.close();
  }
}

/** Replies being written and the newest reply activity, from GET /api/chat/runs; null when malformed. */
function replyEvidence(body: unknown): { runningReplies: number; lastReplyActivityAt: number | null } | null {
  const runsBody = objectOf(body);
  if (!runsBody || !Array.isArray(runsBody.runs)) return null;
  let runningReplies = 0;
  let lastReplyActivityAt: number | null = null;
  for (const entry of runsBody.runs) {
    const run = objectOf(entry);
    if (!run) return null;
    if (run.state !== "finished") runningReplies += 1;
    for (const stamp of [run.createdAt, run.startedAt, run.finishedAt]) {
      const at = typeof stamp === "string" ? Date.parse(stamp) : NaN;
      if (Number.isFinite(at) && (lastReplyActivityAt === null || at > lastReplyActivityAt)) lastReplyActivityAt = at;
    }
  }
  return { runningReplies, lastReplyActivityAt };
}

/** Whether someone is attached to an agent terminal, from GET /api/terminal/sessions; null when malformed. */
function terminalEvidence(body: unknown): boolean | null {
  const terminalsBody = objectOf(body);
  if (!terminalsBody || !Array.isArray(terminalsBody.sessions)) return null;
  return terminalsBody.sessions.some((entry) => objectOf(entry)?.attached === true);
}

export interface AgentIdleEvidence {
  /** Chat replies still being written. */
  runningReplies: number;
  /** When the newest reply started or finished (ms), or null when there were none. */
  lastReplyActivityAt: number | null;
  /** An agent terminal someone is attached to right now. */
  terminalAttached: boolean;
}

/**
 * Whether the agent is being used right now, for the automatic-update sweep.
 * null when either answer couldn't be read, which the sweep treats as busy.
 */
export async function readAgentIdleEvidence(target: Omit<AgentSoftwareBoxTarget, "subject">, fetcher: Fetcher = ssrfSafeFetch): Promise<AgentIdleEvidence | null> {
  const origin = originOf(target);
  const apiToken = typeof target.apiToken === "string" && API_TOKEN.test(target.apiToken) ? target.apiToken : null;
  if (!origin || !apiToken) return null;
  const box = client(origin, apiToken, fetcher);
  try {
    const replies = replyEvidence(await box.get("/api/chat/runs", true, MAX_RUNS_RESPONSE_BYTES));
    const terminalAttached = terminalEvidence(await box.get("/api/terminal/sessions?surface=agent", true));
    if (!replies || terminalAttached === null) return null;
    return { ...replies, terminalAttached };
  } catch {
    return null;
  } finally {
    box.close();
  }
}

// ---------------------------------------------------------------------------
// Surface watchdog receipts (GET /api/surface-watchdog)

const WATCHDOG_EVENT_TYPES = new Set([
  "gateway_down", "gateway_recovered", "unit_restart", "recovered",
  "recovery_exhausted", "unit_failing", "watchdog_error",
]);
const HERMES_PROXY_REASONS = new Set([
  "update_lock", "loopback_connection_refused", "loopback_connection_reset", "loopback_connection_error",
]);

export interface SurfaceWatchdogEvent {
  id: string;
  at: string | null;
  type: string;
  unit?: string;
  kind?: string;
  reason?: string;
  operation?: "http" | "socket_ticket" | "websocket";
  ok?: boolean;
  downForS?: number;
  nRestarts?: number;
  attempt?: number;
  restarts?: number;
}

export interface SurfaceWatchdogReport {
  agentKind: string | null;
  updatedAt: string | null;
  surface: { status: string | null; reason: string | null; restarts: number };
  events: SurfaceWatchdogEvent[];
}

export type SurfaceWatchdogReading =
  | { observation: "reported"; report: SurfaceWatchdogReport }
  | { observation: "not_installed" }
  | { observation: "unreachable" };

function watchdogEvent(value: unknown): SurfaceWatchdogEvent | null {
  const event = objectOf(value);
  if (!event || typeof event.id !== "string" || !/^e\d+-\d{1,12}$/.test(event.id)) return null;
  if (typeof event.type !== "string" || !WATCHDOG_EVENT_TYPES.has(event.type)) return null;
  const out: SurfaceWatchdogEvent = {
    id: event.id,
    at: typeof event.at === "string" ? event.at : null,
    type: event.type,
  };
  for (const key of ["unit", "kind", "reason"] as const) {
    if (typeof event[key] === "string") out[key] = event[key] as string;
  }
  for (const key of ["downForS", "nRestarts", "attempt", "restarts"] as const) {
    if (Number.isInteger(event[key])) out[key] = event[key] as number;
  }
  if (typeof event.ok === "boolean") out.ok = event.ok;
  return out;
}

/**
 * The box-side watchdog's receipts: what it probed through the real user path,
 * which units it restarted and which keep failing. Never throws — a gateway
 * that cannot answer (it is the gateway being probed) reads as unreachable,
 * and a gateway that predates the endpoint reads as not_installed. The bearer
 * goes only to a reply that proved a current Hivra connection service, exactly
 * as for the other private reads here.
 */
export async function readSurfaceWatchdogFromBox(
  target: Omit<AgentSoftwareBoxTarget, "subject">,
  fetcher: Fetcher = ssrfSafeFetch,
): Promise<SurfaceWatchdogReading> {
  const origin = originOf(target);
  const apiToken = typeof target.apiToken === "string" && API_TOKEN.test(target.apiToken) ? target.apiToken : null;
  if (!origin || !apiToken) return { observation: "unreachable" };
  const box = client(origin, apiToken, fetcher);
  try {
    const publicMeta = objectOf(await box.get("/api/meta", false));
    if (!publicMeta || typeof publicMeta.agentKind !== "string"
      || publicMeta.surfaceAuth !== "post-cookie-v1"
      || typeof publicMeta.bootId !== "string" || !BOOT_ID.test(publicMeta.bootId)) {
      return { observation: "unreachable" };
    }
    let body: unknown;
    try {
      body = await box.get("/api/surface-watchdog", true);
    } catch (error) {
      if (error instanceof ReadFailed && /^status 404$/.test(error.message)) {
        return { observation: "not_installed" };
      }
      return { observation: "unreachable" };
    }
    const report = objectOf(body);
    const surface = objectOf(report?.surface);
    if (!report || report.ok !== true || !surface || !Array.isArray(report.events)) {
      return { observation: "unreachable" };
    }
    const events: SurfaceWatchdogEvent[] = [];
    for (const entry of report.events) {
      const event = watchdogEvent(entry);
      if (!event) return { observation: "unreachable" };
      events.push(event);
    }
    if (Array.isArray(report.proxyEvents)) {
      for (const entry of report.proxyEvents.slice(0, 16)) {
        const event = objectOf(entry);
        if (event?.type !== "hermes_proxy_unavailable" || typeof event.id !== "string" || !/^e\d+-\d{1,12}$/.test(event.id)
          || typeof event.reason !== "string" || !HERMES_PROXY_REASONS.has(event.reason)
          || (event.operation !== "http" && event.operation !== "socket_ticket" && event.operation !== "websocket")) continue;
        events.push({
          id: event.id, at: typeof event.at === "string" ? event.at.slice(0, 40) : null,
          type: event.type, kind: "hermes", reason: event.reason, operation: event.operation,
          ...(event.unit === "hermes-gateway.service" || event.unit === "bux-hermes.service" ? { unit: event.unit } : {}),
        });
      }
      events.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""));
    }
    return {
      observation: "reported",
      report: {
        agentKind: typeof report.agentKind === "string" ? report.agentKind : null,
        updatedAt: typeof report.updatedAt === "string" ? report.updatedAt : null,
        surface: {
          status: typeof surface.status === "string" ? surface.status : null,
          reason: typeof surface.reason === "string" ? surface.reason : null,
          restarts: Number.isInteger(surface.restarts) ? surface.restarts as number : 0,
        },
        events,
      },
    };
  } catch {
    return { observation: "unreachable" };
  } finally {
    box.close();
  }
}

export interface AgentActivityReading {
  /** The connection service's own start, as an opaque id. A new id means its counters began again. */
  bootId: string;
  /**
   * App agents: when the app was last used through the connection service
   * (ms). The service's own start counts as a use, so this only shows real use
   * when compared with an earlier reading under the same bootId.
   */
  appLastUsedAt: number | null;
  /** App agents: how many of the app's live connections are open now. */
  appOpenConnections: number | null;
  /** Replies being written through Hivra chat; null when that couldn't be read. */
  runningReplies: number | null;
  /** When the newest reply started or finished (ms); null when there were none or it couldn't be read. */
  lastReplyActivityAt: number | null;
  /** Whether someone is attached to an agent terminal; null when that couldn't be read. */
  terminalAttached: boolean | null;
}

/**
 * How much the agent is being used, as its computer's connection service
 * reports it: counts and times only, never content. null when the computer
 * can't be reached or isn't a current connection service of this agent's kind
 * (the bearer is sent only after the public reply proves that). A part that
 * can't be read is null, never 0 or false.
 */
export async function readAgentActivityFromBox(target: AgentSoftwareBoxTarget, fetcher: Fetcher = ssrfSafeFetch): Promise<AgentActivityReading | null> {
  const origin = originOf(target);
  const apiToken = typeof target.apiToken === "string" && API_TOKEN.test(target.apiToken) ? target.apiToken : null;
  if (!origin || !apiToken) return null;
  const box = client(origin, apiToken, fetcher);
  const optional = async (path: string, limit?: number): Promise<unknown> => {
    try { return await box.get(path, true, limit); } catch { return null; }
  };
  try {
    const publicMeta = objectOf(await box.get("/api/meta", false));
    if (!publicMeta || publicMeta.agentKind !== target.subject.gatewayKind) return null;
    if (publicMeta.surfaceAuth !== "post-cookie-v1" || typeof publicMeta.bootId !== "string" || !BOOT_ID.test(publicMeta.bootId)) return null;
    const privateMeta = objectOf(await box.get("/api/meta", true));
    // The same service must answer both: a restart between the two starts its counters again.
    if (!privateMeta || privateMeta.agentKind !== target.subject.gatewayKind || privateMeta.bootId !== publicMeta.bootId) return null;
    const activity = objectOf(objectOf(privateMeta.agentApp)?.activity);
    const usedAt = typeof activity?.lastUsedAt === "string" ? Date.parse(activity.lastUsedAt) : NaN;
    const open = activity?.openConnections;
    const replies = replyEvidence(await optional("/api/chat/runs", MAX_RUNS_RESPONSE_BYTES));
    const terminalAttached = terminalEvidence(await optional("/api/terminal/sessions?surface=agent"));
    return {
      bootId: publicMeta.bootId,
      appLastUsedAt: Number.isFinite(usedAt) ? usedAt : null,
      appOpenConnections: typeof open === "number" && Number.isInteger(open) && open >= 0 ? open : null,
      runningReplies: replies ? replies.runningReplies : null,
      lastReplyActivityAt: replies ? replies.lastReplyActivityAt : null,
      terminalAttached,
    };
  } catch {
    return null;
  } finally {
    box.close();
  }
}
