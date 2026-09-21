"use client";

import { z } from "zod";
import type { BoxFileEntry } from "./agent-api";

export type WorkspaceSurface = "files" | "box-terminal";
export type WorkspacePhase = "checking" | "opening" | "connected" | "mounted" | "disconnected";
export type WorkspaceFilesAccess = {
  list: (path: string) => Promise<{ path: string; entries: BoxFileEntry[]; error: string | null }>;
  read: (path: string) => Promise<{ content: string; error: string | null }>;
  write: (path: string, content: string) => Promise<{ ok: boolean; error: string | null }>;
};
const Uuid = z.string().uuid();
const Session = z.object({ sessionId: Uuid, computerId: Uuid, surface: z.enum(["files", "box-terminal"]),
  audience: z.string(), handoffUrl: z.string(), exchangeCode: z.string().regex(/^hwe1_[A-Za-z0-9_-]{43}$/),
  expiresAt: z.number().finite(), exchangeExpiresAt: z.number().finite() }).strict();
type Session = z.infer<typeof Session>;
type Ports = { frame: () => Window | null; showFrame: (value: { id: string; url: string } | null) => void;
  status: (phase: WorkspacePhase) => void; fetch?: typeof fetch };
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === "object"
  && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const unavailable = "Workspace disconnected. Reconnect to continue; your draft is still here.";
function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** One dashboard document, one selected surface, one freshly keyed guest frame.
 * Capabilities live in memory only. The caller attaches receive() to its window
 * and disposes on pagehide/unmount; no automatic reconnect or write retry. */
