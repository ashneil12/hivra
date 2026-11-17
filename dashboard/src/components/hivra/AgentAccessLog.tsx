"use client";

import { useEffect, useState } from "react";
import styles from "./AgentModelSettings.module.css";

type Channel = "command" | "files" | "console" | "screen" | "status" | "ssh";

export interface AccessLogView {
  recording: boolean;
  recordingSince: string | null;
  lastCollectedAt: string | null;
  days: number;
  entries: Array<{
    hour: string; firstAt: string; lastAt: string; who: "system" | "staff"; label: string;
    channel: Channel; programs: string[]; count: number;
  }>;
  totals: { staff: number; system: number };
}

const CHANNEL_TEXT: Record<Channel, [string, string]> = {
  command: ["ran a command", "ran commands"],
  files: ["copied files", "copied files"],
  console: ["opened a console", "opened consoles"],
  screen: ["opened the screen", "opened the screen"],
  status: ["checked its status", "checked its status"],
  ssh: ["connected over SSH", "connected over SSH"],
};

function describe(entry: AccessLogView["entries"][number]): string {
  const [one, many] = CHANNEL_TEXT[entry.channel] ?? ["connected", "connected"];
  const what = entry.count === 1 ? one : `${many} ${entry.count} times`;
  const programs = entry.programs.length && entry.channel === "command" ? ` (${entry.programs.join(", ")})` : "";
  return `${what}${programs}`;
}

function when(entry: AccessLogView["entries"][number]): string {
  const first = new Date(entry.firstAt), last = new Date(entry.lastAt);
  const day = last.toLocaleDateString([], { day: "numeric", month: "short" });
  const t = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return entry.count === 1 || t(first) === t(last) ? `${day}, ${t(last)}` : `${day}, ${t(first)} to ${t(last)}`;
}

/** Who connected into this computer, from its server's records. Renders nothing
 * unless the server offers it (NEXT_PUBLIC_HIVRA_ACCESS_LOG on). */
export function AgentAccessLog({ agentId }: { agentId: string }) {
  const [view, setView] = useState<AccessLogView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSystems, setShowSystems] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch(`/api/hivra/agents/${encodeURIComponent(agentId)}/access-log`, {
          cache: "no-store", credentials: "same-origin", redirect: "error", signal: controller.signal,
        });
        if (response.status === 404) return;
        const json = await response.json().catch(() => null);
        if (!response.ok || json?.success !== true) throw new Error(typeof json?.error === "string" ? json.error : "The access log couldn't be loaded.");
        if (!controller.signal.aborted) setView(json.data as AccessLogView);
      } catch (cause) {
        if (!controller.signal.aborted) setError((cause as Error).message);
      }
    })();
    return () => controller.abort();
  }, [agentId]);

  if (!view && !error) return null;

  const staff = view?.entries.filter(e => e.who === "staff") ?? [];
  const systems = view?.entries.filter(e => e.who === "system") ?? [];

  return <div className={styles.current} aria-label="Access log">
    <div style={{ flex: 1 }}>
      <span className={styles.label}>Who connected to this computer</span>
      {view && !view.recording ? <p>This computer&apos;s server isn&apos;t recording connections yet.</p> : null}
      {view?.recording ? <p>
        Last {view.days} days: {staff.length === 0 ? "no one at Hivra connected by hand" : `${view.totals.staff} connection${view.totals.staff === 1 ? "" : "s"} by people at Hivra`}
        {`, ${view.totals.system} by Hivra's automatic systems.`}
      </p> : null}
      <p className={styles.help}>
        Recorded on the server this computer runs on, each time a command, console, screen, SSH session or file copy reaches into it from there.
        It shows who and how, never what was typed, read or written. Automatic connections are how Hivra starts, updates, backs up and checks your computer.
        {view?.recordingSince ? ` Recording since ${new Date(view.recordingSince).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}.` : ""}
      </p>
      {staff.length ? <ul style={{ margin: "8px 0", paddingLeft: 18, display: "grid", gap: 4 }}>
        {staff.map(e => <li key={`${e.hour}-${e.label}-${e.channel}`} style={{ fontSize: 13 }}>
          <strong>{e.label}</strong> {describe(e)}, {when(e)}
        </li>)}
      </ul> : null}
      {systems.length ? <div className={styles.actions}>
        <button type="button" className={styles.quiet} onClick={() => setShowSystems(v => !v)} aria-expanded={showSystems}>
          {showSystems ? "Hide automatic connections" : `Show automatic connections (${systems.length})`}
        </button>
      </div> : null}
      {showSystems ? <ul style={{ margin: "8px 0", paddingLeft: 18, display: "grid", gap: 4 }}>
        {systems.map(e => <li key={`${e.hour}-${e.label}-${e.channel}`} style={{ fontSize: 12.5, color: "var(--text-secondary)" }}>
          {e.label} {describe(e)}, {when(e)}
        </li>)}
      </ul> : null}
      {error ? <p role="alert" className={styles.warning}>{error}</p> : null}
    </div>
  </div>;
}
