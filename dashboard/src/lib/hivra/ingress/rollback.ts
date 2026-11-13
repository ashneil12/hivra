import "server-only";

// Put an agent's public connector back into its computer (the way it was
// before host ingress), and clean the host side up when an agent is deleted.
//
// Rollback, under the agent's ingress lease:
//   1. Wake the agent (a napping computer cannot start its connector).
//   2. Rotate the tunnel secret and write the new token into the guest.
//   3. Turn the guest connector on and wait until the edge lists it.
//   4. Point the origin back at http://localhost:8080.
//   5. Stop the host connector, remove its env and route files, the ARP/IP pin
//      and the nft chain; evict the host connector at the edge.
//   6. Record mode guest, phase rolled_back.
// Idempotent: a guest-mode agent only gets step 5 again, which does nothing
// when nothing is there. Fail toward awake: the host side is only removed once
// the guest connector is listed; until then the host keeps serving.

import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";
import { parseAgentIngressMode } from "@/lib/hivra/ingress/config";
import {
  buildIngressDetachScript,
  buildIngressGuestTunnelScript,
  buildIngressStatusScript,
  type IngressStepResult,
} from "@/lib/hivra/ingress/cutover-scripts";
import { buildGuestTokenPayload } from "@/lib/hivra/ingress/route-file";
import {
  edgeAllHealthy,
  loadIngressContext,
  recordIngressStep,
  runIngressHostStep,
  truncateReason,
  waitForConnectors,
  withDefaults,
  type IngressDeps,
  type IngressRunResult,
  type IngressStepRecord,
} from "@/lib/hivra/ingress/enable";
import { deleteAgentIngressRow, readAgentIngressRow } from "@/lib/hivra/ingress/store";
import type { TunnelConnector } from "@/lib/services/cloudflare-tunnel";

const LOG_SOURCE = "hivra-ingress";
const GUEST_TIMEOUT_MS = 280_000;

const live = (list: TunnelConnector[]) => list.filter((connector) => connector.connections > 0);

/**
 * Hand the agent's public address back to its computer. Needs no flag: this
 * is the way back, and it must work with every switch off.
 */
