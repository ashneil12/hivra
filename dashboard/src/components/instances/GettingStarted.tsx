import { CheckCircle2, Circle } from "lucide-react";
import { useEffect, useState } from "react";

import type { InstanceActivityDigest } from "@/lib/command-center/activity";

type IntegrationStatusMap = Record<string, { configured?: boolean; partial?: boolean }>;

type ChecklistItem = { label: string; done: boolean; onClick?: () => void; cta?: string };

/** localStorage flag: onboarding is complete for this instance → retire forever. */
function onboardingDoneKey(instanceId: string): string {
  return `hivra_onboarding_done:${instanceId}`;
}

/** True once the user has completed (and thereby retired) onboarding on this box. */
function readOnboardingDone(instanceId: string): boolean {
  try {
    return window.localStorage.getItem(onboardingDoneKey(instanceId)) === "1";
  } catch {
    return false; // SSR / private mode — default to showing.
  }
}

function persistOnboardingDone(instanceId: string): void {
  try {
    window.localStorage.setItem(onboardingDoneKey(instanceId), "1");
  } catch {
    // Best-effort: a blocked localStorage just means it isn't remembered.
  }
}

/**
 * Derive the "getting started" checklist purely from data the command panel
 * already holds — the activity digest, the integration-status map, and the
 * Composio connected-state — so onboarding is always-useful with no new fetch.
 *
 * The `onConnect*` / `onSendFirstTask` handlers, when supplied, make each still-
 * open step a real one-tap action instead of a dead status row.
 */
function deriveChecklistItems(args: {
  digest: InstanceActivityDigest | null;
  integrationStatuses?: IntegrationStatusMap | null;
  appStepEnabled: boolean;
  appConnected: boolean;
  taskSent: boolean;
  onConnectChannel?: () => void;
  onConnectApp?: () => void;
  onSendFirstTask?: () => void;
  workflowsAvailable: boolean;
}): ChecklistItem[] {
  const {
    digest,
    integrationStatuses,
    appStepEnabled,
    appConnected,
    taskSent,
    onConnectChannel,
    onConnectApp,
    onSendFirstTask,
    workflowsAvailable,
  } = args;
  const anyChannelConnected = integrationStatuses
    ? Object.values(integrationStatuses).some((s) => s?.configured)
    : false;
  // The digest only refetches on instance change, so a just-injected first task
  // wouldn't show as a session until reload. `taskSent` optimistically completes
  // the step the moment it's dispatched, so it retires live and can't re-fire.
  const hasSentTask = (digest?.recentSessions.length ?? 0) > 0 || taskSent;

  const items: ChecklistItem[] = [
    { label: "Your agent is awake", done: digest ? digest.state !== "not_running" : false },
    {
      label: "Connect a chat channel",
      done: anyChannelConnected,
      onClick: anyChannelConnected ? undefined : onConnectChannel,
      cta: "Connect",
    },
  ];
  // Only surface the app step when the Composio app layer is enabled for this box.
  if (appStepEnabled) {
    items.push({
      label: "Connect your first app",
      done: appConnected,
      onClick: appConnected ? undefined : onConnectApp,
      cta: "Connect",
    });
  }
  items.push({
    // When the Workflows shelf is live, the highest-value first task is running a
    // ready-made workflow — relabel + point the tap at the shelf.
    label: workflowsAvailable ? "Run your first workflow" : "Send your first task",
    done: hasSentTask,
    onClick: hasSentTask ? undefined : onSendFirstTask,
    cta: workflowsAvailable ? "Run" : "Start",
  });
  return items;
}

const CARD_STYLE: React.CSSProperties = {
  border: "1px solid var(--etched-border)",
  background: "rgba(255,255,255,0.04)",
  padding: "clamp(1rem, 3vw, 1.4rem)",
  display: "grid",
  gap: 14,
  minWidth: 0,
};

/**
 * The onboarding spine: a top-of-panel "Getting started" checklist that guides a
 * fresh user through the first four milestones (agent awake → connect a channel →
 * connect an app → send a task) and then RETIRES ITSELF. When every step is done
 * it collapses to a one-line "✓ You're set up" for the current session and
 * persists a done-flag so it never returns.
 */
