"use client";

import { useEffect, useState } from "react";

// The Recovery section's line about off-site copies: shown only with
// NEXT_PUBLIC_HIVRA_COMPUTER_BACKUPS_UI on, and only once copies run for this computer.

type BackupStatus = {
  supported: boolean;
  enabled: boolean;
  lastBackupAt: string | null;
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
  keepDaily: number;
  keepWeekly: number;
};

export function offSiteBackupsUiEnabled(): boolean {
  const value = process.env.NEXT_PUBLIC_HIVRA_COMPUTER_BACKUPS_UI?.trim().toLowerCase();
  return value === "1" || value === "true";
}

function when(iso: string | null): string {
  if (!iso) return "not yet";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "not yet" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function OffSiteBackupCard({ agentId, cardStyle, labelStyle }: {
  agentId: string;
  cardStyle: React.CSSProperties;
  labelStyle: React.CSSProperties;
}) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const shown = offSiteBackupsUiEnabled();

  useEffect(() => {
    if (!shown) return;
    let live = true;
    fetch(`/api/hivra/agents/${encodeURIComponent(agentId)}/backups`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (live) setStatus((body?.data ?? body) as BackupStatus | null); })
      .catch(() => { if (live) setStatus(null); });
    return () => { live = false; };
  }, [agentId, shown]);

  if (!shown || !status?.supported || !status.enabled) return null;
  const weekly = status.keepWeekly > 0 ? ` and ${status.keepWeekly} weekly` : "";
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div className="mono" style={labelStyle}>Off-site copies</div>
      <div style={cardStyle}>
        <div className="serif" style={{ fontSize: 16, fontWeight: 400, color: "var(--ink-black)" }}>Daily encrypted copy</div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
          Once a day, while this computer is awake, Hivra saves an encrypted copy of its disk on separate storage. The last {status.keepDaily} daily{weekly} copies are kept. To bring one back, contact support.
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.6 }}>
          Last copy: {when(status.lastBackupAt)}
          <br />
          Last read back and checked: {status.lastCheckedAt ? `${when(status.lastCheckedAt)}${status.lastCheckOk === false ? " (needs attention; we are on it)" : ""}` : "not yet"}
        </div>
      </div>
    </div>
  );
}
