import "server-only";

// Put an agent's public connector back into its computer (the way it was
// before host ingress), and clean the host side up when an agent is deleted.
//
// Rollback, under the agent's ingress lease:
//   1. Wake the agent (a napping computer cannot start its connector).
//   2. Write the token the host connector runs on into the guest.
//   3. Turn the guest connector on and wait until the edge lists it.
//   4. Point the origin back at http://localhost:8080.
//   5. Stop the host connector, remove its env and route files, the ARP/IP pin
//      and the nft chain; evict the host connector at the edge.
//   6. Only then rotate the tunnel secret and hand the guest the new token.
//   7. Record mode guest, phase rolled_back.
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
  type IngressTarget,
  type IngressStepRecord,
} from "@/lib/hivra/ingress/enable";
import { deleteAgentIngressRow, readAgentIngressRow } from "@/lib/hivra/ingress/store";
import { agentIngressStateFrom, hostIngressConfigured } from "@/lib/hivra/ingress/wake-client";
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
    // A cutover left half done (an enable cut short, a recovery or an earlier
    // rollback that could not hand the guest a working token): the guest's
    // connector may be off or on a revoked secret. Give it the current token
    // first; the host side goes only once the guest has it.
    if (agentIngressStateFrom(ingress, null, { vmid: target.vmid, hostId: target.hostId, env: deps.env }).interrupted) {
      const awake = await deps.ensureAwake(agentId).catch(() => false);
      const before = new Set(await deps.cf.listConnections(tunnelId).then(live).then((l) => l.map((c) => c.clientId)).catch(() => [] as string[]));
      // A fresh connector (the guest's restarted one) must be at the edge before the host side may go.
      const handed = awake && await handTokenToGuest(deps, target, tunnelId, steps)
        && Boolean(await waitForConnectors(deps, tunnelId, (list) => live(list).some((c) => !before.has(c.clientId))));
      if (!handed) {
        recordIngressStep(steps, { step: "guest_token", ok: false, reason: awake ? "guest_token_failed" : "wake_failed" });
        return finish({ ok: false, agentId, mode: "guest", phase: "failed", reason: GUEST_TOKEN_STALE, steps },
          { phase: "failed", last_error: GUEST_TOKEN_STALE });
      }
    }
    // Only the host side can be left over (a failed enable or detach). Clean it.
    const detach = await runIngressHostStep(deps, target, "detach", buildIngressDetachScript({ vmid: target.vmid, hostname }), null);
    recordIngressStep(steps, detach);
    return finish(
      { ok: detach.ok, agentId, mode: "guest", phase: detach.ok ? "rolled_back" : "failed", already: detach.ok, ...(detach.ok ? {} : { reason: detach.reason }), steps },
      detach.ok ? { phase: "rolled_back", last_error: null } : { phase: "failed", last_error: truncateReason(detach.reason ?? "detach_failed") },
    );
  }

  // Before each long step the lease is renewed, so a slow rollback never runs past it.
  const renew = () => deps.store.update({ agentId, leaseId, patch: {} }).catch(() => false);

  // 1. Awake.
  const awake = await deps.ensureAwake(agentId).catch(() => false);
  recordIngressStep(steps, { step: "wake", ok: awake, ...(awake ? {} : { reason: "wake_failed" }) });
  if (!awake) {
    return finish({ ok: false, agentId, mode: "host", phase: ingress.phase, reason: "wake_failed", steps }, { last_error: "rollback_wake_failed" });
  }

  // 2-3. Guest connector back, on the token the host connector runs now. The
  // secret only rotates once the host side is gone (step 6): rotating first
  // would leave the host connector, if the guest never came back, on a
  // revoked secret it could not reconnect with.
  let hostIds = new Set<string>();
  try {
    hostIds = new Set(live(await deps.cf.listConnections(tunnelId)).map((c) => c.clientId));
  } catch {
    // An unreadable edge only means the host connector is not evicted by id below.
  }
  let current: string;
  try {
    current = await deps.cf.getToken(tunnelId);
  } catch {
    recordIngressStep(steps, { step: "guest_enable", ok: false, reason: "token_unavailable" });
    return finish({ ok: false, agentId, mode: "host", phase: "failed", reason: "token_unavailable", steps },
      { phase: "failed", last_error: "rollback_token_failed" });
  }
  await renew();
  const guestOn: IngressStepResult = await runIngressHostStep(deps, target, "guest_enable",
    buildIngressGuestTunnelScript({ vmid: target.vmid, bindingTag: target.bindingTag, op: "enable" }),
    buildGuestTokenPayload(current), GUEST_TIMEOUT_MS);
  recordIngressStep(steps, guestOn);
  const guestListed = guestOn.ok
    ? await waitForConnectors(deps, tunnelId, (list) => live(list).some((c) => !hostIds.has(c.clientId)))
    : null;
  if (guestOn.ok) recordIngressStep(steps, { step: "guest_listed", ok: Boolean(guestListed), ...(guestListed ? {} : { reason: "guest_connector_not_listed" }) });
  if (!guestListed) {
    // The host keeps serving on the secret it has; nothing on the host is touched.
    return finish({ ok: false, agentId, mode: "host", phase: "failed", reason: guestOn.reason ?? "guest_connector_not_listed", steps },
      { phase: "failed", last_error: "rollback_guest_failed" });
  }

  // 4. Origin back to how the tunnel was created.
  await deps.cf.setOrigin(tunnelId, hostname, "http://localhost:8080")
    .then(() => recordIngressStep(steps, { step: "origin", ok: true }))
    .catch(() => recordIngressStep(steps, { step: "origin", ok: false, reason: "origin_write_failed" }));

  await renew();
  // 5. Host side off.
  const detach = await runIngressHostStep(deps, target, "detach", buildIngressDetachScript({ vmid: target.vmid, hostname }), null);
  recordIngressStep(steps, detach);
  for (const clientId of hostIds) {
    await deps.cf.deleteConnection(tunnelId, clientId).catch(() => undefined);
  }

  // The guest serves from here on, whatever the host cleanup said.
  const generation = Number(ingress.generation ?? 0) + 1;
  if (!detach.ok) {
    // The host connector may still run on the current secret: no rotation, so both sides keep working.
    const healthy = await edgeAllHealthy(deps, hostname);
    recordIngressStep(steps, { step: "edge_healthz", ok: healthy, ...(healthy ? {} : { reason: "edge_unhealthy" }) });
    return finish({ ok: false, agentId, mode: "guest", phase: "failed", reason: detach.reason ?? "detach_failed", steps },
      { mode: "guest", phase: "failed", generation, last_error: "detach_failed" });
  }

  await renew();
  // 6. Now that only the guest holds it, a fresh secret, handed to the guest.
  const handed = await rotateIntoGuest(deps, target, tunnelId, steps);
  const healthy = await edgeAllHealthy(deps, hostname);
  recordIngressStep(steps, { step: "edge_healthz", ok: healthy, ...(healthy ? {} : { reason: "edge_unhealthy" }) });
  if (handed === "stale") {
    // The guest runs on a revoked secret: its live connections serve until they
    // reconnect. Kept awake (an interrupted row) until a rollback hands it the token.
    return finish({ ok: false, agentId, mode: "guest", phase: "failed", reason: "guest_token_stale", steps },
      { mode: "guest", phase: "failed", generation, last_error: GUEST_TOKEN_STALE });
  }
  return finish({ ok: true, agentId, mode: "guest", phase: "rolled_back", steps },
    { mode: "guest", phase: "rolled_back", generation, last_error: handed === "unrotated" ? "rollback_rotate_failed" : healthy ? null : "edge_unhealthy" });
}

