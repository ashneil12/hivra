import "server-only";

// Hivra's side of the host relay (services/host-relay-worker): a machine with
// no inbound ports runs hivra-connector, which dials the relay; Hivra dials
// the relay too, and SSH runs end to end through it. This module issues the
// connector's configuration, mints the short-lived client tickets, and turns
// a relay session into the socket ssh2 speaks over. The host key pin and every
// SSH check above the socket are unchanged.
//
// Every value here derives from HOST_RELAY_SECRET, shared with the Worker:
// connector secret = HMAC(secret, "connector|<id>|<generation>"), ticket key =
// HMAC(secret, "client-ticket|v1"), admin token = HMAC(secret, "admin|v1").

import { createHmac, randomBytes } from "node:crypto";
import { Duplex } from "node:stream";

import { log } from "@/lib/logger";

const LOG_SOURCE = "host-relay";
const MIN_SECRET_LENGTH = 32;
const TICKET_LIFETIME_SECONDS = 60;
const DEFAULT_OPEN_TIMEOUT_MS = 20_000;
/** Pause writes above this much unsent data so a slow machine cannot balloon memory. */
const HIGH_WATER_BYTES = 1024 * 1024;
const CONNECTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type HostRelayErrorCode = "not_configured" | "invalid_request" | "host_offline" | "unauthorized" | "too_many_sessions" | "unavailable";

export class HostRelayError extends Error {
  constructor(public readonly code: HostRelayErrorCode, message: string) {
    super(message);
    this.name = "HostRelayError";
  }
}

type RelayConfig = { httpBase: string; wsBase: string; secret: string };

export function hostRelayConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig | null {
  const url = env.HOST_RELAY_URL?.trim();
  const secret = env.HOST_RELAY_SECRET;
  if (!url || !secret || secret.length < MIN_SECRET_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return null;
  const httpBase = `${parsed.protocol}//${parsed.host}`;
  return { httpBase, wsBase: httpBase.replace(/^http/, "ws"), secret };
}

export function hostRelayConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return hostRelayConfig(env) !== null;
}

function requireConfig(): RelayConfig {
  const config = hostRelayConfig();
  if (!config) throw new HostRelayError("not_configured", "Hivra's relay for machines without inbound access is not set up here.");
  return config;
}

function requireConnectionId(connectionId: string) {
  if (!CONNECTION_ID.test(connectionId)) throw new HostRelayError("invalid_request", "That connection id is not valid.");
}

const hmacHex = (key: string, message: string) => createHmac("sha256", key).update(message).digest("hex");

export function connectorSecret(masterSecret: string, connectionId: string, generation: number): string {
  return hmacHex(masterSecret, `connector|${connectionId}|${generation}`);
}

function adminToken(masterSecret: string): string {
  return hmacHex(masterSecret, "admin|v1");
}

/** The configuration file hivra-connector reads on the machine (see its README). */
export function issueConnectorConfig(connectionId: string, generation: number): {
  relay: string;
  connectionId: string;
  generation: number;
  secret: string;
} {
  requireConnectionId(connectionId);
  if (!Number.isSafeInteger(generation) || generation < 1) throw new HostRelayError("invalid_request", "The connector generation is not valid.");
  const config = requireConfig();
  return { relay: config.wsBase, connectionId, generation, secret: connectorSecret(config.secret, connectionId, generation) };
}

export function mintRelayTicket(masterSecret: string, connectionId: string, nowMs: number = Date.now()): string {
  const body = Buffer.from(JSON.stringify({
    aud: connectionId,
    exp: Math.floor(nowMs / 1000) + TICKET_LIFETIME_SECONDS,
    jti: randomBytes(18).toString("base64url"),
  })).toString("base64url");
  const signature = createHmac("sha256", hmacHex(masterSecret, "client-ticket|v1")).update(body).digest("base64url");
  return `${body}.${signature}`;
}

async function adminCall(path: string, init: RequestInit): Promise<Response> {
  const config = requireConfig();
  try {
    return await fetch(`${config.httpBase}${path}`, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${adminToken(config.secret)}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HostRelayError("unavailable", "Hivra's relay could not be reached.");
  }
}

export type HostRelayStatus = { online: boolean; generation: number | null; minGeneration: number; sessions: number };

/** Observed now from the relay: is the machine's connector connected? */
export async function hostRelayStatus(connectionId: string): Promise<HostRelayStatus> {
  requireConnectionId(connectionId);
  const response = await adminCall(`/v1/hosts/${connectionId}/status`, { method: "GET" });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new HostRelayError(response.status === 401 ? "unauthorized" : "unavailable", "Hivra's relay did not report this machine's status.");
  }
  const body = (await response.json()) as Partial<HostRelayStatus>;
  return {
    online: body.online === true,
    generation: typeof body.generation === "number" ? body.generation : null,
    minGeneration: typeof body.minGeneration === "number" ? body.minGeneration : 1,
    sessions: typeof body.sessions === "number" ? body.sessions : 0,
  };
}

