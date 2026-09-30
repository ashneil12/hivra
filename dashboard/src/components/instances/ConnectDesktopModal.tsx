"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Check, Copy, Loader2, X } from "lucide-react";

import { copyTextToClipboard } from "@/lib/client/clipboard";
import { SafePortal } from "@/components/ui/SafePortal";
import {
  buildDesktopInlineCommand,
  buildDesktopLauncherScript,
  desktopLauncherFilename,
  DESKTOP_DOWNLOAD_URL,
  type DesktopLauncherOS,
} from "@/lib/webui/desktop-launcher";

interface ConnectDesktopModalProps {
  instanceId: string;
  onClose: () => void;
}

interface DesktopConnectionData {
  gatewayUrl: string;
  token: string;
  instanceName: string | null;
  ready?: boolean;
}

const OS_OPTIONS: { id: DesktopLauncherOS; label: string }[] = [
  { id: "macos", label: "macOS" },
  { id: "windows", label: "Windows" },
  { id: "linux", label: "Linux" },
];

function detectOS(): DesktopLauncherOS {
  if (typeof navigator === "undefined") return "macos";
  const p = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (p.includes("win")) return "windows";
  if (p.includes("linux") || p.includes("android")) return "linux";
  return "macos";
}

// Phones and tablets cannot run Hermes Desktop; the modal leads with the
// copyable values there instead of a Terminal command or a file download.
const COARSE_POINTER_QUERY = "(pointer: coarse)";

function subscribeCoarsePointer(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const list = window.matchMedia(COARSE_POINTER_QUERY);
  list.addEventListener?.("change", onChange);
  return () => list.removeEventListener?.("change", onChange);
}

function readCoarsePointer(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(COARSE_POINTER_QUERY).matches;
}

function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribeCoarsePointer, readCoarsePointer, () => false);
}

const kicker: React.CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.16em",
  color: "var(--text-muted)",
  fontWeight: 700,
};

// Touch screens floor the mono labels at 11px.
const kickerTouch: React.CSSProperties = { ...kicker, fontSize: 11 };

const bodyText: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.6,
  color: "var(--text-primary)",
  opacity: 0.85,
};

// A code box that scrolls horizontally WITHIN its bounds (never widens the modal).
const codeBox: React.CSSProperties = {
  display: "block",
  flex: "1 1 0%",
  minWidth: 0,
  overflowX: "auto",
  whiteSpace: "nowrap",
  padding: "11px 12px",
  border: "1px solid var(--etched-border)",
  fontSize: 12,
  color: "var(--text-primary)",
};

function CopyButton({ value, label }: { value: string; label: string }) {
  const coarse = useCoarsePointer();
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    if (await copyTextToClipboard(value)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }
  }, [value]);
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={`Copy ${label}`}
      className="mono"
      style={{
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        minHeight: coarse ? 44 : undefined,
        padding: "9px 11px",
        border: "1px solid var(--etched-border)",
        background: "var(--bg-elevated)",
        color: "var(--text-primary)",
        fontSize: coarse ? 11 : 10,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.12em",
        cursor: "pointer",
        whiteSpace: "nowrap",
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function CopyRow({ value, label }: { value: string; label?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "stretch", gap: 8, minWidth: 0 }}>
      <code className="mono" style={codeBox}>
        {value}
      </code>
      <CopyButton value={value} label={label ?? "value"} />
    </div>
  );
}

function CopyField({
  label,
  value,
  secret = false,
}: {
  label: string;
  value: string;
  secret?: boolean;
}) {
  const coarse = useCoarsePointer();
  const [revealed, setRevealed] = useState(!secret);
  const shown = revealed ? value : "•".repeat(Math.min(value.length, 40));
  return (
    <div style={{ display: "grid", gap: 7, minWidth: 0 }}>
      <span className="mono" style={coarse ? kickerTouch : kicker}>
        {label}
      </span>
      <div style={{ display: "flex", alignItems: "stretch", gap: 8, minWidth: 0 }}>
        <code className="mono" style={codeBox}>
          {shown}
        </code>
        {secret ? (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            className="mono"
            style={{
              flexShrink: 0,
              minHeight: coarse ? 44 : undefined,
              minWidth: coarse ? 44 : undefined,
              padding: "9px 9px",
              border: "1px solid var(--etched-border)",
              background: "transparent",
              color: "var(--text-muted)",
              fontSize: coarse ? 11 : 10,
              fontWeight: 700,
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            {revealed ? "Hide" : "Show"}
          </button>
        ) : null}
        <CopyButton value={value} label={label} />
      </div>
    </div>
  );
}

function NumberedStep({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 11, alignItems: "baseline", minWidth: 0 }}>
      <span
        className="mono"
        style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: "var(--text-muted)", width: 14 }}
      >
        {n}.
      </span>
      <span style={{ fontSize: 12.5, lineHeight: 1.55, color: "var(--text-primary)", minWidth: 0 }}>
        {children}
      </span>
    </div>
  );
}