export function createWorkspaceBrowserBridge(computerId: string, boxOrigin: string, surface: WorkspaceSurface, ports: Ports) {
  const fetcher = ports.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  let attempt = 0, phase: WorkspacePhase = "disconnected", current: Omit<Session, "exchangeCode"> | null = null;
  let nonce: string | null = null, secret: { verifier: string; exchangeCode: string } | null = null;
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined, expiry: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const status = (value: WorkspacePhase) => { phase = value; ports.status(value); };
  const revoke = (id: string) => {
    const cancellation = new AbortController(), timeout = setTimeout(() => cancellation.abort(), 5000);
    void fetcher("/api/workspace/sessions", { method: "DELETE", credentials: "same-origin", cache: "no-store", redirect: "error",
      keepalive: true, signal: cancellation.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId: id }) })
      .catch(() => undefined).finally(() => clearTimeout(timeout));
  };
  function reset(notify: boolean) {
    attempt++; controller?.abort(); controller = null; clearTimeout(timer); clearTimeout(expiry);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(unavailable)); }
    pending.clear();
    if (current) revoke(current.sessionId);
    current = null; secret = null; nonce = null;
    if (notify) { ports.showFrame(null); status("disconnected"); }
  }
  async function connect() {
    reset(true); status("checking"); const generation = attempt;
    const abort = new AbortController(); controller = abort;
    timer = setTimeout(() => { if (generation === attempt) reset(true); }, 35000);
    try {
      const origin = new URL(boxOrigin);
      if (!Uuid.safeParse(computerId).success || origin.protocol !== "https:" || origin.origin !== boxOrigin) throw new Error();
      const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const pkceChallenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      if (generation !== attempt) return;
      const response = await fetcher("/api/workspace/sessions", { method: "POST", credentials: "same-origin", cache: "no-store",
        redirect: "error", signal: abort.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ computerId, surface, pkceChallenge }) });
      const payload = await response.json();
      const parsed = z.object({ success: z.literal(true), data: Session }).strict().safeParse(payload);
      if (!response.ok || !parsed.success) throw new Error();
      const session = parsed.data.data;
      if (generation !== attempt) { revoke(session.sessionId); return; }
      // Track even an invalid response's candidate so it can be owner-revoked.
      const { exchangeCode, ...binding } = session;
      current = binding;
      if (session.computerId !== computerId || session.surface !== surface || session.audience !== boxOrigin
        || session.handoffUrl !== `${boxOrigin}/workspace/handoff` || session.exchangeExpiresAt <= Date.now()
        || session.exchangeExpiresAt > Date.now() + 60000 || session.expiresAt <= session.exchangeExpiresAt
        || session.expiresAt > Date.now() + 240000) throw new Error();
      secret = { verifier, exchangeCode };
      clearTimeout(timer);
      timer = setTimeout(() => { if (generation === attempt) reset(true); }, Math.min(30000, session.exchangeExpiresAt - Date.now()));
      expiry = setTimeout(() => { if (generation === attempt) reset(true); }, session.expiresAt - Date.now());
      status("opening"); ports.showFrame({ id: session.sessionId, url: session.handoffUrl });
    } catch { if (generation === attempt) reset(true); }
  }
  function receive(event: MessageEvent) {
    if (!current || event.origin !== boxOrigin || !ports.frame() || event.source !== ports.frame()) return;
    const data = event.data;
    if (exact(data, ["type", "nonce"]) && data.type === "hivra.workspace.ready.v1" && Uuid.safeParse(data.nonce).success) {
      // A reload is a new guest document. Never replay the previous capability.
      if (nonce) { reset(true); return; }
      if (!secret || phase !== "opening") return;
      nonce = data.nonce as string;
      ports.frame()!.postMessage({ type: "hivra.workspace.init.v1", nonce, sessionId: current.sessionId, surface, ...secret }, boxOrigin);
      secret = null;
      return;
    }
    if (!nonce || !data || typeof data !== "object" || data.nonce !== nonce) return;
    if (data.type === "hivra.workspace.ended.v1" && (exact(data, ["type", "nonce", "reason"])
      || (exact(data, ["type", "nonce", "sessionId", "surface", "reason"]) && data.sessionId === current.sessionId && data.surface === surface))) {
      reset(true); return;
    }
    if (data.sessionId !== current.sessionId || data.surface !== surface || Date.now() >= current.expiresAt) return;
    if (exact(data, ["type", "nonce", "sessionId", "surface", "expiresAt"]) && data.expiresAt === current.expiresAt
      && phase === "opening" && ((surface === "files" && data.type === "hivra.workspace.connected.v1")
        || (surface === "box-terminal" && data.type === "hivra.workspace.mounted.v1"))) {
      clearTimeout(timer); status(surface === "files" ? "connected" : "mounted"); return;
    }
    if (data.type !== "hivra.workspace.result.v1" || surface !== "files" || phase !== "connected" || typeof data.requestId !== "string") return;
    const response = pending.get(data.requestId);
    if (!response || !(exact(data, ["type", "nonce", "sessionId", "surface", "requestId", "ok", "status", "data"])
      || exact(data, ["type", "nonce", "sessionId", "surface", "requestId", "ok", "error"]))) return;
    clearTimeout(response.timer); pending.delete(data.requestId);
    if (data.ok === true && typeof data.status === "number" && data.status >= 200 && data.status < 300) response.resolve(data.data);
    else response.reject(new Error("The file request failed. Protected files cannot be opened or changed here."));
  }
  function request(operation: "list" | "read" | "write", path: string, content?: string): Promise<unknown> {
    if (!current || !nonce || phase !== "connected" || surface !== "files" || Date.now() >= current.expiresAt
      || path.length > 4096 || pending.size >= 4 || !ports.frame()
      || (operation === "write" && (typeof content !== "string" || new TextEncoder().encode(content).length > 512 * 1024))) return Promise.reject(new Error(unavailable));
    return new Promise((resolve, reject) => {
      const requestId = crypto.randomUUID();
      const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error("The file request timed out. Check the file before saving again.")); }, 27000);
      pending.set(requestId, { resolve, reject, timer: timeout });
      ports.frame()!.postMessage({ type: "hivra.workspace.files.v1", nonce, sessionId: current!.sessionId, requestId, operation, path,
        ...(operation === "write" ? { content } : {}) }, boxOrigin);
    });
  }
  const error = (value: unknown) => value instanceof Error ? value.message : unavailable;
  const files: WorkspaceFilesAccess = {
    async list(path) {
      try {
        const result = z.object({ path: z.string().max(4096), entries: z.array(z.object({ name: z.string().max(255),
          type: z.enum(["file", "dir"]), size: z.number().finite().nonnegative(), mtime: z.number().finite() })).max(10000) }).parse(await request("list", path));
        return { ...result, error: null };
      } catch (e) { return { path, entries: [], error: error(e) }; }
    },
    async read(path) {
      try { return { content: z.object({ content: z.string().max(2 * 1024 * 1024) }).parse(await request("read", path)).content, error: null }; }
      catch (e) { return { content: "", error: error(e) }; }
    },
    async write(path, content) {
      try { z.object({ ok: z.literal(true) }).parse(await request("write", path, content)); return { ok: true, error: null }; }
      catch (e) { return { ok: false, error: error(e) }; }
    },
  };
  return { connect, receive, files, disconnect: () => reset(true), dispose: () => reset(false) };
}
