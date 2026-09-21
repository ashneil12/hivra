import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import {
  buildConfigSnapshotStagingScript,
  buildMetadataFile,
  parseStagedFiles,
  pushSnapshotToGitHub,
  redactStagedFiles,
  scanForSecrets,
  type StagedFile,
} from "@/lib/services/config-snapshot";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  resolveProxmoxHostEnv,
  runProxmoxHostScript,
} from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
// Staging is light (a handful of small config files over SSH), but bound the host script
// well under the function wall so a hung guest read fails closed instead of truncating.
export const maxDuration = 300;
const HOST_STAGE_TIMEOUT_MS = 240_000;

const LOG_SOURCE = "cron:daily-config-snapshot";
const ROUTE = "/api/cron/daily-config-snapshot";
const HEARTBEAT = "daily-config-snapshot";
const SAFE_INSTANCE_ID = /^[0-9a-f-]{36}$/i;
const SAFE_GUEST_IP = /^[0-9.]{7,15}$/;

const DEFAULT_BRANCH = "main";

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "true" || v === "1" || v === "yes";
}

function redactHostOutput(value: string, max = 8000): string {
  return value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED_KEY]")
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED]")
    .slice(0, max);
}

type TargetRow = {
  id: string;
  name: string | null;
  status: string | null;
  lifecycle_state: string | null;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  ipv4_address: string | null;
  deleted_at: string | null;
};

