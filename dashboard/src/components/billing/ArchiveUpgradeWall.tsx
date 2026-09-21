"use client";

// ArchiveUpgradeWall — Moment #3 of the free→paid bridge (the hard loss-aversion
// wall).
//
// Rendered on the instance page when a FREE agent has been inactivity-paused and
// is counting down toward the dormant-reclaim archive — its SOUL, memory,
// workspace, and connected chats about to be packed away. The caller gates on
// shouldShowArchiveUpgradeWall() (flag ON + isFreePlanInfo(plan) + the agent is
// genuinely in the inactivity-archival window), so a paying customer never sees
// it and it never renders on a non-inactivity archival.
//
// Presentation + analytics only — it changes nothing about the archival cron.
// Same upgrade funnel as the rest of the app: paywall_viewed on render,
// upgrade_clicked on the CTA, both surface:'archive_wall'; CTA deep-links to
// billing with attribution params.

import { useEffect } from "react";
import { CalendarClock } from "lucide-react";

import { captureClient } from "@/lib/telemetry/posthog-client";

const BILLING_HREF = "/dashboard/billing?from=paywall&feature=always_on";

/** "Archiving in 3 days" / "Archiving tomorrow" / "Archiving today". */
function countdownLabel(days: number): string {
  if (days <= 0) return "Archiving today";
  if (days === 1) return "Archiving tomorrow";
  return `Archiving in ${days} days`;
}

export function ArchiveUpgradeWall({
  instanceId,
  instanceName,
  daysUntilArchive,
}: {
  instanceId: string;
  instanceName?: string | null;
  daysUntilArchive: number;
}) {
  // Impression event — once per mount. Best-effort; analytics must never break
  // the surface.
  useEffect(() => {
    try {
      captureClient("paywall_viewed", {
        surface: "archive_wall",
        feature: "always_on",
        plan: "free",
        instance_id: instanceId,
        days_until_archive: daysUntilArchive,
      });
    } catch {
      // ignore
    }
  }, [instanceId, daysUntilArchive]);

  const name = instanceName || "Your agent";

  return (
    <div
      data-testid="instance-archive-upgrade-wall"
      className="instance-chat-banner"
      style={{
        background: "rgba(220, 38, 38, 0.10)",
        borderBottom: "1px solid rgba(220, 38, 38, 0.28)",
        padding: "14px 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
        zIndex: 49,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0, flex: "1 1 460px" }}>
        <CalendarClock size={18} strokeWidth={2.25} style={{ color: "#b91c1c", flexShrink: 0 }} />
        <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
          <span
            className="mono"
            style={{ fontSize: 11, fontWeight: 700, color: "#b91c1c", textTransform: "uppercase", letterSpacing: "0.12em" }}
          >
            {countdownLabel(daysUntilArchive)}
          </span>
          <span style={{ fontSize: 13, color: "rgba(17, 24, 39, 0.82)", lineHeight: 1.45 }}>
            {name} and everything it remembers get packed away. Its memory, its files, the chats you
            connected. Free agents get archived after they sleep. Pro agents never do. Keep yours live and
            always-on for $9.99 a month.
          </span>
        </div>
      </div>
      <div className="instance-chat-banner-actions" style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
        <a
          href={BILLING_HREF}
          onClick={() => {
            // Inactivity archival only reaches FREE agents (paid tiers are exempt
            // from the sweep + auto-resumed if mis-paused), so the transition is
            // always free → operator (Pro).
            captureClient("upgrade_clicked", {
              surface: "archive_wall",
              feature: "always_on",
              limit_type: "inactivity",
              instance_id: instanceId,
              from_plan: "free",
              to_plan: "operator",
              days_until_archive: daysUntilArchive,
            });
          }}
          className="mono"
          style={{
            background: "#1a1a1a",
            color: "#ffffff",
            border: "none",
            padding: "8px 14px",
            fontSize: 11,
            fontWeight: 700,
            cursor: "pointer",
            textDecoration: "none",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            whiteSpace: "nowrap",
          }}
        >
          Keep my agent live
        </a>
      </div>
    </div>
  );
}
