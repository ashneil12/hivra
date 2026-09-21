/**
 * Cold-storage service. Orchestrates archive/restore/verify/purge of Hermes
 * tenant agents to the Hetzner Storage Box.
 *
 * The infrastructure layer (scripts in scripts/ops/ + per-PVE host SSH keys
 * + Storage Box itself) is documented in docs/cold-storage.md. This module
 * is the dashboard-side orchestrator: it composes those primitives, owns the
 * state machine transitions in hermes_instances, and enforces the
 * anti-corruption invariants from docs/cold-storage-orchestration.md.
 *
 * What lives where:
 *   - tar + zstd + rsync up:  scripts/ops/archive-vm-cold.sh on each PVE host
 *   - rsync down + verify + extract + compose up: scripts/ops/restore-vm-cold.sh
 *   - manifest schema + parsing: scripts/ops/backfill-cold-archived-plan.ts
 *   - the dashboard-side state machine, locks, retries: this file
 *
 * Tests live in __tests__/cold-storage-service.test.ts. Anything that mocks
 * away the SSH transport (via the `deps.runHostScript` and `deps.now` seams)
 * is unit-testable; end-to-end is the manual procedure in cold-storage.md
 * which was validated with a disposable sandbox restore and placeholder identities.
 */

import {
  manifestPathFromArchiveUri,
  parseColdStorageManifest,
} from "@/lib/cold-storage/manifest";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import { removeInstanceDnsBestEffort } from "@/lib/services/cloudflare-dns";
import { buildClearedArchivePointerPatch } from "@/lib/instance-lifecycle";
import { log } from "@/lib/logger";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildProxmoxCaddySiteCleanupScript,
  resolveProxmoxHostEnv,
  runProxmoxHostScript,
  type HostScriptResult,
  type ProxmoxHostRoutingConfig,
} from "./proxmox-instance-service";
import { buildColdStorageScriptInstall } from "./cold-storage-host-scripts";

/**
 * EnvLike mirrors the loose shape proxmox-instance-service uses internally.
 * Re-declared here to avoid touching that file just to export its primitive.
 */
type EnvLike = Record<string, string | undefined>;

const LOG_PREFIX = "[cold-storage-service]";

// ──────────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────────

export type ColdStorageDeps = {
  /**
   * Override the SSH-to-PVE transport. Defaults to runProxmoxHostScript from
   * proxmox-instance-service. Tests inject a mock that returns canned
   * HostScriptResult instances; production lets it fall through.
   */
  runHostScript?: (
    script: string,
    env: EnvLike,
    options?: { timeoutMs?: number }
  ) => Promise<HostScriptResult>;
  /** Wallclock injection seam for deterministic transition timestamps. */
  now?: () => Date;
  /** Process env (defaults to process.env). */
  env?: EnvLike;
};

export type ColdArchiveResult =
  | {
      ok: true;
      instanceId: string;
      vmid: number;
      pveHost: string;
      archiveUri: string;
      archiveSha256: string;
      archiveSizeBytes: number;
      archivedAt: string;
    }
  | {
      ok: false;
      reason:
        | "lock_not_acquired"
        | "instance_missing"
        | "instance_not_archivable"
        | "host_script_failed"
        | "manifest_verify_failed"
        | "db_update_failed"
        | "destroy_failed";
      message: string;
      instanceId: string;
      /** When the source VM still exists but archive failed before destroy. */
      retryable: boolean;
    };

export type ColdRestoreResult =
  | {
      ok: true;
      instanceId: string;
      newVmid: number;
      newPveHost: string;
      newIpv4: string;
      restoredAt: string;
    }
  | {
      ok: false;
      reason:
        | "lock_not_acquired"
        | "instance_missing"
        | "instance_not_restorable"
        | "missing_archive_metadata"
        | "host_script_failed"
        | "result_parse_failed"
        // The data restore + VM boot SUCCEEDED but the gateway hadn't reported
        // healthy inside restore-vm-cold.sh's probe window (script exits 5 +
        // RESULT status=health_pending). NOT a failure: the row is parked in
        // lifecycle_substate='restore_health_pending' (NOT reverted to cold —
        // that would leak the live VM) and the recover-stuck-restoring sweep
        // promotes it to active once its gateway answers /health. The new VM's
        // coordinates are returned so the caller can surface "still finalizing".
        | "health_pending"
        | "db_update_failed";
      message: string;
      instanceId: string;
      retryable: boolean;
      /** Populated for reason='health_pending': the live restored VM. */
      newVmid?: number;
      newPveHost?: string;
      newIpv4?: string;
    };

export type ColdVerifyResult =
  | {
      ok: true;
      instanceId: string;
      archiveUri: string;
      expectedSha256: string;
      mode: "slice" | "full";
    }
  | {
      ok: false;
      reason:
        | "missing_archive_metadata"
        | "host_script_failed"
        | "manifest_missing"
        | "manifest_mismatch"
        | "size_mismatch"
        | "sha_mismatch";
      message: string;
      instanceId: string;
      archiveUri: string;
      expectedSha256: string;
      actualSha256?: string;
    };

export type ColdPurgeResult =
  | { ok: true; instanceId: string; trashUri: string; purgedAt: string }
  | {
      ok: false;
      reason: "missing_archive_metadata" | "host_script_failed" | "db_update_failed";
      message: string;
      instanceId: string;
    };

// ──────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────────

type HermesInstanceRow = {
  id: string;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  ipv4_address: string | null;
  resource_tier: string | null;
  lifecycle_state: string | null;
  status: string | null;
  subdomain: string | null;
  archive_uri: string | null;
  archived_at: string | null;
  archive_size_bytes: number | null;
  archive_sha256: string | null;
  archive_count: number | null;
  paused_reason: string | null;
  config: Record<string, unknown> | null;
};

const INSTANCE_COLUMNS = [
  "id",
  "proxmox_node",
  "proxmox_vmid",
  "ipv4_address",
  "resource_tier",
  "lifecycle_state",
  "status",
  "subdomain",
  "archive_uri",
  "archived_at",
  "archive_size_bytes",
  "archive_sha256",
  "archive_count",
  "paused_reason",
  "config",
].join(", ");

async function fetchInstance(
  supabase: SupabaseClient,
  instanceId: string
): Promise<HermesInstanceRow | null> {
  const { data, error } = await supabase
    .from("hermes_instances")
    .select(INSTANCE_COLUMNS)
    .eq("id", instanceId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    throw new Error(`${LOG_PREFIX} fetchInstance(${instanceId}) failed: ${error.message}`);
  }
  return (data as HermesInstanceRow | null) ?? null;
}

function resolveDeps(deps?: ColdStorageDeps): Required<
  Pick<ColdStorageDeps, "runHostScript" | "now" | "env">
> {
  return {
    runHostScript:
      deps?.runHostScript ??
      ((script, env, options) =>
        runProxmoxHostScript(script, env, options as never)),
    now: deps?.now ?? (() => new Date()),
    env: deps?.env ?? process.env,
  };
}

function hostRoutingFor(row: HermesInstanceRow): ProxmoxHostRoutingConfig | null {
  if (!row.proxmox_node) return null;
  return {
    hostId: null,
    hostSlug: row.proxmox_node,
    envPrefix: null,
    failClosed: true,
  };
}

