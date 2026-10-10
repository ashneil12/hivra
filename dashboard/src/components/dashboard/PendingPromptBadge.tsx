"use client";

import { ShieldAlert } from "lucide-react";

/**
 * "Your agent is waiting for your approval" chip on the instance card.
 *
 * Server-driven: the data comes from `instance.pendingPrompt`, populated by
 * GET /api/instances from the instance_pending_prompts table (written by the
 * hivra_approval_relay agent plugin). It does NOT poll — the old ApprovalBadge
 * polled a per-instance agent endpoint that never existed and so never rendered
 * for anyone (retired in #499). The dashboard's existing instance-list poll
 * refreshes this within its normal cadence.
 */
export interface PendingPromptChip {
  promptId: string;
  kind: "approval" | "clarify";
  summary: string | null;
  surface: string | null;
  createdAt: string | null;
  expiresAt: string | null;
}

export function PendingPromptBadge({
  pendingPrompt,
}: {
  pendingPrompt?: PendingPromptChip | null;
}) {
  if (!pendingPrompt) return null;

  const label =
    pendingPrompt.kind === "clarify" ? "Needs your input" : "Needs approval";
  const summary = pendingPrompt.summary?.trim() || null;
  const title =
    summary ||
    (pendingPrompt.kind === "clarify"
      ? "Your agent is waiting for your answer"
      : "Your agent is waiting for your approval");

  const chip = (
    <span
      data-testid="pending-prompt-badge"
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "2px 7px",
        borderRadius: 0,
        fontSize: "11px",
        fontWeight: 600,
        lineHeight: 1.4,
        color: "#92400e",
        background: "rgba(245, 158, 11, 0.12)",
        border: "1px solid rgba(180, 83, 9, 0.4)",
        whiteSpace: "nowrap",
      }}
    >
      <ShieldAlert size={11} aria-hidden="true" />
      {label}
    </span>
  );

  if (!summary) return chip;

  // What the agent is waiting on must be readable without hover (touch has
  // none), so the redacted summary is shown under the chip, clamped to two lines.
  return (
    <span
      style={{
        display: "inline-grid",
        justifyItems: "end",
        gap: "3px",
        minWidth: 0,
        maxWidth: "min(220px, 50vw)",
      }}
    >
      {chip}
      <span
        data-testid="pending-prompt-summary"
        style={{
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          overflowWrap: "anywhere",
          textAlign: "right",
          fontSize: "11px",
          lineHeight: 1.35,
          color: "var(--text-secondary)",
        }}
      >
        {summary}
      </span>
    </span>
  );
}