export async function rollbackHostIngress(agentId: string, partialDeps: Partial<IngressDeps> = {}): Promise<IngressRunResult> {
  const deps = withDefaults(partialDeps);
  const steps: IngressStepRecord[] = [];
  const loaded = await loadIngressContext(agentId, deps, { requireFlags: false, requireIdle: false });
  if (!loaded.ok) {
    if (loaded.reason === "no_ingress_row") return { ok: true, agentId, mode: "guest", phase: "none", already: true, steps };
    return { ok: false, agentId, mode: "unknown", phase: "unknown", reason: loaded.reason, httpStatus: loaded.httpStatus, steps };
  }
  const { target, tunnelId, hostname, ingress } = loaded.context;
  const mode = parseAgentIngressMode(ingress.mode);

  const leaseId = deps.newLeaseId();
  let claimed = false;
  try {
    claimed = await deps.store.claim({ agentId, leaseId });
  } catch {
    claimed = false;
  }
  if (!claimed) return { ok: false, agentId, mode: mode ?? "unknown", phase: ingress.phase, reason: "lease_held", httpStatus: 409, steps };
  const finish = async (result: IngressRunResult, patch: Parameters<IngressDeps["store"]["release"]>[0]["patch"]) => {
    await deps.store.release({ agentId, leaseId, patch });
    log.info("host ingress rollback finished", {
      source: LOG_SOURCE, agentId, ok: result.ok, mode: result.mode, phase: result.phase, reason: result.reason,
    });
    return result;
  };

  if (mode === "guest") {
    // Only the host side can be left over (a failed enable or detach). Clean it.
    const detach = await runIngressHostStep(deps, target, "detach", buildIngressDetachScript({ vmid: target.vmid, hostname }), null);
    recordIngressStep(steps, detach);
    return finish(
      { ok: detach.ok, agentId, mode: "guest", phase: detach.ok ? "rolled_back" : "failed", already: detach.ok, ...(detach.ok ? {} : { reason: detach.reason }), steps },
      detach.ok ? { phase: "rolled_back", last_error: null } : { phase: "failed", last_error: truncateReason(detach.reason ?? "detach_failed") },
    );
  }

  // 1. Awake.
  const awake = await deps.ensureAwake(agentId).catch(() => false);
  recordIngressStep(steps, { step: "wake", ok: awake, ...(awake ? {} : { reason: "wake_failed" }) });
  if (!awake) {
    return finish({ ok: false, agentId, mode: "host", phase: ingress.phase, reason: "wake_failed", steps }, { last_error: "rollback_wake_failed" });
  }

  // 2-3. Guest connector back with a fresh secret.
  let hostIds = new Set<string>();
  try {
    hostIds = new Set(live(await deps.cf.listConnections(tunnelId)).map((c) => c.clientId));
  } catch {
    // An unreadable edge only means the host connector is not evicted by id below.
  }
  let token: string;
  try {
    await deps.cf.rotateSecret(tunnelId);
    token = await deps.cf.getToken(tunnelId);
    recordIngressStep(steps, { step: "rotate", ok: true });
  } catch {
    recordIngressStep(steps, { step: "rotate", ok: false, reason: "rotate_failed" });
    return finish({ ok: false, agentId, mode: "host", phase: "failed", reason: "rotate_failed", steps },
      { phase: "failed", last_error: "rollback_rotate_failed" });
  }
  const guestOn: IngressStepResult = await runIngressHostStep(deps, target, "guest_enable",
    buildIngressGuestTunnelScript({ vmid: target.vmid, bindingTag: target.bindingTag, op: "enable" }),
    buildGuestTokenPayload(token), GUEST_TIMEOUT_MS);
  recordIngressStep(steps, guestOn);
  const guestListed = guestOn.ok
    ? await waitForConnectors(deps, tunnelId, (list) => live(list).some((c) => !hostIds.has(c.clientId)))
    : null;
  if (guestOn.ok) recordIngressStep(steps, { step: "guest_listed", ok: Boolean(guestListed), ...(guestListed ? {} : { reason: "guest_connector_not_listed" }) });
  if (!guestListed) {
    // The host keeps serving; nothing on the host is touched.
    return finish({ ok: false, agentId, mode: "host", phase: "failed", reason: guestOn.reason ?? "guest_connector_not_listed", steps },
      { phase: "failed", last_error: "rollback_guest_failed" });
  }

  // 4. Origin back to how the tunnel was created.
  await deps.cf.setOrigin(tunnelId, hostname, "http://localhost:8080")
    .then(() => recordIngressStep(steps, { step: "origin", ok: true }))
    .catch(() => recordIngressStep(steps, { step: "origin", ok: false, reason: "origin_write_failed" }));

  // 5. Host side off.
  const detach = await runIngressHostStep(deps, target, "detach", buildIngressDetachScript({ vmid: target.vmid, hostname }), null);
  recordIngressStep(steps, detach);
  for (const clientId of hostIds) {
    await deps.cf.deleteConnection(tunnelId, clientId).catch(() => undefined);
  }
  const healthy = await edgeAllHealthy(deps, hostname);
  recordIngressStep(steps, { step: "edge_healthz", ok: healthy, ...(healthy ? {} : { reason: "edge_unhealthy" }) });

  // The guest serves from here on, whatever the host cleanup said.
  const generation = Number(ingress.generation ?? 0) + 1;
  if (!detach.ok) {
    return finish({ ok: false, agentId, mode: "guest", phase: "failed", reason: detach.reason ?? "detach_failed", steps },
      { mode: "guest", phase: "failed", generation, last_error: "detach_failed" });
  }
  return finish({ ok: true, agentId, mode: "guest", phase: "rolled_back", steps },
    { mode: "guest", phase: "rolled_back", generation, last_error: healthy ? null : "edge_unhealthy" });
}