export function GettingStarted({
  instanceId,
  digest,
  loading = false,
  integrationStatuses = null,
  appStepEnabled = false,
  appConnected = false,
  taskSent = false,
  onConnectChannel,
  onConnectApp,
  onSendFirstTask,
  workflowsAvailable = false,
}: {
  instanceId: string;
  digest: InstanceActivityDigest | null;
  loading?: boolean;
  integrationStatuses?: IntegrationStatusMap | null;
  /** True when the Composio app layer is enabled (adds the "Connect your first app" step). */
  appStepEnabled?: boolean;
  /** True once at least one Composio app is connected. */
  appConnected?: boolean;
  /** Optimistically true once a first task has been dispatched this session. */
  taskSent?: boolean;
  onConnectChannel?: () => void;
  onConnectApp?: () => void;
  onSendFirstTask?: () => void;
  workflowsAvailable?: boolean;
}) {
  // Lazy-init from storage (client-only, mounted past the panel's loading gate →
  // SSR-safe): a returning user who already finished onboarding never sees it.
  const [retired] = useState(() => readOnboardingDone(instanceId));

  const items = deriveChecklistItems({
    digest,
    integrationStatuses,
    appStepEnabled,
    appConnected,
    taskSent,
    onConnectChannel,
    onConnectApp,
    onSendFirstTask,
    workflowsAvailable,
  });
  const allDone = items.every((i) => i.done);

  // Once every step is done, persist the done-flag so the section never returns.
  // This session still renders a brief "✓ You're set up" acknowledgement before
  // it retires on the next load.
  useEffect(() => {
    if (!loading && !retired && allDone) persistOnboardingDone(instanceId);
  }, [loading, retired, allDone, instanceId]);

  // Already retired, or still loading the digest (don't flash an all-open list).
  if (retired || loading) return null;

  if (allDone) {
    return (
      <section data-testid="getting-started" data-complete="true" style={CARD_STYLE}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <CheckCircle2 size={16} style={{ color: "#16a34a", flexShrink: 0 }} />
          <span style={{ fontSize: 13.5, color: "var(--text-secondary)" }}>You&apos;re set up.</span>
        </div>
      </section>
    );
  }

  return (
    <section data-testid="getting-started" data-complete="false" style={CARD_STYLE}>
      <div
        className="mono cmdp-small"
        style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.16em", opacity: 0.64 }}
      >
        Getting started
      </div>
      <div style={{ display: "grid", gap: 11 }}>
        {items.map((item) => {
          const inner = (
            <>
              {item.done ? (
                <CheckCircle2 size={16} style={{ color: "#16a34a", flexShrink: 0 }} />
              ) : (
                <Circle size={16} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
              )}
              <span
                style={{
                  fontSize: 13.5,
                  color: item.done ? "var(--text-secondary)" : "var(--ink-black)",
                  textDecoration: item.done ? "line-through" : "none",
                  minWidth: 0,
                }}
              >
                {item.label}
              </span>
              {item.onClick && item.cta ? (
                <span
                  className="mono cmdp-small"
                  style={{
                    marginLeft: "auto",
                    fontSize: 9,
                    textTransform: "uppercase",
                    letterSpacing: "0.12em",
                    fontWeight: 700,
                    color: "var(--text-muted)",
                    flexShrink: 0,
                  }}
                >
                  {item.cta}
                </span>
              ) : null}
            </>
          );
          const rowStyle: React.CSSProperties = {
            display: "flex",
            alignItems: "center",
            gap: 10,
            minWidth: 0,
            width: "100%",
            textAlign: "left",
            background: "transparent",
            border: "none",
            padding: 0,
            font: "inherit",
            cursor: item.onClick ? "pointer" : "default",
          };
          return item.onClick ? (
            <button
              key={item.label}
              type="button"
              onClick={item.onClick}
              data-testid={`checklist-item:${item.label}`}
              data-done={item.done}
              className="cmdp-row cmdp-pad"
              style={rowStyle}
            >
              {inner}
            </button>
          ) : (
            <div
              key={item.label}
              data-testid={`checklist-item:${item.label}`}
              data-done={item.done}
              className="cmdp-row cmdp-pad"
              style={rowStyle}
            >
              {inner}
            </div>
          );
        })}
      </div>
    </section>
  );
}
