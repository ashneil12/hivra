import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { runProxmoxOrphanSweep } from "@/lib/recovery/proxmox-orphan-detection";

/**
 * Cron-triggered orphan sweep. See src/lib/recovery/proxmox-orphan-detection.ts.
 *
 * For each active/draining proxmox_hosts row, SSH in and:
 *  - list running VMIDs and log.warn each VM with no matching hermes_instances
 *    row (visibility only — a row-less VM could be an unregistered debug VM);
 *  - scan for orphaned `vm-<vmid>-*` LVs with no qemu-server config (the
 *    crashed-clone doom-loop landmines) and log.warn each. When
 *    HERMES_ORPHAN_LV_REAP_ENABLED=true these are lvremove'd (config-less
 *    re-check + DB cross-check); OFF by default.
 *
 * Schedule: every 6 hours via vercel.json. Orphans don't accumulate
 * fast, and SSH-per-host is slow enough that a tighter cadence would
 * burn budget without buying anything.
 */
export const dynamic = "force-dynamic";
// SSH-per-host across the ~20-host fleet can approach the default function
// budget on a slow host and silently skip the tail. Give it a real ceiling.
export const maxDuration = 800;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: "detect-proxmox-orphans",
        route: "/api/cron/detect-proxmox-orphans",
        method: "GET",
        failureType: "cron_secret_missing",
      },
    );
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    const summary = await runProxmoxOrphanSweep();

    // Escalate orphan detection from log.warn (lib) to the ops feed. Orphan
    // `vm-<vmid>-*` LVs with no qemu-server config ARE the crashed-clone
    // doom-loop landmines that silently break fresh signups (the allocator keeps
    // re-placing at the dead vmid). Steady state is detection-only
    // (HERMES_ORPHAN_LV_REAP_ENABLED=false), so a human must lvremove them — page
    // so they don't sit unnoticed until the next signup breaks. Best-effort.
    if (summary.orphanLvsDetected > 0) {
      const reaped = summary.orphanLvsReaped;
      await reportOpsEvent({
        source: "synthetic.proxmox-orphan-lv",
        severity: "error",
        title: `Proxmox orphan LVs detected: ${summary.orphanLvsDetected} (reaped ${reaped})`,
        message:
          `detect-proxmox-orphans found ${summary.orphanLvsDetected} config-less vm-<vmid>-* LV group(s) ` +
          `across ${summary.hostsScanned} host(s); ${reaped} were lvremove'd ` +
          `(reapEnabled=${summary.reapEnabled}). Un-reaped orphan LVs are the crashed-clone doom-loop ` +
          `landmines that break fresh signups — lvremove the confirmed orphans on the affected host(s).`,
        route: "/api/cron/detect-proxmox-orphans",
        metadata: {
          orphan_lvs_detected: summary.orphanLvsDetected,
          orphan_lvs_reaped: summary.orphanLvsReaped,
          reap_enabled: summary.reapEnabled,
          hosts_with_orphan_lvs: summary.hosts
            .filter((h) => h.orphanLvCount > 0)
            .map((h) => ({ host_id: h.hostId, orphan_lv_count: h.orphanLvCount, orphan_lv_reaped: h.orphanLvReaped })),
        },
      });
    }

    // Orphan VMs (running VM with no hermes_instances row) are lower severity —
    // could be an unregistered debug VM — but still worth surfacing rather than
    // burying in log.warn.
    if (summary.orphansDetected > 0) {
      await reportOpsEvent({
        source: "synthetic.proxmox-orphan-vm",
        severity: "warn",
        title: `Proxmox orphan VMs detected: ${summary.orphansDetected}`,
        message:
          `detect-proxmox-orphans found ${summary.orphansDetected} running VM(s) with no matching ` +
          `hermes_instances row across ${summary.hostsScanned} host(s). Verify each is an intended ` +
          `unregistered VM and not a billing/lifecycle leak.`,
        route: "/api/cron/detect-proxmox-orphans",
        metadata: {
          orphans_detected: summary.orphansDetected,
          hosts_with_orphan_vms: summary.hosts
            .filter((h) => h.orphanCount > 0)
            .map((h) => ({ host_id: h.hostId, orphan_count: h.orphanCount })),
        },
      });
    }

    return apiSuccess(summary);
  } catch (err) {
    log.error("proxmox orphan sweep failed", err, {
      source: "detect-proxmox-orphans",
      route: "/api/cron/detect-proxmox-orphans",
      method: "GET",
      failureType: "proxmox_orphan_sweep_failed",
    });
    const message = err instanceof Error ? err.message : "Proxmox orphan sweep failed";
    return apiError(message, 500);
  }
}
