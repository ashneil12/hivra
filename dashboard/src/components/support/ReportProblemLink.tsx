"use client";

// ReportProblemLink — the shared "Report this" affordance shown on
// dead-ends (failed agent start, stuck checkout, deploy host errors).
//
// Two things happen on click, both best-effort:
//   1. Opens a prefilled mailto: to the support inbox (the primary,
//      always-works channel — carries the instance id + error context).
//   2. Fire-and-forgets POST /api/support/report so the report also lands
//      in /dashboard/ops as a support_request ops event. A failure here is
//      swallowed; it must never block the mailto.
//
// Renders as a small inline button so it can sit inside existing error
// banners. A Discord link is offered alongside as a faster channel.

import { useCallback, useState } from "react";
import { LifeBuoy, MessageCircle } from "lucide-react";

import {
  SUPPORT_DISCORD_URL,
  buildSupportMailto,
  type ReportProblemContext,
} from "@/lib/support-channels";

export interface ReportProblemLinkProps {
  /** Where the report came from, e.g. "agent-start-failure". */
  surface: string;
  /** Short summary used as the email subject + ops-event title. */
  summary: string;
  instanceId?: string | null;
  errorContext?: string | null;
  /** Also show the Discord link alongside the email report. Defaults to true. */
  showDiscord?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export function ReportProblemLink({
  surface,
  summary,
  instanceId,
  errorContext,
  showDiscord = true,
  className,
  style,
}: ReportProblemLinkProps) {
  const [sent, setSent] = useState(false);

  const ctx: ReportProblemContext = { summary, instanceId, errorContext };
  const mailto = buildSupportMailto(ctx);

  const handleReport = useCallback(() => {
    // Fire-and-forget the in-app breadcrumb; ignore the outcome entirely.
    try {
      void fetch("/api/support/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({
          surface,
          summary,
          instanceId: instanceId ?? null,
          errorContext: errorContext ?? null,
        }),
      }).catch(() => {});
    } catch {
      // Swallow — the mailto below is the channel that matters.
    }
    setSent(true);
    // The <a href={mailto}> performs the actual navigation; we don't
    // preventDefault, so the user's mail client opens as normal.
  }, [surface, summary, instanceId, errorContext]);

  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: 12, flexWrap: "wrap", ...style }}
    >
      <a
        href={mailto}
        onClick={handleReport}
        data-testid="report-problem-link"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 12,
          fontWeight: 700,
          color: "inherit",
          textDecoration: "underline",
          cursor: "pointer",
        }}
      >
        <LifeBuoy size={13} aria-hidden="true" />
        {sent ? "Thanks — reported" : "Report this"}
      </a>
      {showDiscord ? (
        <a
          href={SUPPORT_DISCORD_URL}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            fontWeight: 700,
            color: "inherit",
            textDecoration: "underline",
            cursor: "pointer",
          }}
        >
          <MessageCircle size={13} aria-hidden="true" />
          Ask on Discord
        </a>
      ) : null}
    </span>
  );
}
