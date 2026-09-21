import "server-only";

import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";
import {
  getProxmoxVmidAvailability,
  runProxmoxHostScript,
  type ProxmoxHostRoutingConfig,
  type ProxmoxVmidAvailability,
} from "@/lib/services/proxmox-instance-service";

/**
 * Provisioning guards for the Proxmox fleet.
 *
 * Three ops-hardening guards, each traced to a real incident that black-holed
 * onboarding. They are deliberately kept OUT of the provisioning happy path:
 * every function here either runs on a failure branch, or short-circuits to a
 * no-op when the host is healthy.
 *
 *  1. HOST-REGISTRATION PREFLIGHT (`guardProxmoxHostPlacementReadiness`)
 *     2026-06-09/10: a never-seeded host registered `status='active'` with 0
 *     tenants, therefore won every free-capacity placement, and every provision
 *     died ~100s in at the Caddy origin-cert gate ("[caddy] missing Cloudflare
 *     Origin CA cert/key ... seed the host before provisioning" x26).
 *     Placement had no way to know the host was unseeded until it had already
 *     burned a user's provision.
 *
 *  2. VMID-RANGE UTILIZATION (`reportProxmoxVmidRangeUtilization`)
 *     2026-06-08: "No free Proxmox VMID in range 1300-1349" — 97 API 500s.
 *     The range filled silently; nothing warned on the way up.
 *
 *  3. CORRELATED-FAILURE ESCALATION (`reportCorrelatedProxmoxHostFailure`)
 *     2026-06-25: `host_caddy_invalid` on fixturenodea, fixturenodea, fixturenodea and fixturenodea
 *     simultaneously. Per-host placement failover worked exactly as designed —
 *     and was useless, because every failover candidate carried the same bad
 *     config. Failover cannot save you from a correlated failure; only a page
 *     can. This is the page.
 *
 *  4. HOST-REGISTRY UNAVAILABILITY (`reportProxmoxHostRegistryUnavailable`)
 *     2026-05-12/14: `column proxmox_hosts.thinpool_size_gb does not exist`
 *     x70 (plus one `Could not find the table 'public.proxmox_hosts'` on
 *     05-10). A code/DB schema skew made the registry query fail on EVERY
 *     placement for ~2.5 days. Placement silently fell through to the legacy
 *     env-order path, and nothing gated on it. Benign then (the registry had
 *     no rows yet); today the same skew would route every new agent onto the
 *     hosts ops has deliberately drained. This is the gate.
 */

const LOG_SOURCE = "proxmox-host-guards";
const OPS_SOURCE = "proxmox-host-guards";

/**
 * Source of the host-local provision failure ops_events that
 * `reportCorrelatedProxmoxHostFailure` correlates over. Matches
 * `LOG_SOURCE` in instance-service.ts, which is what `log.error` stamps
 * onto the mirrored ops_event.
 */
const PROVISION_FAILURE_OPS_SOURCE = "instance-service";

export type ProxmoxHostLocalFailureClass =
  | "host_cert_seed_missing"
  | "host_cert_seed_expiring"
  | "host_cert_seed_mismatch"
  | "host_cert_seed_invalid"
  | "host_bridge_missing"
  | "host_template_clone_failed"
  | "host_caddy_invalid"
  | "host_caddy_cert_drift"
  | "host_caddy_unresponsive"
  | "host_provision_lock_timeout"
  | "host_unreachable"
  | "host_script_failure";

/** Classes the preflight probe can assert on directly, before any provision. */
type ProxmoxHostPreflightFailureClass =
  | "host_cert_seed_missing"
  | "host_cert_seed_expiring"
  | "host_cert_seed_mismatch"
  | "host_cert_seed_invalid"
  | "host_bridge_missing"
  | "host_caddy_invalid"
  | "host_caddy_cert_drift"
  | "host_caddy_unresponsive"
  | "host_vmid_range_exhausted";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Warn once a host has consumed more than this share of its VMID range. */
const DEFAULT_VMID_UTILIZATION_WARN_RATIO = 0.8;

/** Two distinct hosts failing the same way inside this window is correlated. */
const DEFAULT_CORRELATION_WINDOW_MS = 60 * 60 * 1000;

/** Distinct hosts required before a host-local failure escalates to FATAL. */
const CORRELATION_HOST_THRESHOLD = 2;

