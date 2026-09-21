export interface FleetLiveUpdateArgs {
  apply: boolean;
  dryRun: boolean;
  instanceId: string | null;
  concurrency: number;
  staleSince: string | null;
}

export interface FleetInstanceLike {
  id: string;
  name?: string | null;
  last_synced_at?: string | null;
}

export interface FleetUpdateResult {
  instanceId: string;
  name: string;
  status: "updated" | "skipped" | "failed";
  detail: string;
}

export interface FleetUpdateReportEvent {
  title?: string | null;
  last_seen_at?: string | null;
  metadata?: { reason?: unknown; detail?: unknown } | null;
}

export type FleetUpdateReportOutcome =
  | { status: "succeeded" }
  | { status: "failed"; detail: string }
  | null;

// WebUI-free instances persist `backend=gateway` even though they use the same
// generated WebUI compose/update path. Excluding that value makes a targeted
// repair silently discover zero instances.
export const FLEET_LIVE_UPDATE_BACKENDS = ["webui", "gateway"] as const;

/**
 * Classify only callbacks emitted after this launch. ops_events collapses
 * repeated reports by fingerprint, so an older success/failure row may still
 * exist for the instance and must not complete a new fleet job.
 */
export function classifyFleetUpdateReport(
  events: FleetUpdateReportEvent[],
  launchedAt: string,
): FleetUpdateReportOutcome {
  const launchedAtMs = Date.parse(launchedAt);
  const fresh = events
    .filter((event) => {
      const seenAtMs = Date.parse(event.last_seen_at ?? "");
      return Number.isFinite(seenAtMs) && seenAtMs >= launchedAtMs;
    })
    .sort(
      (a, b) => Date.parse(b.last_seen_at ?? "") - Date.parse(a.last_seen_at ?? ""),
    );

  for (const event of fresh) {
    if (event.title === "Manual update succeeded") return { status: "succeeded" };
    if (event.title === "Manual update failed") {
      const detail = event.metadata?.detail;
      const reason = event.metadata?.reason;
      return {
        status: "failed",
        detail:
          typeof detail === "string" && detail.trim()
            ? detail
            : typeof reason === "string" && reason.trim()
              ? reason
              : "instance reported an update failure",
      };
    }
  }
  return null;
}

export function parseFleetLiveUpdateArgs(argv: string[]): FleetLiveUpdateArgs {
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  const instanceIdx = argv.indexOf("--instance");
  const instanceId = instanceIdx >= 0 ? argv[instanceIdx + 1] || null : null;
  const concurrencyIdx = argv.indexOf("--concurrency");
  const staleSinceIdx = argv.indexOf("--stale-since");
  const concurrency = concurrencyIdx >= 0
    ? Math.max(1, Math.min(10, Number(argv[concurrencyIdx + 1]) || 1))
    : 1;
  const staleSince = staleSinceIdx >= 0 ? argv[staleSinceIdx + 1] || null : null;

  if (!apply && !dryRun) {
    throw new Error("Pass --dry-run to preview or --apply to update the fleet.");
  }
  if (apply && dryRun) {
    throw new Error("Choose only one of --dry-run or --apply.");
  }
  if (staleSince) {
    const parsed = Date.parse(staleSince);
    if (!Number.isFinite(parsed)) {
      throw new Error("--stale-since must be an ISO timestamp.");
    }
  }

  return { apply, dryRun, instanceId, concurrency, staleSince };
}

function isStaleSince(instance: FleetInstanceLike, staleSince: string | null): boolean {
  if (!staleSince) return true;
  if (!instance.last_synced_at) return true;
  return Date.parse(instance.last_synced_at) < Date.parse(staleSince);
}

export function filterStaleInstances<T extends FleetInstanceLike>(
  instances: T[],
  staleSince: string | null,
): T[] {
  return instances.filter((instance) => isStaleSince(instance, staleSince));
}

export function safeErrorMessage(err: unknown, maxLength = 600): string {
  const message = err instanceof Error
    ? err.stack || err.message
    : typeof err === "string"
      ? err
      : JSON.stringify(err);
  return (message || "Unknown error").slice(0, maxLength);
}

export async function captureFleetUpdateFailure(
  instance: FleetInstanceLike,
  worker: () => Promise<FleetUpdateResult>,
  onError?: (message: string) => void,
): Promise<FleetUpdateResult> {
  try {
    return await worker();
  } catch (err) {
    const detail = `applyLiveUpdate threw: ${safeErrorMessage(err)}`;
    onError?.(detail);
    return {
      instanceId: instance.id,
      name: instance.name || instance.id,
      status: "failed",
      detail,
    };
  }
}
