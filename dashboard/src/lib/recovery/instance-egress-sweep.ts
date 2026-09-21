import "server-only";

import { reportOpsEvent } from "@/lib/ops-events";
import { decryptApiKey } from "@/lib/crypto";
import { isPausedLifecycleState } from "@/lib/instance-lifecycle";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * Synthetic probe of each agent's outbound network to known model API
 * endpoints (`api.openai.com`, `api.anthropic.com`, etc.). Calls the
 * agent's `/api/health/egress` endpoint which performs DNS resolution +
 * TCP connect inside the agent's own network namespace and returns a
 * per-target result.
 *
 * Why this exists: gateway-health probes (instance-health-sweep) prove
 * the agent's HTTPS port answers, but they don't catch the case where
 * the agent itself can't reach the model API — DNS dropped to the
 * upstream resolver, network egress filter, route blackhole etc. Hit
 * live 2026-05-02: every Proxmox VM had Cloudflare 1.1.1.1 unreachable
 * on UDP/53, all chat sends timed out with `gaierror`, `/api/health`
 * stayed green the whole time. Synthetic egress probes catch that
 * class of failure before users hit it.
 *
 * Failure mode: per-target failures are reported to ops_events with a
 * stable fingerprint so an extended outage trends as ONE event rather
 * than firing every cron tick. The agent endpoint is best-effort — if
 * it returns 404 (older image without /api/health/egress baked in) the
 * sweep treats that instance as "unknown" and skips, no alert. When
 * agents are upgraded, probes start working without a coordinated cut.
 */

interface InstanceEgressProbeRow {
  id: string;
  user_id: string;
  gateway_url: string | null;
  status: string | null;
  backend: string | null;
  api_server_key_encrypted: string | null;
  host_id?: string | null;
  hetzner_server_id?: number | null;
  ipv4_address?: string | null;
  lifecycle_state?: string | null;
}

interface EgressTargetResult {
  target: string;
  ok: boolean;
  durationMs?: number;
  errorClass?: string;
  errorDetail?: string;
}

interface InstanceEgressProbeResult {
  instanceId: string;
  gatewayUrl: string;
  /** Whole-probe outcome: did the agent's endpoint answer at all? */
  endpointStatus: "ok" | "missing" | "unauth" | "unreachable" | "error";
  endpointError?: string;
  /** Per-target results when endpointStatus === "ok". */
  targets: EgressTargetResult[];
}

const PROBE_TIMEOUT_MS = 8000;

/** Targets the agent should probe. Kept narrow on purpose — adding more
 *  upstreams just to "be thorough" turns the cron into a noisy alarm
 *  for partial outages that don't matter for chat (eg. github.com being
 *  slow when no agent is making git tool calls). The two model APIs
 *  here cover ~all of today's traffic; expand only when there's a
 *  legitimately new cause-of-outage to monitor. */
const DEFAULT_EGRESS_TARGETS = [
  "api.openai.com",
  "api.anthropic.com",
] as const;

async function probeInstanceEgress(input: {
  instanceId: string;
  gatewayUrl: string;
  apiServerKey: string;
  targets?: readonly string[];
}): Promise<InstanceEgressProbeResult> {
  const targets = (input.targets ?? DEFAULT_EGRESS_TARGETS).join(",");
  const probeUrl = `${input.gatewayUrl.replace(/\/+$/, "")}/api/health/egress?targets=${encodeURIComponent(targets)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(probeUrl, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${input.apiServerKey}`,
      },
    });
  } catch (err) {
    return {
      instanceId: input.instanceId,
      gatewayUrl: input.gatewayUrl,
      endpointStatus: "unreachable",
      endpointError: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      targets: [],
    };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) {
    // Agent image predates the egress endpoint. Skip silently — alerting
    // would just generate noise on every old VM until it's upgraded.
    return {
      instanceId: input.instanceId,
      gatewayUrl: input.gatewayUrl,
      endpointStatus: "missing",
      targets: [],
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      instanceId: input.instanceId,
      gatewayUrl: input.gatewayUrl,
      endpointStatus: "unauth",
      endpointError: `HTTP ${response.status}`,
      targets: [],
    };
  }
  if (response.status >= 500) {
    return {
      instanceId: input.instanceId,
      gatewayUrl: input.gatewayUrl,
      endpointStatus: "error",
      endpointError: `HTTP ${response.status}`,
      targets: [],
    };
  }

  let body: { targets?: EgressTargetResult[] } | null = null;
  try {
    body = (await response.json()) as { targets?: EgressTargetResult[] };
  } catch {
    return {
      instanceId: input.instanceId,
      gatewayUrl: input.gatewayUrl,
      endpointStatus: "error",
      endpointError: "Egress probe returned non-JSON body",
      targets: [],
    };
  }

  return {
    instanceId: input.instanceId,
    gatewayUrl: input.gatewayUrl,
    endpointStatus: "ok",
    targets: Array.isArray(body?.targets) ? body.targets : [],
  };
}