/** How long a passing config probe is trusted before it is re-run. */
const PREFLIGHT_PASS_TTL_MS = 30 * 1000;

/**
 * Failing probes get a much shorter TTL than passing ones: an operator who
 * just seeded a host should see it return to rotation in ~a minute, not wait
 * out a five-minute negative cache.
 */
const PREFLIGHT_FAIL_TTL_MS = 60 * 1000;

/** The config probe is cheap (stat + `ip link` + `caddy validate`). */
const PREFLIGHT_SCRIPT_TIMEOUT_MS = 30_000;

const PREFLIGHT_DONE_MARKER = "HERMES_HOST_PREFLIGHT_DONE";
const PREFLIGHT_FAIL_MARKER = "HERMES_HOST_PREFLIGHT_FAIL";

function resolveVmidUtilizationWarnRatio(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): number {
  const raw = env.HERMES_PROXMOX_VMID_UTILIZATION_WARN_RATIO?.trim();
  if (!raw) return DEFAULT_VMID_UTILIZATION_WARN_RATIO;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1
    ? parsed
    : DEFAULT_VMID_UTILIZATION_WARN_RATIO;
}

/**
 * Kill switch. Default ON. Set to "false" only to unblock provisioning if the
 * probe itself ever misfires — a conclusive probe failure is fail-closed, so a
 * bug here would otherwise take the fleet out of rotation.
 */
function isProxmoxHostPreflightEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): boolean {
  return env.HERMES_PROXMOX_HOST_PREFLIGHT_ENABLED?.trim().toLowerCase() !== "false";
}

// ---------------------------------------------------------------------------
// (a) Preflight probe
// ---------------------------------------------------------------------------

/**
 * Mirrors, check for check, the gates the Phase-1 provisioner script hits ~100s
 * into a provision — but as a read-only probe that costs one SSH round trip.
 *
 * The script ALWAYS exits 0. That is load-bearing: it lets the caller tell a
 * conclusive "this host is misconfigured" (script ran, printed FAIL markers)
 * apart from an inconclusive "we could not ask" (ssh died, timeout, truncated
 * output — no DONE marker). Only the former takes a host out of rotation.
 */
