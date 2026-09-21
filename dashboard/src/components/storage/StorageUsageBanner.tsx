'use client';

import { useEffect, useState } from "react";
import { AlertCircle, AlertTriangle, X } from "lucide-react";
import { type StorageLevel, storageLevelRank } from "@/lib/storage-usage";

interface StorageUsageBannerProps {
  /** The instance whose disk usage to surface. */
  instanceId: string;
}

type WarnLevel = "warn" | "critical";

const COPY: Record<WarnLevel, { title: string; body: (pct: number) => string }> = {
  warn: {
    title: "Running low on storage",
    body: (pct) =>
      `This agent is using ${pct}% of its disk. Clear old files or upgrade before it fills up.`,
  },
  critical: {
    title: "Storage almost full",
    body: (pct) =>
      `This agent is using ${pct}% of its disk. Free up space soon — deploys can start failing once the disk is full.`,
  },
};

const STYLES: Record<WarnLevel, { bg: string; border: string; fg: string }> = {
  warn: { bg: "rgba(217,119,6,0.08)", border: "rgba(217,119,6,0.32)", fg: "#b45309" },
  critical: { bg: "rgba(220,38,38,0.08)", border: "rgba(220,38,38,0.4)", fg: "#dc2626" },
};

interface StorageUsageState {
  level: StorageLevel;
  percent: number;
}

/**
 * Dismissible, read-only disk-usage banner for the agent chat (Layer A). Shows
 * an amber warning at >=80% and a stronger red one at >=95%, computed from the
 * instance's latest metering sample. Purely informational — it never blocks
 * sending a message or starting a deploy, and any fetch failure is swallowed.
 */
export function StorageUsageBanner({ instanceId }: StorageUsageBannerProps) {
  const [usage, setUsage] = useState<StorageUsageState | null>(null);
  // Track the highest severity the user has dismissed so an escalation from
  // warn to critical surfaces again, but the same level stays dismissed.
  const [dismissedRank, setDismissedRank] = useState(0);

  useEffect(() => {
    if (!instanceId) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`/api/instances/${instanceId}/storage`);
        if (!res.ok) return;
        const json = await res.json();
        const data = json?.data;
        if (!cancelled && data && typeof data.level === "string") {
          setUsage({
            level: data.level as StorageLevel,
            percent: typeof data.percent === "number" ? data.percent : 0,
          });
        }
      } catch {
        // Monitoring banner is best-effort — never surface a storage fetch error.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [instanceId]);

  if (!usage || usage.level === "ok") return null;
  if (storageLevelRank(usage.level) <= dismissedRank) return null;

  const level = usage.level as WarnLevel;
  // A disk can never be more than 100% full. The percent is computed against
  // the guest's real `df` total, so this is normally a no-op, but it's a cheap
  // guard against any denominator drift ever rendering an impossible "198%".
  const pct = Math.min(100, Math.round(usage.percent));
  const style = STYLES[level];
  const copy = COPY[level];
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
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            fontWeight: 700,
            color: style.fg,
            marginBottom: 2,
          }}
        >
          {copy.title}
        </div>
        <div style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {copy.body(pct)}
        </div>
      </div>
      <button
        type="button"
        aria-label="Dismiss storage warning"
        onClick={() => setDismissedRank(storageLevelRank(level))}
        style={{
          border: 0,
          background: "transparent",
          color: "var(--text-muted)",
          cursor: "pointer",
          padding: 2,
          display: "inline-flex",
          flexShrink: 0,
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
