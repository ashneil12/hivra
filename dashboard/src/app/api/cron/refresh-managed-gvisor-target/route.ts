import type { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { isCanonicalGitCanaryDeployment } from "@/lib/hivra/canonical-git-canary";
import {
  managedGvisorAuthorityConfig,
  managedGvisorGeneralLaunchEnabled,
  managedGvisorQaEnrollmentConfig,
  managedGvisorQaEnrollmentEnabled,
} from "@/lib/hivra/managed-gvisor-launch-config";
import { GvisorTargetError, refreshManagedGvisorTarget } from "@/lib/infrastructure/gvisor-target";
import { log } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

const CRON = "refresh-managed-gvisor-target";

export async function GET(req: NextRequest) {
  const env = process.env;
  const secret = env.CRON_SECRET;
  if (!secret) {
    log.error("Managed gVisor refresh cron secret missing", new Error("CRON_SECRET missing"), { source: CRON });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, secret)) return apiError("Unauthorized", 401);

  try {
    const general = managedGvisorGeneralLaunchEnabled(env);
    const qa = managedGvisorQaEnrollmentEnabled(env);
    if (!general && !(qa && isCanonicalGitCanaryDeployment(env) && managedGvisorQaEnrollmentConfig(env))) {
      await recordCronHeartbeat(CRON);
      return apiSuccess({ refreshed: false });
    }
    const config = managedGvisorAuthorityConfig(env);
    if (!config || (general && qa)) {
      throw new GvisorTargetError("unsupported", "Managed gVisor authority is not configured for refresh.");
    }
    await refreshManagedGvisorTarget(config);
    await recordCronHeartbeat(CRON);
    return apiSuccess({ refreshed: true });
  } catch (err) {
    const detail = err instanceof GvisorTargetError ? err.code : "refresh_failed";
    log.error("Managed gVisor target refresh failed", new Error(detail), {
      source: CRON,
      route: "/api/cron/refresh-managed-gvisor-target",
      method: "GET",
      failureType: detail,
    });
    await recordCronHeartbeat(CRON, { ok: false, detail });
    return apiError("Managed gVisor target refresh failed", 503);
  }
}
