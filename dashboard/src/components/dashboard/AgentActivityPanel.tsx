"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, Cpu, DollarSign, CalendarDays, Sparkles, Wrench } from "lucide-react";

import { Sparkline } from "@/components/stats/Sparkline";
import { getAgent } from "@/lib/hivra/agent-catalog";
import { captureClient } from "@/lib/telemetry/posthog-client";
import { fetchPlanStrict, isFreePlanInfo, type PlanInfo } from "@/lib/hivra/agent-api";
import { isUsageUpgradeCtaEnabled } from "@/lib/flags/upgrade-prompts";
import { UsageUpgradeFooter } from "@/components/billing/UsageUpgradeFooter";

/**
 * "Your agent at work" — the per-user activity surface. Self-fetches
 * /api/billing/agent-activity and renders one of two views depending on what
 * the payload can actually claim:
 *
 *   Hermes lane (metered usage) — headline cards, a token-volume trend, top
 *   models + skills. Only rendered when token data exists, because it is a
 *   usage view and a zeroed usage view is a lie.
 *
 *   Hivra lane (recorded activity) — lifecycle events, active days, fleet
 *   state, desktop sessions, and a recent timeline. Never renders a token or
 *   dollar figure: Hivra boxes run the customer's own model keys, so Hivra does
 *   not meter them, and inventing a number there would be worse than showing
 *   nothing.
 *
 * The server tells us which of these is legitimate via `coverage`, so the empty
 * state is chosen from evidence rather than inferred from zeroed totals.
 */

const FETCH_DAYS = 30;

interface AgentActivityTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
  sessions: number;
  apiCalls: number;
  toolCalls: number;
}

interface AgentActivityDailyPoint {
  date: string;
  totalTokens: number;
  estimatedCostUsd: number;
  sessions: number;
}

interface AgentActivityModel {
  model: string;
  totalTokens: number;
}

interface AgentActivitySkill {
  skill: string;
  count: number;
}

interface HivraActivityEvent {
  id: string;
  event: string;
  agentType: string | null;
  agentId: string | null;
  createdAt: string;
}

interface HivraActivity {
  eventCount: number;
  byEvent: Array<{ event: string; count: number }>;
  byAgentType: Array<{ agentType: string; count: number }>;
  activeDays: number;
  desktopSessions: number;
  desktopDays: number;
  daily: Array<{ date: string; count: number }>;
  fleet: {
    runningAgents: number;
    totalAgents: number;
    firstAgentAt: string | null;
    byStatus: Record<string, number>;
  };
  recent: HivraActivityEvent[];
  truncated: boolean;
  /** The Hivra lane alone failed; the page must still render. */
  degraded?: boolean;
}

type AgentActivityCoverage = "usage" | "activity" | "none";

interface AgentActivity {
  totals: AgentActivityTotals;
  daily: AgentActivityDailyPoint[];
  topModels: AgentActivityModel[];
  topSkills: AgentActivitySkill[];
  instanceCount: number;
  activeDays: number;
  generatedAt: string;
  /**
   * Optional so a client bundle mid-rolling-deploy can still render an older
   * server's payload instead of throwing. Absent = infer legacy behaviour.
   */
  hivra?: HivraActivity;
  coverage?: AgentActivityCoverage;
  /** Server signalled the zeroed payload is an error fallback, not a real empty. */
  degraded?: boolean;
}

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(n));
}

function fmtUsd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function shortModel(model: string): string {
  // "anthropic/claude-3.5" / "NousResearch/Hermes-4" -> trailing segment.
  const tail = model.split(/[/:]/).pop() ?? model;
  return tail.length > 28 ? `${tail.slice(0, 27)}…` : tail;
}

/**
 * Event names are wire values (provisioned, launch_requested, …). Render them as
 * plain language without inventing semantics the log does not carry.
 */
const EVENT_LABEL: Record<string, string> = {
  launch_requested: "Launch requested",
  provisioned: "Provisioned",
  provision_failed: "Provision failed",
  failed: "Failed",
  bootstrapped: "Bootstrapped",
  started: "Started",
  stopped: "Stopped",
  restarted: "Restarted",
  resized: "Resized",
  deleted: "Deleted",
  bankr_skills_seeded: "Skills seeded",
  skills_installed: "Skills installed",
  tools_installed: "Tools installed",
  tools_uninstalled: "Tools uninstalled",
  template_skills_seeded: "Template skills seeded",
  bankr_wallet_provisioned: "Wallet provisioned",
  snapshot_created: "Snapshot created",
  snapshot_restored: "Snapshot restored",
};

