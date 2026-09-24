/**
 * Host relay: lets hosted Hivra reach a user's machine that has no inbound
 * ports. The machine's hivra-connector holds one outbound control socket per
 * connection. When Hivra needs SSH, it opens a client socket with a short-lived
 * ticket; the relay asks the connector to open a matching stream socket, which
 * the connector joins to 127.0.0.1:22 on the machine. The relay only copies
 * bytes: SSH (and its pinned host key) stays end to end between Hivra and the
 * machine, so the relay can drop traffic but cannot read or alter a session.
 *
 * One Durable Object per connection id. The idle control socket is
 * hibernatable, so a connected machine costs nothing while unused.
 */
import { DurableObject } from "cloudflare:workers";

export interface Env {
  HOST_RELAY: DurableObjectNamespace<HostRelay>;
  HOST_RELAY_SECRET?: string;
}

const CONNECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_ID = /^[A-Za-z0-9_-]{16,64}$/;
const ROUTE = /^\/v1\/hosts\/([0-9a-f-]{36})\/(agent|client|revoke|stream\/([A-Za-z0-9_-]{16,64}))$/;
const CLOCK_SKEW_SECONDS = 120;
const MAX_TICKET_LIFETIME_SECONDS = 120;
const MAX_GENERATION = 1_000_000_000;
const MAX_STREAMS = 8;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = 256 * 1024;
const STREAM_ATTACH_TIMEOUT_MS = 10_000;
const MIN_SECRET_LENGTH = 32;

const encoder = new TextEncoder();

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function configured(env: Env): env is Env & { HOST_RELAY_SECRET: string } {
  return typeof env.HOST_RELAY_SECRET === "string" && env.HOST_RELAY_SECRET.length >= MIN_SECRET_LENGTH;
}

async function hmac(key: string, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message)));
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): string | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    return atob(padded);
  } catch {
    return null;
  }
}

