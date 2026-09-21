import "server-only";
import { chunk } from "@/lib/array-utils";

import { Agent } from "undici";
import { fetchFirstReachableGatewayResponse } from "@/lib/agent-gateway";
import { isPausedLifecycleState } from "@/lib/instance-lifecycle";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import { isWebfreeBackend } from "@/lib/types/instance";

/**
 * Synthetic health probe across the running instance fleet. Pings each
 * agent gateway's `/health` endpoint every cron tick and posts an ops
 * event for any instance that fails or returns a 5xx.
 *
 * Why this exists: today's debug session had a stretch where multiple
 * Proxmox instances were silently broken for hours (DNS NXDOMAIN, port
 * mismatch, CORS-block-as-CSP) before any user noticed. None of those
 * had a server-side signal — Vercel function logs only show errors
 * users actively trip, and Caddy access.log requires SSH. A periodic
 * synthetic probe surfaces breakage in the ops view the moment it
 * starts, even with zero user traffic.
 *
 * Probe-path / reachability parity with recover-unhealthy-active: this
 * sweep originally probed `/api/health`, but that is the OLD hermes-webui
 * app route — after the webfree migration it requires auth (returns 401)
 * or proxies into a slow/hanging app handler, while the canonical agent
 * gateway health endpoint is the unauthenticated `/health` (what
 * recover-unhealthy-active, recover-stuck, and the instance routes all
 * probe). Probing a different path meant this prober flagged hundreds of
 * instances the recover-unhealthy-active cron simultaneously probed
 * HEALTHY (via `/health` over the same multi-URL reachable set) and
 * archived — so the prober re-opened them every 5 min and the open-event
 * backlog churned forever. We now (1) probe `/health`, and (2) for a
 * generic gateway failure that THREW (TLS/network — where the stored
 * gateway host might be unreachable while a fallback URL still answers),
 * confirm against the exact same `fetchFirstReachableGatewayResponse`
 * set before opening an event. The two sweeps can no longer disagree.
 *
 * Failure mode design: we POST to ops_events on FAILURE only. The same
 * failure occurring repeatedly dedupes under the ops_events fingerprint
 * logic so an extended outage shows as ONE trending event with an updated
 * `last_seen_at`, not 60 events/hour. On SUCCESS we archive any open
 * `synthetic.instance-health` event for that instance (self-heal) — the
 * prober used to be append-only (open on failure, never close on
 * recovery), so the backlog only ever grew and relied entirely on the
 * rate-limited recover-unhealthy-active cron to drain it.
 */

interface InstanceHealthProbeRow {
  id: string;
  user_id: string;
  gateway_url: string | null;
  status: string | null;
  backend: string | null;
  infrastructure_provider?: string | null;
  hetzner_server_id?: number | null;
  ipv4_address?: string | null;
  proxmox_vmid?: number | null;
  proxmox_node?: string | null;
  product_surface?: string | null;
  lifecycle_state?: string | null;
  deleted_at?: string | null;
  scheduled_deletion_at?: string | null;
}

export interface InstanceHealthProbeResult {
  instanceId: string;
  gatewayUrl: string;
  status: number | null;
  ok: boolean;
  durationMs: number;
  errorName?: string;
  errorMessage?: string;
  // Set when the default-protocol (HTTP/2) probe failed with a TLS or
  // protocol-level error AND the HTTP/1.1 fallback succeeded. Strong
  // signal of a Caddy certmagic-panic-style wedge: cert is on disk,
  // ALPN negotiates h2, but in-memory HTTP/2 server state is broken.
  // Recovery is `systemctl stop caddy && start caddy` on the host.
  tlsWedged?: boolean;
  tlsError?: boolean;
  expectedGatewayUrl?: string;
  // Signed skew (ms) between the box's HTTP `Date` response header and our
  // (NTP-correct) clock: positive = box ahead, negative = box behind. Undefined
  // when the probe had no parseable Date header. Fuels the clock-skew guard —
  // a box drifting past the webui-login token window serves a blank chat.
  clockSkewMs?: number;
}

// 12s per probe. The old 6s was below the tail latency of a cold gateway
// under prober load — combined with ~495 probes firing at once via Promise.all
// in a single Vercel invocation, ~83% of "failures" were the prober's own
// AbortError, not real outages. Raising the timeout AND bounding concurrency
// (PROBE_BATCH_SIZE below) is what stops the crying-wolf.
const PROBE_TIMEOUT_MS = 12000;

// Probe in bounded batches instead of one giant Promise.all. 495 simultaneous
// fetches inside one serverless invocation starve the event loop and trip
// AbortError on probes that would have answered with more headroom. 25 in
// flight keeps wall time low (~one timeout per batch) without the stampede.
const PROBE_BATCH_SIZE = 25;

// Clock-skew guard threshold. A box whose clock drifts past the webui-login token
// window serves a blank chat: the dashboard mints a 30s login token and the box's
// sidecar rejects it if the box clock is far enough off (2026-07-01 fixturenodea incident —
// host chrony stuck on the unreachable 2.debian.pool default, free-ran ~30s ahead,
// 30s tokens expired on arrival -> 401 -> blank iframe). We alert at 20s, well below
// even the tightest (pre-redeploy) ±30s tolerance, so drift surfaces BEFORE a user
// hits it. Skew is read from the box's /health `Date` header; boxes behind a correct
// CDN report the edge's clock, so this can only under-report, never falsely accuse.
// Kill-switch: HERMES_CLOCK_SKEW_GUARD=off.
const CLOCK_SKEW_ALERT_MS = 20_000;

// Generic synthetic.instance-health events only OPEN after this many
// consecutive failing ticks (tracked per-instance in instance_health_probe_state).
// One transient AbortError no longer pages; a genuine outage that fails two
// 5-minute ticks in a row still surfaces within ~10 minutes.
const HEALTH_FAILURE_OPEN_THRESHOLD = 2;