/** Stop every connector below this generation, and end their sessions. */
export async function revokeRelayConnector(connectionId: string, minGeneration: number): Promise<void> {
  requireConnectionId(connectionId);
  const response = await adminCall(`/v1/hosts/${connectionId}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ minGeneration }),
  });
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    log.warn("Host relay refused a connector revocation", { source: LOG_SOURCE, failureType: "host_relay_revoke_failed", status: response.status });
    throw new HostRelayError(response.status === 401 ? "unauthorized" : "unavailable", "Hivra's relay did not confirm the revocation.");
  }
}

/** A WebSocket as the byte stream ssh2 expects for `sock`. */
class RelaySocket extends Duplex {
  private waitingForDrain: (() => void) | null = null;

  constructor(private readonly ws: WebSocket) {
    super({ allowHalfOpen: false });
    ws.binaryType = "arraybuffer";
    ws.addEventListener("message", (event) => {
      const data = event.data;
      this.push(typeof data === "string" ? Buffer.from(data) : Buffer.from(data as ArrayBuffer));
    });
    ws.addEventListener("close", () => {
      this.push(null);
      this.releaseWriter();
      if (!this.destroyed) this.destroy();
    });
    ws.addEventListener("error", () => this.destroy(new HostRelayError("unavailable", "The relay session ended unexpectedly.")));
  }

  private releaseWriter() {
    const resume = this.waitingForDrain;
    this.waitingForDrain = null;
    resume?.();
  }

  _read() {
    // Data is pushed as it arrives.
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      callback(new HostRelayError("unavailable", "The relay session is closed."));
      return;
    }
    this.ws.send(chunk);
    if (this.ws.bufferedAmount < HIGH_WATER_BYTES) {
      callback();
      return;
    }
    // Hold the writer until the socket drains below the mark.
    this.waitingForDrain = () => callback();
    const poll = () => {
      if (!this.waitingForDrain) return;
      if (this.ws.bufferedAmount < HIGH_WATER_BYTES || this.ws.readyState !== WebSocket.OPEN) this.releaseWriter();
      else setTimeout(poll, 10);
    };
    setTimeout(poll, 10);
  }

  _final(callback: (error?: Error | null) => void) {
    try {
      this.ws.close(1000, "done");
    } catch {
      // Already closing.
    }
    callback();
  }

  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.releaseWriter();
    try {
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(1000, "done");
    } catch {
      // Already closed.
    }
    callback(error);
  }
}

/**
 * Open one relay session to the machine's SSH server. Pass the result to
 * ssh2 as `sock`. When the upgrade is refused, the relay's status says why
 * (the machine is offline is the common case), because a refused WebSocket
 * upgrade does not expose its HTTP status.
 */
export async function openRelaySocket(connectionId: string, options: { timeoutMs?: number } = {}): Promise<Duplex> {
  requireConnectionId(connectionId);
  const config = requireConfig();
  const ws = new WebSocket(`${config.wsBase}/v1/hosts/${connectionId}/client`, {
    headers: { authorization: `Bearer ${mintRelayTicket(config.secret, connectionId)}` },
  } as unknown as string[]);
  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), options.timeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(true); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(timer); resolve(false); }, { once: true });
  });
  if (opened) return new RelaySocket(ws);
  try {
    ws.close();
  } catch {
    // Never opened.
  }
  const status = await hostRelayStatus(connectionId).catch(() => null);
  if (status && !status.online) throw new HostRelayError("host_offline", "This machine isn't connected to Hivra right now. Check that it is on and that hivra-connector is running.");
  if (status && status.sessions >= 8) throw new HostRelayError("too_many_sessions", "This machine already has the most sessions Hivra opens at once. Try again shortly.");
  log.warn("Host relay session did not open", { source: LOG_SOURCE, failureType: "host_relay_open_failed", online: status?.online ?? null });
  throw new HostRelayError("unavailable", "Hivra's relay did not open a session to this machine.");
}
