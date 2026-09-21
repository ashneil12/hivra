import { posthogClient } from "@/lib/posthog";
import { log } from "@/lib/logger";

/**
 * Gateway auto-wake telemetry (server-side PostHog).
 *
 * The reactivation campaign is only measurable if every wake attempt leaves a
 * trace, so the start path and the wake page emit:
 *
 *   - wake_requested          — a start/wake was asked for (source: wake_page
 *                               when it came through /wake/<id>, dashboard for
 *                               the instance-page Start button).
 *   - wake_admission_deferred — the host-side admission guard queued the wake
 *                               (429 to the client) with the measured reason.
 *   - wake_succeeded          — the woken box answered /health and the user
 *                               was (or could be) sent back to it. Deduped in
 *                               PostHog via $insert_id keyed on the wake_id
 *                               the wake page mints per attempt.
 *
 * Best-effort by contract: telemetry must never fail or slow a wake, so all
 * errors are swallowed (logged at warn). Under jest the posthog client is
 * disabled at the source (see @/lib/posthog) and capture() is a no-op.
 */

export type WakeTelemetryEvent =
  | "wake_requested"
  | "wake_admission_deferred"
  | "wake_succeeded";

export type WakeTelemetrySource = "wake_page" | "dashboard";

export function captureWakeEvent(
  event: WakeTelemetryEvent,
  args: {
    userId: string;
    instanceId: string;
    /** Client-minted id correlating one wake attempt across events. */
    wakeId?: string | null;
    source?: WakeTelemetrySource;
    properties?: Record<string, unknown>;
  },
): void {
  try {
    posthogClient.capture({
      distinctId: args.userId,
      event,
      properties: {
        instance_id: args.instanceId,
        source: args.source ?? "dashboard",
        ...(args.wakeId ? { wake_id: args.wakeId } : {}),
        // Collapse duplicate success emits (poll races, double navigation)
        // inside PostHog's ingestion window.
        ...(event === "wake_succeeded" && args.wakeId
          ? { $insert_id: `wake_succeeded_${args.wakeId}` }
          : {}),
        ...(args.properties ?? {}),
        $set_once: { hermes_user_id: args.userId },
      },
    });
  } catch (err) {
    log.warn("wake telemetry capture failed", {
      source: "wake-events",
      failureType: "wake_telemetry_capture_failed",
      event,
      instanceId: args.instanceId,
      userId: args.userId,
    }, err);
  }
}
