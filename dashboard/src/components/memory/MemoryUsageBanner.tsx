'use client';

import { useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, ArrowUpRight, X } from "lucide-react";
import { type MemoryLevel, memoryLevelRank } from "@/lib/memory-usage";

interface MemoryUsageBannerProps {
  /** The instance whose memory pressure to surface. */
  instanceId: string;
  /** Where the "Upgrade" affordance points. Defaults to the billing page. */
  upgradeHref?: string;
}

type WarnLevel = "warn" | "critical";

interface MemoryUsageState {
  level: MemoryLevel;
  percent: number;
  isPaidTier: boolean;
}

/** Copy varies by severity AND tier: a free agent that maxes its pinned RAM is a
 *  free→Pro nudge; a paid agent leaning on burst headroom is an upsell to lock in
 *  more guaranteed RAM. */
function copyFor(level: WarnLevel, isPaidTier: boolean, pct: number): { title: string; body: string } {
  if (level === "warn") {
    return {
      title: "Approaching your plan's RAM",
      body: `This agent is using ${pct}% of your plan's guaranteed RAM. Upgrade for more headroom before it runs out.`,
    };
  }
  // critical (>= 100% of guaranteed baseline)
  return isPaidTier
    ? {
        title: "Over your plan's guaranteed RAM",
        body: `This agent has hit ${pct}% of your plan's RAM — it's leaning on burst headroom that isn't guaranteed and can be reclaimed under load. Upgrade to lock in more.`,
      }
    : {
        title: "Out of RAM on the free plan",
        body: `This agent maxed its free-plan RAM (${pct}%) and may restart mid-task. Upgrade to Pro for several times the memory.`,
      };
}

const STYLES: Record<WarnLevel, { bg: string; border: string; fg: string }> = {
  warn: { bg: "rgba(217,119,6,0.08)", border: "rgba(217,119,6,0.32)", fg: "#b45309" },
  critical: { bg: "rgba(220,38,38,0.08)", border: "rgba(220,38,38,0.4)", fg: "#dc2626" },
};

function dismissedRankKey(instanceId: string): string {
  return `hivra_memory_banner_dismissed_${instanceId}`;
}

function readDismissedRank(instanceId: string): number {
  try {
    const stored = Number(window.localStorage.getItem(dismissedRankKey(instanceId)));
    return Number.isFinite(stored) && stored > 0 ? stored : 0;
  } catch {
    return 0;
  }
}

function clearDismissedRank(instanceId: string): void {
  try {
    window.localStorage.removeItem(dismissedRankKey(instanceId));
  } catch {
    // Storage unavailable; nothing was persisted.
  }
}

/**
 * Dismissible memory-pressure banner for the agent chat. Shows an amber warning
 * as the agent's recent peak RAM approaches its plan's guaranteed baseline (>=80%)
 * and a red one once it reaches/exceeds it (>=100%), computed server-side from the
 * latest metering sample. Unlike the storage banner this one links to the upgrade
 * flow — hitting the RAM ceiling is the moment to convert. Purely informational:
 * it never blocks sending a message, and any fetch failure is swallowed. The route
 * returns "ok" when the feature flag is off, so this self-hides until enabled.
 */
export function MemoryUsageBanner({ instanceId, upgradeHref = "/dashboard/billing" }: MemoryUsageBannerProps) {
  const [usage, setUsage] = useState<MemoryUsageState | null>(null);
  // Track the highest severity dismissed so an escalation from warn to critical
  // surfaces again, but the same level stays dismissed. Persisted per instance
  // so the banner does not return on every visit, and cleared once pressure
  // is back to ok.
  const [dismissedRank, setDismissedRank] = useState(0);

  const dismiss = (rank: number) => {
    setDismissedRank(rank);
    try {
      window.localStorage.setItem(dismissedRankKey(instanceId), String(rank));
    } catch {
      // Storage unavailable; the dismissal lasts for this visit only.
    }
  };

  useEffect(() => {
    if (!instanceId) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/instances/${instanceId}/memory-pressure`);
        if (!res.ok) return;
        const json = await res.json();
        const data = json?.data;
        if (!cancelled && data && typeof data.level === "string") {
          if (data.level === "ok") {
            // Pressure recovered: forget the dismissal so the next episode shows.
            clearDismissedRank(instanceId);
            setDismissedRank(0);
          } else {
            setDismissedRank(readDismissedRank(instanceId));
          }
          setUsage({
            level: data.level as MemoryLevel,
            percent: typeof data.percent === "number" ? data.percent : 0,
            isPaidTier: data.is_paid_tier === true,
          });
        }
      } catch {
        // Monitoring banner is best-effort — never surface a memory fetch error.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [instanceId]);

  if (!usage || usage.level === "ok") return null;
  if (memoryLevelRank(usage.level) <= dismissedRank) return null;

  const level = usage.level as WarnLevel;
  const pct = Math.round(usage.percent);
  const style = STYLES[level];
  const copy = copyFor(level, usage.isPaidTier, pct);
  const Icon = level === "critical" ? AlertCircle : AlertTriangle;

  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
        margin: "10px 16px 0",
        padding: "10px 12px",
        background: style.bg,
        border: `1px solid ${style.border}`,
        color: "var(--ink-black)",
      }}
    >
      <Icon size={16} style={{ color: style.fg, flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className="mono"
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            fontWeight: 700,
            color: style.fg,
            marginBottom: 2,
          }}
        >
          {copy.title}
        </div>
        <div className="line-clamp-1 md:line-clamp-none" style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {copy.body}
        </div>
        <a
          href={upgradeHref}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            marginTop: 6,
            fontSize: 12,
            fontWeight: 600,
            color: style.fg,
            textDecoration: "none",
          }}
        >
          Upgrade plan
          <ArrowUpRight size={13} />
        </a>
      </div>
      <button
        type="button"
        aria-label="Dismiss memory warning"
        onClick={() => dismiss(memoryLevelRank(level))}
        style={{
          border: 0,
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          width: 40,
          height: 40,
          margin: "-10px -12px -10px 0",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