function eventLabel(event: string): string {
  return EVENT_LABEL[event] ?? event.replace(/_/g, " ");
}

/** Relative time for the timeline; coarse on purpose (exact times are noise). */
function timeAgo(iso: string, now: number): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const mins = Math.max(0, Math.round((now - then) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1d ago" : `${days}d ago`;
}

/** Human label for an agent type; falls back to the raw catalog id. */
function agentTypeLabel(type: string | null): string {
  if (!type) return "a deleted agent";
  return getAgent(type)?.name ?? type;
}

const LABEL: React.CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.12em",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const PANEL: React.CSSProperties = {
  border: "1px solid var(--etched-border)",
  background: "rgba(255,255,255,0.025)",
  padding: "1.1rem 1.25rem",
  display: "grid",
  gap: 14,
};

function HeadlineCard({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: string;
  label: string;
}) {
  // Rows stay top-aligned so values line up across tiles when a label wraps.
  return (
    <div style={{ ...PANEL, gap: 6, minWidth: 0, alignContent: "start" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, opacity: 0.5 }}>{icon}</span>
      <span className="serif" style={{ fontSize: "1.7rem", fontWeight: 600, lineHeight: 1.05 }}>
        {value}
      </span>
      <span className="mono" style={LABEL}>
        {label}
      </span>
    </div>
  );
}