export interface IngressStatus {
  agentId: string;
  row: { mode: string; phase: string; generation: number; metrics_port: number | null; last_error: string | null; leased: boolean } | null;
  host: IngressStepResult | null;
  connectors: number | null;
}

/** Read-only view: the ingress row, the host's files and units, the edge's connector count. Never returns a token. */
export async function readHostIngressStatus(agentId: string, partialDeps: Partial<IngressDeps> = {}): Promise<IngressStatus | { error: string; httpStatus: number }> {
  const deps = withDefaults(partialDeps);
  const loaded = await loadIngressContext(agentId, deps, { requireFlags: false, requireIdle: false });
  if (!loaded.ok) {
    if (loaded.reason === "no_ingress_row") return { agentId, row: null, host: null, connectors: null };
    return { error: loaded.reason, httpStatus: loaded.httpStatus };
  }
  const { target, tunnelId, ingress } = loaded.context;
  const host = await runIngressHostStep(deps, target, "status",
    buildIngressStatusScript({ vmid: target.vmid, metricsPort: ingress.metrics_port ?? null }), null);
  const connectors = await deps.cf.listConnections(tunnelId).then((list) => live(list).length).catch(() => null);
  return {
    agentId,
    row: {
      mode: String(ingress.mode),
      phase: String(ingress.phase),
      generation: Number(ingress.generation ?? 0),
      metrics_port: ingress.metrics_port ?? null,
      last_error: ingress.last_error ?? null,
      leased: Boolean(ingress.lease_id),
    },
    host,
    connectors,
  };
}

/**
 * Delete path: stop the agent's host connector and remove its host files,
 * pin and route before the tunnel itself is deleted. Best effort and never
 * throws: once the tunnel is gone a leftover file cannot reach anything. Does
 * nothing (one read) for an agent that never used host ingress.
 */
export async function releaseHostIngressOnDelete(input: { agentId: string; hostname: string | null }, deps: {
  read?: typeof readAgentIngressRow;
  remove?: typeof deleteAgentIngressRow;
  runDetach?: (hostId: string, vmid: number, hostname: string) => Promise<boolean>;
} = {}): Promise<void> {
  const read = deps.read ?? readAgentIngressRow;
  const remove = deps.remove ?? deleteAgentIngressRow;
  const runDetach = deps.runDetach ?? detachOnHost;
  try {
    if (!supabaseAdmin && !deps.read) return;
    const row = await read(input.agentId);
    // Only a well-formed row for exactly this agent names a host side to remove.
    if (!row || row.agent_id !== input.agentId || typeof row.host_id !== "string" || !Number.isSafeInteger(row.vmid)) return;
    if (!input.hostname) {
      log.warn("host ingress cleanup skipped: the agent has no hostname to match", { source: LOG_SOURCE, agentId: input.agentId });
      return;
    }
    const removed = await runDetach(row.host_id, row.vmid, input.hostname.toLowerCase());
    if (removed) {
      await remove(input.agentId);
    } else {
      log.warn("host ingress cleanup on delete did not finish", {
        source: LOG_SOURCE, agentId: input.agentId, failureType: "hivra_ingress_delete_cleanup_incomplete",
      });
    }
  } catch (error) {
    log.warn("host ingress cleanup on delete failed", {
      source: LOG_SOURCE, agentId: input.agentId, error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function detachOnHost(hostId: string, vmid: number, hostname: string): Promise<boolean> {
  const { resolveProxmoxTargetConfiguration, runProxmoxHostScript } = await import("@/lib/services/proxmox-instance-service");
  const { parseIngressStep } = await import("@/lib/hivra/ingress/cutover-scripts");
  const candidate = resolveProxmoxTargetConfiguration(process.env, hostId);
  const run = await runProxmoxHostScript(buildIngressDetachScript({ vmid, hostname }), candidate.env,
    { timeoutMs: 120_000, maxOutputBytes: 64 * 1024 });
  return parseIngressStep(run.stdout)?.ok === true;
}
