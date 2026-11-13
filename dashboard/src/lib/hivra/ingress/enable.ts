import "server-only";

// Per-agent host ingress cutover: the host, not the agent's computer, runs the
// agent's public connector, so a request can later wake a sleeping computer.
//
// Under the agent's ingress lease, recording each phase:
//   1. Preflight: flags, agent awake and idle, host proxy healthy, the tunnel
//      origin is the computer's port 8080, a guest connector is serving.
//   2. Guest forwarder installed (phase forwarder).
//   3. Tunnel origin set to http://127.0.0.1:8080 (works from either side).
//   4. Tunnel secret rotated; the new token goes only to the host, over stdin.
//   5. Route, env file and ARP/IP pin written, proxy reloaded, a local check
//      through the proxy, host connector started and /ready (phase host_connector).
//   6. The host connector is listed at the edge.
//   7. Guest connector disabled and its token file deleted.
//   8. Old guest connectors evicted by client id.
//   9. Only the host connector is listed and the public /healthz answers;
//      mode host, phase cutover.
//
// Fail toward awake. Before step 4 a failure changes nothing that serves the
// agent. From step 4 on, a failure puts the new token back into the guest and
// turns its connector on again before anything on the host is removed; if the
// guest cannot be brought back, the host connector is left running and the
// row says mode host, phase failed, so the agent stays reachable and is kept
// awake.

import { randomUUID } from "node:crypto";

import { log } from "@/lib/logger";
import {
  getBoxTunnelOrigin,
  getBoxTunnelToken,
  listTunnelConnections,
  rotateTunnelSecret,
  deleteTunnelConnection,
  setBoxTunnelOrigin,
  type TunnelConnector,
} from "@/lib/services/cloudflare-tunnel";
import { runProxmoxHostScript, runProxmoxHostScriptWithStdin } from "@/lib/services/proxmox-instance-service";
import { readHivraAgentRow, resolveSleepTarget } from "@/lib/hivra/agent-wake";
import { isAgentAwake } from "@/lib/hivra/agent-sleep-store";
import { supabaseAdmin } from "@/lib/supabase";
import { ingressHostAllowed, parseAgentIngressMode, type IngressHostRow } from "@/lib/hivra/ingress/config";
import {
  buildGuestForwarderHostScript,
  parseGuestForwarderOutput,
} from "@/lib/hivra/ingress/guest-forwarder-program";
import {
  buildGuestTokenPayload,
  buildIngressAttachPayload,
  buildIngressRoute,
  ingressBearerSha256,
  ingressWakeUrl,
  deriveIngressTicketKey,
  isPrivateGuestIp,
  pickMetricsPort,
  resolveIngressSecret,
} from "@/lib/hivra/ingress/route-file";
import {
  buildIngressAttachScript,
  buildIngressDetachScript,
  buildIngressGuestTunnelScript,
  buildIngressPreflightScript,
  parseIngressStep,
  type IngressStepResult,
} from "@/lib/hivra/ingress/cutover-scripts";
import {
  claimAgentIngressLease,
  ensureAgentIngressRow,
  listHostMetricsPorts,
  readAgentIngressRow,
  releaseAgentIngressLease,
  updateAgentIngressUnderLease,
  type AgentIngressRow,
  type IngressPatch,
} from "@/lib/hivra/ingress/store";

const LOG_SOURCE = "hivra-ingress";
type Env = Record<string, string | undefined>;
type AgentRow = Record<string, unknown>;

export interface IngressTarget {
  env: Env;
  vmid: number;
  bindingTag: string | null;
  hostId: string;
  managed: boolean;
}

type HostRun = { ok: boolean; stdout: string; stderr: string; error?: string };
type HostRunOptions = { timeoutMs?: number; maxOutputBytes?: number };

