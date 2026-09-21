import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createHmac } from "crypto";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  resolveProxmoxHostEnv,
  runProxmoxHostScript,
} from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const SAFE_INSTANCE_ID = /^[0-9a-f-]{36}$/i;
// restic short_id is 8 hex chars; accept up to a full 64-char id.
const SAFE_SNAPSHOT_ID = /^[0-9a-f]{8,64}$/i;
const LOG_SOURCE = "instance-granular-backups";

type InstanceBackupRow = {
  id: string;
  user_id: string;
  proxmox_node: string | null;
  proxmox_vmid: number | null;
  resource_tier: string | null;
  lifecycle_state: string | null;
  status: string | null;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// Same per-instance key derivation as the daily-instance-backups cron, so this
// route can open the instance's restic repo read-only to list restore points.
function deriveResticPassword(instanceId: string): string {
  const master = process.env.HERMES_RESTIC_MASTER_KEY?.trim();
  if (!master) throw new Error("HERMES_RESTIC_MASTER_KEY not configured");
  return createHmac("sha256", master).update(instanceId).digest("hex");
}

function buildColdStorageInstallScript(): string {
  const storageKeyB64 = process.env.HETZNER_SSH_PRIVATE_KEY_B64?.trim() ?? "";
  if (!storageKeyB64) {
    return `echo "HETZNER_SSH_PRIVATE_KEY_B64 missing; cold storage alias unavailable" >&2; exit 20`;
  }
  return `install -d -m 700 /root/.ssh
base64 -d > /etc/hivra/keys/cold-storage <<'HERMES_COLD_STORAGE_KEY'
${storageKeyB64}
HERMES_COLD_STORAGE_KEY
chmod 600 /etc/hivra/keys/cold-storage
touch /root/.ssh/config
chmod 600 /root/.ssh/config
sed -i '/# BEGIN HERMES COLD STORAGE/,/# END HERMES COLD STORAGE/d' /root/.ssh/config 2>/dev/null || true
cat >> /root/.ssh/config <<'HERMES_COLD_STORAGE_SSH_CONFIG'
# BEGIN HERMES COLD STORAGE
Host cold hermes-cold-storage
  HostName u594993.your-storagebox.de
  User u594993
  Port 23
  IdentityFile /etc/hivra/keys/cold-storage
  StrictHostKeyChecking accept-new
  UserKnownHostsFile /root/.ssh/known_hosts
# END HERMES COLD STORAGE
HERMES_COLD_STORAGE_SSH_CONFIG`;
}

function buildListResticScript(instanceId: string, password: string): string {
  return `set -uo pipefail
${buildColdStorageInstallScript()}
command -v restic >/dev/null 2>&1 || (DEBIAN_FRONTEND=noninteractive apt-get install -y restic >/dev/null 2>&1 || true)
export RESTIC_PASSWORD=${shellQuote(password)}
export RESTIC_CACHE_DIR=/var/lib/hermes-restic-cache
REPO="sftp:cold:restic/${instanceId}"
if ! restic -r "$REPO" cat config >/dev/null 2>&1; then
  echo '{"snapshots":[]}'
  exit 0
fi
echo -n '{"snapshots":'
restic -r "$REPO" snapshots --json 2>/dev/null || echo '[]'
echo '}'
`;
}

async function loadOwnedInstance(id: string, userId: string): Promise<InstanceBackupRow | null> {
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from("hermes_instances")
    .select("id, user_id, proxmox_node, proxmox_vmid, resource_tier, lifecycle_state, status")
    .eq("id", id)
    .eq("user_id", userId)
    .is("deleted_at", null)
    .maybeSingle();
  return (data as InstanceBackupRow | null) ?? null;
}

type ResticSnapshot = {
  id?: string;
  short_id?: string;
  time?: string;
  paths?: string[];
  tags?: string[];
};

async function listGranularBackups(instance: InstanceBackupRow) {
  if (!instance.proxmox_node) return [];
  const password = deriveResticPassword(instance.id);
  const hostEnv = resolveProxmoxHostEnv(
    { hostId: null, hostSlug: instance.proxmox_node, envPrefix: null, failClosed: true },
    process.env
  );
  const result = await runProxmoxHostScript(buildListResticScript(instance.id, password), hostEnv, {
    timeoutMs: 120_000,
  });
  if (!result.ok) {
    throw new Error(result.error ?? result.stderr ?? "Failed to list restore points");
  }
  const jsonLine = result.stdout
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.trim().startsWith("{") && line.includes("snapshots"));
  if (!jsonLine) return [];
  let parsed: { snapshots?: ResticSnapshot[] };
  try {
    parsed = JSON.parse(jsonLine);
  } catch {
    return [];
  }
  const snapshots = Array.isArray(parsed.snapshots) ? parsed.snapshots : [];
  // Newest first, mapped to the UI's generic restore-point shape.
  return snapshots
    .map((s) => ({
      id: s.short_id ?? s.id ?? "",
      created: s.time ?? null,
      kind: "granular_data",
      description: "Data restore point (chats + workspace)",
      paths: s.paths ?? [],
      size_bytes: null as number | null,
      sha256: undefined as string | undefined,
    }))
    .filter((s) => SAFE_SNAPSHOT_ID.test(s.id))
    .sort((a, b) => (a.created && b.created ? (a.created < b.created ? 1 : -1) : 0));
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    const { id } = await params;
    if (!SAFE_INSTANCE_ID.test(id)) return apiError("Invalid instance ID", 400);
    const instance = await loadOwnedInstance(id, userId);
    if (!instance) return apiError("Instance not found", 404);
    const backups = await listGranularBackups(instance);
    return apiSuccess({
      backups,
      retention_days: 7,
      restore_mode: "granular_request",
      protected_paths: ["chats & sessions", "workspace files"],
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    const { id } = await params;
    if (!SAFE_INSTANCE_ID.test(id)) return apiError("Invalid instance ID", 400);
    const body = await req.json().catch(() => ({}));
    const backupId = String(body.backupId ?? "").trim();
    const confirm = String(body.confirm ?? "").trim();
    if (!SAFE_SNAPSHOT_ID.test(backupId)) return apiError("Invalid backup ID", 400);
    if (confirm !== "RESTORE") return apiError("Type RESTORE to request a restore", 400);
    const instance = await loadOwnedInstance(id, userId);
    if (!instance) return apiError("Instance not found", 404);
    const backups = await listGranularBackups(instance);
    const backup = backups.find((item) => item.id === backupId);
    if (!backup) return apiError("Backup not found", 404);

    // Restore is performed MANUALLY by ops into a staging area, then cut over
    // after verification — never a blind overwrite of a live agent. There is no
    // automated queue, so we must (a) durably notify a human via an ops-event
    // and (b) tell the user the truth: the request was received and ops was
    // notified, but a manual restore is required.
    const restoreRequestId = `${id}:${backupId}:${Date.now()}`;
    log.warn("granular backup restore requested", {
      source: LOG_SOURCE,
      route: "/api/instances/[id]/backups",
      failureType: "granular_backup_restore_requested",
      instanceId: id,
      userId,
      backupId,
      restoreRequestId,
      proxmox_node: instance.proxmox_node,
      proxmox_vmid: instance.proxmox_vmid,
    });

    await reportOpsEvent({
      source: LOG_SOURCE,
      severity: "warn",
      title: "Granular backup restore requested",
      message:
        "A user requested a granular data restore. This is not automated — ops must perform the restore into a staging area manually.",
      route: "/api/instances/[id]/backups",
      userId,
      instanceId: id,
      metadata: {
        failureType: "granular_backup_restore_requested",
        recoveryAction: "perform_manual_granular_restore",
        backupId,
        restoreRequestId,
        proxmox_node: instance.proxmox_node,
        proxmox_vmid: instance.proxmox_vmid,
      },
    });

    return apiSuccess(
      {
        accepted: true,
        restore_request_id: restoreRequestId,
        backup,
        message:
          "Restore request received and our ops team has been notified. A manual restore into a staging area is required — your live agent is not modified. We'll reach out once it's been processed.",
      },
      202
    );
  } catch (err) {
    return handleApiError(err);
  }
}
