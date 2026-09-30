// A Linux Sandbox host authorizes a new sandbox only within 15 minutes of its
// last strict check (the server's executionAuthority). An owner who picked the
// host near the end of that window, then spent a minute on the plan, used to
// get a refusal at Launch. Launch checks the host again first instead; the
// check is read-only.

import { checkGvisorConnection, discoverInfrastructureHost, InfrastructureApiError } from "@/lib/infrastructure/client";
import { isGvisorDeploymentTarget, type DeploymentTargetDto } from "@/lib/infrastructure/contracts";
import { gvisorCheckFailure } from "@/lib/infrastructure/gvisor-check-failure";
import { hasReadyEvidence, launchReadyUntil } from "@/lib/infrastructure/launch-on-server";

/** Time the launch request needs to reach the server with the check still fresh. */
export const GVISOR_RECHECK_MARGIN_MS = 2 * 60_000;

/** A Linux Sandbox host whose readiness lapses before this launch would reach it. */
export function gvisorNeedsRecheck(target: DeploymentTargetDto | null | undefined, now: number): target is DeploymentTargetDto {
  return Boolean(target && isGvisorDeploymentTarget(target) && hasReadyEvidence(target)
    && launchReadyUntil(target) - now < GVISOR_RECHECK_MARGIN_MS);
}

export class GvisorRecheckError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GvisorRecheckError";
  }
}

type Dependencies = { check: typeof checkGvisorConnection; discover: typeof discoverInfrastructureHost };

/** Runs the read-only strict check again, inspecting first when Hivra's last
 * look at the host has expired. Throws GvisorRecheckError in plain words. */
export async function recheckGvisorForLaunch(
  target: DeploymentTargetDto,
  deps: Dependencies = { check: checkGvisorConnection, discover: discoverInfrastructureHost },
): Promise<void> {
  const strict = async () => {
    const result = await deps.check(target.connectionId);
    if (!result.ready) throw new InfrastructureApiError("The readiness check did not pass.", 502, "remote_failed");
  };
  try {
    try {
      await strict();
    } catch (error) {
      if (!(error instanceof InfrastructureApiError) || error.code !== "discovery_required") throw error;
      await deps.discover(target.connectionId);
      await strict();
    }
  } catch (error) {
    const failure = gvisorCheckFailure(error, target.displayName);
    throw new GvisorRecheckError(failure.message, error instanceof InfrastructureApiError ? error.status : 409);
  }
}