/** last_error of a rollback that rotated the secret but could not hand the new token to the guest. */
export const GUEST_TOKEN_STALE = "guest_token_stale";

/**
 * Rotate the tunnel secret and give the guest the new token. "unrotated" when
 * the rotation call failed (the guest was handed whatever the token is now),
 * "stale" when the guest could not take the token.
 */
async function rotateIntoGuest(
  deps: IngressDeps,
  target: IngressTarget,
  tunnelId: string,
  steps: IngressStepRecord[],
): Promise<"handed" | "unrotated" | "stale"> {
  let rotated = true;
  try {
    await deps.cf.rotateSecret(tunnelId);
    recordIngressStep(steps, { step: "rotate", ok: true });
  } catch {
    // A failed rotation may still have happened: hand over whatever the token is now.
    rotated = false;
    recordIngressStep(steps, { step: "rotate", ok: false, reason: "rotate_failed" });
  }
  if (!(await handTokenToGuest(deps, target, tunnelId, steps))) return "stale";
  return rotated ? "handed" : "unrotated";
}

/** Writes the tunnel's current token into the guest and restarts its connector. Two tries. */
async function handTokenToGuest(
  deps: IngressDeps,
  target: IngressTarget,
  tunnelId: string,
  steps: IngressStepRecord[],
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let token: string;
    try {
      token = await deps.cf.getToken(tunnelId);
    } catch {
      recordIngressStep(steps, { step: "guest_token", ok: false, reason: "token_unavailable" });
      continue;
    }
    const step = await runIngressHostStep(deps, target, "guest_token",
      buildIngressGuestTunnelScript({ vmid: target.vmid, bindingTag: target.bindingTag, op: "enable" }),
      buildGuestTokenPayload(token), GUEST_TIMEOUT_MS);
    recordIngressStep(steps, { ...step, step: "guest_token" });
    if (step.ok) return true;
  }
  return false;
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
 * nothing when host ingress was never configured here, and one read for an
 * agent that never used it.
 */
export async function releaseHostIngressOnDelete(input: { agentId: string; hostname: string | null }, deps: {
  read?: typeof readAgentIngressRow;
  remove?: typeof deleteAgentIngressRow;
  runDetach?: (hostId: string, vmid: number, hostname: string) => Promise<boolean>;
  env?: Record<string, string | undefined>;
} = {}): Promise<void> {
  // Never configured here: nothing to read, exactly as before host ingress.
  if (!hostIngressConfigured(deps.env ?? process.env)) return;
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
