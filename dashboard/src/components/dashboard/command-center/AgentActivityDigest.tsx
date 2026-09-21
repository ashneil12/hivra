import { CheckCircle2, Loader2, MessageSquareText, Radio } from "lucide-react";

import { formatMicroUsd } from "@/components/billing/ManagedVeniceSubsidyBanner";
import type { InstanceActivityDigest } from "@/lib/command-center/activity";

// NOTE: the "getting started" onboarding checklist that used to live here has
// moved to its own top-of-panel, self-retiring section — see
// components/instances/GettingStarted.tsx. This component is now purely the
// live-work digest.

function stateColor(state: InstanceActivityDigest["state"] | "loading") {
  if (state === "responding") return "#16a34a";
  // "unreachable" is no longer surfaced as an error (the legacy live-activity
  // surface is retired); treat it as a calm neutral state, same as idle — never
  // a red alarm for what is a normal condition on a current box.
  if (state === "unreachable") return "var(--text-muted)";
  if (state === "not_running") return "#71717a";
  return "var(--ink-black)";
}

function formatSessionMeta(session: InstanceActivityDigest["recentSessions"][number]) {
  const parts = [];
  if (typeof session.messageCount === "number") {
    parts.push(`${session.messageCount} ${session.messageCount === 1 ? "message" : "messages"}`);
  }
  if (session.model) parts.push(session.model);
  if (typeof session.estimatedCostUsd === "number") {
    parts.push(formatMicroUsd(Math.round(session.estimatedCostUsd * 1_000_000), 4));
  }
  return parts.join(" · ");
}

export function AgentActivityDigest({
  digest,
  loading = false,
}: {
  digest: InstanceActivityDigest | null;
  loading?: boolean;
  // `error` is still accepted from callers for API stability but is intentionally
  // not surfaced — an activity-read miss is a normal/calm state, not an error.
  error?: string | null;
}) {
  // When there's no digest (still loading, or a transient fetch miss) fall back
  // to a calm idle state — never the old red "unreachable"/error tone.
  const state = loading ? "loading" : digest?.state ?? "idle";
  const color = stateColor(state);

  const headline = loading ? "Checking activity" : digest?.headline ?? "Ready when you are";
  const detail = loading
    ? "Catching up on recent activity…"
    : digest?.detail ?? "Send a message in the chat to put your agent to work.";

  return (
    <section
      data-testid="agent-activity-digest"
      style={{
        border: "1px solid var(--etched-border)",
        background: "rgba(255,255,255,0.04)",
        padding: "clamp(1rem, 3vw, 1.4rem)",
        display: "grid",
        gap: 16,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
        <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.16em", opacity: 0.64 }}>
            Live Work
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            {loading ? (
              <Loader2 size={18} style={{ animation: "spin 1s linear infinite", color }} />
            ) : (
              <Radio size={18} style={{ color }} />
            )}
            <strong style={{ fontSize: 18, lineHeight: 1.25, color, minWidth: 0 }}>{headline}</strong>
          </div>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "var(--text-secondary)" }}>{detail}</p>
        </div>

        <div className="mono" style={{ fontSize: 10, opacity: 0.64, textTransform: "uppercase", whiteSpace: "nowrap" }}>
          {/* Show a stream count when we have one; otherwise a neutral "live"
              label. Never expose the internal source token ("webui"/"degraded"). */}
          {typeof digest?.activeStreams === "number"
            ? `${digest.activeStreams} active ${digest.activeStreams === 1 ? "stream" : "streams"}`
            : "Live"}
        </div>
      </div>

      {digest?.attentionItems.length ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {digest.attentionItems.map((item) => (
            <span
              key={`${item.type}-${item.label}`}
              className="mono"
              style={{
                border: `1px solid ${item.severity === "critical" ? "#b91c1c" : "var(--gold-leaf)"}`,
                color: item.severity === "critical" ? "#b91c1c" : "var(--gold-leaf)",
                padding: "6px 8px",
                fontSize: 10,
                fontWeight: 800,
                textTransform: "uppercase",
                letterSpacing: "0.1em",
              }}
            >
              {item.label}
            </span>
          ))}
        </div>
      ) : null}

      {digest?.recentSessions.length ? (
        <div style={{ display: "grid", gap: 8 }}>
          {digest.recentSessions.map((session) => (
            <div
              key={session.id}
              style={{
                borderTop: "1px solid var(--etched-border)",
                paddingTop: 10,
                display: "flex",
                gap: 10,
                alignItems: "flex-start",
                minWidth: 0,
              }}
            >
              <MessageSquareText size={15} style={{ marginTop: 2, opacity: 0.7, flexShrink: 0 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {session.title}
                </div>
                <div className="mono" style={{ fontSize: 10, marginTop: 4, opacity: 0.58, textTransform: "uppercase" }}>
                  {formatSessionMeta(session) || "Recent session"}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : !loading ? (
        <div style={{ borderTop: "1px solid var(--etched-border)", paddingTop: 10, display: "flex", alignItems: "center", gap: 8 }}>
          <CheckCircle2 size={15} style={{ opacity: 0.66 }} />
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>No recent activity yet.</span>
        </div>
      ) : null}
    </section>
  );
}