export interface InstanceEgressSweepResult {
  probed: number;
  endpointMissing: number;
  endpointFailed: number;
  targetFailures: number;
  // Rows from the status='running' query skipped before probing because they are
  // intentionally paused (lifecycle_state='paused'). Their VM is shut down, so an
  // egress probe always reports the endpoint unreachable — pure false-positive
  // noise. Surfaced for ops visibility; NOT counted in probed.
  skippedPaused: number;
  results: InstanceEgressProbeResult[];
}

async function archiveRecoveredEndpointUnauthAlert(instanceId: string): Promise<void> {
  if (!supabaseAdmin) return;

  try {
    const { error } = await supabaseAdmin
      .from("ops_events")
      .update({ archived_at: new Date().toISOString() })
      .eq("instance_id", instanceId)
      .eq("source", "synthetic.egress-endpoint")
      .eq("metadata->>failureType", "egress_endpoint_unreachable")
      .eq("metadata->>endpointStatus", "unauth")
      .is("archived_at", null);

    if (error) {
      log.warn("failed to archive recovered egress auth alert", {
        source: "synthetic.egress-endpoint",
        failureType: "egress_endpoint_alert_archive_failed",
        instanceId,
        errorDescription: error.message || String(error),
      });
    }
  } catch (error) {
    log.warn("failed to archive recovered egress auth alert", {
      source: "synthetic.egress-endpoint",
      failureType: "egress_endpoint_alert_archive_failed",
      instanceId,
      errorDescription: error instanceof Error ? error.message : String(error),
    }, error);
  }
}

async function probeInstanceEgressForRow(
  row: InstanceEgressProbeRow & { gateway_url: string; api_server_key_encrypted: string }
): Promise<InstanceEgressProbeResult> {
  let apiServerKey: string;
  try {
    apiServerKey = decryptApiKey(row.api_server_key_encrypted);
  } catch (err) {
    return {
      instanceId: row.id,
      gatewayUrl: row.gateway_url,
      endpointStatus: "error",
      endpointError: `Bearer decrypt failed: ${err instanceof Error ? err.message : "unknown"}`,
      targets: [],
    };
  }

  // An egress *probe* must NEVER mutate security keys. This used to recover and
  // PERSIST a fresh API_SERVER_KEY on an unauth result — but on a 5-min cron, with
  // an object literal that omits config.infrastructure, that recovery could not
  // route to the managing pve host and instead read whatever box answered the
  // non-unique private guest IP first, then wrote a STRANGER's key over this
  // instance's (cross-tenant key corruption → blank white workspace). A genuinely
  // drifted key is surfaced as an unauth result (treated as "missing endpoint"
  // below) and is healed by the authenticated webui-login / page-load path, which
  // routes recovery correctly through the managing host.
  return probeInstanceEgress({
    instanceId: row.id,
    gatewayUrl: row.gateway_url,
    apiServerKey,
  });
}

