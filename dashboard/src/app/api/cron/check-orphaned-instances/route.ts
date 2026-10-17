import { NextRequest } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";
import {
  runOrphanSweep,
} from "@/lib/recovery/orphaned-instances";
import { buildShutdownInstance } from "@/lib/recovery/orphan-instance-shutdown";
import { supabaseAdmin } from "@/lib/supabase";

const SOURCE = "cron/check-orphaned-instances";

/**
 * Weekly cron sweep: find hermes_instances whose Clerk owner has been
 * deleted, shut down their VMs, and schedule them for deletion in 3 days.
 *
 * The 3-day grace gives a window for the user (or someone in their org)
 * to reach out if the deletion was a mistake. The existing
 * `/api/cron/purge-expired` route does the actual teardown when the
 * deadline passes.
 *
 * Schedule: Monday 09:00 UTC via vercel.json.
 *
 * Why a Vercel cron and not a remote agent: prod CLERK_SECRET_KEY +
 * SUPABASE_SERVICE_ROLE_KEY are already in the Vercel env. A remote
 * Claude routine would need them injected, which means embedding live
 * secrets in the routine config in plaintext.
 */
export const dynamic = "force-dynamic";
// Shutting down many VMs over SSH/Hetzner in one weekly run could exceed the
// default function budget. Give it a real ceiling.
export const maxDuration = 800;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error(
      "CRON_SECRET is not configured; refusing to run",
      new Error("CRON_SECRET missing"),
      {
        source: SOURCE,
        route: "/api/cron/check-orphaned-instances",
        method: "GET",
        failureType: "cron_secret_missing",
      },
    );
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }
  if (!supabaseAdmin) {
    return apiError("Database not configured", 500);
  }

  try {
    const clerk = await clerkClient();
    const summary = await runOrphanSweep({
      supabase: supabaseAdmin,
      clerk: clerk.users,
      apply: true,
      shutdownInstance: buildShutdownInstance(supabaseAdmin),
    });

    log.info("orphan sweep complete", {
      source: SOURCE,
      route: "/api/cron/check-orphaned-instances",
      method: "GET",
      ...summary,
    });

    // Surface shutdown failures: previously per-instance shutdown failures were
    // only in the summary and the route returned 200 with no ops-event, so a
    // batch of failed shutdowns (SSH down) was easy to miss until purge-expired
    // tried to delete still-running VMs. Emit a warn event. Best-effort.
    if (summary.shutdownFailures > 0) {
      await reportOpsEvent({
        source: "cron.check_orphaned_instances_shutdown_failed",
        severity: "warn",
        title: `check-orphaned-instances: ${summary.shutdownFailures} shutdown(s) failed`,
        message:
          `check-orphaned-instances scheduled ${summary.newlyDisabled} orphan(s) for deletion but ` +
          `${summary.shutdownFailures} VM shutdown(s) failed (deletion was still scheduled). Those VMs ` +
          `may still be running + billing until purge-expired retries — check SSH/Hetzner host health.`,
        route: "/api/cron/check-orphaned-instances",
        metadata: {
          total_checked: summary.totalChecked,
          newly_disabled: summary.newlyDisabled,
          shutdown_failures: summary.shutdownFailures,
          lookup_failures: summary.lookupFailures,
        },
      });
    }

    // Audit trail for the destructive scheduling decision: surface when newly
    // orphaned owners had their instances armed for deletion. (The sweep already
    // distinguishes lookup-failed from orphan, so a transient Clerk hiccup does
    // NOT schedule deletion — see runOrphanSweep.)
    if (summary.newlyDisabled > 0) {
      await reportOpsEvent({
        source: "cron.check_orphaned_instances_scheduled",
        severity: "warn",
        title: `check-orphaned-instances armed ${summary.newlyDisabled} orphan(s) for deletion`,
        message:
          `check-orphaned-instances flagged ${summary.newlyDisabled} instance(s) whose Clerk owner ` +
          `appears deleted, shut down their VMs, and scheduled deletion (3-day grace, purge-expired ` +
          `does the teardown). If any of these is a live paying customer, restore before the deadline.`,
        route: "/api/cron/check-orphaned-instances",
        metadata: {
          newly_disabled: summary.newlyDisabled,
          orphan_ids: summary.orphanIds.slice(0, 50),
          lookup_failures: summary.lookupFailures,
        },
      });
    }

    return apiSuccess(summary);
  } catch (err) {
    log.error("orphan sweep failed", err, {
      source: SOURCE,
      route: "/api/cron/check-orphaned-instances",
      method: "GET",
      failureType: "orphan_sweep_failed",
    });
    const message = err instanceof Error ? err.message : "Orphan sweep failed";
    return apiError(message, 500);
  }
}
