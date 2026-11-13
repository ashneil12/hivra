"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  getTelegramWakeSetting,
  saveAgentSleepSettings,
  saveTelegramWakeSetting,
  sleepAgentNow,
  wakeAgent,
  type AgentSleepPolicy,
  type HivraAgent,
  type TelegramWakeSetting,
} from "@/lib/hivra/agent-api";
import { agentSleepView, telegramWakeUiEnabled } from "@/lib/hivra/agent-sleep-ui";
import { holdAutoWake, releaseAutoWake } from "../useAgentWake";
import { ManageChannelWake } from "./ManageChannelWake";
import { manageButtonGhost, manageCard, manageDisabled, manageLabel, manageMuted, manageSpin } from "./manage-styles";

type Busy = "policy" | "always_on" | "telegram" | "nap" | "hibernate" | "wake" | null;

/** Plain words for how a manual sleep ended. */
function sleepNote(tier: "nap" | "hibernate", outcome: string): string {
  if (outcome === "slept") return tier === "nap" ? "Your agent is napping." : "Your agent is hibernating.";
  if (outcome === "aborted" || outcome === "not_idle") return "Your agent is busy right now, so it stayed awake.";
  return "Your agent cannot sleep right now, so it stayed awake.";
}

function Switch({ checked, label, disabled, busy, onToggle }: {
  checked: boolean; label: string; disabled: boolean; busy: boolean; onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-busy={busy || undefined}
      disabled={disabled}
      onClick={onToggle}
      style={{
        flex: "none", width: 38, height: 22, borderRadius: 11, padding: 2, marginTop: 1,
        border: "1px solid " + (checked ? "var(--ink-black)" : "var(--etched-border)"),
        background: checked ? "var(--ink-black)" : "transparent",
        cursor: disabled ? "default" : "pointer", opacity: disabled && !busy ? 0.6 : 1,
      }}
    >
      <span style={{
        display: "block", width: 16, height: 16, borderRadius: 8,
        background: checked ? "var(--bg-surface)" : "var(--text-muted)",
        transform: checked ? "translateX(16px)" : "none", transition: "transform 120ms ease",
      }} />
    </button>
  );
}

/**
 * Manage › Overview: when this agent may sleep. "Sleep when idle" lets it nap
 * while nobody uses it, "Keep awake" stops that, and the test buttons put it to
 * sleep or wake it by hand. Shown only where the sleep screens are switched on,
 * for a running agent.
 */