// Pattern-match Node fetch / undici TLS errors. Anchored on the cause
// chain's name/message rather than `instanceof TypeError` because the
// surface error is always TypeError("fetch failed") and the actual
// detail lives in `error.cause`. We're conservative — anything that
// looks remotely TLS-shaped triggers the HTTP/1.1 fallback so we
// don't miss a wedge by being too strict on the error string.
const TLS_ERROR_PATTERNS = [
  /tlsv1.+alert.+internal.+error/i,
  /SSL routines/i,
  /handshake/i,
  /ECONNRESET/,
  /HPE_/, // undici HTTP parser errors
  /protocol error/i,
];

function looksLikeTlsError(err: unknown): boolean {
  if (!err) return false;
  const visited = new Set<unknown>();
  let current: unknown = err;
  while (current && !visited.has(current)) {
    visited.add(current);
    const name = (current as { name?: unknown }).name;
    const message = (current as { message?: unknown }).message;
    const code = (current as { code?: unknown }).code;
    const haystack = [
      typeof name === "string" ? name : "",
      typeof message === "string" ? message : "",
      typeof code === "string" ? code : "",
    ].join(" ");
    if (TLS_ERROR_PATTERNS.some((pattern) => pattern.test(haystack))) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// Singleton h1.1-only undici dispatcher used ONLY for the wedge-
// detection fallback. Disabling h2 forces HTTP/1.1 negotiation; if
// the gateway is wedged on h2 specifically (the certmagic-panic
// pattern), the h1.1 retry succeeds and we know to emit the
// `synthetic.tls-wedged` ops event. Cached per process — undici
// keeps a tiny pool of 2 connections, plenty for sweeper traffic.
let h11Dispatcher: Agent | null = null;
function getHttp11Dispatcher(): Agent {
  if (!h11Dispatcher) {
    h11Dispatcher = new Agent({
      allowH2: false,
      connections: 2,
      keepAliveTimeout: 4000,
    });
  }
  return h11Dispatcher;
}

/**
 * Probe a single instance's gateway. Returns ok=true for 2xx/3xx/4xx
 * (the gateway is alive and responding — a 4xx like 401 is healthy
 * from the probe's perspective; it just means our unsigned request
 * was rejected at the auth layer). 5xx and network failures are not ok.
 *
 * The 4xx-as-healthy decision matches the rollback probe in
 * profile-service.buildCaddyReloadWithHealthProbeScript — same heuristic
 * across both surfaces so they don't disagree on what "healthy" means.
 */
// Best-effort clock-skew read from a probe response's `Date` header (signed ms;
// positive = box ahead of us). Never throws: header-less responses (including the
// bare `{ status }` mocks in tests) and unparseable dates simply yield undefined,
// so a probe never fails over this.
function readClockSkewMs(response: Response): number | undefined {
  try {
    const dateHeader = response.headers?.get?.("date");
    if (!dateHeader) return undefined;
    const boxMs = Date.parse(dateHeader);
    if (!Number.isFinite(boxMs)) return undefined;
    return boxMs - Date.now();
  } catch {
    return undefined;
  }
}

export async function probeInstanceGateway(input: {
  instanceId: string;
  gatewayUrl: string;
}): Promise<InstanceHealthProbeResult> {
  const start = Date.now();
  const probeUrl = `${input.gatewayUrl.replace(/\/+$/, "")}/health`;

  // Default-protocol probe: Node fetch negotiates HTTP/2 over ALPN
  // when the server supports it, which is what real browsers do.
  let primaryError: Error | null = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(probeUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    return {
      instanceId: input.instanceId,
      gatewayUrl: input.gatewayUrl,
      status: response.status,
      ok: response.status < 500,
      durationMs: Date.now() - start,
      clockSkewMs: readClockSkewMs(response),
    };
  } catch (err) {
    primaryError = err instanceof Error ? err : new Error(String(err));
  }

  // Fallback: if the primary probe died with a TLS / protocol-level
  // error, retry once with HTTP/1.1 forced. If h1.1 succeeds the
  // gateway is wedged on h2 specifically (Caddy certmagic-panic
  // pattern) — a state real browsers cannot recover from since they
  // default to h2 over ALPN. Surface tlsWedged=true so the sweeper
  // emits the targeted ops event.
  if (primaryError && looksLikeTlsError(primaryError)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      let h11Response: Response;
      try {
        h11Response = await fetch(probeUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          // @ts-expect-error: undici-specific dispatcher option not in
          // the standard fetch type; runtime supports it on Node 18+.
          dispatcher: getHttp11Dispatcher(),
        });
      } finally {
        clearTimeout(timer);
      }
      // h1.1 worked AND the agent answered (any status < 500): the
      // gateway is reachable but its h2 server is broken. Real
      // browsers will still fail because they negotiate h2 over ALPN;
      // an operator needs to restart Caddy on the host.
      if (h11Response.status < 500) {
        return {
          instanceId: input.instanceId,
          gatewayUrl: input.gatewayUrl,
          status: h11Response.status,
          ok: false, // h2 is what users actually hit — treat as unhealthy
          durationMs: Date.now() - start,
          errorName: primaryError.name,
          errorMessage: primaryError.message,
          tlsWedged: true,
        };
      }
      // Both protocols failed at the application layer — the agent
      // itself is sick, not just Caddy. Fall through to the regular
      // failure shape below.
    } catch {
      // h1.1 also failed — not a wedge, just a real outage.
    }
  }

  return {
    instanceId: input.instanceId,
    gatewayUrl: input.gatewayUrl,
    status: null,
    ok: false,
    durationMs: Date.now() - start,
    errorName: primaryError?.name,
    errorMessage: primaryError?.message,
    tlsError: primaryError ? looksLikeTlsError(primaryError) : false,
  };
}

function canonicalHetznerGatewayUrl(ipv4Address: string): string {
  return `https://${ipv4Address.replace(/\./g, "-")}.sslip.io`;
}