function hostRoutingForSlug(slug: string): ProxmoxHostRoutingConfig {
  return { hostId: null, hostSlug: slug, envPrefix: null, failClosed: true };
}

// Parse a single `KEY=VALUE` token line like the trailing summary lines that
// archive-vm-cold.sh and restore-vm-cold.sh emit:
//   MANIFEST sha256=... size=... iid=... ts=... vmid=... host=...
//   RESULT status=ok instance=... vmid=... host=... ip=... ...
function parseTokenLine(stdout: string, prefix: string): Map<string, string> {
  const match = stdout
    .split("\n")
    .reverse()
    .find((line) => line.trim().startsWith(prefix + " "));
  if (!match) return new Map();
  const tokens = match.trim().slice(prefix.length).trim().split(/\s+/);
  const out = new Map<string, string>();
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq === -1) continue;
    out.set(token.slice(0, eq), token.slice(eq + 1));
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// archiveInstance
// ──────────────────────────────────────────────────────────────────────────────

/** Default host-script ceiling for a single archive when the caller sets none. */
const DEFAULT_ARCHIVE_SCRIPT_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Default host-script ceiling for a single restore when the caller sets none.
 *
 * MUST stay below every calling route's `maxDuration`. Both restore callers
 * (api/instances/[id] and api/admin/restore-batch) declare maxDuration = 800s,
 * and this used to be a flat 15 min (900s) — i.e. the script was allowed to
 * outlive the function. When a restore ran long, Vercel SIGKILLed the handler
 * before restoreInstance could parse the RESULT line, so the row stayed in
 * `restoring` holding the CAS lock while the freshly-cloned VM kept running:
 * the exact "restore_health_pending with a live orphan" state seen in prod.
 *
 * 660s leaves ~140s of the 800s budget for the surrounding work (destination
 * allocation, the DB transition, DNS/Caddy writes) — the same
 * reserve-room-for-the-tail discipline cron/archive-stopped-vms applies via
 * ARCHIVE_TAIL_BUDGET_MS.
 *
 * Honest limitation: restore-vm-cold.sh's own bounded waits still sum to ~885s
 * worst case (180s ssh-up + 120s + 60s compose + ~225s step 5b + 300s health
 * probe), so a pathologically slow restore can still hit this ceiling. That is
 * ACCEPTABLE and strictly better than the old 900s, because the two outcomes
 * are not equivalent:
 *   - Outer timeout (this constant): runHostScript returns ok:false, the row
 *     reverts to cold and the name-guarded teardown destroys the clone. The
 *     archive is untouched, so the user simply retries Start. Recoverable.
 *   - Exceeding maxDuration (the old behaviour): Vercel SIGKILLs the handler
 *     mid-flight. Nothing reverts, the CAS lock stays held, and the clone is
 *     leaked as a running VM no DB row points at. That is the ghost-VM class
 *     that had to be cleaned up by hand on 2026-07-24.
 * Reaching the script's OWN health-probe exit is better still (exit 5 =
 * health_pending parks the box for the recovery sweep with no teardown), which
 * is why step 5b was reworked to retry only the cheap chown rather than the
 * 180s container recreate — that alone cut ~330s off the worst case.
 */
const DEFAULT_RESTORE_SCRIPT_TIMEOUT_MS = 660 * 1000;

export type ArchiveInstanceOptions = {
  /**
   * Upper bound on the archive host-script's wall-clock, in ms. The
   * archive-stopped-vms cron passes the time it has left before Vercel's
   * function ceiling (maxDuration) so a slow archive is aborted in time for the
   * route to stamp its dead-man heartbeat and return — instead of being
   * SIGKILLed mid-run, which strands the row in `archiving` and never records a
   * heartbeat (the failure that made the cron look dead for days and flooded
   * admin alerts). Defaults to 15 min for direct/manual callers (restore, tests).
   */
  maxScriptTimeoutMs?: number;
};

/**
 * Acquire archiving lock via CAS (paused → archiving), invoke
 * archive-vm-cold.sh on the source PVE host, re-verify the manifest,
 * atomically transition the row to cold_archived clearing Proxmox routing
 * fields, and qm destroy the source VM.
 *
 * Per Invariant I3 in docs/cold-storage-orchestration.md the destroy is the
 * last step — we only call it after the archive has been independently
 * re-verified.
 */
export async function archiveInstance(
  supabase: SupabaseClient,
  instanceId: string,
  deps?: ColdStorageDeps,
  options?: ArchiveInstanceOptions
): Promise<ColdArchiveResult> {
  const d = resolveDeps(deps);

  // 1. preflight: instance exists, is paused, has a known vmid+host
  const row = await fetchInstance(supabase, instanceId);
  if (!row) {
    return {
      ok: false,
      reason: "instance_missing",
      message: `Instance ${instanceId} not found or deleted.`,
      instanceId,
      retryable: false,
    };
  }
  if (row.lifecycle_state !== "paused") {
    return {
      ok: false,
      reason: "instance_not_archivable",
      message: `Instance ${instanceId} is not paused (lifecycle_state=${row.lifecycle_state}).`,
      instanceId,
      retryable: false,
    };
  }
  if (!row.proxmox_node || !row.proxmox_vmid) {
    return {
      ok: false,
      reason: "instance_not_archivable",
      message: `Instance ${instanceId} lacks proxmox routing fields.`,
      instanceId,
      retryable: false,
    };
  }

  // 2. CAS: paused → archiving
  const lockedAt = d.now().toISOString();
  const lockResult = await supabase
    .from("hermes_instances")
    .update({
      lifecycle_state: "archiving",
      lifecycle_substate: "archiving_starting",
      last_lifecycle_transition_at: lockedAt,
    })
    .eq("id", instanceId)
    .eq("lifecycle_state", "paused")
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();

  if (lockResult.error) {
    throw new Error(
      `${LOG_PREFIX} archiveInstance lock CAS failed for ${instanceId}: ${lockResult.error.message}`
    );
  }
  if (!lockResult.data) {
    return {
      ok: false,
      reason: "lock_not_acquired",
      message: `Another worker is already archiving ${instanceId}.`,
      instanceId,
      retryable: true,
    };
  }

  // From here on out we own the lock. Any return path that doesn't reach
  // cold_archived must revert the row to paused.
  const revertToPaused = async (
    reason: ColdArchiveResult & { ok: false },
    extra?: { pausedReasonOverride?: string }
  ): Promise<ColdArchiveResult> => {
    // Chain .select().maybeSingle() so callers (and tests) can observe the
    // revert. If revert fails the row stays in `archiving` and ops must
    // intervene — we surface that via the returned reason being marked
    // non-retryable in extreme cases.
    await supabase
      .from("hermes_instances")
      .update({
        lifecycle_state: "paused",
        lifecycle_substate: null,
        paused_reason: extra?.pausedReasonOverride ?? row.paused_reason ?? "inactivity",
        last_lifecycle_transition_at: d.now().toISOString(),
      })
      .eq("id", instanceId)
      .eq("lifecycle_state", "archiving")
      .select("id")
      .maybeSingle();
    return reason;
  };

  // Belt-and-braces: anything thrown synchronously between CAS and the
  // final cold_archived transition (e.g. resolveProxmoxHostEnv throwing on
  // misconfigured host env) must still release the lock. Without this the
  // row stays in `archiving` forever and a retry can't acquire CAS.
  try {
    return await archiveInstanceAfterLock(supabase, row, d, instanceId, revertToPaused, options);
  } catch (err) {
    return revertToPaused({
      ok: false,
      reason: "host_script_failed",
      message: `archiveInstance threw after lock acquired (row was reverted to paused): ${
        err instanceof Error ? err.message : String(err)
      }`,
      instanceId,
      retryable: true,
    });
  }
}

