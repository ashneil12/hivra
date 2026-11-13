// The host wake proxy's per-computer route file, and the secrets derived for
// it. Pure: nothing here talks to the network or the database.
//
// A route file (/etc/hivra/ingress/routes/<vmid>.json, root only) tells the
// proxy which public hostname belongs to which VM and where the VM's guest
// forwarder listens. The server builds everything except the VM's MAC, which
// the host script reads from the VM's own net0 line at run time, so nothing
// host-specific is computed here.
//
// ticket_key = HMAC-SHA256(HIVRA_INGRESS_SECRET, "hivra-ingress-ticket-v1" NUL
// agentId NUL tunnelId NUL generation), hex. Hivra stores nothing per agent:
// the key is derived again whenever it is needed, and moving the generation on
// (every enable and rollback does) revokes every earlier key.
//
// Client wakes: bearer_sha256 is sha256 of the agent's box API token, so the
// proxy's root helper can check a bearer (or the dashboard's /auth/bootstrap
// form) without holding the token itself. wake_url is where a browser asking
// for a napped computer is sent: the owner's agent page, which wakes it
// through Hivra. Both are optional; without them the proxy wakes on tickets only.

import { createHash, createHmac } from "node:crypto";

import { GUEST_FORWARDER_LISTEN_PORT } from "@/lib/hivra/ingress/guest-forwarder-program";

export const INGRESS_ROUTE_VERSION = 1;
export const INGRESS_DIR = "/etc/hivra/ingress";
export const INGRESS_ROUTES_DIR = `${INGRESS_DIR}/routes`;
export const INGRESS_PINS_DIR = `${INGRESS_DIR}/pins`;
/** The proxy's control CLI on the host. */
export const INGRESS_PROXY_PROGRAM = "/usr/local/lib/hivra-ingress/hivra-wake-proxy.py";

/** Host connector metrics ports, one per computer on a host. */
export const INGRESS_METRICS_PORT_MIN = 21000;
export const INGRESS_METRICS_PORT_MAX = 21999;

const MIN_SECRET_LENGTH = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const TAG = /^[A-Za-z0-9._-]{1,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const TUNNEL_TOKEN = /^[A-Za-z0-9+/=_-]{40,4096}$/;
/** The proxy's rule (hivra-wake-proxy.py WAKE_URL_RE): https, no credentials, query or fragment. */
const WAKE_URL = /^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~%/-]*)?$/;
const WAKE_URL_MAX = 512;
const BOX_API_TOKEN = /^[a-f0-9]{64}$/;

type Env = Record<string, string | undefined>;

export function ingressRoutePath(vmid: number): string {
  return `${INGRESS_ROUTES_DIR}/${assertVmid(vmid)}.json`;
}

export function ingressConnectorEnvPath(vmid: number): string {
  return `${INGRESS_DIR}/${assertVmid(vmid)}.env`;
}

export function assertVmid(vmid: number): number {
  if (!Number.isSafeInteger(vmid) || vmid < 100 || vmid > 999_999_999) throw new Error("Invalid VMID.");
  return vmid;
}

/** HIVRA_INGRESS_SECRET, or null when it is unset or shorter than 32 characters (then host ingress cannot be enabled). */
export function resolveIngressSecret(env: Env = process.env): string | null {
  const value = String(env.HIVRA_INGRESS_SECRET ?? "").trim();
  return value.length >= MIN_SECRET_LENGTH ? value : null;
}

/** The proxy's ticket key for one agent, tunnel and generation: 64 hex characters. */
export function deriveIngressTicketKey(input: {
  secret: string;
  agentId: string;
  tunnelId: string;
  generation: number;
}): string {
  if (typeof input.secret !== "string" || input.secret.length < MIN_SECRET_LENGTH) throw new Error("Ingress secret is too short.");
  if (!UUID.test(input.agentId)) throw new Error("Invalid agent id.");
  if (!UUID.test(input.tunnelId)) throw new Error("Invalid tunnel id.");
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) throw new Error("Invalid generation.");
  const message = ["hivra-ingress-ticket-v1", input.agentId.toLowerCase(), input.tunnelId.toLowerCase(), String(input.generation)]
    .join("\u0000");
  return createHmac("sha256", input.secret).update(message, "utf8").digest("hex");
}

/** The route file the server sends; the host script adds guest_mac from net0. */
export interface IngressRouteFile {
  version: typeof INGRESS_ROUTE_VERSION;
  vmid: number;
  hostname: string;
  binding_tag: string;
  guest_ip: string;
  guest_port: number;
  ticket_key: string;
  generation: number;
  /** sha256 (hex) of the box API token: lets the proxy check a client's bearer. */
  bearer_sha256?: string;
  /** Where the proxy sends a browser that asks for the napped computer. */
  wake_url?: string;
}

export function buildIngressRoute(input: {
  vmid: number;
  hostname: string;
  bindingTag: string;
  guestIp: string;
  ticketKey: string;
  generation: number;
  bearerSha256?: string | null;
  wakeUrl?: string | null;
}): IngressRouteFile {
  const route: IngressRouteFile = {
    version: INGRESS_ROUTE_VERSION,
    vmid: input.vmid,
    hostname: String(input.hostname ?? "").toLowerCase(),
    binding_tag: input.bindingTag,
    guest_ip: input.guestIp,
    guest_port: GUEST_FORWARDER_LISTEN_PORT,
    ticket_key: input.ticketKey,
    generation: input.generation,
    ...(input.bearerSha256 ? { bearer_sha256: input.bearerSha256 } : {}),
    ...(input.wakeUrl ? { wake_url: input.wakeUrl } : {}),
  };
  const checked = parseIngressRoute(route);
  if (!checked) throw new Error("Invalid ingress route.");
  return checked;
}

