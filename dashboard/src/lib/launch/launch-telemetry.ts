/**
 * Launch's first-run funnel in PostHog. Launch is the one front door, so it
 * sends the activation events the welcome flow used to: a new account's Free
 * activation, each launch request and what came of it, and the paywall
 * moments on the way. The names and the diagnostic fields are the welcome
 * flow's, so the activation funnel, the first-run audit and the triage
 * dashboards read the same across the move.
 *
 * Nothing here carries a launch's name, a key, a prompt or a raw server
 * error: only ids, sizes, choices and a redacted, shortened message.
 * captureClient queues until PostHog is ready and never throws, so
 * measurement can never break a launch.
 */

import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";
import { captureClient } from "@/lib/telemetry/posthog-client";

import { PROFILE_DETAILS, type LaunchDraft } from "./contracts";

export const LAUNCH_TELEMETRY_SOURCE = "launch-journey";
const LAUNCH_TELEMETRY_ROUTE = "/dashboard/launch";

export type LaunchFunnelEvent =
  | "activation_page_viewed"
  | "activation_started"
  | "activation_dashboard_reached"
  | "activation_instance_requested"
  | "launch_request_accepted"
  | "activation_instance_ready"
  | "activation_card_required"
  | "activation_failed"
  | "launch_outcome_uncertain"
  | "free_limit_hit"
  | "paywall_viewed"
  | "upgrade_clicked";

export function captureLaunchEvent(event: LaunchFunnelEvent, properties: Record<string, unknown> = {}): void {
  captureClient(event, {
    source: LAUNCH_TELEMETRY_SOURCE,
    route: LAUNCH_TELEMETRY_ROUTE,
    surface: "launch",
    ...properties,
  });
}

const sentOnce = new Set<string>();

/** Sends a moment the page shows (a paywall, a limit) once per key, however
 * often it re-renders. Keys carry the launch's request id. */
export function captureLaunchEventOnce(
  key: string,
  event: LaunchFunnelEvent,
  properties: Record<string, unknown> = {},
): void {
  if (sentOnce.has(key)) return;
  sentOnce.add(key);
  captureLaunchEvent(event, properties);
}

/** What every launch event says about the launch it belongs to. */
export function launchEventContext(draft: LaunchDraft): Record<string, unknown> {
  const profile = draft.profileId ? PROFILE_DETAILS[draft.profileId] : null;
  return {
    profile: draft.profileId,
    // The runtime, under the property name the welcome flow's events used.
    agentType: profile?.runtimeId ?? null,
    resourceKind: draft.resourceKind,
    launchRequestId: draft.launchRequestId,
    modelAccess: draft.modelAccess?.mode ?? null,
    browser: draft.browser,
    cpu: draft.resources.cpu,
    ram: draft.resources.ram,
    fromTemplate: Boolean(draft.template),
  };
}

/** The stage the first-run audit groups a launch failure under: Hermes'
 * instance lane, or a Hivra agent or computer. */
export function launchFailureStage(draft: LaunchDraft): "create_instance" | "hivra_box_launch" {
  return draft.profileId === "hermes" ? "create_instance" : "hivra_box_launch";
}

const KEY_LIKE_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,}|key-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{40,})\b/g;
const MAX_ERROR_MESSAGE_LENGTH = 240;

/** A failure's message, safe to send: secrets and key-like strings redacted,
 * the owner's own names for this launch (which server messages can echo)
 * replaced, whitespace collapsed, and shortened. */
export function launchErrorMessage(error: unknown, names: readonly string[] = []): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  let message = redactSensitiveCommandOutput(raw.replace(/\s+/g, " ").trim(), 1_000)
    .replace(KEY_LIKE_PATTERN, "[redacted]");
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed.length < 2) continue;
    message = message.replace(new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[name]");
  }
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}