/**
 * Inner body of archiveInstance run under the CAS lock. Extracted so the
 * outer function can wrap it in a single try/catch and guarantee the row
 * gets unlocked on any thrown error.
 */
async function archiveInstanceAfterLock(
  supabase: SupabaseClient,
  row: HermesInstanceRow,
  d: Required<Pick<ColdStorageDeps, "runHostScript" | "now" | "env">>,
  instanceId: string,
  revertToPaused: (
    reason: ColdArchiveResult & { ok: false },
    extra?: { pausedReasonOverride?: string }
  ) => Promise<ColdArchiveResult>,
  options?: ArchiveInstanceOptions
): Promise<ColdArchiveResult> {
  // 3. run archive-vm-cold.sh on the source host. The host-script timeout is
  // bounded by the caller's remaining function budget (see ArchiveInstanceOptions)
  // so a slow archive is aborted in time for the cron to stamp its heartbeat,
  // never SIGKILLed past Vercel's maxDuration. Falls back to a 15-min ceiling.
  const hostEnv = resolveProxmoxHostEnv(hostRoutingFor(row)!, d.env);
  const scriptTimeoutMs = Math.max(
    1_000,
    options?.maxScriptTimeoutMs ?? DEFAULT_ARCHIVE_SCRIPT_TIMEOUT_MS
  );
  const scriptResult = await d.runHostScript(
    `${buildColdStorageScriptInstall("archive-vm-cold.sh")}
/usr/local/sbin/archive-vm-cold.sh ${row.proxmox_vmid} ${shellQuote(instanceId)}`,
    hostEnv,
    { timeoutMs: scriptTimeoutMs }
  );
  if (!scriptResult.ok) {
    return revertToPaused({
      ok: false,
      reason: "host_script_failed",
      message: `archive-vm-cold.sh failed on ${row.proxmox_node}: ${
        scriptResult.error ?? scriptResult.stderr ?? "unknown error"
      }`,
      instanceId,
      retryable: true,
    });
  }

  // 4. parse the MANIFEST line: sha256, size, iid, ts, vmid, host
  const tokens = parseTokenLine(scriptResult.stdout, "MANIFEST");
  const archiveSha = tokens.get("sha256");
  const archiveSizeStr = tokens.get("size");
  const tsCompact = tokens.get("ts");
  const iidFromScript = tokens.get("iid");
  if (!archiveSha || !archiveSizeStr || !tsCompact || !iidFromScript) {
    return revertToPaused({
      ok: false,
      reason: "host_script_failed",
      message: `archive-vm-cold.sh stdout did not include a MANIFEST line: ${scriptResult.stdout.slice(-400)}`,
      instanceId,
      retryable: true,
    });
  }
  if (iidFromScript !== instanceId) {
    return revertToPaused({
      ok: false,
      reason: "manifest_verify_failed",
      message: `Archive reported instance_id ${iidFromScript} but expected ${instanceId}.`,
      instanceId,
      retryable: false,
    });
  }
  const archiveSizeBytes = Number.parseInt(archiveSizeStr, 10);
  if (!Number.isInteger(archiveSizeBytes) || archiveSizeBytes <= 0) {
    return revertToPaused({
      ok: false,
      reason: "manifest_verify_failed",
      message: `Archive reported non-positive size_bytes=${archiveSizeStr}`,
      instanceId,
      retryable: false,
    });
  }

  // 5. Independently re-fetch the manifest from Storage Box (I3).
  const archiveUri = `free/${instanceId}/data-${tsCompact}.tar.zst`;
  const manifestPath = `meta/${instanceId}/${tsCompact}.json`;
  const manifestFetch = await d.runHostScript(
    `ssh cold "cat ${manifestPath}"`,
    hostEnv,
    { timeoutMs: 30_000 }
  );
  if (!manifestFetch.ok || !manifestFetch.stdout.trim()) {
    return revertToPaused({
      ok: false,
      reason: "manifest_verify_failed",
      message: `Manifest fetch failed at ${manifestPath}: ${
        manifestFetch.error ?? manifestFetch.stderr ?? "empty stdout"
      }`,
      instanceId,
      retryable: true,
    });
  }

  let parsedManifest;
  try {
    parsedManifest = parseColdStorageManifest(manifestFetch.stdout, manifestPath);
  } catch (err) {
    return revertToPaused({
      ok: false,
      reason: "manifest_verify_failed",
      message: `Manifest parse failed at ${manifestPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      instanceId,
      retryable: false,
    });
  }

  if (parsedManifest.archiveSha256 !== archiveSha) {
    return revertToPaused({
      ok: false,
      reason: "manifest_verify_failed",
      message: `SHA mismatch: script=${archiveSha} manifest=${parsedManifest.archiveSha256}`,
      instanceId,
      retryable: false,
    });
  }
  if (parsedManifest.archiveSizeBytes !== archiveSizeBytes) {
    return revertToPaused({
      ok: false,
      reason: "manifest_verify_failed",
      message: `Size mismatch: script=${archiveSizeBytes} manifest=${parsedManifest.archiveSizeBytes}`,
      instanceId,
      retryable: false,
    });
  }

  // 6. Atomic DB transition: archiving → cold_archived, clear routing fields.
  const archivedAtIso = parsedManifest.archivedAt;
  const transitionAt = d.now().toISOString();
  const transition = await supabase
    .from("hermes_instances")
    .update({
      lifecycle_state: "cold_archived",
      lifecycle_substate: null,
      paused_reason: "cold_archived",
      status: "stopped",
      archive_uri: archiveUri,
      archived_at: archivedAtIso,
      archive_size_bytes: archiveSizeBytes,
      archive_sha256: archiveSha,
      archive_count: (row.archive_count ?? 0) + 1,
      proxmox_node: null,
      proxmox_vmid: null,
      ipv4_address: null,
      last_lifecycle_transition_at: transitionAt,
    })
    .eq("id", instanceId)
    .eq("lifecycle_state", "archiving")
    .select("id")
    .maybeSingle();

  if (transition.error || !transition.data) {
    // Don't destroy the VM if we couldn't record the transition — we'd lose
    // the routing fields needed to find it later. Caller retries.
    return revertToPaused({
      ok: false,
      reason: "db_update_failed",
      message: `cold_archived UPDATE failed: ${transition.error?.message ?? "row not in archiving state"}`,
      instanceId,
      retryable: true,
    });
  }

  // 7. Final: qm destroy. If this fails the row already says cold_archived
  // (archive is safe); we surface the failure so ops can clean up by hand.
  const destroyResult = await d.runHostScript(
    `qm stop ${row.proxmox_vmid} >/dev/null 2>&1; sleep 2; qm destroy ${row.proxmox_vmid} --skiplock --purge`,
    hostEnv,
    { timeoutMs: 60_000 }
  );
  if (!destroyResult.ok) {
    return {
      ok: false,
      reason: "destroy_failed",
      message: `qm destroy ${row.proxmox_vmid} on ${row.proxmox_node} failed (row already cold_archived; data safe): ${
        destroyResult.error ?? destroyResult.stderr
      }`,
      instanceId,
      retryable: true,
    };
  }

  // 8. Drop the Cloudflare A record. The VM is gone; the record now points
  // at an IP that hosts nothing for this tenant, and on thaw `mintInstanceDns`
  // would refuse to adopt a same-FQDN record with a different IP (forcing the
  // sslip fallback). Best-effort: a failure here just leaves a stale record
  // that the next archive/purge sweep can clean up; data is already safe.
  await removeInstanceDnsBestEffort(row.subdomain, {
    source: "cold-storage-service",
    instanceId,
  });

  // 9. Remove the per-instance host Caddy site file on the (now ex-)host and
  // reload host Caddy. The VM is destroyed and the routing columns are nulled,
  // but `<caddySitesDir>/<gatewayHost>.caddy` still reverse_proxies the
  // freed private IP. If that VMID/IP is later recycled to a different tenant
  // on the same host, the archived tenant's `<sub>.hermesos.cloud` hostname
  // routes to the NEW tenant's VM (cross-tenant leak). deleteProxmoxInstance
  // already does this; archive historically didn't. Best-effort, exactly like
  // the DNS removal above: a failure here must not flip a successful archive
  // to failure (the VM is gone and the archive is safe), and a later run of
  // scripts/cleanup-orphan-caddy-sites.ts mops up anything left behind.
  try {
    const infra = (row.config?.infrastructure ?? null) as
      | Record<string, unknown>
      | null;
    const dnsDomain = (d.env.CLOUDFLARE_DNS_DOMAIN?.trim() || "hermesos.cloud").replace(
      /^\.+|\.+$/g,
      ""
    );
    const gatewayHost =
      typeof infra?.gatewayHost === "string" && infra.gatewayHost.trim()
        ? infra.gatewayHost.trim()
        : row.subdomain
          ? `${row.subdomain}.${dnsDomain}`
          : null;
    if (gatewayHost) {
      const caddySitesDir =
        d.env.PROXMOX_CADDY_SITES_DIR?.trim() || "/etc/caddy/hermes.d";
      const cleanup = await d.runHostScript(
        buildProxmoxCaddySiteCleanupScript({
          gatewayHosts: [gatewayHost],
          caddySitesDir,
        }),
        hostEnv,
        { timeoutMs: 60_000 }
      );
      if (!cleanup.ok) {
        log.warn("cold-archive host caddy site cleanup failed; stale site file may remain", {
          source: "cold-storage-service",
          instanceId,
          pveHost: row.proxmox_node,
          gatewayHost,
          failureType: "cold_archive_caddy_cleanup_failed",
          error: cleanup.error ?? cleanup.stderr ?? "unknown",
        });
      }
    }
  } catch (err) {
    log.warn("cold-archive host caddy site cleanup threw (archive is safe)", {
      source: "cold-storage-service",
      instanceId,
      pveHost: row.proxmox_node,
      failureType: "cold_archive_caddy_cleanup_threw",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // proxmox_vmid + proxmox_node were null-checked in the outer caller
  // before the CAS lock; TypeScript can't see that across the function
  // boundary so we assert here.
  return {
    ok: true,
    instanceId,
    vmid: row.proxmox_vmid!,
    pveHost: row.proxmox_node!,
    archiveUri,
    archiveSha256: archiveSha,
    archiveSizeBytes,
    archivedAt: archivedAtIso,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// restoreInstance
// ──────────────────────────────────────────────────────────────────────────────

export type RestoreInstanceOptions = {
  /**
   * Destination host, vmid, ip, gateway, and template are all chosen by the
   * caller — typically wired from the dashboard's existing
   * selectAvailableProxmoxProvisionTarget allocator. We don't pick them
   * inside this service because the allocator depends on
   * supabase + env + capacity logic that's already centralised in
   * instance-service.ts.
   */
  destinationHostSlug: string;
  destinationVmid: number;
  destinationIp: string;
  destinationGateway: string;
  templateVmid: number;
  /** Default 30; passed to restore-vm-cold.sh as the resize target. */
  targetDiskGb?: number;
  /**
   * CPU throttle (Proxmox `cpulimit`) for the restored VM. Defaults to 0.5
   * (the free-tier value from tier-specs.ts) when unset so old callers can't
   * accidentally provision an unbounded VM. The orchestrator passes the
   * tenant's resolved cpu_limit from hermes_instances; raw callers should
   * pick the right tier value from tier-specs.ts themselves.
   */
  cpuLimit?: number;
  /**
   * Ceiling for the restore-vm-cold.sh host script, in ms. Mirrors
   * ArchiveInstanceOptions.maxScriptTimeoutMs and exists for the same reason:
   * the default MUST stay under the calling route's `maxDuration` or Vercel
   * SIGKILLs the function mid-restore, stranding the row in `restoring` with
   * the CAS lock still held and a live VM nothing points at.
   *
   * Callers that know their remaining runway (a cron loop, a batch) should pass
   * it explicitly, exactly as cron/archive-stopped-vms does.
   */
  maxScriptTimeoutMs?: number;
};

/**
 * Restore a cold-archived instance to a fresh VM. Caller has already picked
 * the destination (host slug, vmid, ip). See RestoreInstanceOptions.
 *
 * Acquires the `restoring` lock via CAS, runs restore-vm-cold.sh on the
 * destination host, parses the RESULT line, then atomically transitions the
 * DB row to `active` with the new routing fields.
 */
export async function restoreInstance(
  supabase: SupabaseClient,
  instanceId: string,
  options: RestoreInstanceOptions,
  deps?: ColdStorageDeps
): Promise<ColdRestoreResult> {
  const d = resolveDeps(deps);

  const row = await fetchInstance(supabase, instanceId);
  if (!row) {
    return {
      ok: false,
      reason: "instance_missing",
      message: `Instance ${instanceId} not found or deleted.`,
      instanceId,
      retryable: false,
    };
  }
  // `failed` is restorable when the row still carries a valid archive AND
  // has no live infra columns — that's the same shape as cold_archived,
  // just landed here through a half-broken Start path (see the 2026-05-18
  // a prior failed-row recovery incident). Accepting it lets the existing CAS lock + restore
  // pipeline recover the row instead of leaving the user stuck.
  const isFailedButRestorable =
    row.lifecycle_state === "failed" &&
    !!row.archive_uri &&
    !!row.archive_sha256 &&
    row.proxmox_vmid == null;
  if (
    row.lifecycle_state !== "cold_archived" &&
    row.lifecycle_state !== "pending_deletion" &&
    !isFailedButRestorable
  ) {
    return {
      ok: false,
      reason: "instance_not_restorable",
      message: `Instance ${instanceId} is not in a restorable state (lifecycle_state=${row.lifecycle_state}).`,
      instanceId,
      retryable: false,
    };
  }
  if (!row.archive_uri || !row.archive_sha256) {
    return {
      ok: false,
      reason: "missing_archive_metadata",
      message: `Instance ${instanceId} is ${row.lifecycle_state} but lacks archive_uri/sha256.`,
      instanceId,
      retryable: false,
    };
  }

  // CAS: cold_archived | pending_deletion → restoring
  const lockedAt = d.now().toISOString();
  const previousState = row.lifecycle_state;
  const lockResult = await supabase
    .from("hermes_instances")
    .update({
      lifecycle_state: "restoring",
      lifecycle_substate: "restoring_starting",
      last_lifecycle_transition_at: lockedAt,
    })
    .eq("id", instanceId)
    .eq("lifecycle_state", previousState)
    .is("deleted_at", null)
    .select("id")
    .maybeSingle();

  if (lockResult.error) {
    throw new Error(
      `${LOG_PREFIX} restoreInstance lock CAS failed for ${instanceId}: ${lockResult.error.message}`
    );
  }
  if (!lockResult.data) {
    return {
      ok: false,
      reason: "lock_not_acquired",
      message: `Another worker is already restoring ${instanceId} (or it moved out of ${previousState}).`,
      instanceId,
      retryable: true,
    };
  }

  const revertToCold = async (
    reason: ColdRestoreResult & { ok: false }
  ): Promise<ColdRestoreResult> => {
    await supabase
      .from("hermes_instances")
      .update({
        lifecycle_state: previousState,
        lifecycle_substate: null,
        last_lifecycle_transition_at: d.now().toISOString(),
      })
      .eq("id", instanceId)
      .eq("lifecycle_state", "restoring")
      .select("id")
      .maybeSingle();
    return reason;
  };

  // Belt-and-braces: anything thrown synchronously between CAS and the
  // final active transition (e.g. resolveProxmoxHostEnv throwing on
  // misconfigured destination env) must still release the lock.
  try {
    return await restoreInstanceAfterLock(
      supabase,
      row,
      d,
      instanceId,
      options,
      revertToCold
    );
  } catch (err) {
    return revertToCold({
      ok: false,
      reason: "host_script_failed",
      message: `restoreInstance threw after lock acquired (row was reverted to ${previousState}): ${
        err instanceof Error ? err.message : String(err)
      }`,
      instanceId,
      retryable: true,
    });
  }
}

/**
 * VMIDs >= this value are templates (9007 is the production restore template;
 * 9100 is reserved). A teardown script is NEVER generated for them — mirrors
 * TEMPLATE_VMID_THRESHOLD in the recovery sweeps.
 */
const RESTORE_TEMPLATE_VMID_THRESHOLD = 9000;

const INSTANCE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Build the guarded teardown script for a restore clone this attempt created.
 *
 * Returns null (refuses to build) when the vmid is outside the tenant range
 * (0 < vmid < 9000 — templates like 9007/9100 can never be targeted) or the
 * instance id is not a UUID.
 *
 * Script-side guard (TOCTOU, same pattern as the adoption sweep's
 * buildReapScript): the VM is re-checked at run time and only destroyed when
 * `qm config` STILL reports the exact `hermes-<instanceId>` name that
 * restore-vm-cold.sh stamps on its clone. A mismatched or absent name is a
 * no-op skip — we can never destroy a different tenant's VM, a template, or a
 * VM that was recycled between failure and teardown. Destroying the clone is
 * data-safe: the archive on the Storage Box (verified by sha256 before the
 * clone was even created) remains the source of truth; the archive itself is
 * never touched here.
 */
export function buildRestoreCloneTeardownScript(
  vmid: number,
  instanceId: string
): string | null {
  if (!Number.isInteger(vmid) || vmid <= 0 || vmid >= RESTORE_TEMPLATE_VMID_THRESHOLD) {
    return null;
  }
  if (!INSTANCE_UUID_RE.test(instanceId)) return null;
  const expect = `hermes-${instanceId}`;
  return `set -uo pipefail
vmid=${vmid}
expect='${expect}'
name=$(qm config "$vmid" 2>/dev/null | awk -F': ' '/^name:/{print $2; exit}')
if [ -z "\${name:-}" ]; then echo "TEARDOWN_SKIP_ABSENT $vmid"; exit 0; fi
if [ "$name" != "$expect" ]; then echo "TEARDOWN_SKIP_NAME $vmid $name"; exit 0; fi
qm stop "$vmid" --timeout 25 >/dev/null 2>&1 || true
if qm destroy "$vmid" --purge 1 --destroy-unreferenced-disks 1 >/dev/null 2>&1; then
  echo "TEARDOWN_OK $vmid"
else
  echo "TEARDOWN_FAIL $vmid"
fi
`;
}

/**
 * restore-vm-cold.sh's preflight refuses to clone when the destination VMID is
 * already taken ("[restore] VMID <n> already exists on <host>"). When that
 * marker is present, the VM sitting at the destination VMID was NOT created by
 * this attempt, so the teardown must not touch it (it may be a previously
 * leaked clone — the flag-gated sweep handles that class — or, if the
 * allocator raced, another tenant's VM).
 */
export function restoreScriptRefusedPreexistingVmid(result: {
  stdout?: string;
  stderr?: string;
}): boolean {
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return combined.includes("already exists on");
}

/**
 * Best-effort teardown of the clone a FAILED restore attempt left behind.
 *
 * This closes the 2026-07-07 leak class (24 orphan VMs): when
 * restore-vm-cold.sh dies between `qm clone` and its own internal cleanup
 * (SSH transport killed, runHostScript timeout, host reboot mid-run), the
 * clone stays RUNNING with onboot=1 while revertToCold sends the row back to
 * cold_archived — so the next Start leaks ANOTHER clone (fixturecase20 accumulated
 * 4; fixturecase11 was still leaking the morning of 2026-07-07).
 *
 * Never throws; a failed teardown is logged and left for the flag-gated
 * orphan sweep to flag.
 */
async function teardownFailedRestoreCloneBestEffort(
  d: Required<Pick<ColdStorageDeps, "runHostScript" | "now" | "env">>,
  destHostEnv: EnvLike,
  instanceId: string,
  options: RestoreInstanceOptions,
  scriptResult: { stdout?: string; stderr?: string },
  failureReason: string
): Promise<void> {
  try {
    if (restoreScriptRefusedPreexistingVmid(scriptResult)) {
      log.warn("restore teardown skipped: destination VMID pre-existed this attempt", {
        source: "cold-storage-service",
        instanceId,
        pveHost: options.destinationHostSlug,
        vmid: options.destinationVmid,
        failureType: "restore_clone_teardown_skipped_preexisting",
      });
      return;
    }
    const script = buildRestoreCloneTeardownScript(options.destinationVmid, instanceId);
    if (!script) {
      log.warn("restore teardown refused: vmid/instance outside safe range", {
        source: "cold-storage-service",
        instanceId,
        pveHost: options.destinationHostSlug,
        vmid: options.destinationVmid,
        failureType: "restore_clone_teardown_refused",
      });
      return;
    }
    const result = await d.runHostScript(script, destHostEnv, { timeoutMs: 90_000 });
    const outcomeLine =
      result.stdout
        ?.split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("TEARDOWN_")) ?? "no TEARDOWN_ line";
    log.info("restore failure-path clone teardown ran", {
      source: "cold-storage-service",
      instanceId,
      pveHost: options.destinationHostSlug,
      vmid: options.destinationVmid,
      failureReason,
      transportOk: result.ok,
      outcome: outcomeLine,
      failureType: "restore_clone_teardown_ran",
    });
  } catch (err) {
    log.warn("restore failure-path clone teardown threw (leftover clone left for the orphan sweep)", {
      source: "cold-storage-service",
      instanceId,
      pveHost: options.destinationHostSlug,
      vmid: options.destinationVmid,
      failureType: "restore_clone_teardown_threw",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function restoreInstanceAfterLock(
  supabase: SupabaseClient,
  row: HermesInstanceRow,
  d: Required<Pick<ColdStorageDeps, "runHostScript" | "now" | "env">>,
  instanceId: string,
  options: RestoreInstanceOptions,
  revertToCold: (reason: ColdRestoreResult & { ok: false }) => Promise<ColdRestoreResult>
): Promise<ColdRestoreResult> {
  if (!row.archive_uri || !row.archive_sha256) {
    return revertToCold({
      ok: false,
      reason: "missing_archive_metadata",
      message: `Instance ${instanceId} archive metadata vanished after lock acquisition.`,
      instanceId,
      retryable: false,
    });
  }
  const destHostEnv = resolveProxmoxHostEnv(
    hostRoutingForSlug(options.destinationHostSlug),
    d.env
  );

  const cmd = [
    // Reinstall from this deploy's embedded copy first — the host may still be
    // carrying a hand-copied version from an earlier release.
    `${buildColdStorageScriptInstall("restore-vm-cold.sh")}\n/usr/local/sbin/restore-vm-cold.sh`,
    instanceId,
    row.archive_uri,
    row.archive_sha256,
    String(options.destinationVmid),
    options.destinationIp,
    options.destinationGateway,
    String(options.templateVmid),
    String(options.targetDiskGb ?? 30),
    String(options.cpuLimit ?? 0.5),
  ].join(" ");

  const scriptResult = await d.runHostScript(cmd, destHostEnv, {
    timeoutMs: Math.max(
      1_000,
      options.maxScriptTimeoutMs ?? DEFAULT_RESTORE_SCRIPT_TIMEOUT_MS
    ),
  });

  // Parse the RESULT line FIRST — restore-vm-cold.sh emits it on BOTH the
  // success path (exit 0, status=ok) AND the health-pending path (exit 5,
  // status=health_pending: data restored + VM booted, but the gateway hadn't
  // gone healthy inside the script's probe window). On exit 5 scriptResult.ok
  // is false but stdout still carries the RESULT line, so we must inspect it
  // before falling through to the generic host-script-failed revert — reverting
  // a health_pending result would flip the DB back to cold while the new VM
  // keeps running, leaking it.
  const tokens = parseTokenLine(scriptResult.stdout, "RESULT");
  const status = tokens.get("status");
  const newVmidStr = tokens.get("vmid");
  const newIp = tokens.get("ip");
  const newHost = tokens.get("host");
  const reportedInstanceId = tokens.get("instance");
  const hasValidCoords = Boolean(newVmidStr && newIp && newHost);
  const isHealthPending = status === "health_pending" && hasValidCoords;

  // Every failure branch below reverts the row to cold — so the clone this
  // attempt may have created MUST be torn down first, or it leaks as a
  // running onboot=1 VM that nothing else can see (the row's proxmox_vmid is
  // NULL; orphan detection keys off rows that point at vmids). The teardown
  // is guarded (exact `hermes-<instanceId>` name re-check at run time, tenant
  // VMID range only, skipped entirely when the script's preflight refused a
  // pre-existing VMID) and best-effort. health_pending is NOT a failure and
  // never tears down — its live VM is parked for the recovery sweep.

  // Generic host-script failure (no parseable RESULT, or a non-health_pending
  // non-zero exit). health_pending is handled distinctly below — it is NOT a
  // failure, so it must not hit this revert.
  if (!scriptResult.ok && !isHealthPending) {
    await teardownFailedRestoreCloneBestEffort(
      d, destHostEnv, instanceId, options, scriptResult, "host_script_failed"
    );
    return revertToCold({
      ok: false,
      reason: "host_script_failed",
      message: `restore-vm-cold.sh failed on ${options.destinationHostSlug}: ${
        scriptResult.error ?? scriptResult.stderr ?? "unknown error"
      }`,
      instanceId,
      retryable: true,
    });
  }

  if (!isHealthPending && (status !== "ok" || !hasValidCoords)) {
    await teardownFailedRestoreCloneBestEffort(
      d, destHostEnv, instanceId, options, scriptResult, "result_parse_failed"
    );
    return revertToCold({
      ok: false,
      reason: "result_parse_failed",
      message: `restore-vm-cold.sh did not report status=ok; stdout tail: ${scriptResult.stdout.slice(-400)}`,
      instanceId,
      retryable: true,
    });
  }
  if (reportedInstanceId && reportedInstanceId !== instanceId) {
    await teardownFailedRestoreCloneBestEffort(
      d, destHostEnv, instanceId, options, scriptResult, "instance_id_mismatch"
    );
    return revertToCold({
      ok: false,
      reason: "result_parse_failed",
      message: `Restore reported instance=${reportedInstanceId} but expected ${instanceId}`,
      instanceId,
      retryable: false,
    });
  }

  const newVmid = Number.parseInt(newVmidStr!, 10);
  if (!Number.isInteger(newVmid) || newVmid <= 0) {
    await teardownFailedRestoreCloneBestEffort(
      d, destHostEnv, instanceId, options, scriptResult, "invalid_vmid"
    );
    return revertToCold({
      ok: false,
      reason: "result_parse_failed",
      message: `Restore reported non-positive vmid=${newVmidStr}`,
      instanceId,
      retryable: true,
    });
  }

  const restoredAt = d.now().toISOString();
  // Reflect the new VM location in BOTH `config.infrastructure` and the
  // dedicated DB columns. Subsequent action routing
  // (POST /api/instances/[id] action=start/stop/reboot) reads from
  // `config.infrastructure` FIRST (via getProxmoxInfrastructure) and only
  // falls back to the columns when config is empty — leaving the stale
  // pre-archive infra here would make the next user click target the
  // ORIGINAL VMID on the ORIGINAL host. After archive that VMID was
  // destroyed and may have been recycled to a different tenant, so the
  // cross-tenant footgun PR #94 (b254d680) was meant to close stays open.
  // Reconstruct gatewayHost + host-env routing from the restore target. The
  // infra block was stripped at reclaim (stripProxmoxInfrastructure), so the
  // spread above is empty — without these fields the restored row has no
  // gatewayHost, getProxmoxInfrastructure() returns null, and applyLiveUpdate()
  // reports "No host attached", leaving the instance un-updatable after a
  // pause→restore cycle. destinationGateway arrives as a URL.
  const restoredGatewayHost = (() => {
    try {
      return new URL(options.destinationGateway).host || undefined;
    } catch {
      return options.destinationGateway || undefined;
    }
  })();
  const newInfra = {
    ...(row.config?.infrastructure as Record<string, unknown> | undefined ?? {}),
    node: newHost,
    vmid: newVmid,
    hostSlug: newHost,
    provider: "proxmox",
    privateIpv4: newIp,
    ...(restoredGatewayHost ? { gatewayHost: restoredGatewayHost } : {}),
    hostEnvPrefix: `PROXMOX_${String(newHost).toUpperCase()}_`,
  };
  const updatedConfig = {
    ...(row.config ?? {}),
    infrastructure: newInfra,
  };

  // health_pending: data is restored and the VM is live, but the gateway hadn't
  // gone healthy in the script's window. Write the new VM routing (so the
  // recover-stuck-restoring sweep can probe it) and PARK the row in
  // lifecycle_state='restoring' with substate='restore_health_pending' — never
  // revert to cold, which would orphan the live VM. The sweep promotes it to
  // active once /health answers. status='provisioning' so the dashboard shows a
  // "warming up" state rather than a hard error.
  if (isHealthPending) {
    const park = await supabase
      .from("hermes_instances")
      .update({
        lifecycle_state: "restoring",
        lifecycle_substate: "restore_health_pending",
        status: "provisioning",
        paused_reason: null,
        proxmox_node: newHost,
        proxmox_vmid: newVmid,
        ipv4_address: newIp,
        config: updatedConfig,
        last_lifecycle_transition_at: restoredAt,
      })
      .eq("id", instanceId)
      .eq("lifecycle_state", "restoring")
      .select("id")
      .maybeSingle();

    if (park.error || !park.data) {
      return {
        ok: false,
        reason: "db_update_failed",
        message: `Restore reached health_pending but DB UPDATE failed: ${
          park.error?.message ?? "row not in restoring state"
        }; VM is live at ${newHost} vmid=${newVmid} ip=${newIp}`,
        instanceId,
        retryable: false,
        newVmid,
        newPveHost: newHost,
        newIpv4: newIp,
      };
    }

    return {
      ok: false,
      reason: "health_pending",
      message: `Restore finalized on ${newHost} (vmid=${newVmid}, ip=${newIp}) but the gateway hadn't reported healthy yet; row parked as restore_health_pending for the recovery sweep to promote.`,
      instanceId,
      retryable: false,
      newVmid,
      newPveHost: newHost,
      newIpv4: newIp,
    };
  }

  const transition = await supabase
    .from("hermes_instances")
    .update({
      lifecycle_state: "active",
      lifecycle_substate: null,
      status: "running",
      paused_reason: null,
      proxmox_node: newHost,
      proxmox_vmid: newVmid,
      ipv4_address: newIp,
      config: updatedConfig,
      last_lifecycle_transition_at: restoredAt,
      // The VM is live again on a fresh vmid, so this row is no longer a
      // cold-storage row. Leaving the stale pointer behind makes it
      // permanently invisible to the archive cron's archive_uri IS NULL
      // filter once it is re-paused. See buildClearedArchivePointerPatch.
      ...buildClearedArchivePointerPatch(),
    })
    .eq("id", instanceId)
    .eq("lifecycle_state", "restoring")
    .select("id")
    .maybeSingle();

  if (transition.error || !transition.data) {
    // The VM is alive on the new host but we couldn't record it. That's a
    // worse state than "row says cold_archived but actually live" — the
    // dashboard wouldn't route traffic to the new VM. Leave row as
    // restoring; ops will fix.
    return {
      ok: false,
      reason: "db_update_failed",
      message: `Restore succeeded on host but DB UPDATE failed: ${
        transition.error?.message ?? "row not in restoring state"
      }; VM is live at ${newHost} vmid=${newVmid} ip=${newIp}`,
      instanceId,
      retryable: false,
    };
  }

  return {
    ok: true,
    instanceId,
    newVmid,
    newPveHost: newHost!,
    newIpv4: newIp!,
    restoredAt,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// verifyArchiveIntegrity
// ──────────────────────────────────────────────────────────────────────────────

export type VerifyArchiveIntegrityOptions = {
  /**
   * Which PVE host should do the verification work. Any host with the cold
   * SSH alias works — pick one not under load. Defaults to the row's
   * proxmox_node if still set, otherwise caller must supply.
   */
  hostSlug?: string;
  /**
   * "slice" reads first + last 1 MB of the archive and decompresses just
   * enough to validate zstd headers. "full" downloads the entire archive
   * and recomputes SHA256. Slice is the audit-cron default; full is run
   * occasionally or on suspicion.
   */
  mode?: "slice" | "full";
};

export async function verifyArchiveIntegrity(
  supabase: SupabaseClient,
  instanceId: string,
  options: VerifyArchiveIntegrityOptions = {},
  deps?: ColdStorageDeps
): Promise<ColdVerifyResult> {
  const d = resolveDeps(deps);
  const row = await fetchInstance(supabase, instanceId);
  if (!row) {
    return {
      ok: false,
      reason: "missing_archive_metadata",
      message: `Instance ${instanceId} not found.`,
      instanceId,
      archiveUri: "",
      expectedSha256: "",
    };
  }
  if (!row.archive_uri || !row.archive_sha256 || !row.archive_size_bytes) {
    return {
      ok: false,
      reason: "missing_archive_metadata",
      message: `Instance ${instanceId} has no archive metadata to verify.`,
      instanceId,
      archiveUri: row.archive_uri ?? "",
      expectedSha256: row.archive_sha256 ?? "",
    };
  }

  const hostSlug =
    options.hostSlug ??
    row.proxmox_node ??
    (() => {
      throw new Error(
        `${LOG_PREFIX} verifyArchiveIntegrity needs a hostSlug (instance ${instanceId} has no proxmox_node).`
      );
    })();
  const env = resolveProxmoxHostEnv(hostRoutingForSlug(hostSlug), d.env);

  const mode: "slice" | "full" = options.mode ?? "slice";

  // For both modes we first re-fetch the manifest and confirm it parses +
  // matches the DB-recorded sha. That alone catches accidental deletes and
  // manifest tampering.
  const manifestPath = manifestPathFromArchiveUri(row.archive_uri);
  if (!manifestPath) {
    return {
      ok: false,
      reason: "missing_archive_metadata",
      message: `Cannot derive manifest path from archive_uri=${row.archive_uri}`,
      instanceId,
      archiveUri: row.archive_uri,
      expectedSha256: row.archive_sha256,
    };
  }
  const manifestResult = await d.runHostScript(
    `ssh cold "cat ${manifestPath}/$(ssh cold 'ls ${manifestPath} 2>/dev/null' | tail -1)" 2>/dev/null || ssh cold "cat ${manifestPath}"`,
    env,
    { timeoutMs: 30_000 }
  );
  // We accept either a direct file path or a directory-of-generations
  // structure here so the function works against both layouts.
  if (!manifestResult.ok || !manifestResult.stdout.trim()) {
    return {
      ok: false,
      reason: "manifest_missing",
      message: `Manifest fetch failed: ${manifestResult.error ?? manifestResult.stderr ?? "empty"}`,
      instanceId,
      archiveUri: row.archive_uri,
      expectedSha256: row.archive_sha256,
    };
  }

  let parsed;
  try {
    parsed = parseColdStorageManifest(manifestResult.stdout, manifestPath);
  } catch (err) {
    return {
      ok: false,
      reason: "manifest_missing",
      message: `Manifest parse failed: ${err instanceof Error ? err.message : String(err)}`,
      instanceId,
      archiveUri: row.archive_uri,
      expectedSha256: row.archive_sha256,
    };
  }
  if (parsed.archiveSha256 !== row.archive_sha256) {
    return {
      ok: false,
      reason: "manifest_mismatch",
      message: `Manifest sha differs from DB record: manifest=${parsed.archiveSha256} db=${row.archive_sha256}`,
      instanceId,
      archiveUri: row.archive_uri,
      expectedSha256: row.archive_sha256,
      actualSha256: parsed.archiveSha256,
    };
  }
  if (parsed.archiveSizeBytes !== row.archive_size_bytes) {
    return {
      ok: false,
      reason: "size_mismatch",
      message: `Manifest size differs from DB record: manifest=${parsed.archiveSizeBytes} db=${row.archive_size_bytes}`,
      instanceId,
      archiveUri: row.archive_uri,
      expectedSha256: row.archive_sha256,
    };
  }

  if (mode === "slice") {
    // Slice verify: peek the first 1 MB through zstd's stream decoder. If
    // the archive header is intact and zstd can decode anything, it's a real
    // archive — not a truncated upload. Full SHA verify is the `full` mode.
    const sliceResult = await d.runHostScript(
      `ssh cold "head -c 1048576 ${row.archive_uri}" | zstd -dc --long=27 2>/dev/null | head -c 1024 >/dev/null && echo OK`,
      env,
      { timeoutMs: 60_000 }
    );
    if (!sliceResult.ok || !sliceResult.stdout.includes("OK")) {
      return {
        ok: false,
        reason: "sha_mismatch",
        message: `Slice probe of ${row.archive_uri} could not produce decoded output: ${
          sliceResult.error ?? sliceResult.stderr ?? "no OK marker"
        }`,
        instanceId,
        archiveUri: row.archive_uri,
        expectedSha256: row.archive_sha256,
      };
    }
    return {
      ok: true,
      instanceId,
      archiveUri: row.archive_uri,
      expectedSha256: row.archive_sha256,
      mode,
    };
  }

  // Full verify: download to PVE host, sha256sum, compare.
  const fullResult = await d.runHostScript(
    `set -e; T=$(mktemp); rsync -a -e ssh cold:${row.archive_uri} "$T"; FULL_SHA=$(sha256sum "$T" | awk '{print $1}'); SIZE=$(stat -c %s "$T"); rm -f "$T"; echo "VERIFY sha=$FULL_SHA size=$SIZE"`,
    env,
    { timeoutMs: 10 * 60 * 1000 }
  );
  if (!fullResult.ok) {
    return {
      ok: false,
      reason: "host_script_failed",
      message: `Full verify host script failed: ${fullResult.error ?? fullResult.stderr}`,
      instanceId,
      archiveUri: row.archive_uri,
      expectedSha256: row.archive_sha256,
    };
  }
  const verifyTokens = parseTokenLine(fullResult.stdout, "VERIFY");
  const fullSha = verifyTokens.get("sha");
  const fullSizeStr = verifyTokens.get("size");
  if (!fullSha || !fullSizeStr) {
    return {
      ok: false,
      reason: "host_script_failed",
      message: `Full verify did not emit VERIFY line: ${fullResult.stdout.slice(-200)}`,
      instanceId,
      archiveUri: row.archive_uri,
      expectedSha256: row.archive_sha256,
    };
  }
  if (fullSha !== row.archive_sha256) {
    return {
      ok: false,
      reason: "sha_mismatch",
      message: `Full SHA mismatch: stored=${row.archive_sha256} downloaded=${fullSha}`,
      instanceId,
      archiveUri: row.archive_uri,
      expectedSha256: row.archive_sha256,
      actualSha256: fullSha,
    };
  }
  if (Number.parseInt(fullSizeStr, 10) !== row.archive_size_bytes) {
    return {
      ok: false,
      reason: "size_mismatch",
      message: `Full size mismatch: stored=${row.archive_size_bytes} downloaded=${fullSizeStr}`,
      instanceId,
      archiveUri: row.archive_uri,
      expectedSha256: row.archive_sha256,
    };
  }
  return {
    ok: true,
    instanceId,
    archiveUri: row.archive_uri,
    expectedSha256: row.archive_sha256,
    mode,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// purgeArchive
// ──────────────────────────────────────────────────────────────────────────────

export type PurgeArchiveOptions = {
  hostSlug?: string;
  /**
   * Trash safety net (Invariant: `docs/cold-storage-orchestration.md` §5).
   * Instead of `rm -rf` we move the archive into `trash/<id>-<ts>/` on the
   * Storage Box. A separate purge sweep later does the actual delete after
   * the configured trash retention period.
   */
  skipTrash?: boolean;
};

export async function purgeArchive(
  supabase: SupabaseClient,
  instanceId: string,
  options: PurgeArchiveOptions = {},
  deps?: ColdStorageDeps
): Promise<ColdPurgeResult> {
  const d = resolveDeps(deps);
  const row = await fetchInstance(supabase, instanceId);
  if (!row) {
    return {
      ok: false,
      reason: "missing_archive_metadata",
      message: `Instance ${instanceId} not found.`,
      instanceId,
    };
  }
  if (!row.archive_uri) {
    return {
      ok: false,
      reason: "missing_archive_metadata",
      message: `Instance ${instanceId} has no archive_uri to purge.`,
      instanceId,
    };
  }

  const hostSlug =
    options.hostSlug ??
    row.proxmox_node ??
    (() => {
      throw new Error(
        `${LOG_PREFIX} purgeArchive needs a hostSlug (instance ${instanceId} has no proxmox_node).`
      );
    })();

  const env = resolveProxmoxHostEnv(hostRoutingForSlug(hostSlug), d.env);

  const ts = d.now().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const trashUri = `trash/${instanceId}-${ts}`;

  const dataPathParent = row.archive_uri.replace(/\/[^/]+$/, "");
  const remoteCmd = options.skipTrash
    ? `ssh cold "rm -rf ${dataPathParent} meta/${instanceId}"`
    : `ssh cold "mkdir -p ${trashUri} && mv ${dataPathParent} ${trashUri}/data && (mv meta/${instanceId} ${trashUri}/meta || true)"`;

  const result = await d.runHostScript(remoteCmd, env, { timeoutMs: 60_000 });
  if (!result.ok) {
    return {
      ok: false,
      reason: "host_script_failed",
      message: `purge command failed: ${result.error ?? result.stderr}`,
      instanceId,
    };
  }

  const purgedAt = d.now().toISOString();
  const transition = await supabase
    .from("hermes_instances")
    .update({
      lifecycle_state: "deleted",
      lifecycle_substate: null,
      deleted_at: purgedAt,
      archive_uri: null,
      last_lifecycle_transition_at: purgedAt,
    })
    .eq("id", instanceId)
    .select("id")
    .maybeSingle();

  if (transition.error || !transition.data) {
    return {
      ok: false,
      reason: "db_update_failed",
      message: `DB update after purge failed: ${transition.error?.message ?? "no row"}`,
      instanceId,
    };
  }

  return {
    ok: true,
    instanceId,
    trashUri: options.skipTrash ? "" : trashUri,
    purgedAt,
  };
}

// Re-exports for callers that only want the public surface from one place.
export {
  manifestPathFromArchiveUri,
  parseColdStorageManifest,
} from "@/lib/cold-storage/manifest";
