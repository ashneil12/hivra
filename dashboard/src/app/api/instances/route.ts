export const runtime = "nodejs";

// Provisioning a Proxmox VM end-to-end (qm clone → qm start → SSH-ready
// poll → in-VM apt install + docker pull + agent setup) realistically
// takes 3-7 minutes. Without this explicit cap, Vercel's default function
// timeout (60s on Pro, 10s on Hobby) kills the request mid-bootstrap and
// leaves the DB row stuck at status='provisioning' with the VM half-built.
// 300s is the Vercel Pro maximum; if a bootstrap genuinely needs more
// time, the right fix is async/background provisioning (out of scope for
// the warden-mvp branch).
export const maxDuration = 300;

import { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { getHetznerInstanceStatus } from "@/lib/services/hetzner-instance-service";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { getPublicInstanceConfig } from "@/lib/instance-settings";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { InstanceService, CreateInstanceSchema } from "@/lib/services/instance-service";
import { decryptApiKey } from "@/lib/crypto";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import {
  getLatestInstanceFailureAlerts,
  suppressFailureAlertsResolvedByLifecycle,
} from "@/lib/instance-failure-alerts";
import { getOpenPendingPrompts } from "@/lib/instance-pending-prompts";
import { getLatestFailedInstanceUpdateAlerts } from "@/lib/update-alerts";
import {
  getProxmoxInfrastructure,
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInstanceStatus,
  getProxmoxInstanceStatusBatch,
  stripProxmoxInfrastructure,
  type ProxmoxInstanceStatus,
} from "@/lib/services/proxmox-instance-service";
import { checkProvisioningGate } from "@/lib/abuse/gate";
import { getRequestContext, type RequestContext } from "@/lib/request-context";
import {
  buildInstanceLifecyclePatch,
  getLifecycleStateForStatus,
} from "@/lib/instance-lifecycle";
import { isWebfreeBackend } from "@/lib/types/instance";
import { scheduleSoulSeedReconcileAfterResponse } from "@/lib/recovery/soul-seed-reconcile";
import { scheduleAgentReadyPushAfterResponse } from "@/lib/push/agent-ready-push";
import { recoverProxmoxInstanceAcrossFleet } from "@/lib/recovery/recover-orphan-provisioning";

interface InstanceRow {
  id: string;
  name: string;
  status: string;
  provider: string;
  subdomain?: string;
  hetzner_server_id?: number;
  gateway_url?: string;
  api_server_key_encrypted?: string;
  api_key_preview?: string;
  config?: Record<string, unknown>;
  host_id?: string;
  cpu_limit?: number;
  ram_limit?: number;
  ipv4_address?: string;
  created_at: string;
  updated_at?: string;
  /** First observed agent session (write-once, stamped by the usage harvest cron). */
  first_usage_at?: string | null;
  last_lifecycle_transition_at?: string | null;
  backend?: string | null;
  infrastructure_provider?: string | null;
  lifecycle_state?: string | null;
  paused_reason?: string | null;
  entitlement_state?: string | null;
  entitlement_reason?: string | null;
  entitlement_grace_started_at?: string | null;
  entitlement_grace_ends_at?: string | null;
  entitlement_suspended_at?: string | null;
}

function buildReadinessProbeOptions(params: {
  backend?: string | null;
  apiServerKey?: string | null;
}) {
  // Modern webfree box (backend='gateway'): probe the CHAT lane, not the
  // dashboard shell. The box Caddyfile routes '/health' to the
  // official-dashboard web server only, which comes up seconds (idle canary)
  // to minutes (loaded prod host) BEFORE the gateway api_server that actually
  // answers chat — measured on a fresh canary box 2026-07-10 (audit run
  // fixturecase04): '/health' 200'd and the row flipped 'running' 8s before the
  // box accepted its first WS upgrade; prod run fixturecase05 showed the same gap
  // stretched past 190s, so a new user's workspace painted while their first
  // message died. '/api/sessions' with the instance bearer traverses
  // caddy → dashboard-sidecar → official-dashboard → gateway and flips 200
  // in the same probe window as the WS upgrade, so 'running' (and the
  // workspace it unlocks) means "you can chat". Keyless rows keep the legacy
  // '/health' probe rather than never promoting (fail-open; the apiServerKey
  // self-heal backfills the key). Legacy backend='webui' boxes don't serve
  // the sessions route and keep '/health' too.
  if (params.backend === "gateway" && params.apiServerKey) {
    return {
      pathname: "/api/sessions",
      headers: {
        Authorization: `Bearer ${params.apiServerKey}`,
      } as Record<string, string>,
    };
  }

  if (isWebfreeBackend(params.backend)) {
    return {
      pathname: "/health",
      headers: {} as Record<string, string>,
    };
  }

  return {
    pathname: "/v1/models",
    headers: params.apiServerKey
      ? { Authorization: `Bearer ${params.apiServerKey}` }
      : ({} as Record<string, string>),
  };
}

export async function GET(request: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const { searchParams } = new URL(request.url);
    const summary = searchParams.get("summary") === "true";

    if (!supabaseAdmin) return apiError("Database not configured", 500);

    // Filter on BOTH status and lifecycle_state. lifecycle_state is the
    // post-Sprint-0 source of truth for "is this slot still occupied"
    // (see instance-service:assertFreeInstanceCreatable). If a row ends
    // up with `lifecycle_state='deleted'` but `status` lagging behind
    // (observed 2026-05-17 on 9 production rows whose 2026-05-10 cleanup
    // set the lifecycle column but not the status column), this used to
    // leave a ghost agent visible in the dashboard that the user
    // couldn't delete — `infrastructure_provider='proxmox'` without a
    // vmid trips the DELETE handler's safety guard. Excluding either
    // signal is enough to hide a fully-gone row; checking both is the
    // belt-and-suspenders.
    const { data: instances, error } = await supabaseAdmin
      .from("hermes_instances")
      .select("*")
      .eq("user_id", userId)
      .neq("status", "deleted")
      .neq("lifecycle_state", "deleted")
      .order("created_at", { ascending: true })
      .returns<InstanceRow[]>();

    if (error) {
      return apiError("Failed to fetch instances", 500, {
        failureType: "instances_fetch_failed",
      });
    }

    const rows = instances || [];

    // Sync status for instances that are actively provisioning/redeploying,
    // OR if we're doing a full fetch (summary=false) and they are running.
    // Fire the alert queries alongside the per-instance sync work
    // — they're independent (alerts only need the IDs, which we already
    // have from the initial select). Saves one full ops_events
    // round-trip from the critical path of the instance-list response.
    const rowIds = rows.map((inst) => inst.id);
    const alertsPromise = getLatestFailedInstanceUpdateAlerts(rowIds);
    const failureAlertsPromise = getLatestInstanceFailureAlerts(rowIds);
    // "Your agent is blocked waiting for your approval" — server-driven, so the
    // card shows it without each card polling the box (the old ApprovalBadge's
    // per-card poll of a nonexistent agent endpoint, retired in #499).
    const pendingPromptsPromise = getOpenPendingPrompts(rowIds);

    // Pre-fetch Proxmox VM status per host in a single `qm list` SSH
    // call. Previously this was one `qm status <vmid>` SSH per row, so
    // a 10-VM user paid 10 × SSH-RTT per dashboard poll. Now: one
    // SSH-RTT per host the user has VMs on.
    const proxmoxStatusByVmid = new Map<number, ProxmoxInstanceStatus>();
    const proxmoxBatchGroups = new Map<
      string,
      { hostConfig: ReturnType<typeof getProxmoxHostRoutingConfigFromInfrastructure>; vmids: number[] }
    >();
    for (const inst of rows) {
      const infra = getProxmoxInfrastructure(inst.config);
      if (!infra) continue;
      // Match the original needsProxmoxSync gate so we only SSH for VMs
      // that would have been probed anyway.
      const wouldProbe =
        Boolean(inst.gateway_url) &&
        Boolean(inst.api_server_key_encrypted) &&
        (["provisioning", "redeploying"].includes(inst.status) ||
          (!summary && inst.status === "running"));
      if (!wouldProbe) continue;
      const hostConfig = getProxmoxHostRoutingConfigFromInfrastructure(infra, {
        host_id: inst.host_id ?? null,
      });
      // Key by host identity — hostId/hostSlug/envPrefix determine the
      // SSH target. Rows sharing a host share a single `qm list`. Fall
      // back to gatewayHost (always populated on a valid infra) so the
      // grouping degrades safely if the routing config is sparse.
      const key =
        hostConfig?.hostId ||
        hostConfig?.hostSlug ||
        hostConfig?.envPrefix ||
        infra.gatewayHost ||
        `node:${infra.node ?? "default"}`;
      const group = proxmoxBatchGroups.get(key);
      if (group) {
        if (!group.vmids.includes(infra.vmid)) group.vmids.push(infra.vmid);
      } else {
        proxmoxBatchGroups.set(key, { hostConfig, vmids: [infra.vmid] });
      }
    }
    await Promise.all(
      Array.from(proxmoxBatchGroups.values()).map(async (group) => {
        if (!group.hostConfig) return;
        const results = await getProxmoxInstanceStatusBatch(group.vmids, {
          hostConfig: group.hostConfig,
        });
        for (const [vmid, status] of results) {
          proxmoxStatusByVmid.set(vmid, status);
        }
      })
    );

    const synced = await Promise.all(
      rows.map(async (inst) => {
        const proxmoxInfrastructure = getProxmoxInfrastructure(inst.config);
        const needsProxmoxSync = Boolean(
          proxmoxInfrastructure &&
            inst.gateway_url &&
            inst.api_server_key_encrypted &&
            (["provisioning", "redeploying"].includes(inst.status) ||
              (!summary && inst.status === "running"))
        );
        const needsSync = inst.hetzner_server_id && (
          ["provisioning", "redeploying"].includes(inst.status) ||
          (!summary && inst.status === "running")
        );

        if (needsProxmoxSync) {
          let nextStatus = inst.status;
          // Terminal metadata applied alongside the status patch when the VM
          // is gone (see the vmMissing block below). Empty on the happy path.
          const metadataPatch: Record<string, unknown> = {};

          // 1. Authoritative liveness from Proxmox. Looks up the result
          //    from the per-host batched `qm list` above; falls back to
          //    a per-vmid `qm status` SSH only if the batch didn't fire
          //    (defensive, shouldn't happen because the batch loop uses
          //    the same gate predicate).
          const batched = proxmoxStatusByVmid.get(proxmoxInfrastructure!.vmid);
          const ps: ProxmoxInstanceStatus = batched
            ? batched
            : await getProxmoxInstanceStatus(proxmoxInfrastructure!, {
                hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(proxmoxInfrastructure, { host_id: inst.host_id ?? null }),
              });
          if (ps.vmMissing) {
            // `qm status` reports the VMID is gone — the VM was destroyed by
            // Phase 2's cleanup trap on a failed bootstrap (or a host purge).
            // Flip to "error" AND RELEASE the row's Proxmox handle so the
            // recover-missing-vm-instances cron can rebuild it on a healthy
            // host: null proxmox_vmid + strip config.infrastructure with the
            // release marker. Without this the LIST reconcile only set
            // status="stopped" (ps.status maps missing → stopped) while
            // leaving proxmox_vmid + config.infrastructure intact and no
            // marker — and once the row left running/provisioning the [id]
            // reconcile's release path (gated on provisioning|running|
            // redeploying) never ran again, so the recovery cron's candidate
            // query (proxmox_vmid IS NULL + release marker) never matched.
            // The user was stranded on the "Something's wrong with your
            // agent" banner forever. Mirrors the [id] GET reconcile guard
            // (Fixture Customer A/Fixture Customer B): "error", not "deleted", so a wrong-routed-host
            // false positive surfaces for a human instead of silently
            // removing the row, and the marker keeps the DELETE guards happy.
            const recovery = await recoverProxmoxInstanceAcrossFleet({
              id: inst.id,
              user_id: userId,
              status: inst.status,
              lifecycle_state: inst.lifecycle_state ?? null,
              proxmox_node: proxmoxInfrastructure!.node ?? null,
              proxmox_vmid: proxmoxInfrastructure!.vmid,
              proxmox_template_vmid: proxmoxInfrastructure!.templateVmid ?? null,
              ipv4_address: inst.ipv4_address ?? null,
              gateway_url: inst.gateway_url ?? null,
              api_server_key_encrypted: inst.api_server_key_encrypted ?? null,
              config: inst.config ?? null,
              subdomain: inst.subdomain ?? null,
            });
            if (recovery.status === "recovered") {
              nextStatus = "running";
            } else {
              nextStatus = "error";
              if (recovery.status === "gone") {
                metadataPatch.proxmox_vmid = null;
                metadataPatch.config = stripProxmoxInfrastructure(
                  inst.config,
                  "vm_missing_across_fleet",
                );
              }
            }
            log.warn("proxmox vm reported missing on routed host (list reconcile); fleet recovery evaluated", {
              source: "instances",
              route: "/api/instances",
              method: "GET",
              instanceId: inst.id,
              userId,
              failureType: "proxmox_vm_missing_on_routed_host",
              proxmoxNode: proxmoxInfrastructure!.node ?? null,
              proxmoxVmid: proxmoxInfrastructure!.vmid,
              fleetRecoveryStatus: recovery.status,
            });
          } else if (ps.status === "stopped" || ps.status === "error") {
            nextStatus = ps.status;
          } else {
            // 2. VM is running per Proxmox; probe the right HTTP endpoint per
            //    backend (see buildReadinessProbeOptions). The key is needed
            //    for webfree boxes too now — their probe is the bearer-authed
            //    chat lane, not the public /health shell.
            let apiServerKey: string | null = null;
            if (inst.api_server_key_encrypted) {
              try {
                apiServerKey = decryptApiKey(inst.api_server_key_encrypted);
              } catch {
                // Fall through — webfree falls back to /health, gateway-backend
                // probes will likely 401; both surface as provisioning.
              }
            }
            const probeOptions = buildReadinessProbeOptions({
              backend: inst.backend,
              apiServerKey,
            });

            try {
              const { response } = await fetchFirstReachableGatewayResponse({
                baseUrl: inst.gateway_url!,
                pathname: probeOptions.pathname,
                headers: probeOptions.headers,
                timeoutMs: 5_000,
              });

              await response.text().catch(() => {});
              // Never demote an already-running instance on a single probe miss
              // (transient blip or a Vercel-side reachability gap, e.g. a
              // grey-cloud box the dashboard can't reach) — that strands a healthy
              // box on the boot spinner. Mirrors the [id] GET reconcile guard.
              if (response.ok) {
                nextStatus = "running";
              } else if (inst.status !== "running") {
                nextStatus = "provisioning";
              }
            } catch {
              if (inst.status !== "running") {
                nextStatus = "provisioning";
              }
            }
          }

          const expectedLifecycleState = getLifecycleStateForStatus(nextStatus);
          if (
            nextStatus !== inst.status ||
            inst.lifecycle_state !== expectedLifecycleState ||
            Object.keys(metadataPatch).length > 0
          ) {
            const statusPatch =
              nextStatus !== inst.status ||
              inst.lifecycle_state !== expectedLifecycleState
                ? buildInstanceLifecyclePatch(nextStatus)
                : {};
            // metadataPatch (the vmMissing release) must win over the status
            // patch so the released proxmox_vmid/config are persisted.
            const patch = { ...statusPatch, ...metadataPatch };
            await supabaseAdmin!
              .from("hermes_instances")
              .update(patch)
              .eq("id", inst.id);
            // Post-ready SOUL.md seed: this list-sync promotion may be the
            // FIRST observation of readiness (user sitting on the dashboard
            // instead of the welcome poll). The in-band provision seed races
            // the agent's own factory-default SOUL.md write and loses on slow
            // provisions — re-seed now that the box is provably up. Deferred
            // until after the response; guarded + idempotent.
            if (
              nextStatus === "running" &&
              inst.status !== "running" &&
              isWebfreeBackend(inst.backend)
            ) {
              scheduleSoulSeedReconcileAfterResponse({
                instanceId: inst.id,
                trigger: "list_provision_promote",
              });
            }
            // Agent-ready push (iOS Phase 2): the provisioning→running flip is
            // the "「name」 is ready — say hi" moment. Only the provision flip
            // (not redeploy/restart promotions) and once-guarded per instance
            // inside the scheduled callback. Deferred until after the
            // response; a push hiccup can never touch this reconcile.
            if (nextStatus === "running" && inst.status === "provisioning") {
              scheduleAgentReadyPushAfterResponse({
                instanceId: inst.id,
                userId,
                trigger: "list_provision_promote_proxmox",
              });
            }
            return { ...inst, ...patch };
          }
        } else if (needsSync) {
          const hs = await getHetznerInstanceStatus(inst.hetzner_server_id as number);
          let nextStatus = hs.status;

          if (
            (inst.status === "provisioning" || (!summary && inst.status === "running")) &&
            hs.status === "running" &&
            inst.gateway_url &&
            (isWebfreeBackend(inst.backend) || inst.api_server_key_encrypted)
          ) {
            try {
              const apiServerKey = inst.api_server_key_encrypted
                ? decryptApiKey(inst.api_server_key_encrypted)
                : null;
              const probeOptions = buildReadinessProbeOptions({
                backend: inst.backend,
                apiServerKey,
              });
              const { response } = await fetchFirstReachableGatewayResponse({
                baseUrl: inst.gateway_url,
                pathname: probeOptions.pathname,
                instanceIpv4: hs.ipv4 || inst.ipv4_address || undefined,
                headers: probeOptions.headers,
                timeoutMs: 5_000,
              });

              await response.text().catch(() => {});
              // Never demote an already-running instance on a single probe miss
              // (transient blip or a Vercel-side reachability gap, e.g. a
              // grey-cloud box the dashboard can't reach) — that strands a healthy
              // box on the boot spinner. Mirrors the [id] GET reconcile guard.
              if (response.ok) {
                nextStatus = "running";
              } else if (inst.status !== "running") {
                nextStatus = "provisioning";
              }
            } catch {
              if (inst.status !== "running") {
                nextStatus = "provisioning";
              }
            }
          }

          if (nextStatus) {
            const expectedLifecycleState = getLifecycleStateForStatus(nextStatus);
            if (
              nextStatus !== inst.status ||
              inst.lifecycle_state !== expectedLifecycleState
            ) {
              const patch = buildInstanceLifecyclePatch(nextStatus);
              await supabaseAdmin!
                .from("hermes_instances")
                .update(patch)
                .eq("id", inst.id);
              // Post-ready SOUL.md seed on the Hetzner promotion path — same
              // race, same fix as the Proxmox branch above.
              if (
                nextStatus === "running" &&
                inst.status !== "running" &&
                isWebfreeBackend(inst.backend)
              ) {
                scheduleSoulSeedReconcileAfterResponse({
                  instanceId: inst.id,
                  trigger: "list_provision_promote",
                });
              }
              // Agent-ready push on the Hetzner promotion path — same trigger,
              // same once-guard as the Proxmox branch above.
              if (nextStatus === "running" && inst.status === "provisioning") {
                scheduleAgentReadyPushAfterResponse({
                  instanceId: inst.id,
                  userId,
                  trigger: "list_provision_promote_hetzner",
                });
              }
              return { ...inst, ...patch };
            }
          }
        } else if (
          !proxmoxInfrastructure &&
          inst.infrastructure_provider === "proxmox" &&
          inst.status === "provisioning" &&
          inst.created_at &&
          Date.now() - new Date(inst.created_at).getTime() > 25 * 60 * 1000
        ) {
          // Orphan sweeper — Phase 1 SSH/clone never produced infrastructure
          // metadata (Vercel-killed before the early-finish marker). Without
          // this, the row stays 'provisioning' forever and the boot UI
          // spins. Mirror the per-instance GET handler in [id]/route.ts.
          const patch = buildInstanceLifecyclePatch("error");
          await supabaseAdmin!
            .from("hermes_instances")
            .update(patch)
            .eq("id", inst.id);
          return { ...inst, ...patch };
        }
        return inst;
      })
    );
    const [updateAlerts, rawFailureAlerts, pendingPrompts] = await Promise.all([
      alertsPromise,
      failureAlertsPromise,
      pendingPromptsPromise,
    ]);
    const failureAlerts = suppressFailureAlertsResolvedByLifecycle(
      rawFailureAlerts,
      synced
    );

    // Summary mode: return minimal info
    if (summary) {
      return apiSuccess(
        synced.map(
          ({
            id,
            name,
            status,
            provider,
            created_at,
            first_usage_at,
            host_id,
            cpu_limit,
            ram_limit,
            config,
            ipv4_address,
            lifecycle_state,
            paused_reason,
          }) => ({
            id,
            name,
            status,
            provider,
            created_at,
            // Read-only activation signal — the dashboard's onboarding
            // checklist marks "send your first message" off it.
            first_usage_at: first_usage_at ?? null,
            host_id,
            cpu_limit,
            ram_limit,
            lifecycle_state: lifecycle_state ?? null,
            paused_reason: paused_reason ?? null,
            public_ipv4: ipv4_address ?? null,
            config: getPublicInstanceConfig(config),
            updateAlert: updateAlerts[id] ?? null,
            failureAlert: failureAlerts[id] ?? null,
            pendingPrompt: pendingPrompts[id] ?? null,
          })
        )
      );
    }

    // Full mode. `select("*")` pulls every column into the row, including
    // `api_server_key_encrypted` — the per-instance gateway bearer, encrypted
    // at rest. It's a server-only secret and must never reach the client, so
    // the `...inst` spread is overridden to drop it (JSON serialization omits
    // `undefined` keys). The single-instance GET handler ([id]/route.ts)
    // already redacts it the same way; this keeps the list response consistent.
    return apiSuccess(
      synced.map((inst) => ({
        ...inst,
        api_server_key_encrypted: undefined,
        config: getPublicInstanceConfig(inst.config),
        updateAlert: updateAlerts[inst.id] ?? null,
        failureAlert: failureAlerts[inst.id] ?? null,
        pendingPrompt: pendingPrompts[inst.id] ?? null,
      }))
    );
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(request: NextRequest) {
  let ctx: RequestContext | undefined;
  try {
    const ip = getIP(request);
    const { success } = enforceRateLimit(`create_instance_${ip}`, {
      limit: 10,
      windowMs: 60 * 1000,
    });
    if (!success) {
      return apiError("Too Many Requests", 429);
    }

    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    // Deploy failures must be user-attributable in ops_events. auth() was
    // just called above, so skip the duplicate Clerk lookup inside
    // getRequestContext and stamp the userId directly.
    ctx = await getRequestContext(request, {
      source: "api.instances",
      skipAuth: true,
    });
    ctx.userId = userId;

    // Free-tier abuse prevention. Runs BEFORE schema parsing because we
    // want even malformed-payload retries to count against the gate (and
    // we don't want to leak schema details to blocked accounts). Paid
    // subscribers bypass this internally — see lib/abuse/gate.ts.
    const json = await request.json();
    const fingerprintRequestId =
      typeof json?.fingerprintRequestId === "string" ? json.fingerprintRequestId : null;

    const user = await currentUser();
    const email =
      user?.primaryEmailAddress?.emailAddress ??
      user?.emailAddresses?.[0]?.emailAddress ??
      null;

    const gate = await checkProvisioningGate({
      userId,
      ip,
      email,
      fingerprintRequestId,
    });

    if (!gate.allow) {
      // 402 (card_required) carries a structured `reason` so the frontend
      // can route the user to the SetupIntent collection step rather than
      // showing a generic error. 403 (blocked) is terminal — no recovery
      // path short of contacting support. logLevel "error" because only
      // error-level lines mirror into ops_events; the route rate limit
      // keeps repeat offenders from flooding it. Status codes unchanged.
      return apiError(
        gate.message,
        gate.status,
        { failureType: `abuse_gate_${gate.reason}` },
        { reason: gate.reason },
        { ctx, failureType: `abuse_gate_${gate.reason}`, logLevel: "error" }
      );
    }

    const parsed = CreateInstanceSchema.safeParse(json);
    if (!parsed.success) {
      return apiError(parsed.error.issues[0].message, 400, undefined, undefined, {
        ctx,
        failureType: "deploy_rejected_invalid_payload",
        logLevel: "error",
      });
    }

    const result = await InstanceService.createInstance(userId, parsed.data);

    if (!result.success) {
      // Machine-readable code in the response body so the client can tell
      // transient infra failures (provision_host_failure) from permanent
      // user-input rejections. Falls back to a status-derived code for
      // service paths that don't set one yet.
      const failureType =
        result.failureType ??
        (result.status >= 500
          ? "instance_create_failed"
          : `deploy_rejected_${result.status}`);
      // The one-base-agent 403 carries the user's EXISTING instance id in the
      // service error. Surface it (and the code) in the response body so the
      // welcome flow can offer "Open/Restore your agent" instead of a dead-end
      // upgrade wall. It's the caller's own instance id — safe to return.
      const extra: Record<string, unknown> = { failureType };
      if (result.error && typeof result.error === "object") {
        const { code, existingInstanceId } = result.error as {
          code?: unknown;
          existingInstanceId?: unknown;
        };
        if (
          code === "FREE_INSTANCE_LIMIT_REACHED" &&
          typeof existingInstanceId === "string"
        ) {
          extra.code = code;
          extra.existingInstanceId = existingInstanceId;
        }
      }
      return apiError(result.message, result.status, result.error, extra, {
        ctx,
        failureType,
        // 4xx deploy rejections (403 entitlement / 400 key shape / 402
        // card) need to reach ops_events too; status codes are unchanged,
        // this only raises log severity for this route's deploy path.
        logLevel: "error",
      });
    }

    return apiSuccess(result.data, 200, ctx);
  } catch (err) {
    return handleApiError(err, ctx);
  }
}
