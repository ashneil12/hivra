import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import {
  runManagedProvisionerBundleConvergence,
  type ManagedBundleHostReport,
} from "@/lib/hivra/managed-provisioner-bundle-convergence";
import { managedHivraProvisionerChannelForServerEnvironment } from "@/lib/hivra/managed-provisioner-channel";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import { supabaseAdmin } from "@/lib/supabase";

/**
 * Cron-triggered convergence of managed Proxmox hosts onto this deployment's
 * provisioner bundle. See src/lib/hivra/managed-provisioner-bundle-convergence.ts.
 *
 * Without it, every provisioner version bump left owners' "Update connection
 * service" returning 503 until an operator synced each host through
 * /api/ops/hivra/provisioner-bundle (2026-10-10: Start, Restart and launch were
 * blocked on four of five prod hosts).
 *
 * OFF unless HIVRA_MANAGED_BUNDLE_SYNC_ENABLED=true; off does no DB read and
 * no SSH. ?dryRun=1 probes every host and syncs nothing, whether or not the
 * switch is on.
 *
 * Schedule: every 10 minutes via vercel.json, one host synced per run.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Probes run in parallel (20 s each); up to two syncs of 120 s each follow.
export const maxDuration = 300;

const SOURCE = "sync-managed-provisioner-bundles";
const ROUTE = "/api/cron/sync-managed-provisioner-bundles";

// Hosts a person has to look at. A host that is merely behind and waiting for
// its turn is not one of them.
function attentionFor(host: ManagedBundleHostReport): { severity: "error" | "warn"; why: string } | null {
  const holdsComputers = host.liveComputers > 0;
  switch (host.status) {
    case "sync_failed":
      return { severity: "error", why: "the bundle sync failed and the previous bundle was kept" };
    case "not_prepared":
      return holdsComputers
        ? { severity: "error", why: "it has no provisioner directory for this channel but holds computers on it" }
        : null;
    case "unconfigured":
      return holdsComputers
        ? { severity: "error", why: "it holds computers but this deployment has no configuration for it" }
        : { severity: "warn", why: "it is an active placement host but this deployment has no configuration for it" };
    case "unreachable":
      return { severity: holdsComputers ? "error" : "warn", why: "the read-only bundle probe failed" };
    case "newer_on_host":
      return { severity: "warn", why: "it carries a newer provisioner than this deployment ships, so it was left alone" };
    default:
      return null;
  }
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: SOURCE,
      route: ROUTE,
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  try {
    const dryRunParam = new URL(req.url).searchParams.get("dryRun");
    const dryRun = dryRunParam === "1" || dryRunParam === "true";
    // Throws for an unfamiliar deployment, which must never write a shared
    // production provisioner directory.
    const channel = managedHivraProvisionerChannelForServerEnvironment(process.env);
    const summary = await runManagedProvisionerBundleConvergence({
      supabase: supabaseAdmin,
      env: process.env,
      channel,
      dryRun,
    });

    log.info("managed provisioner bundle convergence run", {
      source: SOURCE,
      enabled: summary.enabled,
      dryRun: summary.dryRun,
      channel: summary.channel,
      requestedVersion: summary.requestedVersion,
      synced: summary.synced,
      pending: summary.pending,
      hosts: summary.hosts.map((host) => ({
        targetId: host.targetId,
        status: host.status,
        observedVersion: host.observedVersion,
        liveComputers: host.liveComputers,
      })),
    });

    for (const host of summary.hosts) {
      if (host.status === "synced") {
        await reportOpsEvent({
          source: "cron.sync_managed_provisioner_bundles",
          severity: "info",
          title: `Provisioner bundle ${summary.requestedVersion} synced on ${host.targetId} (${summary.channel})`,
          message:
            `Brought ${host.targetId}'s ${summary.channel} provisioner bundle up to ${summary.requestedVersion} ` +
            `so owner runtime updates there no longer need an operator. VM inventory and Caddy state were unchanged.`,
          route: ROUTE,
          metadata: { ...host, channel: summary.channel, requestedVersion: summary.requestedVersion },
        });
        continue;
      }
      const attention = attentionFor(host);
      if (!attention) continue;
      // Stable text (no counts or timestamps) so repeated runs fold into one
      // ops_events row per host and condition.
      await reportOpsEvent({
        source: "cron.sync_managed_provisioner_bundles",
        severity: attention.severity,
        title: `Provisioner bundle on ${host.targetId} (${summary.channel}) needs attention: ${host.status}`,
        message:
          `Automatic bundle sync cannot bring ${host.targetId} to ${summary.requestedVersion} because ${attention.why}. ` +
          `Owner runtime updates on this host keep failing until it is fixed; ` +
          `the operator route is /api/ops/hivra/provisioner-bundle.`,
        route: ROUTE,
        metadata: { ...host, channel: summary.channel, requestedVersion: summary.requestedVersion },
      });
    }

    return apiSuccess(summary);
  } catch (error) {
    log.error("managed provisioner bundle convergence failed", error instanceof Error ? error : new Error(String(error)), {
      source: SOURCE,
      route: ROUTE,
      method: "GET",
      failureType: "managed_provisioner_bundle_convergence_failed",
    });
    return apiError("Managed provisioner bundle convergence failed", 500);
  }
}