export function ConnectDesktopModal({ instanceId, onClose }: ConnectDesktopModalProps) {
  const coarse = useCoarsePointer();
  const [os, setOs] = useState<DesktopLauncherOS>("macos");
  const [data, setData] = useState<DesktopConnectionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // A backdrop press closes only when it also started on the backdrop, so a
  // text selection dragged out of a code box does not.
  const backdropPressRef = useRef(false);

  useEffect(() => setOs(detectOS()), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/instances/${instanceId}/desktop-connection`);
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok || !body?.success) {
          setError(body?.error || "Could not load desktop connection details.");
        } else {
          setData(body.data as DesktopConnectionData);
        }
      } catch {
        if (!cancelled) setError("Could not load desktop connection details.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [instanceId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const inlineCommand = useMemo(
    () => (data ? buildDesktopInlineCommand(os, data) : ""),
    [data, os]
  );

  const downloadSetup = useCallback(() => {
    if (!data) return;
    const blob = new Blob([buildDesktopLauncherScript(os, data)], {
      type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = desktopLauncherFilename(os);
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [data, os]);

  const osLabel = OS_OPTIONS.find((o) => o.id === os)?.label;
  const shell = os === "windows" ? "PowerShell" : "Terminal";

  // Option A (quick connect) and Option B (manual). On touch devices the
  // copyable values lead, in DOM order so screen readers match the layout.
  const quickConnect = data ? (
    <div
      key="quick"
      style={{
        display: "grid",
        gap: 11,
        minWidth: 0,
        padding: 16,
        border: "1px solid var(--etched-border)",
        background: "rgba(127,127,127,0.04)",
      }}
    >
      <span className="mono" style={{ ...(coarse ? kickerTouch : kicker), color: "var(--text-primary)" }}>
        Option A · Quick connect
      </span>
      <span style={{ fontSize: 12.5, color: "var(--text-primary)", lineHeight: 1.55 }}>
        Paste this one line into {shell}. Here&apos;s exactly what it does — nothing hidden:
      </span>
      <div style={{ display: "grid", gap: 5 }}>
        {[
          "Saves this instance's address + access key into Hermes' own settings file",
          "Opens the app already connected to your cloud — no install, no system changes",
          "That's the whole script. It stays connected every time you open Hermes after.",
        ].map((line, i) => (
          <div key={i} style={{ display: "flex", gap: 9, alignItems: "baseline" }}>
            <span style={{ flexShrink: 0, color: "var(--text-muted)", fontSize: 12 }}>•</span>
            <span style={{ fontSize: 12, lineHeight: 1.5, color: "var(--text-muted)" }}>{line}</span>
          </div>
        ))}
      </div>
      <CopyRow value={inlineCommand} label="setup command" />
      <span style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        Runs instantly with no security pop-up — it&apos;s plain text you can read in full above.
        A signed one-click app (no Terminal at all) is on the way.
      </span>
      {coarse ? null : (
        <>
          <button
            type="button"
            onClick={downloadSetup}
            className="mono"
            style={{
              justifySelf: "start",
              display: "inline-flex",
              alignItems: "center",
              gap: 7,
              padding: "8px 12px",
              marginTop: 2,
              border: "1px solid var(--etched-border)",
              background: "transparent",
              color: "var(--text-primary)",
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              cursor: "pointer",
            }}
          >
            Or download as a {osLabel} file
          </button>
          {os === "macos" ? (
            <span style={{ fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
              A downloaded file gets a one-time macOS prompt — right-click → Open, or allow it in
              System Settings → Privacy &amp; Security. (The paste command above skips this.)
            </span>
          ) : null}
        </>
      )}
    </div>
  ) : null;
  const manualSetup = data ? (
    <div
      key="manual"
      style={{
        display: "grid",
        gap: 12,
        minWidth: 0,
        padding: 16,
        border: "1px solid var(--etched-border)",
      }}
    >
      <span className="mono" style={{ ...(coarse ? kickerTouch : kicker), color: "var(--text-primary)" }}>
        Option B · Set it up yourself
      </span>
      <span style={{ fontSize: 12.5, color: "var(--text-primary)", lineHeight: 1.55 }}>
        Rather not run a script? This is just as quick — three steps in the app:
      </span>
      <div style={{ display: "grid", gap: 8 }}>
        <NumberedStep n={1}>
          Open Hermes → <strong>Settings → Gateway</strong>, choose <strong>Remote gateway</strong>.
        </NumberedStep>
        <NumberedStep n={2}>Paste the two values below into Remote URL and Session token.</NumberedStep>
        <NumberedStep n={3}>
          Click <strong>Save and reconnect</strong>. Done — it stays connected.
        </NumberedStep>
      </div>
      <CopyField label="Remote URL" value={data.gatewayUrl} />
      <CopyField label="Session token" value={data.token} secret />
      <span style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
        The token is this instance&apos;s credential — keep it private.
      </span>
    </div>
  ) : null;

  return (
    <SafePortal>
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Connect Hermes Desktop"
      onPointerDown={(e) => {
        backdropPressRef.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        const pressedBackdrop = backdropPressRef.current;
        backdropPressRef.current = false;
        if (pressedBackdrop && e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(26,26,26,0.55)",
        backdropFilter: "blur(5px)",
        display: "flex",
        overflowY: "auto",
        zIndex: 9999,
        padding:
          "max(20px, env(safe-area-inset-top, 0px)) max(16px, env(safe-area-inset-right, 0px)) max(20px, env(safe-area-inset-bottom, 0px)) max(16px, env(safe-area-inset-left, 0px))",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(580px, 100%)",
          maxWidth: "100%",
          margin: "auto",
          maxHeight:
            "calc(var(--workspace-viewport-height, 100dvh) - 40px - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))",
          overflowY: "auto",
          overflowX: "hidden",
          background: "var(--bg-elevated)",
          border: "1px solid var(--etched-border)",
          boxShadow: "0 30px 80px rgba(26,26,26,0.25)",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 12,
            padding: "clamp(16px, 5vw, 22px) clamp(16px, 5vw, 24px) 18px",
            borderBottom: "1px solid var(--etched-border)",
          }}
        >
          <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
            <span className="mono" style={coarse ? kickerTouch : kicker}>
              Hivra · Desktop
            </span>
            <h2 className="serif" style={{ fontSize: "1.55rem", fontWeight: 700, lineHeight: 1.1, color: "var(--text-primary)" }}>
              Connect Hermes Desktop
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 44,
              height: 44,
              marginTop: -6,
              marginRight: -6,
              border: "1px solid var(--etched-border)",
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            <X size={15} />
          </button>
        </div>

        <div style={{ padding: "clamp(16px, 5vw, 24px)", minWidth: 0 }}>
          {loading ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--text-muted)", fontSize: 13 }}>
              <Loader2 size={15} className="animate-spin" /> Loading connection details…
            </div>
          ) : error ? (
            <div style={{ padding: "12px 14px", border: "1px solid var(--etched-border)", color: "var(--text-primary)", fontSize: 13 }}>
              {error}
            </div>
          ) : data && data.ready === false ? (
            <div style={{ display: "grid", gap: 16, minWidth: 0 }}>
              <span className="mono" style={coarse ? kickerTouch : kicker}>
                One quick step first
              </span>
              <p style={{ ...bodyText, margin: 0, opacity: 1 }}>
                Desktop access isn&apos;t enabled on this instance yet. It was
                created before the feature shipped — a <strong>one-time redeploy</strong>
                {" "}turns it on (your chats, settings and workspace are untouched).
              </p>
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6, margin: 0 }}>
                Go to <strong>Console → Redeploy</strong>, wait for it to come back, then
                reopen this. New instances have it on automatically.
              </p>
            </div>
          ) : data ? (
            <div style={{ display: "grid", gap: 24, minWidth: 0 }}>
              {coarse ? (
                <p
                  className="mono"
                  style={{
                    margin: 0,
                    padding: "12px 14px",
                    border: "1px solid var(--etched-border)",
                    borderLeft: "2px solid var(--hivra-red)",
                    fontSize: 11,
                    lineHeight: 1.6,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: "var(--text-primary)",
                  }}
                >
                  Hermes Desktop runs on your computer — open this page there, or copy the values below.
                </p>
              ) : null}
              <p style={{ ...bodyText, margin: 0 }}>
                Run the native Hermes Desktop app on this instance — your sessions,
                agents and cron in a real desktop window. No local install, no
                Tailscale, no port-forwarding.
              </p>

              {/* Step 1 */}
              <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
                <span className="mono" style={coarse ? kickerTouch : kicker}>
                  Step 1 · Install the app
                </span>
                <a
                  href={DESKTOP_DOWNLOAD_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="mono"
                  style={{
                    justifySelf: "start",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    minHeight: coarse ? 44 : undefined,
                    padding: "10px 14px",
                    border: "1px solid var(--etched-border)",
                    color: "var(--text-primary)",
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.1em",
                    textDecoration: "none",
                  }}
                >
                  Get Hermes Desktop ↗
                </a>
                <span style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.55 }}>
                  Install it once from Nous Research (macOS, Windows, Linux).
                </span>
              </div>

              {/* Step 2 */}
              <div style={{ display: "grid", gap: 14, minWidth: 0, paddingTop: 20, borderTop: "1px solid var(--etched-border)" }}>
                <span className="mono" style={coarse ? kickerTouch : kicker}>
                  Step 2 · Connect — pick your OS
                </span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {OS_OPTIONS.map((opt) => {
                    const active = os === opt.id;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setOs(opt.id)}
                        className="mono"
                        style={{
                          minHeight: coarse ? 44 : undefined,
                          padding: "7px 14px",
                          border: "1px solid var(--etched-border)",
                          background: active ? "var(--ink-black)" : "transparent",
                          color: active ? "var(--bg-elevated)" : "var(--text-primary)",
                          fontSize: 11,
                          fontWeight: 700,
                          textTransform: "uppercase",
                          letterSpacing: "0.08em",
                          cursor: "pointer",
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>

                <div style={{ display: "grid", gap: 14, minWidth: 0 }}>
                  {coarse ? [manualSetup, quickConnect] : [quickConnect, manualSetup]}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
    </SafePortal>
  );
}
