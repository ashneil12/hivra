"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { agentSleepUiEnabled } from "@/lib/hivra/agent-sleep-ui";
import { manageMuted, manageSpin } from "./manage-styles";

/**
 * The "Wake on Matrix messages" switch, under Manage › Overview's sleep card.
 * Dark unless the sleep screens and NEXT_PUBLIC_HIVRA_CHANNEL_WAKE=1 are both
 * on: with either off it renders nothing and makes no request. Shown only when
 * the server says the switch applies to this agent.
 */

export interface ChannelWakeSetting {
  available: boolean;
  enabled: boolean;
}

/** Written out in full so the build can inline it. */
export function channelWakeUiEnabled(): boolean {
  return agentSleepUiEnabled() && process.env.NEXT_PUBLIC_HIVRA_CHANNEL_WAKE === "1";
}

function settingOf(data: unknown): ChannelWakeSetting {
  const d = data && typeof data === "object" ? data as Record<string, unknown> : {};
  return { available: d.available === true, enabled: d.enabled === true };
}

async function readJson(r: Response): Promise<Record<string, unknown> | null> {
  try {
    const j = await r.json();
    return j && typeof j === "object" ? j as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function urlOf(agentId: string): string {
  return `/api/hivra/agents/${encodeURIComponent(agentId)}/channel-wake/matrix`;
}

export function ManageChannelWake({ agentId, disabled, onChanged }: { agentId: string; disabled: boolean; onChanged?: () => void }) {
  const [state, setState] = useState<{ agentId: string; setting: ChannelWakeSetting } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!channelWakeUiEnabled()) return;
    let live = true;
    fetch(urlOf(agentId), { cache: "no-store" })
      .then(async (r) => {
        const j = await readJson(r);
        if (live && r.ok && j?.success === true) setState({ agentId, setting: settingOf(j.data) });
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, [agentId]);

  const setting = state?.agentId === agentId ? state.setting : null;
  if (!setting?.available) return null;

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(urlOf(agentId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !setting.enabled }),
      });
      const j = await readJson(r);
      if (!r.ok || j?.success !== true) {
        throw new Error(typeof j?.error === "string" && j.error ? j.error : "Could not save this setting.");
      }
      setState({ agentId, setting: settingOf(j.data) });
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this setting.");
    } finally {
      setBusy(false);
    }
  };

  const checked = setting.enabled;
  return (
    <div style={{ display: "grid", gap: 6, borderTop: "1px solid var(--etched-border)", paddingTop: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label="Wake on Matrix messages"
          aria-busy={busy || undefined}
          disabled={disabled || busy}
          onClick={() => void toggle()}
          style={{
            flex: "none", width: 38, height: 22, borderRadius: 11, padding: 2, marginTop: 1,
            border: "1px solid " + (checked ? "var(--ink-black)" : "var(--etched-border)"),
            background: checked ? "var(--ink-black)" : "transparent",
            cursor: disabled || busy ? "default" : "pointer", opacity: disabled && !busy ? 0.6 : 1,
          }}
        >
          <span style={{
            display: "block", width: 16, height: 16, borderRadius: 8,
            background: checked ? "var(--bg-surface)" : "var(--text-muted)",
            transform: checked ? "translateX(16px)" : "none", transition: "transform 120ms ease",
          }} />
        </button>
        <div style={{ display: "grid", gap: 2 }}>
          <div style={{ fontSize: 12.5, color: "var(--text-primary)", display: "flex", alignItems: "center", gap: 6 }}>
            Wake on Matrix messages
            {busy ? <Loader2 size={12} style={{ ...manageSpin, color: "var(--text-muted)" }} /> : null}
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
            Your agent can sleep while connected to Matrix. A direct message or a mention wakes it in a few seconds.
            In group rooms it wakes only when mentioned, except encrypted group rooms, where every message wakes it
            (at most 6 times an hour; later wakes wait their turn).
          </div>
        </div>
      </div>
      {error ? <div role="alert" style={{ ...manageMuted, color: "var(--hg-bad)" }}>{error}</div> : null}
    </div>
  );
}
