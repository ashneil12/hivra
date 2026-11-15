"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, FileUp, Loader2, Sparkles, Upload } from "lucide-react";
import { boxImportPush, boxImportStatus, boxImportToken, type BoxImportStatus } from "@/lib/hivra/agent-api";
import { buildImportPrompt, importGuideFor } from "@/lib/hivra/agent-import";
import { capAvailable, capReason, type ManageCap } from "@/lib/hivra/manage-sections";
import { useManageSectionVisible } from "../ManageLayout";
import { CopyButton } from "./ManageAdvancedParts";
import { manageButtonGhost, manageDisabled, manageError, manageLabel, manageMuted, manageSpin } from "./manage-styles";

const BUSY_STATES = new Set(["unpacking", "restoring", "restarting"]);
const PHASE_LABEL: Record<string, string> = {
  unpacking: "Unpacking the bundle",
  restoring: "Restoring the agent's data",
  restarting: "Restarting the agent",
};

/**
 * Advanced's "Move an agent from your device" card, next to Export data.
 * The owner either pastes a generated prompt into the agent on their machine
 * (it packs its own state and pushes it straight to the box), or drops a
 * .tar.gz bundle here. The box does the restore; this card just tracks it.
 */
export function HivraImportPanel({
  cap,
  boxUrl,
  token,
  agentType,
  agentName,
}: {
  cap: ManageCap;
  boxUrl: string;
  token: string | null;
  agentType: string;
  agentName: string;
}) {
  const visible = useManageSectionVisible();
  const guide = importGuideFor(agentType);
  const [probe, setProbe] = useState<"pending" | "ready" | "missing">("pending");
  const [status, setStatus] = useState<BoxImportStatus | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const next = await boxImportStatus(boxUrl, token);
    setProbe(next ? "ready" : "missing");
    if (next) setStatus(next);
  }, [boxUrl, token]);

  useEffect(() => { if (visible) void refresh(); }, [visible, refresh]);

  // Track a running restore; stop polling once the box reports done or error.
  useEffect(() => {
    if (!visible || !status || !BUSY_STATES.has(status.state)) return;
    const timer = window.setInterval(() => void refresh(), 2500);
    return () => window.clearInterval(timer);
  }, [visible, status, refresh]);

  const makePrompt = useCallback(async () => {
    setBusy(true);
    setPushError(null);
    try {
      const minted = await boxImportToken(boxUrl, token);
      setPrompt(buildImportPrompt({ agentType, boxUrl, token: minted.token, expiresAt: minted.expiresAt }));
    } catch (e) {
      setPushError((e as Error).message || "Could not mint a transfer token");
    } finally {
      setBusy(false);
    }
  }, [boxUrl, token, agentType]);

  const pushFile = useCallback(async (file: File) => {
    setBusy(true);
    setPushError(null);
    try {
      const result = await boxImportPush(boxUrl, file, token);
      if (!result.ok) { setPushError(result.error || "Upload failed"); return; }
      await refresh();
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [boxUrl, token, refresh]);

  const running = status != null && BUSY_STATES.has(status.state);
  const usable = capAvailable(cap) && probe === "ready";

  return (
    <div style={{ border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.035)", padding: 18, display: "grid", gap: 14, boxSizing: "border-box", minWidth: 0 }} data-testid="manage-agent-import">
      <div className="serif" style={{ fontSize: 16, color: "var(--ink-black)" }}>Move an agent from your device</div>
      <div style={manageMuted}>
        Already running {agentName} on your own machine? It can pack up its memory, settings and logins
        and send them straight to this box — nothing passes through Hivra&apos;s servers.
      </div>

      {guide ? (
        <div style={{ display: "grid", gap: 6 }}>
          <div className="mono" style={manageLabel}>Comes across</div>
          <ul style={{ ...manageMuted, margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
            {guide.transfers.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <div className="mono" style={{ ...manageLabel, marginTop: 4 }}>Stays behind</div>
          <ul style={{ ...manageMuted, margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
            {guide.misses.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      ) : null}

      {!capAvailable(cap) ? <div style={manageMuted}>{capReason(cap)}</div> : null}
      {capAvailable(cap) && probe === "missing" ? (
        <div style={manageMuted}>This box can&apos;t receive a transfer yet — update its runtime in Updates, then come back.</div>
      ) : null}

      {usable ? (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" onClick={() => void makePrompt()} disabled={busy || running}
              style={{ ...manageButtonGhost, ...manageDisabled(manageButtonGhost, busy || running) }}>
              {busy && !prompt ? <Loader2 size={13} style={manageSpin} /> : <Sparkles size={13} />}
              {prompt ? "New transfer prompt" : "Get the transfer prompt"}
            </button>
            <button type="button" onClick={() => fileRef.current?.click()} disabled={busy || running}
              style={{ ...manageButtonGhost, ...manageDisabled(manageButtonGhost, busy || running) }}>
              <Upload size={13} /> Upload a bundle
            </button>
            <input ref={fileRef} type="file" accept=".tar.gz,.tgz,application/gzip" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void pushFile(f); }} />
          </div>

          {prompt ? (
            <div style={{ display: "grid", gap: 8 }}>
              <div className="mono" style={manageLabel}>Paste this into the agent on your device</div>
              <div style={manageMuted}>It packs its own data and sends it here. The link inside works once.</div>
              <div style={{ position: "relative" }}>
                <pre className="mono" style={{
                  margin: 0, padding: "12px 52px 12px 12px", fontSize: 11, lineHeight: 1.55, whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere", border: "1px solid var(--etched-border)", background: "rgba(0,0,0,0.22)",
                  color: "var(--text-secondary)", maxHeight: 220, overflowY: "auto",
                }}>{prompt}</pre>
                <span style={{ position: "absolute", top: 6, right: 6 }}><CopyButton value={prompt} label="transfer prompt" /></span>
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      {running ? (
        <div style={{ ...manageMuted, display: "flex", alignItems: "center", gap: 8 }}>
          <Loader2 size={13} style={manageSpin} />
          {PHASE_LABEL[status.state] ?? status.detail ?? "Working"}…
        </div>
      ) : null}

      {status?.state === "done" ? (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ ...manageMuted, color: "var(--ink-black)", display: "flex", alignItems: "center", gap: 8 }}>
            <Check size={13} /> Restored {(status.files ?? 0).toLocaleString()} files
            {status.restored?.length ? <> into {status.restored.join(", ")}</> : null}.
          </div>
          {status.skipped?.length ? (
            <div style={manageMuted}>Skipped: {status.skipped.slice(0, 8).join(", ")}{status.skipped.length > 8 ? `, +${status.skipped.length - 8} more` : ""}</div>
          ) : null}
          <div style={manageMuted}>Open the agent and continue — its memory and settings are already here.</div>
        </div>
      ) : null}

      {status?.state === "error" ? <div style={manageError}>{status.error || "The restore failed."}</div> : null}
      {pushError ? <div style={manageError}>{pushError}</div> : null}

      <div style={{ ...manageMuted, display: "flex", alignItems: "center", gap: 8 }}>
        <FileUp size={13} style={{ flexShrink: 0 }} />
        Your existing agent keeps running on your device — nothing is deleted there.
      </div>
    </div>
  );
}