export function AgentActivityPanel() {
  const [activity, setActivity] = useState<AgentActivity | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  // The signed-in user's real plan — drives the free-only upgrade footer. Starts
  // null (unknown) so the footer never flashes before the plan resolves; a paid
  // user therefore never sees the pitch. Strict fetch: on error the plan stays
  // null (unknown ≠ free), so a payer with one failed billing round-trip is
  // never pitched. Skipped entirely while the flag is off — a dark feature must
  // not add an API call.
  const [plan, setPlan] = useState<PlanInfo | null>(null);

  useEffect(() => {
    if (!isUsageUpgradeCtaEnabled()) return;
    let alive = true;
    void fetchPlanStrict()
      .then((p) => {
        if (alive) setPlan(p);
      })
      .catch(() => {
        // Unknown plan stays null → footer stays hidden.
      });
    return () => {
      alive = false;
    };
  }, []);

  // Fire once on mount — best-effort, never user-visible if telemetry is down.
  useEffect(() => {
    try {
      captureClient("agent_usage_viewed", { days: FETCH_DAYS });
    } catch {
      // ignore — analytics must never break the page
    }
  }, []);

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    // State starts at "loading" (the retry button re-arms it); the fetch flips
    // it to "ready"/"error".
    let alive = true;
    fetch(`/api/billing/agent-activity?days=${FETCH_DAYS}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body) => {
        if (!alive) return;
        setActivity((body?.data ?? null) as AgentActivity | null);
        setState("ready");
      })
      .catch(() => {
        if (alive) setState("error");
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  // Mount-time clock for the timeline's relative labels. Read once so every row
  // in a render agrees on "now".
  const [nowMs] = useState(() => Date.now());

  const sparklineData = useMemo(
    () => (activity?.daily ?? []).map((d) => ({ date: d.date, count: d.totalTokens })),
    [activity]
  );

  // The Hivra lane's series, kept in its own shape so it can never be handed to
  // a component that labels its values as tokens.
  const hivraSparklineData = useMemo(
    () => (activity?.hivra?.daily ?? []).map((d) => ({ date: d.date, count: d.count })),
    [activity]
  );

  // Metered-usage presence. Cost counts: a snapshot can carry spend without a
  // token count, and gating on tokens alone would render the Hivra activity
  // section's "we don't meter you" disclaimer over a real Hermes invoice.
  const hasUsage = useMemo(() => {
    if (!activity) return false;
    const t = activity.totals;
    return (
      t.totalTokens > 0 ||
      t.sessions > 0 ||
      t.apiCalls > 0 ||
      t.toolCalls > 0 ||
      t.estimatedCostUsd > 0
    );
  }, [activity]);

  // RECORDED activity only — having boxes is not activity. Absent `hivra`
  // (older server) reads as false, so a rolling deploy keeps the previous
  // behaviour rather than throwing.
  const hasActivity = useMemo(() => {
    const h = activity?.hivra;
    if (!h) return false;
    return (h.eventCount ?? 0) > 0 || (h.desktopSessions ?? 0) > 0;
  }, [activity]);

  // Boxes exist but nothing has been recorded yet — distinct from "no boxes".
  const hasFleet = useMemo(() => {
    const h = activity?.hivra;
    return (h?.fleet?.totalAgents ?? 0) > 0 || (activity?.instanceCount ?? 0) > 0;
  }, [activity]);

  const header = (
    <header style={{ display: "grid", gap: 6, marginBottom: "0.5rem" }}>
      <h1 className="serif" style={{ fontSize: "1.6rem", fontWeight: 600, margin: 0 }}>
        Your agent at work
      </h1>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
        What your agent has been doing over the last {FETCH_DAYS} days.
      </p>
    </header>
  );

  if (state === "loading") {
    return (
      <div style={{ display: "grid", gap: 18 }}>
        {header}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 14,
          }}
        >
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              style={{
                ...PANEL,
                height: 110,
                opacity: 0.5,
                animation: "pulse 1.4s ease-in-out infinite",
              }}
            />
          ))}
        </div>
        <style>{`@keyframes pulse { 0%,100% { opacity: 0.35 } 50% { opacity: 0.6 } }`}</style>
      </div>
    );
  }

  const retryCard = (message: string) => (
    <div style={{ ...PANEL, padding: "2rem 1.5rem", textAlign: "center", gap: 8 }}>
      <span style={{ display: "inline-flex", justifyContent: "center", opacity: 0.4 }}>
        <Activity size={22} />
      </span>
      <p style={{ fontSize: 14, color: "var(--text-secondary)", margin: 0, lineHeight: 1.6 }}>
        {message}
      </p>
      <button
        type="button"
        onClick={() => {
          setState("loading");
          setReloadKey((k) => k + 1);
        }}
        className="mono pointer-coarse:min-h-[44px]"
        style={{
          marginTop: 4,
          alignSelf: "center",
          padding: "8px 16px",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          borderRadius: 0,
          border: "1px solid var(--etched-border)",
          background: "transparent",
          color: "var(--text-secondary)",
          cursor: "pointer",
        }}
      >
        Retry
      </button>
    </div>
  );

  // A failed fetch (HTTP error) means nothing loaded at all — offer a retry.
  if (state === "error" || !activity) {
    return (
      <div style={{ display: "grid", gap: 18 }}>
        {header}
        {retryCard("We couldn't load your agent's activity just now.")}
      </div>
    );
  }

  // The Hermes metered-usage half errored. If the Hivra half can still fill the
  // page, render it with an inline note rather than blanking everything — one
  // lane's failure must not erase the other lane's real data.
  const usageFailed = activity.degraded === true;
  if (usageFailed && !hasUsage && !hasActivity) {
    return (
      <div style={{ display: "grid", gap: 18 }}>
        {header}
        {retryCard("We couldn't load your agent's activity just now.")}
      </div>
    );
  }

  // Nothing on either lane and no boxes to speak of: the only case that earns a
  // genuinely-empty message. Coverage (not zeroed totals) decides.
  if (!hasUsage && !hasActivity && !hasFleet) {
    return (
      <div style={{ display: "grid", gap: 18 }}>
        {header}
        <div style={{ ...PANEL, padding: "2rem 1.5rem", textAlign: "center", gap: 8 }}>
          <span style={{ display: "inline-flex", justifyContent: "center", opacity: 0.4 }}>
            <Activity size={22} />
          </span>
          <p style={{ fontSize: 14, color: "var(--text-secondary)", margin: 0, lineHeight: 1.6 }}>
            No activity recorded yet. Launch an agent and it will show up here.
          </p>
        </div>
      </div>
    );
  }

  const hivra = activity.hivra;
  const { totals, topModels, topSkills, activeDays, instanceCount } = activity;
  const maxModelTokens = Math.max(1, ...topModels.map((m) => m.totalTokens));
  const maxSkillCount = Math.max(1, ...topSkills.map((s) => s.count));
  const maxEventCount = Math.max(1, ...(hivra?.byEvent ?? []).map((e) => e.count));

  // Boxes exist but neither lane has recorded anything yet. Telling this user
  // they have "no activity yet" is false — we simply have not observed them.
  if (!hasUsage && !hasActivity) {
    const since = hivra?.fleet?.firstAgentAt;
    const n = hivra?.fleet?.totalAgents ?? instanceCount;
    return (
      <div style={{ display: "grid", gap: 18 }}>
        {header}
        <div style={{ ...PANEL, padding: "2rem 1.5rem", textAlign: "center", gap: 8 }}>
          <span style={{ display: "inline-flex", justifyContent: "center", opacity: 0.4 }}>
            <Activity size={22} />
          </span>
          <p style={{ fontSize: 14, color: "var(--text-secondary)", margin: 0, lineHeight: 1.6 }}>
            You have {n} {n === 1 ? "agent" : "agents"}, but Hivra hasn&apos;t recorded any activity
            yet{since ? ` since ${new Date(since).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""}.
          </p>
        </div>
      </div>
    );
  }

  /**
   * Recorded Hivra-lane activity. This is an ACTIVITY view, not a usage view:
   * Hivra boxes run the customer's own model keys, so no token or cost figure
   * exists for them and none is shown.
   */
  const activitySection = hivra && hasActivity && (
    <div style={{ display: "grid", gap: 18 }}>
      {usageFailed ? (
        <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
          Metered usage could not be loaded just now — showing recorded activity only.
        </p>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 14,
        }}
      >
        <HeadlineCard
          icon={<Activity size={15} />}
          value={fmtCompact(hivra.fleet.runningAgents)}
          label={hivra.fleet.runningAgents === 1 ? "agent running" : "agents running"}
        />
        <HeadlineCard
          icon={<CalendarDays size={15} />}
          value={String(hivra.activeDays)}
          label={hivra.activeDays === 1 ? "active day" : "active days"}
        />
        <HeadlineCard
          icon={<Wrench size={15} />}
          value={fmtCompact(hivra.eventCount)}
          label="lifecycle events"
        />
        <HeadlineCard
          icon={<Cpu size={15} />}
          value={fmtCompact(hivra.desktopSessions)}
          label="desktop sessions"
        />
      </div>

      <div style={{ ...PANEL, gap: 12 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <span className="mono" style={LABEL}>
            Recorded activity · last {FETCH_DAYS} days
          </span>
          {Object.keys(hivra.fleet.byStatus).length > 0 ? (
            <span className="mono" style={LABEL}>
              {Object.entries(hivra.fleet.byStatus)
                .sort((a, b) => b[1] - a[1])
                .map(([status, count]) => `${count} ${status}`)
                .join(" · ")}
            </span>
          ) : null}
        </div>
        <Sparkline
          data={hivraSparklineData}
          ariaLabel={`Recorded daily activity over the last ${FETCH_DAYS} days`}
          labels={{
            peak: "busiest day",
            total: `${FETCH_DAYS}-day total`,
            barLabel: "{date}: {count} events",
          }}
        />
        {hivra.truncated ? (
          <span style={{ fontSize: 11, color: "var(--text-secondary)", opacity: 0.7 }}>
            Showing the most recent {FETCH_DAYS} days; older activity is not counted here.
          </span>
        ) : null}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 14,
        }}
      >
        <div style={PANEL}>
          <span className="mono" style={LABEL}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Sparkles size={12} /> Activity by type
            </span>
          </span>
          {hivra.byEvent.length === 0 ? (
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              No lifecycle events yet.
            </span>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
              {hivra.byEvent.slice(0, 8).map((e) => (
                <li key={e.event} style={{ display: "grid", gap: 5 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {eventLabel(e.event)}
                    </span>
                    <span className="mono" style={{ fontSize: 12, opacity: 0.6, flexShrink: 0 }}>
                      {fmtCompact(e.count)}
                    </span>
                  </div>
                  <div
                    style={{
                      height: 4,
                      background: "var(--etched-border)",
                      borderRadius: 2,
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        height: "100%",
                        width: `${Math.max(4, (e.count / maxEventCount) * 100)}%`,
                        background: "var(--gold-leaf)",
                        opacity: 0.85,
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div style={PANEL}>
          <span className="mono" style={LABEL}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Cpu size={12} /> Recent activity
            </span>
          </span>
          {hivra.recent.length === 0 ? (
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              Nothing recorded in this window.
            </span>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
              {hivra.recent.slice(0, 12).map((e) => (
                <li
                  key={e.id}
                  style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 13 }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {eventLabel(e.event)}
                  </span>
                  <span className="mono" style={{ fontSize: 11, opacity: 0.55, flexShrink: 0 }}>
                    {agentTypeLabel(e.agentType)} · {timeAgo(e.createdAt, nowMs)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0, lineHeight: 1.6 }}>
        These boxes run your own model keys, so Hivra does not meter their tokens. This is what
        Hivra has observed.
      </p>
      {hivra.degraded ? (
        <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0, lineHeight: 1.6 }}>
          Some recorded activity could not be loaded just now.
        </p>
      ) : null}
    </div>
  );

  // No metered usage: the page is the activity view alone.
  if (!hasUsage) {
    return (
      <div style={{ display: "grid", gap: 18 }}>
        {header}
        {activitySection}
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: 18 }}>
      {header}

      {/* Headline cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
          gap: 14,
        }}
      >
        <HeadlineCard icon={<Activity size={15} />} value={fmtCompact(totals.sessions)} label="sessions" />
        <HeadlineCard icon={<Cpu size={15} />} value={fmtCompact(totals.totalTokens)} label="total tokens" />
        <HeadlineCard icon={<DollarSign size={15} />} value={fmtUsd(totals.estimatedCostUsd)} label="est. cost" />
        <HeadlineCard
          icon={<CalendarDays size={15} />}
          value={String(activeDays)}
          label={activeDays === 1 ? "active day" : "active days"}
        />
      </div>

      {/* Token-volume trend */}
      <div style={{ ...PANEL, gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <span className="mono" style={LABEL}>
            Token volume · last {FETCH_DAYS} days
          </span>
          <span className="mono" style={LABEL}>
            {instanceCount} {instanceCount === 1 ? "agent" : "agents"}
          </span>
        </div>
        <Sparkline
          data={sparklineData}
          ariaLabel="Daily token volume over the last 30 days"
          labels={{ peak: "peak day", total: "30-day total", barLabel: "{date}: {count} tokens" }}
        />
      </div>

      {/* Top models + top skills */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14 }}>
        <div style={PANEL}>
          <span className="mono" style={LABEL}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Sparkles size={12} /> Top models
            </span>
          </span>
          {topModels.length === 0 ? (
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>No model data yet.</span>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
              {topModels.map((m) => (
                <li key={m.model} style={{ display: "grid", gap: 5 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {shortModel(m.model)}
                    </span>
                    <span className="mono" style={{ fontSize: 12, opacity: 0.6, flexShrink: 0 }}>
                      {fmtCompact(m.totalTokens)}
                    </span>
                  </div>
                  <div style={{ height: 4, background: "var(--etched-border)", borderRadius: 2, overflow: "hidden" }}>
                    <div
                      style={{
                        height: "100%",
                        width: `${Math.max(4, (m.totalTokens / maxModelTokens) * 100)}%`,
                        background: "var(--gold-leaf)",
                        opacity: 0.85,
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div style={PANEL}>
          <span className="mono" style={LABEL}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <Wrench size={12} /> Top skills
            </span>
          </span>
          {topSkills.length === 0 ? (
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>No skill activity yet.</span>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 10 }}>
              {topSkills.map((s) => (
                <li key={s.skill} style={{ display: "grid", gap: 5 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {s.skill}
                    </span>
                    <span className="mono" style={{ fontSize: 12, opacity: 0.6, flexShrink: 0 }}>
                      {fmtCompact(s.count)}
                    </span>
                  </div>
                  <div style={{ height: 4, background: "var(--etched-border)", borderRadius: 2, overflow: "hidden" }}>
                    <div
                      style={{
                        height: "100%",
                        width: `${Math.max(4, (s.count / maxSkillCount) * 100)}%`,
                        background: "var(--gold-leaf)",
                        opacity: 0.85,
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* A user with both metered usage and Hivra boxes sees the recorded
          activity below the usage view. */}
      {activitySection}

      {/*
        Free→paid Moment #2: show-value-then-ask. We're already in the
        ready-with-usage branch (hasUsage === true), so this only reaches free
        users who got real value. Flag default-OFF; isFreePlanInfo gates out
        paying customers (and null/loading plans).
      */}
      {isUsageUpgradeCtaEnabled() && isFreePlanInfo(plan) ? <UsageUpgradeFooter /> : null}
    </div>
  );
}