/** Everything enable and rollback touch, injectable for tests. */
export interface IngressDeps {
  env: Env;
  readAgent(agentId: string): Promise<AgentRow | null>;
  resolveTarget(row: AgentRow): Promise<IngressTarget | null>;
  readHostRow(hostId: string): Promise<IngressHostRow | null>;
  runHostScript(script: string, env: Env, options: HostRunOptions): Promise<HostRun>;
  runHostScriptWithStdin(script: string, stdin: string, env: Env, options: HostRunOptions): Promise<HostRun>;
  store: {
    read: typeof readAgentIngressRow;
    ensure: typeof ensureAgentIngressRow;
    claim: typeof claimAgentIngressLease;
    update: typeof updateAgentIngressUnderLease;
    release: typeof releaseAgentIngressLease;
    listPorts: typeof listHostMetricsPorts;
  };
  cf: {
    getToken: (tunnelId: string) => Promise<string>;
    listConnections: (tunnelId: string) => Promise<TunnelConnector[]>;
    rotateSecret: (tunnelId: string) => Promise<void>;
    deleteConnection: (tunnelId: string, clientId: string) => Promise<void>;
    getOrigin: (tunnelId: string, hostname: string) => Promise<string | null>;
    setOrigin: (tunnelId: string, hostname: string, service: "http://localhost:8080" | "http://127.0.0.1:8080") => Promise<void>;
  };
  /** GET https://<hostname>/healthz through the edge: true on 200. */
  edgeHealthy(hostname: string): Promise<boolean>;
  /** Wakes the agent (rollback only). */
  ensureAwake(agentId: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  newLeaseId(): string;
}

async function readHostRowFromDb(hostId: string): Promise<IngressHostRow | null> {
  if (!supabaseAdmin) throw new Error("database_unavailable");
  const { data, error } = await supabaseAdmin.from("proxmox_hosts").select("id, ingress_mode").eq("id", hostId).maybeSingle();
  if (error) throw new Error("host_read_failed");
  return (data as IngressHostRow | null) ?? null;
}

async function resolveTargetFromRow(row: AgentRow): Promise<IngressTarget | null> {
  const resolved = await resolveSleepTarget(row, LOG_SOURCE);
  if (!resolved.ok) return null;
  const { target } = resolved;
  return {
    env: target.env,
    vmid: target.vmid,
    bindingTag: target.bindingTag,
    hostId: target.executionContext.host,
    managed: target.executionContext.kind === "managed",
  };
}

async function edgeHealthyDefault(hostname: string): Promise<boolean> {
  try {
    const response = await fetch(`https://${hostname}/healthz`, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.status === 200;
  } catch {
    return false;
  }
}

async function ensureAwakeDefault(agentId: string): Promise<boolean> {
  const { ensureHivraAgentAwake } = await import("@/lib/hivra/agent-wake");
  const result = await ensureHivraAgentAwake(agentId, { trigger: "ingress", waitMs: 60_000 });
  return result.state === "awake";
}

export const DEFAULT_INGRESS_DEPS: IngressDeps = {
  env: process.env,
  readAgent: readHivraAgentRow,
  resolveTarget: resolveTargetFromRow,
  readHostRow: readHostRowFromDb,
  runHostScript: (script, env, options) => runProxmoxHostScript(script, env, options),
  runHostScriptWithStdin: (script, stdin, env, options) => runProxmoxHostScriptWithStdin(script, stdin, env, options),
  store: {
    read: readAgentIngressRow,
    ensure: ensureAgentIngressRow,
    claim: claimAgentIngressLease,
    update: updateAgentIngressUnderLease,
    release: releaseAgentIngressLease,
    listPorts: listHostMetricsPorts,
  },
  cf: {
    getToken: (tunnelId) => getBoxTunnelToken(tunnelId),
    listConnections: (tunnelId) => listTunnelConnections(tunnelId),
    rotateSecret: (tunnelId) => rotateTunnelSecret(tunnelId),
    deleteConnection: (tunnelId, clientId) => deleteTunnelConnection(tunnelId, clientId),
    getOrigin: (tunnelId, hostname) => getBoxTunnelOrigin(tunnelId, hostname),
    setOrigin: (tunnelId, hostname, service) => setBoxTunnelOrigin(tunnelId, hostname, service),
  },
  edgeHealthy: edgeHealthyDefault,
  ensureAwake: ensureAwakeDefault,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  newLeaseId: () => randomUUID(),
};

export function withDefaults(deps: Partial<IngressDeps> = {}): IngressDeps {
  return {
    ...DEFAULT_INGRESS_DEPS,
    ...deps,
    store: { ...DEFAULT_INGRESS_DEPS.store, ...(deps.store ?? {}) },
    cf: { ...DEFAULT_INGRESS_DEPS.cf, ...(deps.cf ?? {}) },
  };
}

export interface IngressStepRecord {
  step: string;
  ok: boolean;
  reason?: string;
  ms?: number;
}

export interface IngressRunResult {
  ok: boolean;
  agentId: string;
  /** What serves the agent's public address after this run. */
  mode: "guest" | "host" | "unknown";
  phase: string;
  already?: boolean;
  reason?: string;
  /** HTTP status for a refusal before anything changed. */
  httpStatus?: number;
  steps: IngressStepRecord[];
}

/** Why an agent cannot be moved, or null. Pure. */
export function ingressAgentRefusal(row: AgentRow): string | null {
  if (row.status !== "running" || (row.desired_state !== undefined && row.desired_state !== "running")) return "agent_not_running";
  if (row.operation_id) return "agent_busy";
  if (!isAgentAwake(row)) return "agent_asleep";
  if (row.computer_substrate != null && row.computer_substrate !== "proxmox-kvm") return "unsupported_substrate";
  if (typeof row.cf_tunnel_id !== "string" || typeof row.cf_hostname !== "string") return "no_named_tunnel";
  if (typeof row.ip !== "string" || !isPrivateGuestIp(row.ip)) return "guest_ip_unknown";
  return null;
}

const HOST_TIMEOUT_MS = 120_000;
const GUEST_TIMEOUT_MS = 280_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const LIST_ATTEMPTS = 15;
const LIST_INTERVAL_MS = 2_000;
const EDGE_CHECKS = 5;

function record(steps: IngressStepRecord[], step: IngressStepResult | IngressStepRecord) {
  steps.push({ step: step.step, ok: step.ok, ...(step.reason ? { reason: step.reason } : {}), ...(typeof step.ms === "number" ? { ms: step.ms } : {}) });
}

/** Runs a host script and reads its answer. A run with no answer is a failed step named after `name`. */
async function hostStep(
  deps: IngressDeps,
  target: IngressTarget,
  name: string,
  script: string,
  stdin: string | null,
  timeoutMs = HOST_TIMEOUT_MS,
): Promise<IngressStepResult> {
  try {
    const run = stdin === null
      ? await deps.runHostScript(script, target.env, { timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES })
      : await deps.runHostScriptWithStdin(script, stdin, target.env, { timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES });
    const parsed = parseIngressStep(run.stdout);
    if (parsed) return parsed;
    return { step: name, ok: false, reason: run.ok ? "no_answer" : "host_script_failed", ms: 0 };
  } catch {
    return { step: name, ok: false, reason: "host_script_threw", ms: 0 };
  }
}

/** Polls the edge until `accept` holds for the connector list. Returns the last list, or null if it never held. */
async function waitForConnectors(
  deps: IngressDeps,
  tunnelId: string,
  accept: (list: TunnelConnector[]) => boolean,
): Promise<TunnelConnector[] | null> {
  for (let attempt = 0; attempt < LIST_ATTEMPTS; attempt += 1) {
    try {
      const list = await deps.cf.listConnections(tunnelId);
      if (accept(list)) return list;
    } catch {
      // the next attempt reads again
    }
    if (attempt + 1 < LIST_ATTEMPTS) await deps.sleep(LIST_INTERVAL_MS);
  }
  return null;
}

async function edgeAllHealthy(deps: IngressDeps, hostname: string): Promise<boolean> {
  for (let index = 0; index < EDGE_CHECKS; index += 1) {
    if (!(await deps.edgeHealthy(hostname))) return false;
  }
  return true;
}

const live = (list: TunnelConnector[]) => list.filter((connector) => connector.connections > 0);

export interface IngressContext {
  agentId: string;
  row: AgentRow;
  target: IngressTarget;
  tunnelId: string;
  hostname: string;
  ingress: AgentIngressRow;
}

/** Loads the agent, its host, its ingress row; refuses unless every switch allows host ingress here. */
async function loadContext(
  agentId: string,
  deps: IngressDeps,
  options: { requireFlags: boolean; requireIdle: boolean },
): Promise<{ ok: true; context: IngressContext } | { ok: false; reason: string; httpStatus: number }> {
  let row: AgentRow | null;
  try {
    row = await deps.readAgent(agentId);
  } catch {
    return { ok: false, reason: "agent_unreadable", httpStatus: 503 };
  }
  if (!row) return { ok: false, reason: "not_found", httpStatus: 404 };
  if (options.requireIdle) {
    const refusal = ingressAgentRefusal(row);
    if (refusal) return { ok: false, reason: refusal, httpStatus: 409 };
  } else if (typeof row.cf_tunnel_id !== "string" || typeof row.cf_hostname !== "string") {
    return { ok: false, reason: "no_named_tunnel", httpStatus: 409 };
  }
  let target: IngressTarget | null;
  try {
    target = await deps.resolveTarget(row);
  } catch {
    target = null;
  }
  if (!target) return { ok: false, reason: "target_unavailable", httpStatus: 503 };
  if (!target.managed) return { ok: false, reason: "not_managed", httpStatus: 409 };
  if (!target.bindingTag) return { ok: false, reason: "binding_tag_missing", httpStatus: 409 };
  if (options.requireFlags) {
    let host: IngressHostRow | null;
    try {
      host = await deps.readHostRow(target.hostId);
    } catch {
      return { ok: false, reason: "host_unreadable", httpStatus: 503 };
    }
    if (!ingressHostAllowed(host, deps.env)) return { ok: false, reason: "ingress_off", httpStatus: 409 };
  }
  let ingress: AgentIngressRow | null;
  try {
    ingress = await deps.store.read(agentId);
    if (!ingress) {
      if (!options.requireFlags) return { ok: false, reason: "no_ingress_row", httpStatus: 404 };
      await deps.store.ensure({ agentId, vmid: target.vmid, hostId: target.hostId });
      ingress = await deps.store.read(agentId);
    }
  } catch {
    return { ok: false, reason: "ingress_unreadable", httpStatus: 503 };
  }
  if (!ingress) return { ok: false, reason: "ingress_unreadable", httpStatus: 503 };
  if (ingress.vmid !== target.vmid || ingress.host_id !== target.hostId) {
    // The computer moved since the row was written; a human looks first.
    return { ok: false, reason: "ingress_row_mismatch", httpStatus: 409 };
  }
  return {
    ok: true,
    context: {
      agentId,
      row,
      target,
      tunnelId: String(row.cf_tunnel_id).toLowerCase(),
      hostname: String(row.cf_hostname).toLowerCase(),
      ingress,
    },
  };
}

export { loadContext as loadIngressContext, hostStep as runIngressHostStep, waitForConnectors, edgeAllHealthy, record as recordIngressStep };

/**
 * Move one agent's public connector from its computer to the host. Safe to
 * call again: an agent already in host mode answers already.
 */
export async function enableHostIngress(agentId: string, partialDeps: Partial<IngressDeps> = {}): Promise<IngressRunResult> {
  const deps = withDefaults(partialDeps);
  const steps: IngressStepRecord[] = [];
  const refuse = (reason: string, httpStatus: number, mode: IngressRunResult["mode"] = "guest", phase = "none"): IngressRunResult =>
    ({ ok: false, agentId, mode, phase, reason, httpStatus, steps });

  const secret = resolveIngressSecret(deps.env);
  if (!secret) return refuse("ingress_secret_missing", 409);
  const loaded = await loadContext(agentId, deps, { requireFlags: true, requireIdle: true });
  if (!loaded.ok) return refuse(loaded.reason, loaded.httpStatus);
  const { target, tunnelId, hostname, ingress } = loaded.context;
  const currentMode = parseAgentIngressMode(ingress.mode);
  if (currentMode === "host" && ingress.phase === "cutover") {
    return { ok: true, agentId, mode: "host", phase: "cutover", already: true, steps };
  }
  if (currentMode !== "guest") return refuse("ingress_row_not_guest", 409, "unknown", ingress.phase);

  const leaseId = deps.newLeaseId();
  let claimed = false;
  try {
    claimed = await deps.store.claim({ agentId, leaseId });
  } catch {
    return refuse("lease_unavailable", 503);
  }
  if (!claimed) return refuse("lease_held", 409);

  const finish = async (result: IngressRunResult, patch: IngressPatch): Promise<IngressRunResult> => {
    const released = await deps.store.release({ agentId, leaseId, patch });
    if (!released) {
      log.warn("host ingress finished but its lease was gone", { source: LOG_SOURCE, agentId, phase: result.phase });
    }
    log.info("host ingress enable finished", {
      source: LOG_SOURCE, agentId, ok: result.ok, mode: result.mode, phase: result.phase, reason: result.reason,
    });
    return result;
  };
  const phase = (patch: IngressPatch) => deps.store.update({ agentId, leaseId, patch });

  // 1. Preflight: nothing changes yet.
  const preflight = await hostStep(deps, target, "preflight", buildIngressPreflightScript(target), null);
  record(steps, preflight);
  if (!preflight.ok) {
    return finish({ ok: false, agentId, mode: "guest", phase: "failed", reason: preflight.reason, steps },
      { phase: "failed", last_error: preflight.reason ?? "preflight_failed" });
  }
  let guestConnectors: TunnelConnector[];
  try {
    const origin = await deps.cf.getOrigin(tunnelId, hostname);
    if (origin !== "http://localhost:8080" && origin !== "http://127.0.0.1:8080") {
      record(steps, { step: "preflight_origin", ok: false, reason: "origin_unexpected" });
      return finish({ ok: false, agentId, mode: "guest", phase: "failed", reason: "origin_unexpected", steps },
        { phase: "failed", last_error: "origin_unexpected" });
    }
    guestConnectors = live(await deps.cf.listConnections(tunnelId));
  } catch {
    record(steps, { step: "preflight_edge", ok: false, reason: "edge_unreadable" });
    return finish({ ok: false, agentId, mode: "guest", phase: "failed", reason: "edge_unreadable", steps },
      { phase: "failed", last_error: "edge_unreadable" });
  }
  if (guestConnectors.length === 0) {
    record(steps, { step: "preflight_edge", ok: false, reason: "no_guest_connector" });
    return finish({ ok: false, agentId, mode: "guest", phase: "failed", reason: "no_guest_connector", steps },
      { phase: "failed", last_error: "no_guest_connector" });
  }
  const guestIds = new Set(guestConnectors.map((connector) => connector.clientId));

  // 2. Guest forwarder: a host-only listener in the guest. Harmless if left.
  let forwarderOk = false;
  try {
    const run = await deps.runHostScript(buildGuestForwarderHostScript(target, "install"), target.env,
      { timeoutMs: HOST_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES });
    const parsed = parseGuestForwarderOutput(run.stdout);
    forwarderOk = Boolean(parsed && !parsed.refused && parsed.ok);
    record(steps, { step: "forwarder", ok: forwarderOk, ...(forwarderOk ? {} : { reason: parsed?.refused || (parsed && !parsed.ok) ? (parsed.reason ?? "refused") : "no_answer" }) });
  } catch {
    record(steps, { step: "forwarder", ok: false, reason: "host_script_threw" });
  }
  if (!forwarderOk) {
    return finish({ ok: false, agentId, mode: "guest", phase: "failed", reason: "forwarder_failed", steps },
      { phase: "failed", last_error: "forwarder_failed" });
  }
  const generation = Number(ingress.generation ?? 0) + 1;
  let metricsPort: number | null;
  try {
    metricsPort = pickMetricsPort(await deps.store.listPorts(target.hostId, agentId), ingress.metrics_port);
  } catch {
    metricsPort = null;
  }
  if (metricsPort === null) {
    return finish({ ok: false, agentId, mode: "guest", phase: "failed", reason: "metrics_port_unavailable", steps },
      { phase: "failed", last_error: "metrics_port_unavailable" });
  }
  if (!(await phase({ phase: "forwarder", generation, metrics_port: metricsPort, last_error: null }))) {
    return finish({ ok: false, agentId, mode: "guest", phase: "failed", reason: "lease_lost", steps }, {});
  }

  // 3. Origin: http://127.0.0.1:8080 serves from the guest and from the host proxy alike.
  try {
    await deps.cf.setOrigin(tunnelId, hostname, "http://127.0.0.1:8080");
    record(steps, { step: "origin", ok: true });
  } catch {
    record(steps, { step: "origin", ok: false, reason: "origin_write_failed" });
    return finish({ ok: false, agentId, mode: "guest", phase: "failed", reason: "origin_write_failed", steps },
      { phase: "failed", last_error: "origin_write_failed" });
  }

  // Whether the host connector runs (the attach script removes its own work when it fails).
  let hostAttached = false;

  // 4. Rotate. From here on a failure must give the guest the new token back.
  let token: string;
  try {
    await deps.cf.rotateSecret(tunnelId);
    token = await deps.cf.getToken(tunnelId);
    record(steps, { step: "rotate", ok: true });
  } catch {
    record(steps, { step: "rotate", ok: false, reason: "rotate_failed" });
    // The secret may or may not have moved on: recover as if it had.
    return recover("rotate_failed", null);
  }

  // 5. Host side.
  const route = buildIngressRoute({
    vmid: target.vmid,
    hostname,
    bindingTag: target.bindingTag as string,
    guestIp: String(loaded.context.row.ip),
    ticketKey: deriveIngressTicketKey({ secret, agentId, tunnelId, generation }),
    generation,
    bearerSha256: ingressBearerSha256(loaded.context.row.api_token),
    wakeUrl: ingressWakeUrl(agentId, deps.env),
  });
  const attach = await hostStep(deps, target, "attach",
    buildIngressAttachScript({ vmid: target.vmid, bindingTag: target.bindingTag, hostname, guestIp: route.guest_ip, metricsPort }),
    buildIngressAttachPayload({ route, token, metricsPort }));
  record(steps, attach);
  if (!attach.ok) return recover(attach.reason ?? "attach_failed", token);
  hostAttached = true;
  if (!(await phase({ phase: "host_connector" }))) return recover("lease_lost", token);

  // 6. The host connector is at the edge.
  const withHost = await waitForConnectors(deps, tunnelId, (list) => live(list).some((c) => !guestIds.has(c.clientId)));
  record(steps, { step: "host_listed", ok: Boolean(withHost), ...(withHost ? {} : { reason: "host_connector_not_listed" }) });
  if (!withHost) return recover("host_connector_not_listed", token);
  const hostIds = new Set(live(withHost).filter((c) => !guestIds.has(c.clientId)).map((c) => c.clientId));

  // 7. Guest connector off, its (now stale) token file deleted.
  const guestOff = await hostStep(deps, target, "guest_disable",
    buildIngressGuestTunnelScript({ vmid: target.vmid, bindingTag: target.bindingTag, op: "disable" }), null, GUEST_TIMEOUT_MS);
  record(steps, guestOff);
  if (!guestOff.ok) return recover(guestOff.reason ?? "guest_disable_failed", token);

  // 8. Evict whatever the guest left at the edge.
  for (const clientId of guestIds) {
    try {
      await deps.cf.deleteConnection(tunnelId, clientId);
    } catch {
      // checked below
    }
  }

  // 9. Only the host connector, and the public address answers through it.
  const onlyHost = await waitForConnectors(deps, tunnelId, (list) => {
    const current = live(list);
    return current.length > 0 && current.every((c) => hostIds.has(c.clientId));
  });
  record(steps, { step: "only_host_listed", ok: Boolean(onlyHost), ...(onlyHost ? {} : { reason: "guest_connector_still_listed" }) });
  if (!onlyHost) return recover("guest_connector_still_listed", token);
  const healthy = await edgeAllHealthy(deps, hostname);
  record(steps, { step: "edge_healthz", ok: healthy, ...(healthy ? {} : { reason: "edge_unhealthy" }) });
  if (!healthy) return recover("edge_unhealthy", token);

  return finish({ ok: true, agentId, mode: "host", phase: "cutover", steps },
    { mode: "host", phase: "cutover", last_error: null });

  /**
   * Put the guest back in charge. The guest connector comes back first (with
   * the current token); only once it is listed does the host side go.
   */
  async function recover(reason: string, knownToken: string | null): Promise<IngressRunResult> {
    let current = knownToken;
    if (!current) {
      try {
        current = await deps.cf.getToken(tunnelId);
      } catch {
        current = null;
      }
    }
    const before = await deps.cf.listConnections(tunnelId).then(live).catch(() => [] as TunnelConnector[]);
    const knownIds = new Set(before.map((c) => c.clientId));
    let guestBack = false;
    if (current) {
      const guestOn = await hostStep(deps, target, "guest_enable",
        buildIngressGuestTunnelScript({ vmid: target.vmid, bindingTag: target.bindingTag, op: "enable" }),
        buildGuestTokenPayload(current), GUEST_TIMEOUT_MS);
      record(steps, guestOn);
      if (guestOn.ok) {
        // A guest connector that never went away (rotate failed early) counts too.
        const listed = await waitForConnectors(deps, tunnelId,
          (list) => live(list).some((c) => !knownIds.has(c.clientId) || guestIds.has(c.clientId)));
        guestBack = Boolean(listed);
        record(steps, { step: "guest_listed", ok: guestBack, ...(guestBack ? {} : { reason: "guest_connector_not_listed" }) });
      }
    } else {
      record(steps, { step: "guest_enable", ok: false, reason: "token_unavailable" });
    }
    if (!guestBack) {
      // Leave the host side exactly as it is: it may be the only way in. When
      // it never came up, the guest's old connections are all that serve, and
      // they stop on their next reconnect: an operator must look now.
      const servingMode = hostAttached ? "host" : "guest";
      log.error("host ingress enable could not hand the agent back to its computer", new Error(reason), {
        source: LOG_SOURCE, agentId, failureType: "hivra_ingress_recovery_failed", servingMode,
      });
      return finish({ ok: false, agentId, mode: servingMode, phase: "failed", reason, steps },
        { mode: servingMode, phase: "failed", last_error: "recovery_failed" });
    }
    const detach = await hostStep(deps, target, "detach", buildIngressDetachScript({ vmid: target.vmid, hostname }), null);
    record(steps, detach);
    await deps.cf.setOrigin(tunnelId, hostname, "http://localhost:8080").catch(() => undefined);
    return finish({ ok: false, agentId, mode: "guest", phase: "failed", reason, steps },
      { mode: "guest", phase: "failed", last_error: detach.ok ? truncateReason(reason) : "detach_failed" });
  }
}

/** last_error must match ^[a-z_]{1,40}$. */
export function truncateReason(reason: string): string {
  const clean = String(reason).replace(/[^a-z_]/g, "_").slice(0, 40);
  return clean || "failed";
}