function sameString(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

/** The secret a connector holds; derived, so the relay stores nothing per host. */
async function connectorSecret(master: string, connectionId: string, generation: number): Promise<string> {
  return hex(await hmac(master, `connector|${connectionId}|${generation}`));
}

async function adminToken(master: string): Promise<string> {
  return hex(await hmac(master, "admin|v1"));
}

async function ticketKey(master: string): Promise<string> {
  return hex(await hmac(master, "client-ticket|v1"));
}

async function connectorSignature(secret: string, kind: "agent" | "stream", connectionId: string, streamId: string, timestamp: number): Promise<string> {
  return hex(await hmac(secret, `${kind}|${connectionId}|${streamId}|${timestamp}`));
}

function randomToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

function isUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

type StreamEntry = {
  client: WebSocket;
  stream: WebSocket | null;
  pending: Array<string | ArrayBuffer>;
  pendingBytes: number;
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * End a control socket. The reason is sent as a message first: a server-side
 * close on an idle hibernatable socket can be flushed late, and the connector
 * acts on the message (reconnect, or stop for good when revoked).
 */
function retireAgent(socket: WebSocket, code: 4000 | 4001, reason: "replaced" | "revoked") {
  try {
    socket.send(JSON.stringify({ type: "closing", reason }));
  } catch {
    // Already gone.
  }
  try {
    socket.close(code, reason);
  } catch {
    // Already closed.
  }
}

function frameSize(data: string | ArrayBuffer): number {
  return typeof data === "string" ? encoder.encode(data).byteLength : data.byteLength;
}

export class HostRelay extends DurableObject<Env> {
  private streams = new Map<string, StreamEntry>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalive pings are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
  }

  async fetch(request: Request): Promise<Response> {
    if (!configured(this.env)) return json(503, { error: "not_configured" });
    const url = new URL(request.url);
    const match = ROUTE.exec(url.pathname);
    if (!match || !CONNECTION_ID.test(match[1])) return json(404, { error: "not_found" });
    const connectionId = match[1];
    const route = match[2];
    const master = this.env.HOST_RELAY_SECRET;

    if (route === "revoke") return this.revoke(request, master);
    if (!isUpgrade(request)) return json(426, { error: "websocket_required" });
    if (route === "agent") return this.acceptAgent(request, master, connectionId);
    if (route === "client") return this.acceptClient(request, master, connectionId);
    return this.acceptStream(request, master, connectionId, match[3]);
  }

  private async minGeneration(): Promise<number> {
    return (await this.ctx.storage.get<number>("minGeneration")) ?? 1;
  }

  private async verifyConnector(request: Request, master: string, kind: "agent" | "stream", connectionId: string, streamId: string): Promise<number | null> {
    const generation = Number(request.headers.get("x-hivra-generation"));
    const timestamp = Number(request.headers.get("x-hivra-timestamp"));
    const signature = request.headers.get("x-hivra-signature") ?? "";
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION) return null;
    if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > CLOCK_SKEW_SECONDS) return null;
    if (!/^[0-9a-f]{64}$/.test(signature)) return null;
    if (generation < await this.minGeneration()) return null;
    const expected = await connectorSignature(await connectorSecret(master, connectionId, generation), kind, connectionId, streamId, timestamp);
    return sameString(expected, signature) ? generation : null;
  }

  private async revoke(request: Request, master: string): Promise<Response> {
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    const authorization = request.headers.get("authorization") ?? "";
    if (!sameString(authorization, `Bearer ${await adminToken(master)}`)) return json(401, { error: "unauthorized" });
    let minGeneration: unknown;
    try {
      minGeneration = ((await request.json()) as { minGeneration?: unknown }).minGeneration;
    } catch {
      return json(400, { error: "invalid_request" });
    }
    if (typeof minGeneration !== "number" || !Number.isSafeInteger(minGeneration) || minGeneration < 1 || minGeneration > MAX_GENERATION) {
      return json(400, { error: "invalid_request" });
    }
    const next = Math.max(await this.minGeneration(), minGeneration);
    await this.ctx.storage.put("minGeneration", next);
    for (const socket of this.ctx.getWebSockets("agent")) {
      const tag = this.ctx.getTags(socket).find((value) => value.startsWith("gen:"));
      if (Number(tag?.slice(4)) < next) retireAgent(socket, 4001, "revoked");
    }
    // Revocation also ends sessions already running through the relay.
    for (const [streamId, entry] of this.streams) {
      if (entry) this.closeEntry(streamId, 4001, "revoked");
    }
    return json(200, { minGeneration: next });
  }

  private async acceptAgent(request: Request, master: string, connectionId: string): Promise<Response> {
    const generation = await this.verifyConnector(request, master, "agent", connectionId, "");
    if (generation === null) return json(401, { error: "unauthorized" });
    // One control socket per machine: a reconnect replaces the old one.
    for (const socket of this.ctx.getWebSockets("agent")) retireAgent(socket, 4000, "replaced");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["agent", `gen:${generation}`]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async acceptClient(request: Request, master: string, connectionId: string): Promise<Response> {
    const ticket = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(request.headers.get("authorization") ?? "");
    if (!ticket) return json(401, { error: "unauthorized" });
    const expected = base64url(await hmac(await ticketKey(master), ticket[1]));
    if (!sameString(expected, ticket[2])) return json(401, { error: "unauthorized" });
    let payload: { aud?: unknown; exp?: unknown; jti?: unknown };
    try {
      payload = JSON.parse(fromBase64url(ticket[1]) ?? "") as typeof payload;
    } catch {
      return json(401, { error: "unauthorized" });
    }
    const now = Math.floor(Date.now() / 1000);
    if (payload.aud !== connectionId || typeof payload.exp !== "number" || payload.exp <= now
      || payload.exp > now + MAX_TICKET_LIFETIME_SECONDS || typeof payload.jti !== "string" || !TOKEN_ID.test(payload.jti)) {
      return json(401, { error: "unauthorized" });
    }
    const replayKey = `jti:${payload.jti}`;
    if (await this.ctx.storage.get(replayKey)) return json(401, { error: "unauthorized" });
    await this.ctx.storage.put(replayKey, payload.exp);
    await this.forgetExpiredTickets(now);

    const agent = this.ctx.getWebSockets("agent")[0];
    if (!agent) return json(503, { error: "host_offline" });
    if (this.streams.size >= MAX_STREAMS) return json(429, { error: "too_many_streams" });

    const streamId = randomToken();
    const pair = new WebSocketPair();
    const client = pair[1];
    client.accept();
    const entry: StreamEntry = { client, stream: null, pending: [], pendingBytes: 0, timer: null };
    this.streams.set(streamId, entry);
    entry.timer = setTimeout(() => this.closeEntry(streamId, 4504, "host did not answer"), STREAM_ATTACH_TIMEOUT_MS);
    client.addEventListener("message", (event) => this.forward(streamId, "client", event.data as string | ArrayBuffer));
    client.addEventListener("close", (event) => this.closeEntry(streamId, event.code === 1005 ? 1000 : event.code, "client closed"));
    client.addEventListener("error", () => this.closeEntry(streamId, 1011, "client error"));
    try {
      agent.send(JSON.stringify({ type: "open", stream: streamId }));
    } catch {
      this.closeEntry(streamId, 4503, "host offline");
      return json(503, { error: "host_offline" });
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async acceptStream(request: Request, master: string, connectionId: string, streamId: string): Promise<Response> {
    const generation = await this.verifyConnector(request, master, "stream", connectionId, streamId);
    if (generation === null) return json(401, { error: "unauthorized" });
    const entry = this.streams.get(streamId);
    if (!entry) return json(404, { error: "unknown_stream" });
    if (entry.stream) return json(409, { error: "stream_attached" });
    const pair = new WebSocketPair();
    const stream = pair[1];
    stream.accept();
    entry.stream = stream;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    stream.addEventListener("message", (event) => this.forward(streamId, "stream", event.data as string | ArrayBuffer));
    stream.addEventListener("close", (event) => this.closeEntry(streamId, event.code === 1005 ? 1000 : event.code, "host closed"));
    stream.addEventListener("error", () => this.closeEntry(streamId, 1011, "host error"));
    for (const frame of entry.pending) stream.send(frame);
    entry.pending = [];
    entry.pendingBytes = 0;
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private forward(streamId: string, from: "client" | "stream", data: string | ArrayBuffer) {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    const size = frameSize(data);
    if (size > MAX_FRAME_BYTES) {
      this.closeEntry(streamId, 1009, "frame too large");
      return;
    }
    if (from === "stream") {
      entry.client.send(data);
      return;
    }
    if (entry.stream) {
      entry.stream.send(data);
      return;
    }
    // SSH clients speak first; hold their bytes until the machine joins.
    if (entry.pendingBytes + size > MAX_PENDING_BYTES) {
      this.closeEntry(streamId, 1009, "too much data before the host joined");
      return;
    }
    entry.pending.push(data);
    entry.pendingBytes += size;
  }

  private closeEntry(streamId: string, code: number, reason: string) {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    this.streams.delete(streamId);
    if (entry.timer) clearTimeout(entry.timer);
    const safeCode = code === 1000 || (code >= 3000 && code <= 4999) || code === 1009 || code === 1011 ? code : 1011;
    for (const socket of [entry.client, entry.stream]) {
      try {
        socket?.close(safeCode, reason);
      } catch {
        // Already closed.
      }
    }
  }

  private async forgetExpiredTickets(now: number) {
    const seen = await this.ctx.storage.list<number>({ prefix: "jti:", limit: 100 });
    const expired = [...seen].filter(([, exp]) => exp <= now).map(([key]) => key);
    if (expired.length) await this.ctx.storage.delete(expired);
  }

  // Hibernation handlers: only the agent control socket is hibernatable.
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string" || message.length > 256) return;
    try {
      if ((JSON.parse(message) as { type?: unknown }).type === "ping") socket.send(JSON.stringify({ type: "pong" }));
    } catch {
      // Ignore anything that is not a ping.
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string) {
    try {
      socket.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json(200, { ok: true, configured: configured(env) });
    if (!configured(env)) return json(503, { error: "not_configured" });
    const match = ROUTE.exec(url.pathname);
    if (!match || !CONNECTION_ID.test(match[1])) return json(404, { error: "not_found" });
    const stub = env.HOST_RELAY.get(env.HOST_RELAY.idFromName(match[1]));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
