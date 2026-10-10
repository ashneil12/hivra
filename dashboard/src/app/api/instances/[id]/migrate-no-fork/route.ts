// GET/POST /api/instances/[id]/migrate-no-fork
//
// "Update to latest Hermes": moves a box from the Hivra Hermes fork image onto stock upstream Hermes
// plus the Hivra overlay, keeping everything the user owns and rolling back by itself if any check
// fails. The work runs ON the box (a detached systemd unit, see no-fork-migration-builder.ts); this
// route only offers it, starts it, and reads the box's honest progress file.
//
//   GET   offer + (with ?status=1) the live progress read from the box
//   POST  start (owner only, only when the registry offers an overlay release)
import { NextRequest } from "next/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { evaluateNoForkOffer, parseNoForkStatus } from "@/lib/hermes-releases/no-fork";
import { isRegistryMissingError } from "@/lib/hermes-releases/live-update";
import { loadReleases } from "@/lib/hermes-releases/store";
import { sshExec } from "@/lib/hetzner/ssh";
import { log } from "@/lib/logger";
import { validateConsoleAccess } from "@/lib/services/console-helpers";
import {
  buildNoForkMigrationLauncher,
  buildNoForkMigrationScript,
  NOFORK_OVERLAY_REPO,
  NOFORK_STATUS_DIR,
  NOFORK_UPSTREAM_ALIAS,
} from "@/lib/services/no-fork-migration-builder";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const SOURCE = "no-fork-migration";

async function loadOffer(instance: { id: string; status: string | null; backend?: string | null; release_channel?: string | null; config: Record<string, unknown> | null }) {
  let releases: Awaited<ReturnType<typeof loadReleases>> = [];
  try {
    releases = await loadReleases(supabaseAdmin!, NOFORK_OVERLAY_REPO);
  } catch (err) {
    if (!isRegistryMissingError(err)) throw err;
  }
  return evaluateNoForkOffer(instance, releases);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    const access = await validateConsoleAccess(params);
    if (access.errorResponse) return access.errorResponse;
    const instance = access.instance as unknown as Parameters<typeof loadOffer>[0];
    let offer = await loadOffer(instance);

    let progress = null;
    if (request.nextUrl.searchParams.get("status") === "1") {
      const read = await sshExec(
        access.hostIp!,
        `cat ${NOFORK_STATUS_DIR(access.id!)}/status.json 2>/dev/null || true`,
        { timeoutMs: 15_000, proxmoxHostConfig: access.proxmoxHostConfig ?? null }
      ).catch(() => null);
      progress = parseNoForkStatus(read?.ok ? read.stdout : null);
    }

    // The box finished the move: record it so every later update path keeps the box on upstream.
    if (progress?.state === "done" && !offer.alreadyUpstream) {
      const config = { ...(instance.config ?? {}), webuiAgentImage: NOFORK_UPSTREAM_ALIAS, agentSource: "upstream-overlay" };
      const { error } = await supabaseAdmin.from("hermes_instances").update({ config }).eq("id", access.id!).eq("user_id", access.userId!);
      if (error) log.warn("could not record the upstream move", { source: SOURCE, instanceId: access.id, cause: error.message });
      else offer = await loadOffer({ ...instance, config });
    }
    return apiSuccess({ offer, progress });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    const access = await validateConsoleAccess(params);
    if (access.errorResponse) return access.errorResponse;
    const instance = access.instance as unknown as Parameters<typeof loadOffer>[0];
    const offer = await loadOffer(instance);
    if (!offer.available || !offer.target) {
      return apiError("The latest Hermes is not available for this agent right now.", 409, undefined, undefined, { failureType: `no_fork_${offer.reason}`, source: SOURCE });
    }

    const current = await sshExec(
      access.hostIp!,
      `cat ${NOFORK_STATUS_DIR(access.id!)}/status.json 2>/dev/null || true`,
      { timeoutMs: 15_000, proxmoxHostConfig: access.proxmoxHostConfig ?? null }
    ).catch(() => null);
    const progress = parseNoForkStatus(current?.ok ? current.stdout : null);
    if (progress?.state === "running") return apiError("An update is already running for this agent.", 409);

    const script = buildNoForkMigrationScript({ instanceId: access.id!, overlayImage: offer.target.overlayImage });
    const launch = await sshExec(access.hostIp!, buildNoForkMigrationLauncher(script, access.id!), {
      timeoutMs: 60_000,
      proxmoxHostConfig: access.proxmoxHostConfig ?? null,
    });
    if (!launch.ok || !/started/.test(launch.stdout ?? "")) {
      log.warn("could not start the upstream move", { source: SOURCE, instanceId: access.id, failureType: "no_fork_launch_failed", stderr: (launch.stderr ?? "").slice(0, 300) });
      return apiError("Could not start the update. Nothing was changed.", 502);
    }
    log.info("upstream move started", { source: SOURCE, instanceId: access.id, version: offer.target.version });
    return apiSuccess({ started: true, version: offer.target.version }, 202);
  } catch (err) {
    return handleApiError(err);
  }
}
