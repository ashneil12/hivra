"use client";

// PoolMeter — a small, presentational view of the user's compute pool: how much
// their OTHER agents already use, how much THIS box's current selection takes,
// and how much is left. Shared by the deploy form (WelcomeFlow) and the per-agent
// resize panel (HivraManage) so "size by pool" looks and reads the same in both.

export interface PoolMetric {
  /** CPU/RAM already used by the user's OTHER active agents. */
  othersUsed: number;
  /** This computer's selected (or current) allocation. */
  selected: number;
  /** The plan's total pool for this metric. */
  total: number;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function Bar({ metric, unit }: { metric: PoolMetric; unit: string }) {
  const total = metric.total > 0 ? metric.total : 0;
  const othersPct = total > 0 ? Math.min(100, (metric.othersUsed / total) * 100) : 0;
  const minePct = total > 0 ? Math.min(100 - othersPct, (metric.selected / total) * 100) : 0;
  const usedTotal = metric.othersUsed + metric.selected;
  const free = Math.max(0, total - usedTotal);
  return (
    <div style={{ display: "grid", gap: 5 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 800, opacity: 0.78, width: 36 }}>{unit}</span>
        <span className="mono" style={{ fontSize: 11, color: "var(--ink-black)" }}>{fmt(metric.selected)}</span>
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.78 }}>
          {fmt(free)} free · {fmt(total)} total
        </span>
      </div>
      <div style={{ position: "relative", height: 7, borderRadius: 4, background: "rgba(0,0,0,0.08)", border: "1px solid var(--etched-border)", overflow: "hidden", display: "flex" }}>
        <div style={{ width: `${othersPct}%`, background: "var(--text-muted)", opacity: 0.55 }} />
        <div style={{ width: `${minePct}%`, background: "var(--gold-leaf)" }} />
      </div>
    </div>
  );
}

export function PoolMeter({
  planName,
  cpu,
  ram,
}: {
  planName?: string;
  cpu: PoolMetric;
  ram: PoolMetric;
}) {
  // Nothing meaningful to show until a real pool is known.
  if (!(cpu.total > 0) && !(ram.total > 0)) return null;
  const hasOthers = cpu.othersUsed > 0 || ram.othersUsed > 0;
  return (
    <div style={{ border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.02)", padding: "11px 13px", display: "grid", gap: 9 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.14em", fontWeight: 800, opacity: 0.78 }}>
          {planName ? `${planName} pool` : "Compute pool"}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--gold-leaf)", display: "inline-block" }} />
          <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.78 }}>This computer</span>
        </span>
        {hasOthers ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: "var(--text-muted)", opacity: 0.55, display: "inline-block" }} />
            <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.78 }}>Other agents</span>
          </span>
        ) : null}
      </div>
      <Bar metric={cpu} unit="CPU" />
      <Bar metric={ram} unit="GB" />
    </div>
  );
}
