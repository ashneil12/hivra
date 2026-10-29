import "server-only";

// Reads an agent's software state from its computer, on the server: the
// connection service's public /api/meta first, and only when that proves a
// current Hivra connection service of the right kind, the same endpoint again
// with the computer's bearer (which adds the Claude Code / Codex version, or
// the Aeon / OpenClaw / Agent Zero app version, and update progress). The bearer never leaves the server for this and is never
// returned or logged. The automatic-update sweep also asks, with the bearer,
// whether a reply is being written or an agent terminal is attached.
//
// Every request goes to the computer's own validated origin (the stored
// chat_url, bound to its named tunnel hostname) through the SSRF-safe fetch,
// without redirects or cookies, bounded in time and size.

import { ssrfSafeFetch } from "@/lib/ssrf-safe-fetch";
import { checkOutboundUrlSafety } from "@/lib/url-safety";
import { validateHivraChatOrigin } from "./agent-host-result";
import { parseAgentCliMeta, type AgentCliMetaReport, type AgentSoftwareSubject } from "./agent-cli-status";
import { AGENT_COMPUTER_READ_TIMEOUT_MS } from "./lifecycle-timeouts";

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
        headers: { Accept: "application/json", ...(authenticated ? { Authorization: `Bearer ${apiToken}` } : {}) },
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
    const runsBody = objectOf(await box.get("/api/chat/runs", true, MAX_RUNS_RESPONSE_BYTES));
    const terminalsBody = objectOf(await box.get("/api/terminal/sessions?surface=agent", true));
    if (!runsBody || !Array.isArray(runsBody.runs) || !terminalsBody || !Array.isArray(terminalsBody.sessions)) return null;
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
    const terminalAttached = terminalsBody.sessions.some((entry) => objectOf(entry)?.attached === true);
    return { runningReplies, lastReplyActivityAt, terminalAttached };
  } catch {
    return null;
  } finally {
    box.close();
  }
}