async function handle(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return apiError("Cron secret is not configured", 500);
  if (!verifyBearerHeader(req, cronSecret)) return apiError("Unauthorized", 401);
  if (!supabaseAdmin) return apiError("Database not configured", 500);

  // run-one forces an apply push regardless of the flag (manual smoke test); dry-run stages
  // + scans without pushing; otherwise the flag decides. Mirrors daily-instance-backups.
  const action = req.nextUrl.searchParams.get("action")?.trim() ?? "";
  const enabled = envBool("DAILY_CONFIG_SNAPSHOT_ENABLED", false);
  const apply = action === "run-one" ? true : action === "dry-run" ? false : enabled;
  const shouldStage = apply || action === "dry-run";

  // While disabled, the scheduled cron does NOTHING expensive — no DB lookup, no SSH, no
  // host I/O for a feature that isn't activated yet (and on the canary DB the tracked
  // prod instance doesn't exist, which would otherwise 404-warn daily). `?action=dry-run`
  // forces a real stage+scan (no push); `?action=run-one` forces a full apply. Mirrors
  // daily-instance-backups' dark mode.
  if (!shouldStage) {
    return apiSuccess({
      ok: true,
      mode: "disabled",
      note: "DAILY_CONFIG_SNAPSHOT_ENABLED is off; no work performed. Use ?action=dry-run to stage+scan, ?action=run-one to push.",
    });
  }

  // Snapshot targets are deployment-owned inventory. Never bake a Hivra
  // instance or backup repository into the public source tree.
  const instanceId = (process.env.CONFIG_SNAPSHOT_INSTANCE_ID?.trim() || "").toLowerCase();
  if (!SAFE_INSTANCE_ID.test(instanceId)) {
    return apiError("CONFIG_SNAPSHOT_INSTANCE_ID must be a configured UUID", 500);
  }
  const repo = process.env.HERMESOS_BACKUP_REPO?.trim();
  if (!repo) return apiError("HERMESOS_BACKUP_REPO is not configured", 500);
  const branch = process.env.HERMESOS_BACKUP_BRANCH?.trim() || DEFAULT_BRANCH;

  // Resolve the live host/vmid/ip for the tracked instance.
  const { data, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, name, status, lifecycle_state, proxmox_node, proxmox_vmid, ipv4_address, deleted_at")
    .eq("id", instanceId)
    .maybeSingle();

  if (error) {
    log.error("config snapshot target query failed", error, {
      source: LOG_SOURCE,
      route: ROUTE,
      failureType: "config_snapshot_target_query_failed",
      instanceId,
    });
    return apiError(`target query failed: ${error.message}`, 500);
  }
  const row = data as TargetRow | null;
  if (!row) return apiError(`tracked instance not found: ${instanceId}`, 404);
  if (row.deleted_at) return apiError(`tracked instance is deleted: ${instanceId}`, 409);
  if (row.lifecycle_state !== "active" || row.status !== "running") {
    return apiError(
      `tracked instance not running (lifecycle=${row.lifecycle_state} status=${row.status})`,
      409
    );
  }
  if (!row.proxmox_node || !row.proxmox_vmid || row.proxmox_vmid <= 0) {
    return apiError("tracked instance missing proxmox_node/proxmox_vmid", 409);
  }
  const guestIp = row.ipv4_address && SAFE_GUEST_IP.test(row.ipv4_address) ? row.ipv4_address : null;

  // Stage the allowlisted config on the host (the GitHub token is NOT in scope here).
  const hostEnv = resolveProxmoxHostEnv(
    { hostId: null, hostSlug: row.proxmox_node, envPrefix: null, failClosed: true },
    process.env
  );
  const stageResult = await runProxmoxHostScript(
    buildConfigSnapshotStagingScript({ instanceId, vmid: row.proxmox_vmid, guestIp }),
    hostEnv,
    { timeoutMs: HOST_STAGE_TIMEOUT_MS }
  );
  if (!stageResult.ok) {
    await reportOpsEvent({
      source: "cron.daily_config_snapshot_failed",
      severity: "warn",
      title: "Config snapshot: host staging failed",
      message:
        `daily-config-snapshot staging failed for instance ${instanceId} on ${row.proxmox_node}/` +
        `${row.proxmox_vmid}: ${stageResult.error ?? stageResult.stderr ?? "unknown error"}`,
      route: ROUTE,
      metadata: { instance_id: instanceId, proxmox_node: row.proxmox_node, proxmox_vmid: row.proxmox_vmid },
    });
    return apiError(stageResult.error ?? stageResult.stderr ?? "host staging failed", 500, undefined, {
      stderr: redactHostOutput(stageResult.stderr, 4000),
    });
  }

  // Parse -> redact config.yaml -> add metadata -> fail-closed scan.
  let files: StagedFile[];
  try {
    files = redactStagedFiles(parseStagedFiles(stageResult.stdout));
  } catch (err) {
    return apiError(`failed to parse staged files: ${err instanceof Error ? err.message : String(err)}`, 500);
  }
  files.push(
    buildMetadataFile({ instanceId, proxmoxNode: row.proxmox_node, proxmoxVmid: row.proxmox_vmid })
  );

  const hits = scanForSecrets(files);
  if (hits.length > 0) {
    await reportOpsEvent({
      source: "cron.daily_config_snapshot_blocked",
      severity: "error",
      title: `Config snapshot BLOCKED: ${hits.length} secret/path hit(s)`,
      message:
        `daily-config-snapshot refused to push for instance ${instanceId}: the fail-closed scanner ` +
        `flagged ${hits.length} hit(s). The allowlist or redaction may have a gap. Hits: ` +
        hits.slice(0, 20).map((h) => `${h.kind}:${h.path}`).join(", "),
      route: ROUTE,
      metadata: { instance_id: instanceId, hits: hits.slice(0, 50) },
    });
    return apiError("blocked: secret/path scan failed", 422, undefined, { hits: hits.slice(0, 50) });
  }

  const fileCount = files.length;
  const summary = {
    instance_id: instanceId,
    name: row.name,
    proxmox_node: row.proxmox_node,
    proxmox_vmid: row.proxmox_vmid,
    repo,
    branch,
    files: fileCount,
    apply,
  };

  if (!apply) {
    // dry-run / disabled: staged + scanned clean, nothing pushed.
    return apiSuccess({ ok: true, mode: "dry_run", ...summary });
  }

  const token = process.env.HERMESOS_BACKUP_GH_TOKEN?.trim();
  if (!token) {
    return apiError("HERMESOS_BACKUP_GH_TOKEN not configured", 500, undefined, summary);
  }

  try {
    const pushed = await pushSnapshotToGitHub({
      repo,
      branch,
      token,
      files,
      commitMessage: `backup: Hermes config snapshot ${new Date().toISOString().replace(/\.\d+Z$/, "Z")}`,
    });
    await recordCronHeartbeat(HEARTBEAT);
    return apiSuccess({
      ok: true,
      mode: "applied",
      ...summary,
      changed: pushed.changed,
      commit: pushed.commitSha ?? null,
      blobs_uploaded: pushed.blobsUploaded,
      files_deleted: pushed.filesDeleted,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await reportOpsEvent({
      source: "cron.daily_config_snapshot_failed",
      severity: "warn",
      title: "Config snapshot: GitHub push failed",
      message:
        `daily-config-snapshot push to ${repo}@${branch} failed for instance ${instanceId}: ${message}. ` +
        `A 401/403 usually means HERMESOS_BACKUP_GH_TOKEN expired or lost Contents:write on ${repo}.`,
      route: ROUTE,
      metadata: { instance_id: instanceId, repo, branch },
    });
    log.error("config snapshot push failed", err, {
      source: LOG_SOURCE,
      route: ROUTE,
      failureType: "config_snapshot_push_failed",
      instanceId,
    });
    return apiError(`github push failed: ${message}`, 500, undefined, summary);
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