export function ManageSleepSettings({ agent, onChanged }: { agent: HivraAgent; onChanged: () => void }) {
  const view = agentSleepView(agent);
  const [saved, setSaved] = useState<{ agentId: string; policy: AgentSleepPolicy | null; alwaysOn: boolean } | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Only asked for when its switches are on, and shown only for an agent with a Telegram bot.
  const [telegram, setTelegram] = useState<{ agentId: string; setting: TelegramWakeSetting } | null>(null);
  useEffect(() => {
    if (!telegramWakeUiEnabled()) return;
    let live = true;
    getTelegramWakeSetting(agent.id)
      .then((setting) => { if (live) setTelegram({ agentId: agent.id, setting }); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [agent.id]);
  const telegramSetting = telegram?.agentId === agent.id ? telegram.setting : null;

  // What was just saved shows at once; until then the agent's own row says.
  const own = saved?.agentId === agent.id ? saved : null;
  const policy = own ? own.policy : agent.sleep_policy ?? null;
  const alwaysOn = own ? own.alwaysOn : agent.always_on === true;
  const sleepWhenIdle = policy === "full";
  const asleep = view !== "awake";

  const save = async (which: "policy" | "always_on", patch: { sleep_policy?: "off" | "full"; always_on?: boolean }) => {
    if (busy) return;
    setBusy(which);
    setError(null);
    setNote(null);
    try {
      const result = await saveAgentSleepSettings(agent.id, patch);
      setSaved({ agentId: agent.id, policy: result.sleep_policy, alwaysOn: result.always_on });
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this setting.");
    } finally {
      setBusy(null);
    }
  };

  const saveTelegram = async (enabled: boolean) => {
    if (busy) return;
    setBusy("telegram");
    setError(null);
    setNote(null);
    try {
      const setting = await saveTelegramWakeSetting(agent.id, enabled);
      setTelegram({ agentId: agent.id, setting });
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this setting.");
    } finally {
      setBusy(null);
    }
  };

  const sleepNow = async (tier: "nap" | "hibernate") => {
    if (busy) return;
    setBusy(tier);
    setError(null);
    setNote(null);
    try {
      const result = await sleepAgentNow(agent.id, tier);
      // The owner asked for this sleep: the page must not wake the agent again by itself.
      if (result.outcome === "slept") holdAutoWake(agent.id);
      setNote(sleepNote(tier, result.outcome));
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not put your agent to sleep.");
    } finally {
      setBusy(null);
    }
  };

  const wakeNow = async () => {
    if (busy) return;
    setBusy("wake");
    setError(null);
    setNote(null);
    releaseAutoWake(agent.id);
    const result = await wakeAgent(agent.id);
    if (result.state === "failed") setError(result.message);
    else setNote(result.state === "awake" ? "Your agent is awake." : "Your agent is still waking up.");
    setBusy(null);
    onChanged();
  };

  const idle = busy === null;
  const sleepDisabled = !idle || asleep;
  return (
    <div style={{ display: "grid", gap: 10 }} data-testid="manage-sleep">
      <div className="mono" style={manageLabel}>Sleep</div>
      <div style={manageCard}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <Switch
            checked={sleepWhenIdle && !alwaysOn}
            label="Sleep when idle"
            disabled={!idle || alwaysOn}
            busy={busy === "policy"}
            onToggle={() => void save("policy", { sleep_policy: sleepWhenIdle ? "off" : "full" })}
          />
          <div style={{ display: "grid", gap: 2 }}>
            <div style={{ fontSize: 12.5, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 6 }}>
              Sleep when idle
              {busy === "policy" ? <Loader2 size={12} style={{ ...manageSpin, color: "var(--text-muted)" }} /> : null}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Your agent naps when no one is using it and wakes when you open it.
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, borderTop: "1px solid var(--etched-border)", paddingTop: 12 }}>
          <Switch
            checked={alwaysOn}
            label="Keep awake"
            disabled={!idle}
            busy={busy === "always_on"}
            onToggle={() => void save("always_on", { always_on: !alwaysOn })}
          />
          <div style={{ display: "grid", gap: 2 }}>
            <div style={{ fontSize: 12.5, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 6 }}>
              Keep awake
              {busy === "always_on" ? <Loader2 size={12} style={{ ...manageSpin, color: "var(--text-muted)" }} /> : null}
            </div>
            <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
              Your agent never sleeps, so it answers at once.
            </div>
          </div>
        </div>
        {telegramSetting?.available ? (
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10, borderTop: "1px solid var(--etched-border)", paddingTop: 12 }}>
            <Switch
              checked={telegramSetting.enabled}
              label="Wake on Telegram messages"
              disabled={!idle}
              busy={busy === "telegram"}
              onToggle={() => void saveTelegram(!telegramSetting.enabled)}
            />
            <div style={{ display: "grid", gap: 2 }}>
              <div style={{ fontSize: 12.5, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 6 }}>
                Wake on Telegram messages
                {busy === "telegram" ? <Loader2 size={12} style={{ ...manageSpin, color: "var(--text-muted)" }} /> : null}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
                Your agent can sleep while connected to Telegram, and a new message wakes it in a few seconds.
              </div>
            </div>
          </div>
        ) : null}
        <ManageChannelWake agentId={agent.id} disabled={!idle} onChanged={onChanged} />
        <div style={{ borderTop: "1px solid var(--etched-border)", paddingTop: 12, display: "grid", gap: 8 }}>
          <div style={manageMuted}>For testing: put this agent to sleep now, or wake it.</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" disabled={sleepDisabled} onClick={() => void sleepNow("nap")} style={manageDisabled(manageButtonGhost, sleepDisabled)}>
              {busy === "nap" ? <Loader2 size={14} style={manageSpin} /> : null} Nap now
            </button>
            <button type="button" disabled={sleepDisabled} onClick={() => void sleepNow("hibernate")} style={manageDisabled(manageButtonGhost, sleepDisabled)}>
              {busy === "hibernate" ? <Loader2 size={14} style={manageSpin} /> : null} Hibernate now
            </button>
            <button type="button" disabled={!idle || !asleep} onClick={() => void wakeNow()} style={manageDisabled(manageButtonGhost, !idle || !asleep)}>
              {busy === "wake" ? <Loader2 size={14} style={manageSpin} /> : null} Wake
            </button>
          </div>
        </div>
        {note ? <div role="status" style={{ ...manageMuted, color: "var(--ink-black)" }}>{note}</div> : null}
        {error ? <div role="alert" style={{ ...manageMuted, color: "var(--hg-bad)" }}>{error}</div> : null}
      </div>
    </div>
  );
}
