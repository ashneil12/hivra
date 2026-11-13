// Switches for host ingress: the host, not the agent's computer, runs the
// agent's public connector, so a request can wake a sleeping agent. Pure:
// nothing here talks to the network or the database, and nothing here imports
// server-only code.
//
// Three switches, all needed before ingress code may act on an agent:
//   HIVRA_HOST_INGRESS        server env: off (default), canary or on
//   proxmox_hosts.ingress_mode per host:  off (default), canary or on
//   hivra_agent_ingress row    per agent: mode guest or host
//
// The stricter of the server and the host switch wins, so either one being off
// means no ingress code runs on that host. An agent with no ingress row, or a
// row this code does not understand, is never acted on.
//
// Fail toward awake: an agent whose row says host while ingress may not act is
// served by a connector nothing is managing, so it must be woken and kept
// awake (ingressNeedsAwake).

export type HostIngressMode = "off" | "canary" | "on";
export type AgentIngressMode = "guest" | "host";
export type AgentIngressPhase = "none" | "forwarder" | "host_connector" | "cutover" | "rolled_back" | "failed";

export const AGENT_INGRESS_PHASES: readonly AgentIngressPhase[] = [
  "none", "forwarder", "host_connector", "cutover", "rolled_back", "failed",
];

type Env = Record<string, string | undefined>;

/** The agent's ingress row, as far as the switches care. */
export interface IngressAgentRow {
  mode?: unknown;
}

/** The agent's host row, as far as the switches care. */
export interface IngressHostRow {
  ingress_mode?: unknown;
}

const RANK: Record<HostIngressMode, number> = { off: 0, canary: 1, on: 2 };

function parseMode(value: unknown): HostIngressMode {
  const mode = String(value ?? "").trim().toLowerCase();
  return mode === "canary" || mode === "on" ? mode : "off";
}

/** HIVRA_HOST_INGRESS. Anything but canary or on is off. */
export function parseHostIngressMode(value: string | undefined | null): HostIngressMode {
  return parseMode(value);
}

/**
 * proxmox_hosts.ingress_mode. Exact values only, the same as the database
 * check: anything else, including a missing column, is off.
 */
export function parseHostRowIngressMode(value: unknown): HostIngressMode {
  return value === "canary" || value === "on" ? value : "off";
}

/** hivra_agent_ingress.mode, or null when the value is not one this code knows. */
export function parseAgentIngressMode(value: unknown): AgentIngressMode | null {
  return value === "guest" || value === "host" ? value : null;
}

/** The server's ingress mode, from the environment. */
export function resolveHostIngressMode(env: Env = process.env): HostIngressMode {
  return parseHostIngressMode(env.HIVRA_HOST_INGRESS);
}

/** The stricter of the server and host switch. */
export function effectiveIngressMode(host: IngressHostRow | null | undefined, env: Env = process.env): HostIngressMode {
  const server = resolveHostIngressMode(env);
  const hostMode = parseHostRowIngressMode(host?.ingress_mode);
  return RANK[server] <= RANK[hostMode] ? server : hostMode;
}

/**
 * Whether ingress code may act on this agent: the server switch and the host
 * switch are both on (canary or on), and the agent has an ingress row with a
 * known mode.
 */
export function ingressActsFor(
  row: IngressAgentRow | null | undefined,
  host: IngressHostRow | null | undefined,
  env: Env = process.env,
): boolean {
  if (!row || parseAgentIngressMode(row.mode) === null) return false;
  return effectiveIngressMode(host, env) !== "off";
}

/**
 * Whether ingress code may start a new move to host on this host (no row yet).
 * Same switches as ingressActsFor, without the agent row.
 */
export function ingressHostAllowed(host: IngressHostRow | null | undefined, env: Env = process.env): boolean {
  return effectiveIngressMode(host, env) !== "off";
}

/**
 * The kill switch. True when the agent's row says the host serves it but
 * ingress may not act (a switch is off, or the row is unreadable): the sweep
 * must wake such an agent and never nap it.
 */
export function ingressNeedsAwake(
  row: IngressAgentRow | null | undefined,
  host: IngressHostRow | null | undefined,
  env: Env = process.env,
): boolean {
  if (!row) return false;
  const mode = parseAgentIngressMode(row.mode);
  if (mode === "guest") return false;
  // host, or a value this code does not know: awake unless ingress may act on it.
  return mode === null || !ingressActsFor(row, host, env);
}

/** HIVRA_HOST_WAKE_PROXY_ENABLED: lets the install step put the wake proxy on a host. Off unless plainly true. */
export function hostWakeProxyEnabled(env: Env = process.env): boolean {
  return parseBool(env.HIVRA_HOST_WAKE_PROXY_ENABLED);
}

/** HIVRA_INGRESS_HOST_CREDENTIAL: lets hosts call Hivra (wake-report, wake-request). Off unless plainly true. */
export function ingressHostCredentialEnabled(env: Env = process.env): boolean {
  return parseBool(env.HIVRA_INGRESS_HOST_CREDENTIAL);
}

/** true, 1, yes or on (any case) is true; anything else is false. */
export function parseBool(value: string | undefined | null): boolean {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes" || text === "on";
}