export function buildProxmoxHostPreflightScript(): string {
  return `#!/usr/bin/env bash
# Deliberately no 'set -e': every check must run so the caller sees ALL of a
# host's problems in one probe, and the script must exit 0 so that a non-zero
# exit unambiguously means "transport/exec failure", not "host unhealthy".
CERT=/etc/caddy/wildcards/hermesos.cloud.crt
KEY=/etc/caddy/wildcards/hermesos.cloud.key
CADDYFILE=/etc/caddy/Caddyfile

if [ ! -r "$CERT" ] || [ ! -r "$KEY" ]; then
  echo "${PREFLIGHT_FAIL_MARKER} host_cert_seed_missing missing Cloudflare Origin CA cert/key at /etc/caddy/wildcards/hermesos.cloud.{crt,key}; seed the host before provisioning"
else
  CERT_PUB=$(openssl x509 -in "$CERT" -pubkey -noout 2>/dev/null | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)
  KEY_PUB=$(openssl pkey -in "$KEY" -pubout -outform DER 2>/dev/null | sha256sum | cut -d' ' -f1)
  if [ -z "$CERT_PUB" ] || [ "$CERT_PUB" != "$KEY_PUB" ]; then
    echo "${PREFLIGHT_FAIL_MARKER} host_cert_seed_mismatch wildcard certificate and private key do not match"
  fi
  if ! openssl x509 -in "$CERT" -noout -checkend 2592000 >/dev/null 2>&1; then
    echo "${PREFLIGHT_FAIL_MARKER} host_cert_seed_expiring wildcard certificate expires within 30 days"
  fi
  CERT_ISSUER=$(openssl x509 -in "$CERT" -noout -issuer 2>/dev/null || true)
  if ! printf '%s' "$CERT_ISSUER" | grep -Fq "CloudFlare Origin SSL"; then
    echo "${PREFLIGHT_FAIL_MARKER} host_cert_seed_invalid wildcard certificate is not the required CloudFlare Origin SSL certificate"
  fi
  if ! openssl x509 -in "$CERT" -noout -checkhost hermesos.cloud >/dev/null 2>&1 ||
     ! openssl x509 -in "$CERT" -noout -checkhost preflight.hermesos.cloud >/dev/null 2>&1; then
    echo "${PREFLIGHT_FAIL_MARKER} host_cert_seed_invalid wildcard certificate does not cover hermesos.cloud and *.hermesos.cloud"
  fi
fi

if ! ip link show vmbr1 >/dev/null 2>&1; then
  echo "${PREFLIGHT_FAIL_MARKER} host_bridge_missing missing private bridge vmbr1; persist /etc/network/interfaces.d/vmbr1 and ifup vmbr1"
fi

if ! command -v caddy >/dev/null 2>&1; then
  echo "${PREFLIGHT_FAIL_MARKER} host_caddy_invalid caddy binary is not installed on this host"
elif [ -f "$CADDYFILE" ]; then
  # A host that has never taken a provision has no /etc/caddy/Caddyfile yet —
  # the Phase-1 script writes it. Only validate a Caddyfile that already
  # exists, otherwise a freshly-seeded host could never enter rotation.
  # Caddyfiles may reference service-only environment variables such as
  # {env.CLOUDFLARE_API_TOKEN}. A plain SSH shell does not inherit those, so
  # validate in the running service's environment when possible. Otherwise a
  # healthy host is falsely removed from placement even while Caddy is active.
  CADDY_PID=$(systemctl show caddy --property=MainPID --value 2>/dev/null || true)
  if command -v nsenter >/dev/null 2>&1 && [ "\${CADDY_PID:-0}" -gt 0 ] 2>/dev/null; then
    VALIDATE_ERR=$(timeout 12 nsenter --target "$CADDY_PID" --mount --env caddy validate --config "$CADDYFILE" 2>&1)
    VALIDATE_STATUS=$?
  else
    VALIDATE_ERR=$(timeout 12 caddy validate --config "$CADDYFILE" 2>&1)
    VALIDATE_STATUS=$?
  fi
  if [ "$VALIDATE_STATUS" -ne 0 ]; then
    echo "${PREFLIGHT_FAIL_MARKER} host_caddy_invalid invalid Caddyfile: $(printf '%s' "$VALIDATE_ERR" | tail -n 3 | tr '\\n' ' ')"
  fi

  if { grep -Il "/var/lib/caddy/.local/share/caddy/certificates" "$CADDYFILE" 2>/dev/null; grep -RIl "/var/lib/caddy/.local/share/caddy/certificates" /etc/caddy/hermes.d --include="*.caddy" 2>/dev/null; } | grep -q .; then
    echo "${PREFLIGHT_FAIL_MARKER} host_caddy_cert_drift active Caddy config references mutable CertMagic certificate storage"
  fi

  if ! systemctl is-active --quiet caddy; then
    echo "${PREFLIGHT_FAIL_MARKER} host_caddy_unresponsive caddy service is not active"
  else
    TLS_STATUS=$(curl -ksS --max-time 5 --resolve hermesos.cloud:443:127.0.0.1 -o /dev/null -w '%{http_code}' https://hermesos.cloud/ 2>/dev/null || true)
    if [ -z "$TLS_STATUS" ] || [ "$TLS_STATUS" = "000" ]; then
      echo "${PREFLIGHT_FAIL_MARKER} host_caddy_unresponsive local TLS handshake did not complete within 5 seconds"
    fi
  fi
fi

echo ${PREFLIGHT_DONE_MARKER}
`;
}

type ProxmoxHostConfigProbeResult =
  | { ok: true }
  | {
      ok: false;
      /**
       * True when the probe ran to completion and the host is definitively
       * misconfigured. False when we could not reach a verdict (ssh failure,
       * timeout, truncated output). Production placement fails closed and
       * tries another candidate instead of trusting an unverified host.
       */
      conclusive: boolean;
      failures: Array<{ failureClass: ProxmoxHostPreflightFailureClass; detail: string }>;
      detail: string;
    };

type RunHostScript = (
  script: string,
  env: NodeJS.ProcessEnv,
  timeoutMs?: number
) => Promise<{ ok: boolean; stdout: string; stderr: string; error?: string }>;

const defaultRunHostScript: RunHostScript = (script, env, timeoutMs) =>
  runProxmoxHostScript(script, env, timeoutMs);