export async function runInstanceEgressSweep(): Promise<InstanceEgressSweepResult> {
  const db = supabaseAdmin;
  if (!db) {
    throw new Error("Supabase admin client not configured");
  }

  const { data, error } = await db
    .from("hermes_instances")
    .select("id, user_id, gateway_url, status, backend, api_server_key_encrypted, host_id, hetzner_server_id, ipv4_address, lifecycle_state")
    .eq("status", "running")
    .not("gateway_url", "is", null)
    .not("api_server_key_encrypted", "is", null);

  if (error) {
    throw new Error(error.message || "Failed to fetch instances");
  }

  const rows = (data ?? []) as InstanceEgressProbeRow[];

  // Drop intentionally-paused boxes before probing. status='running' alone is
  // not enough — a paused row's status can drift back to 'running' while
  // lifecycle_state stays 'paused', so the powered-off VM leaks into the probe
  // set and reports its egress endpoint "unreachable" on every tick. Companion
  // to the same guard in instance-health-sweep; see isPausedLifecycleState.
  const liveRows = rows.filter((row) => !isPausedLifecycleState(row.lifecycle_state));
  const skippedPaused = rows.length - liveRows.length;

  const probable = liveRows.filter(
    (row): row is InstanceEgressProbeRow & { gateway_url: string; api_server_key_encrypted: string } =>
      typeof row.gateway_url === "string" &&
      row.gateway_url.trim().length > 0 &&
      typeof row.api_server_key_encrypted === "string" &&
      row.api_server_key_encrypted.length > 0,
  );

  const results = await Promise.all(probable.map(probeInstanceEgressForRow));

  let endpointMissing = 0;
  let endpointFailed = 0;
  let targetFailures = 0;

  await Promise.all(
    results.map(async (result, index) => {
      const row = probable[index];

      if (result.endpointStatus === "missing") {
        endpointMissing += 1;
        return;
      }

      if (result.endpointStatus === "unauth") {
        // Post-recovery persistent 401: webui's auth middleware rejects
        // unknown paths BEFORE route lookup on auth-enabled instances, and
        // webui doesn't process `Authorization: Bearer` at all (see
        // hermes-webui/api/auth.py — `check_auth` only validates session
        // cookies). The `/api/health/egress` route is also not implemented
        // anywhere yet (no handler in hermes-webui or browser-sidecar). So a
        // persistent 401 here means "auth-enabled instance with no egress
        // endpoint" — operationally indistinguishable from 404. Treating it
        // as missing avoids a permanent false-positive alert. Once the
        // endpoint is actually implemented + added to PUBLIC_PATHS (or given
        // bearer support), instances upgraded to that image will start
        // returning real 200/4xx/5xx responses and this branch goes cold.
        // Archive any prior alerts emitted under the old "unauth = error"
        // semantics so the ops feed clears without manual action.
        endpointMissing += 1;
        await archiveRecoveredEndpointUnauthAlert(row.id);
        return;
      }

      if (result.endpointStatus === "unreachable" || result.endpointStatus === "error") {
        endpointFailed += 1;
        // Reaching the endpoint at all is the prereq for trusting any
        // per-target result. If it's down we report it ONCE (deduped by
        // ops_events fingerprint) and move on — the broader gateway
        // health sweep already covers full-instance unreachability.
        await reportOpsEvent({
          source: "synthetic.egress-endpoint",
          severity: "error",
          title: `Egress probe endpoint ${result.endpointStatus} on ${result.gatewayUrl}`,
          message:
            `GET ${result.gatewayUrl}/api/health/egress failed: ` +
            `${result.endpointError || result.endpointStatus}. ` +
            `Cannot verify outbound network from this agent.`,
          instanceId: row.id,
          userId: row.user_id,
          metadata: {
            failureOwner: "runtime",
            failurePhase: "egress",
            failureType: "egress_endpoint_unreachable",
            recoveryAction: "repair_runtime",
            gatewayUrl: result.gatewayUrl,
            backend: row.backend,
            endpointStatus: result.endpointStatus,
          },
        });
        return;
      }

      // endpointStatus === "ok" — inspect per-target results.
      const failed = result.targets.filter((t) => !t.ok);
      if (failed.length === 0) return;

      targetFailures += failed.length;

      // One ops event per (instance, target) pair so the dedup
      // fingerprint groups recurring failures of the same target on the
      // same instance, but still distinguishes "all of openai down for
      // this one VM" from "all VMs lost openai" — the operator wants
      // both signals separately.
      await Promise.all(
        failed.map((target) =>
          reportOpsEvent({
            source: "synthetic.egress-target",
            severity: "error",
            title: `Agent can't reach ${target.target} from ${result.gatewayUrl}`,
            message:
              `Agent VM probe to ${target.target} failed: ` +
              `${target.errorClass || "error"}: ${target.errorDetail || "(no detail)"}. ` +
              `Chat sends to this provider will fail until network egress is restored. ` +
              `Common causes: upstream DNS resolver dropped (check /etc/resolv.conf), ` +
              `host network filter, target API outage.`,
            instanceId: row.id,
            userId: row.user_id,
            metadata: {
              failureOwner: "runtime",
              failurePhase: "egress",
              failureType: "egress_target_unreachable",
              recoveryAction: "repair_runtime",
              gatewayUrl: result.gatewayUrl,
              backend: row.backend,
              target: target.target,
              durationMs: target.durationMs,
              errorClass: target.errorClass,
              errorDetail: target.errorDetail,
            },
          }),
        ),
      );
    }),
  );

  return {
    probed: probable.length,
    endpointMissing,
    endpointFailed,
    targetFailures,
    skippedPaused,
    results,
  };
}
