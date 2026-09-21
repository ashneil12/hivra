"use client";

import type { AgentComputer } from "@/lib/agent-computers/contracts";

export type WorkspaceNoticeState =
  | "loading"
  | "unavailable"
  | "expired"
  | "revoked"
  | "reconnecting"
  | "error"
  | "recovery"
  | "provisioning"
  | "compatibility"
  | "unknown";

export interface WorkspaceStateNoticeProps {
  state: WorkspaceNoticeState;
  agentName: string;
  surfaceLabel: string;
  observedReason?: string;
  observedDetail?: string;
  observedState?: string;
  updatedAt: string;
  lastConnectedAt?: string;
  recoveryActionLabel?: "Open Console" | "Open Manage";
  computer?: AgentComputer;
  blocking?: boolean;
  now?: string | Date;
  onPrimaryAction?: () => void;
  onBack?: () => void;
}

const COMPATIBILITY_DESCRIPTION =
  "This legacy session has no canonical run acknowledgement. Activity shown here is connection and event evidence only.";

function parsedTime(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function relativeTime(value: string, now: string | Date | undefined): string {
  const time = parsedTime(value);
  const reference = now instanceof Date ? now.getTime() : Date.parse(now ?? new Date().toISOString());
  if (time === null || !Number.isFinite(reference)) return "at an unknown time";

  const seconds = Math.max(0, Math.floor((reference - time) / 1_000));
  if (seconds < 60) return seconds === 1 ? "1 second ago" : `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function absoluteTime(value: string): string {
  const time = parsedTime(value);
  if (time === null) return "Unknown time";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(time));
}

function normalizedFact(value: string | undefined, fallback: string): string {
  const fact = value?.trim();
  return fact || fallback;
}

function noticeContent({
  state,
  agentName,
  surfaceLabel,
  observedReason,
  observedDetail,
  observedState,
  updatedAt,
  lastConnectedAt,
  recoveryActionLabel,
  now,
}: WorkspaceStateNoticeProps): { copy: string; actionLabel: string | null } {
  const checked = relativeTime(updatedAt, now);

  switch (state) {
    case "loading":
      return { copy: `Opening ${surfaceLabel}…`, actionLabel: null };
    case "unavailable":
      return {
        copy: `${surfaceLabel} is unavailable right now. ${normalizedFact(
          observedReason,
          "No usable route was advertised.",
        )}`,
        actionLabel: "Retry surface",
      };
    case "expired":
      return {
        copy: `Access to ${surfaceLabel} expired.`,
        actionLabel: "Reconnect surface",
      };
    case "revoked":
      return {
        copy: `Access to ${surfaceLabel} was revoked.`,
        actionLabel: "Return to conversation",
      };
    case "reconnecting":
      return {
        copy: `Reconnecting to ${surfaceLabel}… Last connected ${relativeTime(
          lastConnectedAt ?? updatedAt,
          now,
        )}.`,
        actionLabel: "Retry surface",
      };
    case "error":
      return {
        copy: `Couldn't reach ${agentName}. Check the connection and try again.`,
        actionLabel: "Retry message",
      };
    case "recovery":
      return {
        copy: `${agentName} needs attention. ${normalizedFact(
          observedDetail,
          "The observed operation failed.",
        )}`,
        actionLabel: recoveryActionLabel ?? "Open Manage",
      };
    case "provisioning":
      return {
        copy: `${agentName} is still starting. Observed: ${normalizedFact(
          observedState,
          "unknown",
        )}. This workspace opens when the runtime responds; no completion percentage is guessed. Last checked ${checked}.`,
        actionLabel: "Refresh status",
      };
    case "compatibility":
      return { copy: COMPATIBILITY_DESCRIPTION, actionLabel: null };
    case "unknown":
      return {
        copy: `${surfaceLabel} state is unknown. Last checked ${checked}.`,
        actionLabel: "Refresh status",
      };
  }
}

export function WorkspaceStateNotice(props: WorkspaceStateNoticeProps) {
  const content = noticeContent(props);
  const alert = props.state === "revoked" || props.blocking === true;
  const updatedRelative = relativeTime(props.updatedAt, props.now);
  const updatedAbsolute = absoluteTime(props.updatedAt);
  const operation = props.computer?.state.operation?.state ?? "none observed";

  return (
    <div
      data-testid="workspace-state-gutter"
      className="w-full p-4 sm:p-6 lg:p-8"
    >
      <section
        role={alert ? "alert" : "status"}
        aria-live={alert ? "assertive" : "polite"}
        aria-atomic="true"
        className="mx-auto w-full max-w-[840px] border border-[var(--etched-border)] bg-[var(--bg-surface)] p-5 sm:p-6"
        data-workspace-state={props.state}
      >
        <p className="text-[14px] leading-[1.6] text-[var(--ink-black)]">{content.copy}</p>

        {props.computer ? (
          <dl
            data-testid="workspace-state-facts"
            className="mono mt-5 grid grid-cols-2 gap-px border border-[var(--etched-border)] bg-[var(--etched-border)] text-[12px] leading-[1.3] sm:grid-cols-4"
          >
            {[
              ["Desired", props.computer.state.desired],
              ["Observed", props.computer.state.observed],
              ["Health", props.computer.state.health],
              ["Operation", operation],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0 bg-[var(--bg-surface)] p-3">
                <dt className="text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">
                  {label}
                </dt>
                <dd className="mt-1 truncate text-[var(--ink-black)]" title={value}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        <time
          dateTime={props.updatedAt}
          title={updatedAbsolute}
          aria-label={`Updated ${updatedRelative}; ${updatedAbsolute}`}
          className="mono mt-4 block text-[12px] leading-[1.3] text-[var(--text-muted)]"
        >
          Updated {updatedRelative}
        </time>

        {content.actionLabel || (props.state === "unavailable" && props.onBack) ? (
          <div className="mt-5 flex flex-wrap gap-2">
            {content.actionLabel && props.onPrimaryAction ? (
              <button
                type="button"
                onClick={props.onPrimaryAction}
                className="action-button min-h-[44px] px-4 text-[12px] font-semibold normal-case tracking-normal"
              >
                {content.actionLabel}
              </button>
            ) : null}
            {props.state === "unavailable" && props.onBack ? (
              <button
                type="button"
                onClick={props.onBack}
                className="mono min-h-[44px] border border-[var(--etched-border)] px-4 text-[12px] font-semibold text-[var(--text-muted)] outline-none hover:text-[var(--ink-black)] focus-visible:ring-2 focus-visible:ring-[var(--hivra-red)] focus-visible:ring-offset-2"
              >
                Back to conversation
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
