"use client";

import { ThinkingOrb } from "@/components/ui/ThinkingOrb";
import { formatWakeSeconds, type AgentRestingReason } from "./useAgentWake";

const panelStyle = {
  flex: 1,
  minHeight: 0,
  padding: "clamp(32px, 6vw, 56px) clamp(16px, 4vw, 40px)",
  textAlign: "center" as const,
  color: "var(--text-muted)",
  overflowWrap: "anywhere" as const,
};
const buttonStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 40,
  marginTop: 18,
  padding: "0 16px",
  border: "1px solid var(--etched-border)",
  background: "var(--bg-surface)",
  color: "var(--ink-black)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

/**
 * What an agent's page shows instead of its chat, terminal and files while the
 * agent is asleep: its computer cannot answer until it is awake, so nothing
 * tries to reach it. It reads as a short wait, not as an error. If the wake did
 * not work, it says so plainly and offers another try.
 */
export function AgentWakePanel({
  name,
  failure,
  onRetry,
  resting = null,
}: {
  name: string;
  /** A plain message when the wake did not work. */
  failure: string | null;
  onRetry: () => void;
  /**
   * Set while the page leaves the agent asleep on purpose: the owner put it to
   * sleep for a test, or it napped while this page sat open. Nothing is waking
   * yet, so the panel says so and offers the button.
   */
  resting?: AgentRestingReason | null;
}) {
  if (failure) {
    return (
      <div style={panelStyle}>
        <div role="alert">
          <div className="serif" style={{ fontSize: 24, fontWeight: 600, color: "var(--ink-black)", marginBottom: 8 }}>
            Your agent could not wake up
          </div>
          <p style={{ fontSize: 13, maxWidth: 460, margin: "0 auto", lineHeight: 1.6 }}>{failure}</p>
        </div>
        <button type="button" onClick={onRetry} style={buttonStyle}>Try again</button>
      </div>
    );
  }
  if (resting) {
    return (
      <div style={panelStyle}>
        <div role="status" aria-live="polite">
          <div className="serif" style={{ fontSize: 24, fontWeight: 600, color: "var(--ink-black)", marginBottom: 8 }}>
            Your agent is napping
          </div>
          <p style={{ fontSize: 13, maxWidth: 460, margin: "0 auto", lineHeight: 1.6 }}>
            {resting === "manual"
              ? `You put ${name} to sleep for a test. It stays asleep until you wake it.`
              : `${name} napped while nobody was using it. It wakes up as soon as you use this page.`}
          </p>
        </div>
        <button type="button" onClick={onRetry} style={buttonStyle}>Wake it up</button>
      </div>
    );
  }
  return (
    <div style={panelStyle}>
      <div role="status" aria-live="polite">
        <div style={{ display: "flex", justifyContent: "center" }}><ThinkingOrb size={32} state="connecting" /></div>
        <div className="serif" style={{ fontSize: 24, fontWeight: 600, color: "var(--ink-black)", margin: "14px 0 6px" }}>
          Waking up your agent
        </div>
        <p style={{ fontSize: 13, maxWidth: 460, margin: "0 auto", lineHeight: 1.6 }}>
          {name} was resting while nobody used it. It will be ready in a few seconds.
        </p>
      </div>
    </div>
  );
}

/** Shown for a moment after the agent comes up. */
export function WokeUpNote({ ms }: { ms: number }) {
  return (
    <div
      role="status"
      style={{
        alignSelf: "center",
        margin: "6px 0",
        padding: "4px 12px",
        border: "1px solid var(--hg-stroke)",
        borderRadius: 999,
        background: "var(--hg-fill-1)",
        color: "var(--text-secondary)",
        fontSize: 12,
      }}
    >
      Woke up in {formatWakeSeconds(ms)}
    </div>
  );
}