function parsePreflightFailures(
  stdout: string
): Array<{ failureClass: ProxmoxHostPreflightFailureClass; detail: string }> {
  const failures: Array<{ failureClass: ProxmoxHostPreflightFailureClass; detail: string }> = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(PREFLIGHT_FAIL_MARKER)) continue;
    const rest = trimmed.slice(PREFLIGHT_FAIL_MARKER.length).trim();
    const spaceIdx = rest.indexOf(" ");
    const rawClass = (spaceIdx === -1 ? rest : rest.slice(0, spaceIdx)).trim();
    const detail = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim();
    if (
      rawClass === "host_cert_seed_missing" ||
      rawClass === "host_cert_seed_expiring" ||
      rawClass === "host_cert_seed_mismatch" ||
      rawClass === "host_cert_seed_invalid" ||
      rawClass === "host_bridge_missing" ||
      rawClass === "host_caddy_invalid" ||
      rawClass === "host_caddy_cert_drift" ||
      rawClass === "host_caddy_unresponsive"
    ) {
      failures.push({ failureClass: rawClass, detail: detail || rawClass });
    }
  }
  return failures;
}

/**
 * Run the (uncached) host config probe over SSH.
 */
async function runProxmoxHostConfigProbe(params: {
  env: NodeJS.ProcessEnv;
  runHostScript?: RunHostScript;
}): Promise<ProxmoxHostConfigProbeResult> {
  const runner = params.runHostScript ?? defaultRunHostScript;

  let result: { ok: boolean; stdout: string; stderr: string; error?: string } | undefined;
  try {
    result = await runner(buildProxmoxHostPreflightScript(), params.env, PREFLIGHT_SCRIPT_TIMEOUT_MS);
  } catch (err) {
    return {
      ok: false,
      conclusive: false,
      failures: [],
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  // A malformed runner result can never be read as "host is fine" — and must
  // never throw out of a guard and into the provisioning path.
  if (!result || typeof result !== "object") {
    return {
      ok: false,
      conclusive: false,
      failures: [],
      detail: "host preflight probe returned no result",
    };
  }

  const stdout = result.stdout ?? "";

  // No DONE marker => the script never finished. Inconclusive, never fatal.
  if (!stdout.includes(PREFLIGHT_DONE_MARKER)) {
    return {
      ok: false,
      conclusive: false,
      failures: [],
      detail:
        result.error?.slice(0, 300) ||
        result.stderr?.slice(0, 300) ||
        "host preflight probe produced no completion marker",
    };
  }

  const failures = parsePreflightFailures(stdout);
  if (failures.length === 0) return { ok: true };

  return {
    ok: false,
    conclusive: true,
    failures,
    detail: failures.map((f) => `${f.failureClass}: ${f.detail}`).join("; "),
  };
}

// --- TTL cache -------------------------------------------------------------

type CacheEntry = { expiresAt: number; result: ProxmoxHostConfigProbeResult };

const probeCache = new Map<string, CacheEntry>();

/** Test seam — the cache is module-level (per-lambda) state. */
export function __resetProxmoxHostPreflightCacheForTests(): void {
  probeCache.clear();
}

/**
 * Cached config probe. Keyed by target id so a fleet-wide placement pass costs
 * at most one SSH round trip per host per TTL, not one per candidate per
 * provision.
 */
async function checkProxmoxHostConfigProbeCached(params: {
  targetId: string | null;
  env: NodeJS.ProcessEnv;
  runHostScript?: RunHostScript;
  now?: number;
}): Promise<ProxmoxHostConfigProbeResult> {
  const now = params.now ?? Date.now();
  const cacheKey = params.targetId ?? "__default__";

  const cached = probeCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.result;

  const result = await runProxmoxHostConfigProbe({
    env: params.env,
    runHostScript: params.runHostScript,
  });

  // Inconclusive probes are not cached at all: caching "we couldn't tell"
  // would extend a transient ssh blip into a minute of blind placement.
  if (!result.ok && !result.conclusive) {
    probeCache.delete(cacheKey);
    return result;
  }

  probeCache.set(cacheKey, {
    result,
    expiresAt: now + (result.ok ? PREFLIGHT_PASS_TTL_MS : PREFLIGHT_FAIL_TTL_MS),
  });
  return result;
}

// --- Full preflight (config + VMID capacity) --------------------------------

export type ProxmoxHostPreflightResult =
  | { ok: true; targetId: string | null }
  | {
      ok: false;
      targetId: string | null;
      conclusive: boolean;
      failures: Array<{ failureClass: ProxmoxHostPreflightFailureClass; detail: string }>;
      detail: string;
    };

/**
 * Full host-registration preflight: everything placement needs to be true
 * before a host may be selected. Use this from ops tooling before flipping a
 * `proxmox_hosts` row to `status='active'`.
 *
 * `vmidAvailability` may be supplied by callers that already computed it (the
 * placement loop does) so the preflight never pays for a second SSH probe.
 */
export async function runProxmoxHostPreflight(params: {
  targetId: string | null;
  env: NodeJS.ProcessEnv;
  hostConfig?: ProxmoxHostRoutingConfig | null;
  vmidAvailability?: ProxmoxVmidAvailability;
  runHostScript?: RunHostScript;
  getVmidAvailability?: typeof getProxmoxVmidAvailability;
}): Promise<ProxmoxHostPreflightResult> {
  const configProbe = await runProxmoxHostConfigProbe({
    env: params.env,
    runHostScript: params.runHostScript,
  });

  const failures: Array<{ failureClass: ProxmoxHostPreflightFailureClass; detail: string }> =
    configProbe.ok ? [] : [...configProbe.failures];

  if (!configProbe.ok && !configProbe.conclusive) {
    return {
      ok: false,
      targetId: params.targetId,
      conclusive: false,
      failures,
      detail: configProbe.detail,
    };
  }

  const vmidAvailability =
    params.vmidAvailability ??
    (await (params.getVmidAvailability ?? getProxmoxVmidAvailability)({
      env: params.env,
      hostConfig: params.hostConfig ?? null,
    }));

  if (!vmidAvailability.ok) {
    // Could not read the allocator — inconclusive, so production placement
    // must try another host rather than provisioning without capacity proof.
    return {
      ok: false,
      targetId: params.targetId,
      conclusive: false,
      failures,
      detail: vmidAvailability.error,
    };
  }

  if (vmidAvailability.freeVmids.length === 0) {
    failures.push({
      failureClass: "host_vmid_range_exhausted",
      detail: `no free VMID in configured range ${vmidAvailability.vmidStart}-${vmidAvailability.vmidEnd}`,
    });
  }

  if (failures.length === 0) return { ok: true, targetId: params.targetId };

  return {
    ok: false,
    targetId: params.targetId,
    conclusive: true,
    failures,
    detail: failures.map((f) => `${f.failureClass}: ${f.detail}`).join("; "),
  };
}

// ---------------------------------------------------------------------------
// (b) Placement-time guard
// ---------------------------------------------------------------------------

export type ProxmoxHostPlacementGuardVerdict =
  | { skip: false }
  | {
      skip: true;
      status: number;
      message: string;
      error: Record<string, unknown>;
    };

/**
 * Placement-selection guard. Inconclusive readiness fails closed by default.
 * Callers may explicitly opt out for non-placement diagnostics, but production
 * tenant placement requires a current, conclusive pass and can try another
 * candidate host when one cannot be verified.
 */
export async function guardProxmoxHostPlacementReadiness(params: {
  targetId: string | null;
  env: NodeJS.ProcessEnv;
  userId?: string;
  runHostScript?: RunHostScript;
  now?: number;
  requireConclusivePass?: boolean;
}): Promise<ProxmoxHostPlacementGuardVerdict> {
  if (!isProxmoxHostPreflightEnabled(params.env)) return { skip: false };

  const probe = await checkProxmoxHostConfigProbeCached({
    targetId: params.targetId,
    env: params.env,
    runHostScript: params.runHostScript,
    now: params.now,
  });

  if (probe.ok) return { skip: false };

  if (!probe.conclusive) {
    const requireConclusivePass = params.requireConclusivePass !== false;

    log.warn(
      requireConclusivePass
        ? "Proxmox host preflight probe inconclusive; refusing unvouched placement"
        : "Proxmox host preflight probe inconclusive; allowing placement",
      {
        source: LOG_SOURCE,
        failureType: requireConclusivePass
          ? "proxmox_host_readiness_unverified"
          : "proxmox_host_preflight_inconclusive",
        userId: params.userId,
        targetId: params.targetId,
        detail: probe.detail,
      }
    );
    await reportOpsEvent({
      source: OPS_SOURCE,
      severity: "warn",
      title: `Proxmox host preflight inconclusive on ${params.targetId ?? "default target"}`,
      message:
        requireConclusivePass
          ? "The host readiness probe could not reach a verdict, so placement was refused. If this persists the orchestrator cannot see the host."
          : "The host readiness probe could not reach a verdict, so this non-strict caller allowed placement to proceed. If this persists the orchestrator cannot see the host.",
      metadata: {
        failureType: "proxmox_host_preflight_inconclusive",
        targetId: params.targetId,
        detail: probe.detail,
        requireConclusivePass,
      },
    });

    if (!requireConclusivePass) return { skip: false };

    return {
      skip: true,
      status: 503,
      message:
        "Deployment target is temporarily unavailable while the host is being prepared. Please try again shortly.",
      error: {
        code: "PROXMOX_HOST_READINESS_UNVERIFIED",
        targetId: params.targetId,
        recoveryAction: "restore_host_registry_or_remove_dead_host_from_targets",
      },
    };
  }

  const failureClasses = probe.failures.map((f) => f.failureClass);

  log.warn("skipping Proxmox host that failed registration preflight", {
    source: LOG_SOURCE,
    failureType: "proxmox_host_preflight_failed",
    userId: params.userId,
    targetId: params.targetId,
    failureClasses,
    detail: probe.detail,
  });

  // Fingerprint is stable per (host, failure classes): a misconfigured host
  // that keeps winning placement folds into one row with a rising
  // occurrence_count rather than one row per rejected provision.
  await reportOpsEvent({
    source: OPS_SOURCE,
    severity: "error",
    title: `Proxmox host failed registration preflight on ${params.targetId ?? "default target"}`,
    message: `Host is registered active but failed readiness checks (${failureClasses.join(", ")}) and was skipped for placement. Seed or repair the host, or mark it non-active in proxmox_hosts.`,
    metadata: {
      failureType: "proxmox_host_preflight_failed",
      targetId: params.targetId,
      failureClasses,
      detail: probe.detail,
      recoveryAction: "seed_or_repair_host_then_reactivate",
    },
  });

  return {
    skip: true,
    status: 503,
    message:
      "Deployment target is temporarily unavailable while the host is being prepared. Please try again shortly.",
    error: {
      code: "PROXMOX_HOST_PREFLIGHT_FAILED",
      targetId: params.targetId,
      failureClasses,
    },
  };
}

// ---------------------------------------------------------------------------
// (2) VMID range utilization
// ---------------------------------------------------------------------------

export type VmidUtilizationVerdict = "ok" | "warn" | "exhausted";

/**
 * Emit an ops_event when a host's configured VMID range is running out.
 *
 * `warn` above the configured ratio (default 80%), `fatal` on exhaustion — the
 * 2026-06-08 shape, where the range filled silently and users saw
 * "No free Proxmox VMID in range 1300-1349" as a 500.
 *
 * Fingerprints are stable per host so a saturated host pages once, not once per
 * provision attempt; the live counts ride in `metadata` (which is not part of
 * the fingerprint) and update on every sighting.
 */
export async function reportProxmoxVmidRangeUtilization(params: {
  targetId: string | null;
  vmidStart: number;
  vmidEnd: number;
  occupiedCount: number;
  freeCount: number;
  env?: NodeJS.ProcessEnv;
  userId?: string;
}): Promise<VmidUtilizationVerdict> {
  const total = params.vmidEnd - params.vmidStart + 1;
  if (!Number.isFinite(total) || total <= 0) return "ok";

  const warnRatio = resolveVmidUtilizationWarnRatio(params.env ?? process.env);
  const utilization = params.occupiedCount / total;
  const hostLabel = params.targetId ?? "default target";
  const rangeLabel = `${params.vmidStart}-${params.vmidEnd}`;

  if (params.freeCount === 0) {
    log.error(
      "Proxmox VMID range exhausted",
      new Error(`No free Proxmox VMID in range ${rangeLabel}`),
      {
        source: LOG_SOURCE,
        failureType: "proxmox_vmid_range_exhausted",
        // Already surfaced as a dedicated fatal ops_event below; the mirrored
        // error event would only duplicate it under a per-user fingerprint.
        reportOpsEvent: false,
        userId: params.userId,
        targetId: params.targetId,
        vmidStart: params.vmidStart,
        vmidEnd: params.vmidEnd,
        occupiedCount: params.occupiedCount,
        total,
      }
    );
    await reportOpsEvent({
      source: OPS_SOURCE,
      severity: "fatal",
      title: `Proxmox VMID range exhausted on ${hostLabel}`,
      message: `Every VMID in the configured range ${rangeLabel} is claimed. This host can no longer accept provisions — widen PROXMOX_VMID_START/PROXMOX_VMID_END or add capacity.`,
      metadata: {
        failureType: "proxmox_vmid_range_exhausted",
        targetId: params.targetId,
        vmidStart: params.vmidStart,
        vmidEnd: params.vmidEnd,
        occupiedCount: params.occupiedCount,
        freeCount: params.freeCount,
        total,
        recoveryAction: "widen_vmid_range_or_add_capacity",
      },
    });
    return "exhausted";
  }

  if (utilization > warnRatio) {
    log.warn("Proxmox VMID range utilization high", {
      source: LOG_SOURCE,
      failureType: "proxmox_vmid_range_utilization_high",
      userId: params.userId,
      targetId: params.targetId,
      vmidStart: params.vmidStart,
      vmidEnd: params.vmidEnd,
      occupiedCount: params.occupiedCount,
      freeCount: params.freeCount,
      total,
      utilization,
    });
    await reportOpsEvent({
      source: OPS_SOURCE,
      severity: "warn",
      title: `Proxmox VMID range over ${Math.round(warnRatio * 100)}% consumed on ${hostLabel}`,
      message: `Host has consumed more than ${Math.round(warnRatio * 100)}% of its configured VMID range ${rangeLabel}. Widen the range or add capacity before it exhausts and provisions start failing.`,
      metadata: {
        failureType: "proxmox_vmid_range_utilization_high",
        targetId: params.targetId,
        vmidStart: params.vmidStart,
        vmidEnd: params.vmidEnd,
        occupiedCount: params.occupiedCount,
        freeCount: params.freeCount,
        total,
        utilization,
        warnRatio,
        recoveryAction: "widen_vmid_range_or_add_capacity",
      },
    });
    return "warn";
  }

  return "ok";
}

// ---------------------------------------------------------------------------
// (3) Correlated host-local failure escalation
// ---------------------------------------------------------------------------

export type CorrelatedFailureResult = {
  correlated: boolean;
  hosts: string[];
};

/**
 * Escalate to FATAL when >= 2 DISTINCT hosts report the same host-local
 * failureClass inside the correlation window.
 *
 * Why this is the page-worthy signal: per-host failover is designed to route
 * around ONE bad host. When the same class lights up on two hosts, failover is
 * about to walk the whole candidate list and hand the user the generic
 * "Our capacity system hit a snag" 500 — exactly what happened on 2026-06-25
 * when fixturenodea/fixturenodea/fixturenodea/fixturenodea all had an invalid Caddyfile at once.
 *
 * The prior host sightings are read back out of ops_events (written by
 * instance-service's `log.error` mirror). The CURRENT host is unioned in from
 * memory rather than read back, because that mirror is fire-and-forget and may
 * not have landed yet.
 *
 * Dedup: the emitted fatal's fingerprint is a pure function of the
 * failureClass — the host list and counts live in `metadata`, which
 * `buildOpsEventFingerprint` ignores. A widening incident therefore keeps
 * updating one row (occurrence_count++) and, per reportOpsEvent's
 * INSERT-only paging branch, pages exactly once.
 */
export async function reportCorrelatedProxmoxHostFailure(params: {
  supabase?: typeof supabaseAdmin;
  failureClass: ProxmoxHostLocalFailureClass;
  targetId: string;
  windowMs?: number;
  now?: number;
}): Promise<CorrelatedFailureResult> {
  const supabase = params.supabase ?? supabaseAdmin;
  if (!supabase) return { correlated: false, hosts: [params.targetId] };

  const windowMs = params.windowMs ?? DEFAULT_CORRELATION_WINDOW_MS;
  const now = params.now ?? Date.now();
  const since = new Date(now - windowMs).toISOString();

  const hosts = new Set<string>([params.targetId]);

  try {
    const { data, error } = await supabase
      .from("ops_events")
      .select("metadata")
      .eq("source", PROVISION_FAILURE_OPS_SOURCE)
      .eq("metadata->>failureClass", params.failureClass)
      .gte("last_seen_at", since)
      .limit(500);

    if (error) {
      log.warn("correlated host-failure lookup failed", {
        source: LOG_SOURCE,
        failureType: "proxmox_correlated_failure_lookup_failed",
        failureClass: params.failureClass,
        targetId: params.targetId,
        detail: error.message,
      });
      return { correlated: false, hosts: [...hosts] };
    }

    for (const row of (data ?? []) as Array<{ metadata?: Record<string, unknown> | null }>) {
      const rowTargetId = row.metadata?.targetId;
      if (typeof rowTargetId === "string" && rowTargetId.trim().length > 0) {
        hosts.add(rowTargetId.trim());
      }
    }
  } catch (err) {
    log.warn("correlated host-failure lookup threw", {
      source: LOG_SOURCE,
      failureType: "proxmox_correlated_failure_lookup_failed",
      failureClass: params.failureClass,
      targetId: params.targetId,
      detail: err instanceof Error ? err.message : String(err),
    });
    return { correlated: false, hosts: [...hosts] };
  }

  const distinctHosts = [...hosts].sort();
  if (distinctHosts.length < CORRELATION_HOST_THRESHOLD) {
    return { correlated: false, hosts: distinctHosts };
  }

  const windowMinutes = Math.round(windowMs / 60_000);

  log.warn("correlated Proxmox host-local failure detected", {
    source: LOG_SOURCE,
    failureType: "proxmox_correlated_host_failure",
    failureClass: params.failureClass,
    targetId: params.targetId,
    hosts: distinctHosts,
    hostCount: distinctHosts.length,
  });

  // Title/message are a pure function of failureClass so the fingerprint is
  // stable as more hosts join the incident. Volatile data stays in metadata.
  await reportOpsEvent({
    source: OPS_SOURCE,
    severity: "fatal",
    title: `Correlated Proxmox host failure: ${params.failureClass}`,
    message: `Two or more distinct Proxmox hosts reported ${params.failureClass} within the correlation window. Placement failover cannot route around a correlated failure — every candidate host is likely affected, and new provisions will start failing with a generic 500.`,
    metadata: {
      failureType: "proxmox_correlated_host_failure",
      failureClass: params.failureClass,
      hosts: distinctHosts,
      hostCount: distinctHosts.length,
      windowMinutes,
      latestTargetId: params.targetId,
      recoveryAction: "inspect_shared_host_config_or_recent_fleet_rollout",
    },
  });

  return { correlated: true, hosts: distinctHosts };
}

// ---------------------------------------------------------------------------
// (4) Host-registry unavailability
// ---------------------------------------------------------------------------

/**
 * Page when the `proxmox_hosts` registry cannot be read at placement time.
 *
 * This is a FATAL, not an error: an unreadable registry means placement has no
 * way to know which hosts an operator has drained, so the only safe action is
 * to stop provisioning. Every second it stays unread is a second of paused
 * onboarding — that is worth waking someone for.
 *
 * Dedup: title and message are constants, so every occurrence folds into ONE
 * ops_events row (occurrence_count++) and, per reportOpsEvent's INSERT-only
 * paging branch, pages exactly once per incident. Crucially we do NOT pass
 * `userId` — `buildOpsEventFingerprint` hashes it, so a per-user fingerprint
 * would page once per affected signup. The volatile bits (the driver's error
 * text, the attempt count) ride in `metadata`, which the fingerprint ignores.
 *
 * The `log.error` mirror in instance-service is suppressed at its call site for
 * exactly this reason: it fingerprints on the driver's error string plus the
 * user id, which is why the 2026-05 incident landed as two rows spread across
 * 71 occurrences instead of one page.
 *
 * Took a `stage` discriminator until 2026-07, when the registry read collapsed
 * from two queries (active-host select + `head` count probe) into one whole-table
 * select partitioned in memory. With a single read there is no stage to name.
 */
export async function reportProxmoxHostRegistryUnavailable(params: {
  detail: string;
  attempts?: number;
}): Promise<void> {
  await reportOpsEvent({
    source: OPS_SOURCE,
    severity: "fatal",
    title: "Proxmox host registry unreadable; provisioning halted",
    message:
      "The proxmox_hosts registry query failed, so placement cannot tell which hosts are active. Provisioning is halted rather than falling back to the legacy env-order path, which would route new agents onto drained or decommissioned hosts. Restore the registry query (check for a code/DB schema skew) to resume onboarding.",
    metadata: {
      failureType: "proxmox_hosts_registry_unavailable",
      detail: params.detail,
      attempts: params.attempts ?? null,
      recoveryAction: "restore_proxmox_hosts_registry_query",
    },
  });
}
