"use client";

import { ArrowUpCircle, Loader2, AlertTriangle } from "lucide-react";
import type { HivraAgent } from "@/lib/hivra/agent-api";
import { getAgent as catalogAgent } from "@/lib/hivra/agent-catalog";
import { agentSoftwareBadge, agentSoftwareSubject, type AgentSoftwareBadge, type AgentSoftwareView } from "@/lib/hivra/agent-cli-status";
import { agentSoftwareDisplayName, agentSoftwareVersionName } from "@/lib/hivra/agent-software-names";
import { useAgentSoftware } from "./useAgentSoftware";
import styles from "./AgentSoftwareChip.module.css";

const CHIP_TEXT: Record<AgentSoftwareBadge, string> = {
  update_available: "Update available",
  updating: "Updating…",
  update_failed: "Update didn't finish",
};
/** What a phone-width page shows instead, so the chip still says something next to its icon. */
const CHIP_SHORT_TEXT: Record<AgentSoftwareBadge, string> = {
  update_available: "Update",
  updating: "Updating…",
  update_failed: "Update failed",
};

/**
 * Whether Hivra checks this agent's software here: an agent it covers
 * (agentSoftwareSubject) whose connection service Manage can update. An
 * operation in progress (such as the update itself) doesn't hide it.
 */
export function agentSoftwareCovered(agent: HivraAgent): boolean {
  const cap = agent.manage?.connectionServiceUpdate;
  return agentSoftwareSubject(agent) !== null && cap != null && cap.state !== "unavailable";
}

function describe(view: AgentSoftwareView, badge: AgentSoftwareBadge, name: string, tested: string | null): string {
  const v = agentSoftwareVersionName;
  if (view.kind === "older_connection_service") return `${CHIP_TEXT[badge]}: this agent's connection service is older than Hivra's current one. Open Updates.`;
  if (view.kind === "behind" && tested) return `${CHIP_TEXT[badge]}: ${name} ${v(view.installed)} is installed and Hivra has tested ${v(tested)}. Open Updates.`;
  if (view.kind === "ahead_hivra" && tested) return `${CHIP_TEXT[badge]}: Hivra now tests ${name} ${v(tested)}. Open Updates.`;
  if (view.kind === "other_version" && tested) return `${CHIP_TEXT[badge]}: Hivra has tested ${name} ${v(tested)}. Open Updates.`;
  if (badge === "updating") return `Updating ${name}. Open Updates to follow it.`;
  if (badge === "update_failed") return `The ${name} update didn't finish. Open Updates.`;
  return `${CHIP_TEXT[badge]}. Open Updates.`;
}

/**
 * "Update available" (or "Updating…", "Update didn't finish") for an agent
 * whose Claude Code, Codex or hosted app is behind the version Hivra has
 * tested (or, for an app, on a version Hivra didn't record or test), or whose
 * connection service is older than Hivra's current one. Never shown for a
 * version newer than tested. Pressing it opens Manage › Updates.
 */
export function AgentSoftwareChip({ agent, onOpen, className }: {
  agent: HivraAgent;
  onOpen: () => void;
  className?: string;
}) {
  const enabled = agent.status === "running" && agentSoftwareCovered(agent);
  const { state } = useAgentSoftware(agent.id, enabled);
  if (!enabled || !state?.supported) return null;
  const badge = agentSoftwareBadge(state.view, state.app != null);
  if (!badge) return null;
  const name = agentSoftwareDisplayName(state.app ?? null, catalogAgent(agent.type)?.name ?? "The agent");
  const Icon = badge === "updating" ? Loader2 : badge === "update_failed" ? AlertTriangle : ArrowUpCircle;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={className}
      data-testid="agent-software-chip"
      data-badge={badge}
      aria-label={describe(state.view, badge, name, state.tested)}
      title={describe(state.view, badge, name, state.tested)}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, minHeight: 44, minWidth: 44, padding: 0,
        border: 0, background: "transparent", cursor: "pointer", color: "var(--ink-black)",
      }}
    >
      <span style={{
        display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 9px", whiteSpace: "nowrap",
        border: `1px solid ${badge === "update_failed" ? "#c0392b" : "var(--gold-leaf, var(--etched-border))"}`,
        fontSize: 11, fontWeight: 700, letterSpacing: "0.02em",
      }}>
        <Icon size={12} aria-hidden="true" style={badge === "updating" ? { animation: "spin 1s linear infinite" } : undefined} />
        <span data-chip-text>{CHIP_TEXT[badge]}</span>
        <span data-chip-short className={styles.short}>{CHIP_SHORT_TEXT[badge]}</span>
      </span>
    </button>
  );
}
