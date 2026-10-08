"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Loader2, RefreshCw } from "lucide-react";
import { getAgentEvents } from "@/lib/hivra/agent-api";
import type { ComputerHistoryEvent } from "@/lib/hivra/computer-history";
import type { ManageCapabilities } from "@/lib/hivra/manage-sections";
import { useManageSectionVisible } from "../ManageLayout";
import { manageButtonGhost, manageCard, manageLabel, manageMuted, manageValue } from "./manage-styles";

export function formatManageDate(iso?: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  return `${date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} · ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      title={`Copy ${label}`}
      onClick={() => { void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => undefined); }}
      className="mono"
      style={{ ...manageLabel, border: "1px solid var(--etched-border)", background: "transparent", padding: "4px 10px", minHeight: 40, minWidth: 40, cursor: "pointer", color: "var(--text-secondary)", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, flexShrink: 0 }}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}{copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Read-only facts from the server's allowlist, never host names or private addresses. */
export function ManageDetails({ details }: { details: ManageCapabilities["details"] }) {
  if (details.length === 0) return null;
  return (
    <dl style={{ margin: 0, display: "grid", gap: 10, gridTemplateColumns: "minmax(0, 1fr)" }}>
      {details.map((detail) => {
        const value = detail.format === "date" ? formatManageDate(detail.value) : detail.value;
        return (
          <div key={detail.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", minWidth: 0 }}>
            <dt className="mono" style={{ ...manageLabel, flex: "0 0 160px" }}>{detail.label}</dt>
            <dd style={{ ...manageValue, margin: 0, flex: "1 1 160px", minWidth: 0, overflowWrap: "anywhere" }}>{value}</dd>
            {detail.copy ? <CopyButton value={detail.value} label={detail.label} /> : null}
          </div>
        );
      })}
    </dl>
  );
}

/**
 * The computer's last 20 lifecycle events. Loaded the first time Advanced
 * opens, and again with Refresh; never while the section is hidden.
 */
export function ManageHistory({ agentId }: { agentId: string }) {
  const visible = useManageSectionVisible();
  // Opened once the section is first shown; it stays loaded after that.
  const [opened, setOpened] = useState(visible);
  if (visible && !opened) setOpened(true);
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{ version: number; events: ComputerHistoryEvent[] | null; error: string | null } | null>(null);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    if (!opened) return;
    const controller = new AbortController();
    getAgentEvents(agentId, controller.signal)
      .then((next) => setResult({ version, events: next, error: null }))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setResult({ version, events: null, error: cause instanceof Error ? cause.message : "Could not load this computer's history." });
        }
      });
    return () => controller.abort();
  }, [agentId, opened, version]);
  const loading = opened && result?.version !== version;
  const events = result?.events ?? null;
  const error = loading ? null : result?.error ?? null;

  return (
    <div style={{ ...manageCard }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div className="serif" style={{ flex: 1, fontSize: 16, color: "var(--ink-black)" }}>History</div>
        <button type="button" disabled={loading} onClick={refresh} style={{ ...manageButtonGhost, cursor: loading ? "default" : "pointer" }}>
          {loading ? <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={13} />} Refresh
        </button>
      </div>
      {error ? <div role="alert" style={{ ...manageMuted, color: "#e06c5a" }}>{error}</div>
        : events === null ? <div style={manageMuted}>Loading history…</div>
          : events.length === 0 ? <div style={manageMuted}>No history yet.</div>
            : (
              <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
                {events.map((event, index) => (
                  <li key={`${event.createdAt}-${index}`} style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12.5, lineHeight: 1.5 }}>
                    <time dateTime={event.createdAt} className="mono" style={{ ...manageLabel, flex: "0 0 170px", letterSpacing: "0.08em" }}>{formatManageDate(event.createdAt)}</time>
                    <span style={{ color: "var(--ink-black)" }}>{event.label}</span>
                  </li>
                ))}
              </ol>
            )}
      <div style={{ ...manageMuted, fontSize: 11.5 }}>The last 20 changes to this computer. Your chats and files aren&apos;t listed here.</div>
    </div>
  );
}

/** Everything this computer can't do, and why, so nothing disappears silently. */
export function ManageNotAvailable({ items }: { items: ManageCapabilities["notAvailable"] }) {
  if (items.length === 0) return null;
  return (
    <div style={{ ...manageCard }}>
      <div className="serif" style={{ fontSize: 16, color: "var(--ink-black)" }}>Not available on this computer</div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 10 }}>
        {items.map((item) => (
          <li key={item.capability} style={{ display: "grid", gap: 2 }}>
            <span style={{ fontSize: 12.5, color: "var(--ink-black)", fontWeight: 650 }}>{item.capability}</span>
            <span style={manageMuted}>{item.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A size that can't be changed here, and why. */
export function ManageFixedSize({ size, reason }: { size: string; reason: string }) {
  return (
    <div style={{ ...manageCard }} data-testid="manage-fixed-size">
      <div className="serif" style={{ fontSize: 16, fontWeight: 400, color: "var(--ink-black)" }}>Fixed size · {size}</div>
      <div style={manageMuted}>{reason}</div>
    </div>
  );
}
