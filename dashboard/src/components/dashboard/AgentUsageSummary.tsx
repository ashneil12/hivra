"use client";

import { useEffect, useState } from "react";
import { Activity, Wrench, Cpu, Sparkles } from "lucide-react";

import type { InstanceUsageSummary } from "@/lib/usage-summary";

/**
 * "What your agent did" — a compact 7-day proof-of-work card for the Primary
 * Agent panel. Self-fetches /api/instances/[id]/usage-summary (harvested
 * instance_usage_snapshots, user-authorized). Gives a returning user a reason
 * to stay: a visible record that the agent has been working for them.
 */

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(n);
}

function shortModel(model: string): string {
  // "anthropic/claude-3.5" / "NousResearch/Hermes-4" -> trailing segment,
  // shown in full on its own row.
  return model.split(/[/:]/).pop() || model;
}

const LABEL: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.12em",
  color: "var(--text-muted)",
  fontWeight: 700,
};

function Stat({
  icon,
  value,
  label,
  title,
  wide = false,
}: {
  icon: React.ReactNode;
  value: string;
  label: string;
  title?: string;
  /** A text value (a model name) at a smaller size that wraps in full. */
  wide?: boolean;
}) {
  return (
    <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, opacity: 0.5 }}>{icon}</span>
      <span
        className="serif"
        title={title}
        style={{
          fontSize: wide ? "1rem" : "1.3rem",
          fontWeight: 600,
          lineHeight: wide ? 1.2 : 1,
          ...(wide ? { overflowWrap: "anywhere" } : null),
        }}
      >
        {value}
      </span>
      <span className="mono" style={LABEL}>{label}</span>
    </div>
  );
}

export function AgentUsageSummary({ instanceId, days = 7 }: { instanceId: string; days?: number }) {
  const [summary, setSummary] = useState<InstanceUsageSummary | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let alive = true;
    fetch(`/api/instances/${instanceId}/usage-summary?days=${days}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        if (!alive) return;
        setSummary((body?.data ?? null) as InstanceUsageSummary | null);
        setState("ready");
      })
      .catch(() => {
        if (alive) setState("error");
      });
    return () => {
      alive = false;
    };
  }, [instanceId, days]);

  // Stay quiet on error/loading — this is an enhancement, never a blocker.
  if (state !== "ready" || !summary) return null;

  const wrap: React.CSSProperties = {
    border: "1px solid var(--etched-border)",
    background: "rgba(255,255,255,0.025)",
    padding: "0.9rem 1.1rem",
    display: "grid",
    gap: 12,
  };

  if (summary.isEmpty) {
    return (
      <div style={wrap} data-testid="agent-usage-summary-empty">
        <span className="mono" style={LABEL}>Recent work · last {summary.days} days</span>
        <span style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          Nothing yet. Ask your agent to do something — or give it a standing order, like
          “every morning, summarize the news in my industry.” It’ll show up here.
        </span>
      </div>
    );
  }

  return (
    <div style={wrap} data-testid="agent-usage-summary">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <span className="mono" style={LABEL}>Recent work · last {summary.days} days</span>
        <span className="mono" style={LABEL}>
          active {summary.activeDays} {summary.activeDays === 1 ? "day" : "days"}
          {summary.lastActiveDate ? ` · last ${summary.lastActiveDate}` : ""}
        </span>
      </div>
      {/* Counts share a row; the model name takes its own row so it never truncates. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(72px, 1fr))", gap: 14 }}>
        <Stat icon={<Activity size={13} />} value={fmtCompact(summary.sessions)} label="sessions" />
        <Stat icon={<Wrench size={13} />} value={fmtCompact(summary.toolCalls)} label="tool calls" />
        <Stat icon={<Cpu size={13} />} value={fmtCompact(summary.totalTokens)} label="tokens" />
      </div>
      {summary.topModel ? (
        <Stat
          icon={<Sparkles size={13} />}
          value={shortModel(summary.topModel)}
          title={summary.topModel}
          label="top model"
          wide
        />
      ) : null}
    </div>
  );
}