/** Strict read of a route file (with or without guest_mac). null when anything is off. */
export function parseIngressRoute(value: unknown): (IngressRouteFile & { guest_mac?: string }) | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const known = new Set(["version", "vmid", "hostname", "binding_tag", "guest_ip", "guest_port", "ticket_key", "generation", "guest_mac",
    "bearer_sha256", "wake_url"]);
  if (Object.keys(v).some((key) => !known.has(key))) return null;
  if (v.version !== INGRESS_ROUTE_VERSION) return null;
  if (typeof v.vmid !== "number") return null;
  try { assertVmid(v.vmid); } catch { return null; }
  if (typeof v.hostname !== "string" || !HOSTNAME.test(v.hostname)) return null;
  if (typeof v.binding_tag !== "string" || !TAG.test(v.binding_tag)) return null;
  if (typeof v.guest_ip !== "string" || !isPrivateGuestIp(v.guest_ip)) return null;
  if (v.guest_port !== GUEST_FORWARDER_LISTEN_PORT) return null;
  if (typeof v.ticket_key !== "string" || !HEX64.test(v.ticket_key)) return null;
  if (typeof v.generation !== "number" || !Number.isSafeInteger(v.generation) || v.generation < 0) return null;
  if (v.guest_mac !== undefined && (typeof v.guest_mac !== "string" || !/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(v.guest_mac))) return null;
  if (v.bearer_sha256 !== undefined && (typeof v.bearer_sha256 !== "string" || !HEX64.test(v.bearer_sha256))) return null;
  if (v.wake_url !== undefined && !isIngressWakeUrl(v.wake_url)) return null;
  return v as unknown as IngressRouteFile & { guest_mac?: string };
}

/** Whether a value is a wake URL the proxy accepts. */
export function isIngressWakeUrl(value: unknown): value is string {
  return typeof value === "string" && value.length <= WAKE_URL_MAX && WAKE_URL.test(value);
}

/** sha256 (hex) of a box API token, or null when it is not the 64-hex shape boxes use. */
export function ingressBearerSha256(apiToken: unknown): string | null {
  if (typeof apiToken !== "string" || !BOX_API_TOKEN.test(apiToken)) return null;
  return createHash("sha256").update(apiToken, "utf8").digest("hex");
}

/**
 * The owner's agent page, from NEXT_PUBLIC_APP_URL: a signed-in owner lands there and
 * the page wakes the agent through Hivra. null when no usable https origin is set.
 */
export function ingressWakeUrl(agentId: string, env: Env = process.env): string | null {
  if (!UUID.test(agentId)) return null;
  let origin: URL;
  try {
    origin = new URL(String(env.NEXT_PUBLIC_APP_URL ?? "").trim());
  } catch {
    return null;
  }
  if (origin.protocol !== "https:" || origin.username || origin.password) return null;
  const url = `https://${origin.host.toLowerCase()}/dashboard/agent/${agentId.toLowerCase()}`;
  return isIngressWakeUrl(url) ? url : null;
}

/** RFC 1918 or shared (100.64/10) IPv4, the same rule the proxy applies. */
export function isPrivateGuestIp(value: string): boolean {
  if (!IPV4.test(value)) return false;
  const [a, b] = value.split(".").map(Number);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** Whether a string looks like a tunnel run token. */
export function isTunnelTokenShape(value: unknown): value is string {
  return typeof value === "string" && TUNNEL_TOKEN.test(value);
}

/**
 * The stdin document for the attach step. It carries the run token, so it
 * only ever travels as SSH stdin, never in argv, a log or the database.
 */
export function buildIngressAttachPayload(input: { route: IngressRouteFile; token: string; metricsPort: number }): string {
  if (!isTunnelTokenShape(input.token)) throw new Error("Invalid tunnel credential shape.");
  if (!parseIngressRoute(input.route)) throw new Error("Invalid ingress route.");
  assertMetricsPort(input.metricsPort);
  return JSON.stringify({ route: input.route, token: input.token, metrics_port: input.metricsPort });
}

/** The stdin document that puts a run token back into the guest. */
export function buildGuestTokenPayload(token: string): string {
  if (!isTunnelTokenShape(token)) throw new Error("Invalid tunnel credential shape.");
  return JSON.stringify({ token });
}

export function assertMetricsPort(port: number): number {
  if (!Number.isSafeInteger(port) || port < INGRESS_METRICS_PORT_MIN || port > INGRESS_METRICS_PORT_MAX) {
    throw new Error("Invalid metrics port.");
  }
  return port;
}

/** The lowest free metrics port, given the ones other computers on the host hold. null when the range is full. */
export function pickMetricsPort(used: Iterable<number | null | undefined>, preferred?: number | null): number | null {
  const taken = new Set<number>();
  for (const port of used) if (typeof port === "number") taken.add(port);
  if (typeof preferred === "number" && preferred >= INGRESS_METRICS_PORT_MIN && preferred <= INGRESS_METRICS_PORT_MAX
    && !taken.has(preferred)) {
    return preferred;
  }
  for (let port = INGRESS_METRICS_PORT_MIN; port <= INGRESS_METRICS_PORT_MAX; port += 1) {
    if (!taken.has(port)) return port;
  }
  return null;
}