function getHetznerGatewayConfigIssue(
  row: InstanceHealthProbeRow & { gateway_url: string },
): { expectedGatewayUrl: string } | null {
  if (!row.hetzner_server_id && row.infrastructure_provider !== "hetzner") {
    return null;
  }
  const ipv4Address = row.ipv4_address?.trim();
  if (!ipv4Address) {
    return null;
  }
  const expectedGatewayUrl = canonicalHetznerGatewayUrl(ipv4Address);
  if (row.gateway_url.replace(/\/+$/, "") === expectedGatewayUrl) {
    return null;
  }
  return { expectedGatewayUrl };
}

export interface InstanceHealthSweepResult {
  probed: number;
  failed: number;
  // Generic gateway-host failures that THREW but turned out to be
  // reachable on a fallback candidate URL (the recover-unhealthy-active
  // reachable set). These are NOT counted in `failed` and do NOT open an
  // ops event — flagging them is exactly what used to churn against the
  // recovery cron.
  recoveredViaFallback: number;
  // Failing probes that bumped the consecutive-failure counter but did NOT yet
  // open a generic synthetic.instance-health event because this was only their
  // first failing tick (count < HEALTH_FAILURE_OPEN_THRESHOLD). Counted in
  // `failed` — the probe did fail — but suppressed from the ops feed so a lone
  // AbortError under prober load no longer cries wolf.
  suppressedPendingFailures: number;
  // Rows that came back from the status='running' query but were skipped before
  // probing because they are intentionally paused (lifecycle_state='paused' — an
  // idle/capacity/dormant/ram-cap park). Their VM is shut down, so probing only
  // ever produced gateway-down false positives. Surfaced for ops visibility; NOT
  // counted in probed/failed.
  skippedPaused: number;
  // Open `synthetic.instance-health` events archived this run because the
  // instance probed healthy (self-heal of the append-only backlog).
  archivedHealthy: number;
  // Open instance-actions/orchestrator failure events archived this run because
  // the instance probed healthy — closes the user-facing "ACTIVE FAILURE
  // OWNERSHIP" Console banner a timed-out Update/Repair/Redeploy left behind.
  archivedActionFailures: number;
  // Running hermesos instances found on the legacy "gateway" backend (no public
  // dashboard shell → workspace iframe 404). The 2026-06-15 incident-shape
  // detector; each one opens a first-sighting FATAL ops event.
  backendLaneViolations: number;
  results: InstanceHealthProbeResult[];
}

// PostgREST encodes `.in()` filters in the GET/PATCH query string; past a
// few hundred UUIDs the URL overflows the gateway's request-line limit and
// the query 400s. Chunk every id-list query — same landmine that killed
// recover-unhealthy-active on 2026-06-10.
const ARCHIVE_ID_CHUNK_SIZE = 100;

const HEALTH_EVENT_SOURCE = "synthetic.instance-health";

// User-facing action/runtime failure events the Console pins as "ACTIVE FAILURE
// OWNERSHIP" — written by the instance-action routes (apiError → logger → ops
// bridge) and by the orchestrator. Unlike the prober's own
// synthetic.instance-health rows, these were never closed on recovery, so a box
// that recreated healthy after a timed-out Update/Repair/Redeploy kept a
// permanent failure banner. We close them on the same verified-healthy signal
// (see archiveResolvedActionFailureEvents); reportOpsEvent un-archives the
// fingerprint on the next genuine failure, so nothing is lost.
const ACTION_FAILURE_SOURCES = ["instance-actions", "instance-orchestrator"];
const ACTION_FAILURE_RESOLVED_TYPES = [
  "instance_action_failed",
  "live_update_failed",
  "update_launch_failed",
  "ssh_exec_failed",
];

/**
 * Confirm an instance is genuinely unreachable before opening a generic
 * `synthetic.instance-health` event. Uses the EXACT same call as
 * recover-unhealthy-active's `probeHealth` — `fetchFirstReachableGatewayResponse`
 * over `/health` with the instance's direct IP as a fallback candidate —
 * so the two sweeps share one definition of "reachable" and can never
 * churn against each other. Returns true only when a candidate URL answers
 * 2xx (recover-unhealthy-active's `response.ok` bar), matching its archive
 * trigger precisely.
 */
