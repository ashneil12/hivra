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
  const title =
    pendingPrompt.summary?.trim() ||
    (pendingPrompt.kind === "clarify"
      ? "Your agent is waiting for your answer"
      : "Your agent is waiting for your approval");

  return (
    <span
      data-testid="pending-prompt-badge"
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        padding: "2px 7px",
        borderRadius: "999px",
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
}
