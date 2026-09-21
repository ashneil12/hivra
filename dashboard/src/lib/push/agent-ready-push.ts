/**
 * Agent-ready push — "「name」 is ready — say hi" (iOS Phase 2, trigger a).
 *
 * Fired from the GET /api/instances list reconcile at the exact moment a
 * provisioning row is promoted to running (the same seam the post-ready
 * SOUL.md seed hooks). This replaces the never-shipped "your agent is online"
 * email for the mobile lane: if the user backgrounds the app during the 2–4
 * minute provision, this push pulls them back into the first chat.
 *
 * Once-per-instance guard: the `notifications_sent` jsonb send-once ledger on
 * hermes_instances (introduced by the cold-storage lifecycle migration, keyed
 * by notification name). The claim is a conditional UPDATE filtered on the key
 * being absent, so concurrent list polls promoting the same row can't
 * double-push — exactly one request wins the claim. Claim-first ordering means
 * a push failure after a won claim loses that one push (accepted) instead of
 * ever duping.
 *
 * PostHog: `mobile_launch_ready` (elapsed ms since the mobile launch request)
 * is emitted here — but ONLY for boxes launched through POST /api/mobile/launch,
 * which stamps `mobile_launch_requested_at` into the same ledger. Web-launched
 * boxes still get the push (any registered device benefits) without polluting
 * the mobile funnel metric.
 *
 * Everything here is best-effort and after-response (`after()`), mirroring
 * scheduleSoulSeedReconcileAfterResponse: a push/telemetry hiccup must never
 * slow or fail the instances list response.
 */

import "server-only";

import { after } from "next/server";

import { log } from "@/lib/logger";
import { posthogClient } from "@/lib/posthog";
import { sendMobilePushToUser } from "@/lib/push/expo-push";
import { supabaseAdmin } from "@/lib/supabase";

const LOG_SOURCE = "agent-ready-push";

/** notifications_sent key claimed when the agent-ready push fires. */
export const AGENT_READY_PUSH_LEDGER_KEY = "mobile_agent_ready_push";
/** notifications_sent key stamped by POST /api/mobile/launch at request time. */
export const MOBILE_LAUNCH_REQUESTED_LEDGER_KEY = "mobile_launch_requested_at";

type AgentReadyPushTrigger =
  | "list_provision_promote_proxmox"
  | "list_provision_promote_hetzner";

export interface AgentReadyPushParams {
  instanceId: string;
  userId: string;
  trigger: AgentReadyPushTrigger;
}

interface AgentReadyRow {
  id: string;
  user_id: string | null;
  name: string | null;
  created_at: string | null;
  notifications_sent: Record<string, unknown> | null;
}

/**
 * Defer the notify until after the response is flushed. Mirrors
 * scheduleSoulSeedReconcileAfterResponse — when `after()` is unavailable
 * (tests, non-request contexts) the push is skipped with a log line rather
 * than blocking or throwing.
 */
export function scheduleAgentReadyPushAfterResponse(params: AgentReadyPushParams): void {
  try {
    after(() => notifyAgentReady(params));
  } catch (err) {
    log.warn("agent-ready push not scheduled (after() unavailable)", {
      source: LOG_SOURCE,
      trigger: params.trigger,
      instanceId: params.instanceId,
      errorName: err instanceof Error ? err.name : typeof err,
    });
  }
}

/**
 * Claim the once-guard and send the push (+ mobile_launch_ready telemetry).
 * Never throws. Exported for direct testing.
 */
export async function notifyAgentReady(params: AgentReadyPushParams): Promise<void> {
  const { instanceId, userId, trigger } = params;
  try {
    if (!supabaseAdmin) return;

    const { data: row, error: readError } = await supabaseAdmin
      .from("hermes_instances")
      .select("id, user_id, name, created_at, notifications_sent")
      .eq("id", instanceId)
      .maybeSingle<AgentReadyRow>();

    if (readError || !row) {
      if (readError) {
        log.warn("agent-ready push read failed", {
          source: LOG_SOURCE,
          trigger,
          instanceId,
          errorMessage: readError.message,
        });
      }
      return;
    }

    const ledger =
      row.notifications_sent && typeof row.notifications_sent === "object"
        ? row.notifications_sent
        : {};
    if (ledger[AGENT_READY_PUSH_LEDGER_KEY]) return; // already sent

    // Atomic claim: the jsonb-path filter makes the UPDATE match only while
    // the key is still absent, so exactly one concurrent promoter wins.
    // (The merged-object write can, in principle, drop a key another writer
    // added between our read and this update — no other writer touches the
    // ledger of a just-provisioned row, so the window is acceptable here.)
    const { data: claimed, error: claimError } = await supabaseAdmin
      .from("hermes_instances")
      .update({
        notifications_sent: {
          ...ledger,
          [AGENT_READY_PUSH_LEDGER_KEY]: new Date().toISOString(),
        },
      })
      .eq("id", instanceId)
      .is(`notifications_sent->${AGENT_READY_PUSH_LEDGER_KEY}`, null)
      .select("id");

    if (claimError) {
      log.warn("agent-ready push claim failed; skipping (no push without a claim)", {
        source: LOG_SOURCE,
        trigger,
        instanceId,
        errorMessage: claimError.message,
      });
      return;
    }
    if (!claimed || claimed.length === 0) return; // lost the race — other request pushes

    const ownerUserId = row.user_id ?? userId;
    const name = row.name?.trim() || "Your agent";
    await sendMobilePushToUser({
      userId: ownerUserId,
      title: `${name} is ready — say hi`,
      body: `${name} just finished setting up and is waiting for your first task.`,
      url: `hivra://chat/${instanceId}`,
      data: { kind: "agent_ready", instanceId },
    });

    // Mobile funnel metric — only for launches that came through the mobile
    // lane (see module docstring).
    const requestedAtRaw = ledger[MOBILE_LAUNCH_REQUESTED_LEDGER_KEY];
    if (typeof requestedAtRaw === "string" && requestedAtRaw) {
      const startedMs = Date.parse(requestedAtRaw);
      const fallbackMs = row.created_at ? Date.parse(row.created_at) : Number.NaN;
      const baseMs = Number.isFinite(startedMs) ? startedMs : fallbackMs;
      const elapsedMs = Number.isFinite(baseMs)
        ? Math.max(0, Date.now() - baseMs)
        : null;
      try {
        posthogClient.capture({
          distinctId: ownerUserId,
          event: "mobile_launch_ready",
          properties: {
            instance_id: instanceId,
            elapsed_ms: elapsedMs,
            trigger,
            // Stable dedup key (box_created pattern): collapses cross-process
            // duplicates inside PostHog's ingestion window.
            $insert_id: `mobile_launch_ready_${instanceId}`,
            $set_once: { hermes_user_id: ownerUserId },
          },
        });
        await posthogClient.flush();
      } catch (captureErr) {
        log.warn("failed to capture mobile_launch_ready", {
          source: LOG_SOURCE,
          trigger,
          instanceId,
          errorMessage:
            captureErr instanceof Error ? captureErr.message : String(captureErr),
        });
      }
    }
  } catch (err) {
    log.warn("agent-ready push failed", {
      source: LOG_SOURCE,
      failureType: "agent_ready_push_failed",
      trigger,
      instanceId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}