async function confirmReachableViaRecoverySet(
  row: InstanceHealthProbeRow & { gateway_url: string },
): Promise<boolean> {
  try {
    const { response } = await fetchFirstReachableGatewayResponse({
      baseUrl: row.gateway_url,
      pathname: "/health",
      instanceIpv4: row.ipv4_address ?? undefined,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    await response.text().catch(() => {});
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Archive every open `synthetic.instance-health` event for instances that
 * probed healthy this run. Keyed on instance_id (NOT fingerprint): one
 * instance can hold several open rows because the fingerprint folds in the
 * title/message, which carry the gateway_url and error string, so a
 * gateway_url change or a different error spawns a fresh row. Best-effort —
 * recover-unhealthy-active archives the same way, so a transient failure
 * here just defers the drain by one tick rather than losing it.
 */
async function archiveHealthyInstanceEvents(
  db: NonNullable<typeof supabaseAdmin>,
  instanceIds: string[],
): Promise<number> {
  const ids = Array.from(
    new Set(instanceIds.filter((id) => typeof id === "string" && id.trim().length > 0)),
  );
  if (ids.length === 0) return 0;

  let archived = 0;
  for (let i = 0; i < ids.length; i += ARCHIVE_ID_CHUNK_SIZE) {
    const { data, error } = await db
      .from("ops_events")
      .update({ archived_at: new Date().toISOString() })
      .eq("source", HEALTH_EVENT_SOURCE)
      .is("archived_at", null)
      .in("instance_id", ids.slice(i, i + ARCHIVE_ID_CHUNK_SIZE))
      .select("id");
    if (error) {
      log.warn("instance-health-sweep healthy-event archive failed", {
        source: "probe-instance-health",
        failureType: "instance_health_archive_failed",
        errorMessage: error.message,
      });
      continue;
    }
    archived += data?.length ?? 0;
  }
  return archived;
}

/**
 * Archive the open USER-FACING action/runtime failure events for instances that
 * probed healthy this run. Companion to archiveHealthyInstanceEvents (which only
 * closes the prober's own `synthetic.instance-health` rows). The Console's
 * "ACTIVE FAILURE OWNERSHIP" banner is the latest unarchived
 * instance-actions/orchestrator failure for the instance; a 500 from a
 * timed-out Update/Repair/Redeploy (or an ssh-exec failure) wrote one and
 * nothing closed it on recovery, so a healthy-again box kept a permanent
 * failure banner and the owner re-clicked into more 500s. Best-effort +
 * self-reviving: reportOpsEvent un-archives the fingerprint on the next genuine
 * failure, so this loses no audit trail. Same id-chunking as the health archive.
 */
async function archiveResolvedActionFailureEvents(
  db: NonNullable<typeof supabaseAdmin>,
  instanceIds: string[],
): Promise<number> {
  const ids = Array.from(
    new Set(instanceIds.filter((id) => typeof id === "string" && id.trim().length > 0)),
  );
  if (ids.length === 0) return 0;

  let archived = 0;
  for (let i = 0; i < ids.length; i += ARCHIVE_ID_CHUNK_SIZE) {
    const { data, error } = await db
      .from("ops_events")
      .update({ archived_at: new Date().toISOString() })
      .is("archived_at", null)
      .in("source", ACTION_FAILURE_SOURCES)
      .in("metadata->>failureType", ACTION_FAILURE_RESOLVED_TYPES)
      .in("instance_id", ids.slice(i, i + ARCHIVE_ID_CHUNK_SIZE))
      .select("id");
    if (error) {
      log.warn("instance-health-sweep action-failure archive failed", {
        source: "probe-instance-health",
        failureType: "instance_action_failure_archive_failed",
        errorMessage: error.message,
      });
      continue;
    }
    archived += data?.length ?? 0;
  }
  return archived;
}

/**
 * Reset the consecutive-failure counters for instances that probed healthy
 * this run. Done in bulk (delete the rows) so a recovered instance starts
 * fresh and a future flap needs two NEW failing ticks before paging again.
 * Best-effort — a missed reset just means the next failing tick reads a stale
 * count, which at worst pages one tick early.
 */
async function resetHealthyProbeFailureCounters(
  db: NonNullable<typeof supabaseAdmin>,
  instanceIds: string[],
): Promise<void> {
  const ids = Array.from(
    new Set(instanceIds.filter((id) => typeof id === "string" && id.trim().length > 0)),
  );
  if (ids.length === 0) return;
  for (let i = 0; i < ids.length; i += ARCHIVE_ID_CHUNK_SIZE) {
    const { error } = await db
      .from("instance_health_probe_state")
      .delete()
      .in("instance_id", ids.slice(i, i + ARCHIVE_ID_CHUNK_SIZE));
    if (error) {
      log.warn("instance-health-sweep failure-counter reset failed", {
        source: "probe-instance-health",
        failureType: "instance_health_counter_reset_failed",
        errorMessage: error.message,
      });
    }
  }
}

/**
 * Clear hermes_instances.auto_restart_attempts for instances that probed
 * healthy this run.
 *
 * recover-unhealthy-active-instances BUMPS this counter on every redeploy of
 * an active+running row that stays gateway-unhealthy and, at the 3-attempt
 * cap, pages a fatal synthetic.auto-repair-exhausted. The ONLY reset lived in
 * recover-stuck-instances — but that sweep only touches failed/provisioning/
 * redeploying rows, so an active+running box that flapped unhealthy
 * (attempts→N) then recovered on its own kept its stale counter forever. The
 * next lone failure then tipped it straight to the cap and paged on a healthy
 * VM (part of the 2026-06-30 fixturecase06… incident, where a bad bridge-IP
 * gateway_url drove auto_restart_attempts to 3/3 on a perfectly healthy box).
 * This sweep is the authoritative "healthy right now" signal for the whole
 * running fleet, so reset here too.
 *
 * Filtered server-side to attempts>0 so a healthy fleet isn't rewritten every
 * tick — only rows that actually carry a stale counter are touched. Chunked
 * (PostgREST `.in()` request-line limit) and best-effort: a missed reset just
 * defers the clear to the next healthy tick.
 */
async function resetHealthyAutoRestartAttempts(
  db: NonNullable<typeof supabaseAdmin>,
  instanceIds: string[],
): Promise<void> {
  const ids = Array.from(
    new Set(instanceIds.filter((id) => typeof id === "string" && id.trim().length > 0)),
  );
  if (ids.length === 0) return;
  const nowIso = new Date().toISOString();
  for (let i = 0; i < ids.length; i += ARCHIVE_ID_CHUNK_SIZE) {
    const { error } = await db
      .from("hermes_instances")
      .update({ auto_restart_attempts: 0, updated_at: nowIso })
      .in("id", ids.slice(i, i + ARCHIVE_ID_CHUNK_SIZE))
      .gt("auto_restart_attempts", 0);
    if (error) {
      log.warn("instance-health-sweep auto-restart-attempts reset failed", {
        source: "probe-instance-health",
        failureType: "instance_health_auto_restart_reset_failed",
        errorMessage: error.message,
      });
    }
  }
}

/**
 * Bump (upsert) the consecutive-failure counter for a single instance and
 * return the NEW count. The generic-event branch opens an ops event only once
 * this count reaches HEALTH_FAILURE_OPEN_THRESHOLD, so one AbortError under
 * prober load (count 1) stays silent while a genuine outage (count >= 2 across
 * consecutive ticks) surfaces. Returns the threshold value on a read/write
 * error so a DB hiccup fails OPEN (better a slightly noisy event than a
 * swallowed real outage).
 */
async function bumpProbeFailureCounter(
  db: NonNullable<typeof supabaseAdmin>,
  instanceId: string,
): Promise<number> {
  try {
    const nowIso = new Date().toISOString();
    const { data: existing } = await db
      .from("instance_health_probe_state")
      .select("consecutive_failures")
      .eq("instance_id", instanceId)
      .maybeSingle();
    const next = (existing?.consecutive_failures ?? 0) + 1;
    const { error } = await db
      .from("instance_health_probe_state")
      .upsert(
        {
          instance_id: instanceId,
          consecutive_failures: next,
          last_failure_at: nowIso,
          updated_at: nowIso,
        },
        { onConflict: "instance_id" },
      );
    if (error) {
      log.warn("instance-health-sweep failure-counter bump failed", {
        source: "probe-instance-health",
        failureType: "instance_health_counter_bump_failed",
        instanceId,
        errorMessage: error.message,
      });
      return HEALTH_FAILURE_OPEN_THRESHOLD;
    }
    return next;
  } catch (err) {
    log.warn("instance-health-sweep failure-counter bump threw", {
      source: "probe-instance-health",
      failureType: "instance_health_counter_bump_threw",
      instanceId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return HEALTH_FAILURE_OPEN_THRESHOLD;
  }
}

/**
 * Probe every running instance with a non-empty gateway_url and report
 * failures to ops_events. Exists as a pure function (no Next request
 * context) so the same code path can run from cron, from a manual
 * script, or from a future "Run health check" dashboard button.
 */
export async function runInstanceHealthSweep(): Promise<InstanceHealthSweepResult> {
  const db = supabaseAdmin;
  if (!db) {
    throw new Error("Supabase admin client not configured");
  }

  const { data, error } = await db
    .from("hermes_instances")
    .select("id, user_id, gateway_url, status, backend, infrastructure_provider, hetzner_server_id, ipv4_address, proxmox_vmid, proxmox_node, product_surface, lifecycle_state, deleted_at, scheduled_deletion_at")
    .eq("status", "running")
    .not("gateway_url", "is", null);

  if (error) {
    throw new Error(error.message || "Failed to fetch instances");
  }

  const rows = (data ?? []) as InstanceHealthProbeRow[];

  // Drop intentionally-paused boxes before probing. The status='running' filter
  // above is NOT enough: a paused row's `status` can drift back to 'running'
  // while lifecycle_state stays 'paused' (the inactivity sweep sets BOTH, but a
  // later reconcile can re-stamp status alone), so paused VMs leak into the
  // probe set and — being powered off — fail every /health probe. One paused box
  // logged 2090+ bogus failures since mid-May. lifecycle_state='paused' is the
  // authoritative "intentionally off" marker (recover-unhealthy-active gates on
  // lifecycle_state='active' for the same reason), so a healthy box is never
  // excluded here. See isPausedLifecycleState.
  const liveRows = rows.filter((row) => !isPausedLifecycleState(row.lifecycle_state));
  const skippedPaused = rows.length - liveRows.length;

  const probable = liveRows.filter(
    (row): row is InstanceHealthProbeRow & { gateway_url: string } =>
      typeof row.gateway_url === "string" && row.gateway_url.trim().length > 0,
  );

  // Probe in bounded batches. Within a batch the probes run in parallel (each
  // has a hard PROBE_TIMEOUT_MS cap), but we only keep PROBE_BATCH_SIZE in
  // flight at once so a ~500-instance fleet no longer stampedes one serverless
  // invocation into self-inflicted AbortErrors. Worst-case wall time is
  // ~ceil(N / PROBE_BATCH_SIZE) * PROBE_TIMEOUT_MS, comfortably inside the
  // cron envelope for the current fleet.
  const results: InstanceHealthProbeResult[] = [];
  for (const batch of chunk(probable, PROBE_BATCH_SIZE)) {
    const batchResults = await Promise.all(
      batch.map((row): Promise<InstanceHealthProbeResult> => {
        const configIssue = getHetznerGatewayConfigIssue(row);
        if (configIssue) {
          return Promise.resolve({
            instanceId: row.id,
            gatewayUrl: row.gateway_url,
            status: null,
            ok: false,
            durationMs: 0,
            errorName: "GatewayConfigurationError",
            errorMessage: `Hetzner gateway_url must use ${configIssue.expectedGatewayUrl}`,
            expectedGatewayUrl: configIssue.expectedGatewayUrl,
          } satisfies InstanceHealthProbeResult);
        }
        return probeInstanceGateway({ instanceId: row.id, gatewayUrl: row.gateway_url });
      }),
    );
    results.push(...batchResults);
  }

  let failed = 0;
  let recoveredViaFallback = 0;
  let suppressedPendingFailures = 0;
  // Instances that probed healthy this run — primary probe ok, OR a generic
  // failure that a fallback candidate URL rescued. We archive their open
  // synthetic.instance-health events at the end so the prober closes what it
  // opens instead of growing the backlog forever.
  const healthyInstanceIds = new Set<string>();
  for (let i = 0; i < results.length; i += 1) {
    if (results[i].ok) healthyInstanceIds.add(probable[i].id);
  }

  await Promise.all(
    results.map(async (result, index) => {
      if (result.ok) return;
      const row = probable[index];

      // tlsWedged path: HTTP/2 broke but HTTP/1.1 worked. This is the
      // Caddy certmagic-panic signature — invisible to the simpler
      // "probe failed" path. Severity=fatal so it surfaces above the
      // noise on /dashboard/ops, and the title/source string lets an
      // operator grep for it. Recovery is the caddy stop/start in the
      // message below.
      if (result.tlsWedged) {
        failed += 1;
        await reportOpsEvent({
          source: "synthetic.tls-wedged",
          severity: "fatal",
          // Title + message MUST be stable for a given wedged instance — this is
          // a fatal event on the every-5-min probe cron, and reportOpsEvent
          // fingerprints on (source,title,message,route,instanceId) and pages only
          // on first sighting. The raw h2 error string + h1.1 status vary probe to
          // probe for the SAME wedge (undici surfaces many error shapes), so
          // embedding them here re-paged every 5 min. They live in metadata
          // (h2ErrorName/h2ErrorMessage/h11Status), which is NOT fingerprinted.
          title: `Caddy TLS wedged on ${result.gatewayUrl} — h2 fails, h1.1 works`,
          message:
            `HTTP/2 probe to ${result.gatewayUrl}/health failed with a TLS/protocol ` +
            `error, but the same request over HTTP/1.1 succeeded. Browsers negotiate ` +
            `h2 by default and cannot reach this agent. Recovery: SSH to the Proxmox ` +
            `host and run 'systemctl stop caddy && sleep 2 && systemctl start caddy'. ` +
            `The exact h2 error + h1.1 status are in this event's metadata.`,
          instanceId: row.id,
          userId: row.user_id,
          metadata: {
            failureOwner: "hypervisor",
            failurePhase: "network",
            failureType: "caddy_tls_wedged",
            recoveryAction: "restart_gateway",
            gatewayUrl: result.gatewayUrl,
            h2ErrorName: result.errorName,
            h2ErrorMessage: result.errorMessage,
            h11Status: result.status,
            backend: row.backend,
            durationMs: result.durationMs,
          },
        });
        return;
      }

      if (result.expectedGatewayUrl) {
        failed += 1;
        await reportOpsEvent({
          source: "synthetic.gateway-config",
          severity: "fatal",
          title: `Hetzner gateway URL is not canonical: ${result.gatewayUrl}`,
          message:
            `Hetzner instance ${row.id} has gateway_url=${result.gatewayUrl}, ` +
            `but Hetzner gateways must use ${result.expectedGatewayUrl}. ` +
            `Custom hermesos.cloud hostnames do not self-create DNS records and ` +
            `will fail before reaching the instance. Recovery: update gateway_url ` +
            `and the instance Caddy site label to ${result.expectedGatewayUrl}.`,
          instanceId: row.id,
          userId: row.user_id,
          metadata: {
            failureOwner: "control-plane",
            failurePhase: "routing",
            failureType: "hetzner_gateway_url_not_sslip",
            recoveryAction: "canonicalize_gateway_url",
            gatewayUrl: result.gatewayUrl,
            expectedGatewayUrl: result.expectedGatewayUrl,
            hetznerServerId: row.hetzner_server_id ?? null,
            ipv4Address: row.ipv4_address ?? null,
            backend: row.backend,
          },
        });
        return;
      }

      if (
        result.tlsError &&
        row.infrastructure_provider === "proxmox" &&
        result.gatewayUrl.includes(".agents.hermesos.cloud")
      ) {
        failed += 1;
        await reportOpsEvent({
          source: "synthetic.gateway-route",
          severity: "fatal",
          title: `Proxmox gateway route or certificate missing: ${result.gatewayUrl}`,
          message:
            `TLS failed before ${result.gatewayUrl}/health returned an HTTP response. ` +
            `For Proxmox agents.hermesos.cloud gateways this usually means the host Caddy ` +
            `does not have a current site route/certificate for the DB gateway_url. ` +
            `Recovery: rebuild the per-instance Caddy route for VM ${row.proxmox_vmid ?? "<unknown>"}, ` +
            `validate Caddy, reload it, and re-probe the gateway.`,
          instanceId: row.id,
          userId: row.user_id,
          metadata: {
            failureOwner: "hypervisor",
            failurePhase: "routing",
            failureType: "proxmox_caddy_route_or_cert_missing",
            recoveryAction: "rebuild_caddy_route",
            gatewayUrl: result.gatewayUrl,
            proxmoxVmid: row.proxmox_vmid ?? null,
            backend: row.backend,
            durationMs: result.durationMs,
            errorName: result.errorName,
            errorMessage: result.errorMessage,
          },
        });
        return;
      }

      // Generic gateway failure. If the primary probe THREW (status null —
      // a TLS/network error where the stored gateway host might be down
      // while a fallback candidate URL still answers), confirm against the
      // recover-unhealthy-active reachable set before opening an event. An
      // HTTP response (5xx, or a Cloudflare 520–527 edge code) is NOT
      // re-confirmed: the gateway host already answered, so re-probing the
      // same set can't disagree — emit straight away and let host-wedge
      // aggregation correlate the edge codes. This is the guard that stops
      // the prober from flagging instances recover-unhealthy-active is
      // simultaneously probing healthy and archiving.
      if (result.status === null) {
        const reachable = await confirmReachableViaRecoverySet(row);
        if (reachable) {
          recoveredViaFallback += 1;
          healthyInstanceIds.add(row.id);
          log.info("instance-health-sweep generic failure rescued by fallback URL", {
            source: "probe-instance-health",
            failureType: "instance_health_fallback_reachable",
            instanceId: row.id,
            userId: row.user_id,
            gatewayUrl: result.gatewayUrl,
          });
          return;
        }
      }

      failed += 1;

      // Consecutive-failure gate. A single failing tick — the classic prober
      // AbortError under load — bumps the counter but does NOT open an event.
      // Only the SECOND consecutive failing tick (count >= threshold) opens the
      // generic synthetic.instance-health event, so the prober stops crying
      // wolf. A healthy tick deletes the counter (resetHealthyProbeFailureCounters),
      // so two non-consecutive blips never accumulate to an open. The
      // deterministic fatal branches above (config / tls-wedged / route /
      // host-wedge) are NOT gated — those are high-confidence, not flaky.
      const consecutiveFailures = await bumpProbeFailureCounter(db, row.id);
      if (consecutiveFailures < HEALTH_FAILURE_OPEN_THRESHOLD) {
        suppressedPendingFailures += 1;
        log.info("instance-health-sweep failure below open threshold — not yet opening event", {
          source: "probe-instance-health",
          failureType: "instance_health_failure_pending",
          instanceId: row.id,
          userId: row.user_id,
          gatewayUrl: result.gatewayUrl,
          consecutiveFailures,
        });
        return;
      }

      await reportOpsEvent({
        source: "synthetic.instance-health",
        severity: "error",
        title: `Instance gateway unhealthy: ${result.gatewayUrl}`,
        message: result.errorMessage
          ? `Probe to ${result.gatewayUrl}/health failed: ${result.errorName}: ${result.errorMessage}`
          : `Probe to ${result.gatewayUrl}/health returned ${result.status}`,
        instanceId: row.id,
        userId: row.user_id,
        metadata: {
          failureOwner: "runtime",
          failurePhase: "runtime",
          failureType: "instance_gateway_unhealthy",
          recoveryAction: "repair_runtime",
          gatewayUrl: result.gatewayUrl,
          status: result.status,
          backend: row.backend,
          durationMs: result.durationMs,
          errorName: result.errorName,
          consecutiveFailures,
        },
      });
    }),
  );

  await emitProxmoxHostWedgeEvents(probable, results);

  // Self-heal: close open synthetic.instance-health events for every
  // instance that probed healthy this run. The prober used to be
  // append-only — open on failure, never close on recovery — so the
  // backlog only ever shrank via the rate-limited recover-unhealthy-active
  // cron (active+running+webui only, ≤5 repairs/run). reportOpsEvent
  // revives an archived fingerprint on the next genuine failure, so
  // archiving here loses nothing.
  const archivedHealthy = await archiveHealthyInstanceEvents(db, [...healthyInstanceIds]);

  // Self-heal the USER-FACING failure banner too. A 500 from a timed-out
  // Update/Repair/Redeploy (or an ssh-exec failure) writes an
  // instance-actions/orchestrator failure event that the Console pins as
  // "ACTIVE FAILURE OWNERSHIP" — and nothing closed it on recovery, so a box
  // that recreated healthy kept a permanent failure banner that scared the
  // owner into re-clicking. Close those on the same verified-healthy signal
  // (self-reviving on the next real failure).
  const archivedActionFailures = await archiveResolvedActionFailureEvents(db, [
    ...healthyInstanceIds,
  ]);

  // Reset the consecutive-failure gate for every instance that probed healthy
  // this run so a recovered instance starts fresh — a later flap needs two NEW
  // consecutive failing ticks before it can page again.
  await resetHealthyProbeFailureCounters(db, [...healthyInstanceIds]);

  // Clear the auto-restart-attempts counter for the same verified-healthy set
  // so a recovered active/running box can't be tipped to the auto-repair cap by
  // a single later failure (recover-unhealthy-active only ever bumps it; the
  // sole reset lived in recover-stuck, which never sees active/running rows).
  await resetHealthyAutoRestartAttempts(db, [...healthyInstanceIds]);

  // Backend-lane guard (2026-06-15 incident durability net). A healthy, active,
  // Proxmox hermesos instance MUST be on a WEBFREE backend (post Phase-2 collapse,
  // both "webui" and "gateway" build the webfree stack — see isWebfreeBackend). A
  // box on any NON-webfree backend would fall to the legacy stack that serves NO
  // public dashboard shell (catch-all → agent gateway :8642 → 404 GET /), so the
  // workspace iframe 404s while /health is 200 — invisible to the probe above.
  // Pure DB-field check (no extra HTTP/load), so it fires the instant a
  // provision/redeploy regression strands a box on a non-webfree backend. Scoping
  // mirrors recover-unhealthy-active's predicate (active + running + not deleted/
  // scheduled) so the two sweeps agree, limited to Proxmox (the incident blast
  // radius). workspace_cloud sets backend explicitly and is excluded. Verified 0
  // violators across the live fleet; HERMES_BACKEND_LANE_GUARD=off is the kill-switch.
  const backendLaneViolators =
    process.env.HERMES_BACKEND_LANE_GUARD === "off"
      ? []
      : probable.filter(
          (row) =>
            !isWebfreeBackend(row.backend) &&
            row.infrastructure_provider === "proxmox" &&
            (row.product_surface ?? "hermesos") !== "workspace_cloud" &&
            (row.lifecycle_state ?? "active") === "active" &&
            !row.deleted_at &&
            !row.scheduled_deletion_at,
        );
  const backendLaneViolations = backendLaneViolators.length;
  if (backendLaneViolations > 0) {
    // ONE aggregated fatal per sweep — a fleet-wide regression must page ONCE,
    // not once per box. Message is intentionally STABLE (count/ids only in
    // metadata) so reportOpsEvent's message-keyed fingerprint dedupes across
    // ticks and pages a single first-sighting fatal until resolved.
    await reportOpsEvent({
      source: "instance-health-sweep",
      severity: "fatal",
      title: "Instances on a non-webfree backend (no public dashboard shell)",
      message:
        `One or more running Proxmox instances are on a NON-webfree backend ` +
        `(expected webui or gateway); their dashboards 404 in the workspace iframe ` +
        `(no public /webchat or /dash shell). A deploy path regressed the default ` +
        `backend or a backend branch point — see the 2026-06-15 webfree-backend ` +
        `incident. Count + sample instance ids are in this event's metadata.`,
      metadata: {
        failureType: "instance_backend_not_webfree",
        count: backendLaneViolations,
        sampleInstanceIds: backendLaneViolators.slice(0, 25).map((r) => r.id),
      },
    });
  }

  // Clock-skew guard (2026-07-01 fixturenodea blank-chat incident durability net). A box
  // whose clock drifts past the webui-login token window serves a blank chat while
  // /health stays 200 — invisible to the probe above. We read the box's HTTP `Date`
  // header during the /health probe (no extra request/load) and page when any box is
  // more than CLOCK_SKEW_ALERT_MS off our NTP-correct clock, catching a host whose
  // chrony silently stopped syncing BEFORE its tenants hit the cliff. ONE aggregated
  // fatal per sweep with a STABLE message (count/skew/ids only in metadata) so
  // reportOpsEvent's message-keyed fingerprint dedupes across ticks. Kill-switch:
  // HERMES_CLOCK_SKEW_GUARD=off.
  const clockSkewViolators =
    process.env.HERMES_CLOCK_SKEW_GUARD === "off"
      ? []
      : results.filter(
          (r) =>
            typeof r.clockSkewMs === "number" &&
            Math.abs(r.clockSkewMs) > CLOCK_SKEW_ALERT_MS,
        );
  if (clockSkewViolators.length > 0) {
    const worst = clockSkewViolators.reduce((a, b) =>
      Math.abs(b.clockSkewMs as number) > Math.abs(a.clockSkewMs as number) ? b : a,
    );
    await reportOpsEvent({
      source: "instance-health-sweep",
      severity: "fatal",
      title: "Instances with host clock skew (webui login handoff at risk)",
      message:
        `One or more running instances report an HTTP Date more than ` +
        `${Math.round(CLOCK_SKEW_ALERT_MS / 1000)}s off our NTP-correct clock. A box whose ` +
        `clock drifts past the webui-login token window serves a blank chat (the 30s login ` +
        `token expires on arrival -> 401) while /health stays 200. Usually a Proxmox host ` +
        `whose chrony is stuck on the unreachable 2.debian.pool default and free-running — ` +
        `repoint at reachable NTP and step the guests. ` +
        `Count, worst skew, and sample instance ids are in this event's metadata.`,
      metadata: {
        failureType: "instance_clock_skew",
        count: clockSkewViolators.length,
        thresholdMs: CLOCK_SKEW_ALERT_MS,
        worstSkewMs: worst.clockSkewMs,
        worstInstanceId: worst.instanceId,
        sampleInstanceIds: clockSkewViolators.slice(0, 25).map((r) => r.instanceId),
      },
    });
  }

  return {
    probed: probable.length,
    failed,
    recoveredViaFallback,
    suppressedPendingFailures,
    skippedPaused,
    archivedHealthy,
    archivedActionFailures,
    backendLaneViolations,
    results,
  };
}

// Cloudflare 520–527 are the "I tried to reach origin and couldn't" range.
// 521 specifically = "Web server is down" — Cloudflare's edge could not
// open a TCP connection to the origin. When several instances on the same
// Proxmox host return one of these in the same probe run, the host (or
// its Caddy) is the common factor, not any individual VM. The h1.1
// fallback above can't catch this because Cloudflare absorbs the wedge
// and serves a clean 521 response — from the probe's POV that's a
// successful HTTP response, just with a bad status.
const CLOUDFLARE_ORIGIN_UNREACHABLE_STATUSES = new Set([520, 521, 522, 523, 524, 525, 526, 527]);

const HOST_WEDGE_MIN_INSTANCES = 2;

async function emitProxmoxHostWedgeEvents(
  probable: ReadonlyArray<InstanceHealthProbeRow & { gateway_url: string }>,
  results: ReadonlyArray<InstanceHealthProbeResult>,
): Promise<void> {
  const wedgesByNode = new Map<
    string,
    Array<{ instanceId: string; gatewayUrl: string; status: number | null }>
  >();

  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (result.ok) continue;
    const row = probable[i];
    if (row.infrastructure_provider !== "proxmox") continue;
    const node = row.proxmox_node?.trim();
    if (!node) continue;
    const status = typeof result.status === "number" ? result.status : null;
    if (status === null || !CLOUDFLARE_ORIGIN_UNREACHABLE_STATUSES.has(status)) continue;

    const bucket = wedgesByNode.get(node) ?? [];
    bucket.push({ instanceId: row.id, gatewayUrl: result.gatewayUrl, status });
    wedgesByNode.set(node, bucket);
  }

  for (const [node, affected] of wedgesByNode) {
    if (affected.length < HOST_WEDGE_MIN_INSTANCES) continue;

    const statusCounts = affected.reduce<Record<string, number>>((acc, item) => {
      const key = String(item.status);
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});

    await reportOpsEvent({
      source: "synthetic.proxmox-host-wedged",
      severity: "fatal",
      // Title + message MUST be stable per node. This fatal has NO instanceId, so
      // title+message are its only fingerprint discriminators, and it fires every
      // 5-min probe tick while the host stays wedged. The affected COUNT and the
      // per-status breakdown flap tick to tick as VMs trip/recover, so embedding
      // them re-paged every 5 min. They live in metadata (affectedInstanceCount /
      // statusCounts / affectedInstanceIds), which is NOT fingerprinted — so an
      // ongoing host wedge now pages once per node. Mirrors the backend-lane fatal.
      title: `Proxmox host ${node}: multiple gateways unreachable from Cloudflare`,
      message:
        `Multiple instances on Proxmox node ${node} returned Cloudflare "origin ` +
        `unreachable" codes (520–527) in a single probe run. The shared factor is the ` +
        `host, not any individual VM — most often Caddy on the host has wedged or ` +
        `stopped listening on the origin port. Recovery: SSH to ${node} and run ` +
        `'systemctl restart caddy' (see RUNBOOK). Affected count + per-status ` +
        `breakdown + instance ids are in this event's metadata.`,
      metadata: {
        failureOwner: "hypervisor",
        failurePhase: "network",
        failureType: "proxmox_host_origin_unreachable",
        recoveryAction: "restart_host_caddy",
        proxmoxNode: node,
        affectedInstanceCount: affected.length,
        affectedInstanceIds: affected.map((a) => a.instanceId),
        statusCounts,
      },
    });
  }
}
