"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ExternalLink,
  Loader2,
  ShieldCheck,
  UploadCloud,
  X,
} from "lucide-react";

import { SafePortal } from "@/components/ui/SafePortal";

// The recommended export tool: open-source, runs entirely on-device (no upload),
// one click per site. Exactly what you want for live login cookies.
const EXT_CHROME =
  "https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc";
const EXT_FIREFOX =
  "https://addons.mozilla.org/firefox/addon/get-cookies-txt-locally/";

interface CookieImportModalProps {
  /** Hermes: builds the dashboard proxy URL `/api/instances/{id}/browser-sidecar/cookies/import`. */
  instanceId?: string;
  /** Override the POST target (Hivra passes the box tunnel `…/api/cookies/import`). */
  endpoint?: string;
  /** Bearer token for a direct cross-origin box call (Hivra). */
  authToken?: string | null;
  onClose: () => void;
  /** Open the live browser so the user can verify the import landed. */
  onOpenBrowser?: () => void;
}

interface Preview {
  count: number;
  format: string;
  domains: string[];
}

const kicker: React.CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.16em",
  color: "var(--text-muted)",
  fontWeight: 700,
};
const body: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.6,
  color: "var(--text-primary)",
  opacity: 0.85,
};
const primaryBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  padding: "10px 16px",
  border: "1px solid var(--ink-black)",
  background: "var(--ink-black)",
  color: "var(--bg-elevated)",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  cursor: "pointer",
};

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
      <span
        className="mono"
        style={{
          flexShrink: 0,
          width: 20,
          height: 20,
          borderRadius: 999,
          border: "1px solid var(--etched-border)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 11,
          fontWeight: 700,
          color: "var(--text-primary)",
        }}
      >
        {n}
      </span>
      <div style={{ ...body, opacity: 1 }}>{children}</div>
    </div>
  );
}

export function CookieImportModal({ instanceId, endpoint, authToken, onClose, onOpenBrowser }: CookieImportModalProps) {
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileText, setFileText] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ imported: number; skipped: number; domains: string[] } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const apiUrl = endpoint ?? `/api/instances/${instanceId}/browser-sidecar/cookies/import`;

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setPreview(null);
      setDone(null);
      if (file.size > 8 * 1024 * 1024) {
        setError("That file is too large (max 8 MB).");
        return;
      }
      let text = "";
      try {
        text = await file.text();
      } catch {
        setError("Couldn't read that file.");
        return;
      }
      setFileName(file.name);
      setFileText(text);
      setBusy(true);
      try {
        const res = await fetch(apiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
          body: JSON.stringify({ file: text, dryRun: true }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || json?.ok === false) {
          setError(json?.error || "We couldn't read that cookie file — try re-exporting it.");
          return;
        }
        setPreview({ count: json.count ?? 0, format: json.format ?? "", domains: json.domains ?? [] });
      } catch {
        setError("Couldn't reach your agent. Make sure it's running and try again.");
      } finally {
        setBusy(false);
      }
    },
    [apiUrl, authToken],
  );

  const handleImport = useCallback(async () => {
    if (!fileText) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}) },
        body: JSON.stringify({ file: fileText, dryRun: false }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.ok === false) {
        setError(json?.error || "Import failed. Try again.");
        return;
      }
      setDone({ imported: json.imported ?? 0, skipped: json.skipped ?? 0, domains: json.domains ?? [] });
    } catch {
      setError("Couldn't reach your agent. Try again.");
    } finally {
      setBusy(false);
    }
  }, [apiUrl, fileText, authToken]);

  return (
    <SafePortal>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Import cookies"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(26,26,26,0.55)",
          backdropFilter: "blur(5px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9999,
          padding: 20,
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            width: "min(560px, 100%)",
            maxHeight: "calc(100dvh - 40px)",
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
              padding: "22px 24px 18px",
              borderBottom: "1px solid var(--etched-border)",
            }}
          >
            <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
              <span className="mono" style={kicker}>
                Live browser
              </span>
              <h2
                className="serif"
                style={{ fontSize: "1.5rem", fontWeight: 700, lineHeight: 1.1, color: "var(--text-primary)" }}
              >
                Log in with your accounts
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
                width: 30,
                height: 30,
                border: "1px solid var(--etched-border)",
                background: "transparent",
                color: "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              <X size={15} />
            </button>
          </div>

          <div style={{ padding: 24, display: "grid", gap: 18, minWidth: 0 }}>
            {done ? (
              /* ---- Success ---- */
              <div style={{ display: "grid", gap: 16 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <CheckCircle2 size={20} style={{ color: "var(--accent-positive, #2e7d32)", flexShrink: 0 }} />
                  <div style={{ ...body, opacity: 1 }}>
                    Imported <strong>{done.imported}</strong> cookie{done.imported === 1 ? "" : "s"} across{" "}
                    <strong>{done.domains.length}</strong> site{done.domains.length === 1 ? "" : "s"}
                    {done.skipped > 0 ? ` (${done.skipped} skipped — the browser wouldn't accept them)` : ""}. Your
                    agent is now signed in — open the live browser to check.
                  </div>
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  {onOpenBrowser && (
                    <button type="button" onClick={onOpenBrowser} style={primaryBtn}>
                      Open the live browser
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setDone(null);
                      setPreview(null);
                      setFileName(null);
                      setFileText("");
                    }}
                    style={{
                      ...primaryBtn,
                      background: "var(--bg-elevated)",
                      color: "var(--text-primary)",
                      border: "1px solid var(--etched-border)",
                    }}
                  >
                    Import another site
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p style={body}>
                  Your agent has its own browser in the cloud. Drop in the cookies from a site you&apos;re already
                  logged into, and the agent can use that account — no passwords to share.
                </p>

                {/* Guided steps */}
                <div style={{ display: "grid", gap: 12 }}>
                  <Step n={1}>
                    Install the free, open-source extension{" "}
                    <a
                      href={EXT_CHROME}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: "var(--text-primary)", fontWeight: 700, textDecoration: "underline", whiteSpace: "nowrap" }}
                    >
                      Get cookies.txt LOCALLY <ExternalLink size={11} style={{ display: "inline", verticalAlign: "-1px" }} />
                    </a>{" "}
                    (
                    <a href={EXT_FIREFOX} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-muted)", textDecoration: "underline" }}>
                      Firefox
                    </a>
                    ). It runs only on your machine — nothing is uploaded.
                  </Step>
                  <Step n={2}>Open the site you&apos;re logged into (e.g. mail.google.com) in a tab.</Step>
                  <Step n={3}>
                    Click the extension icon → <strong>Export</strong>. It saves a small <code className="mono">cookies.txt</code>.
                  </Step>
                  <Step n={4}>Drop that file below.</Step>
                </div>

                {/* Drop zone */}
                <label
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) void handleFile(f);
                  }}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 8,
                    padding: "26px 18px",
                    border: `1.5px dashed ${dragOver ? "var(--ink-black)" : "var(--etched-border)"}`,
                    background: dragOver ? "var(--bg-surface, rgba(0,0,0,0.03))" : "transparent",
                    cursor: "pointer",
                    textAlign: "center",
                  }}
                >
                  <input
                    ref={inputRef}
                    type="file"
                    accept=".txt,.json,text/plain,application/json"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void handleFile(f);
                    }}
                  />
                  {busy ? (
                    <Loader2 size={20} className="animate-spin" style={{ color: "var(--text-muted)" }} />
                  ) : (
                    <UploadCloud size={22} style={{ color: "var(--text-muted)" }} />
                  )}
                  <span style={{ ...body, opacity: 1, fontWeight: 600 }}>
                    {fileName ? fileName : "Drop your cookies.txt here, or click to choose"}
                  </span>
                  <span className="mono" style={{ fontSize: 10, color: "var(--text-muted)" }}>
                    cookies.txt (Netscape) · Cookie-Editor JSON · storageState
                  </span>
                </label>

                {/* Preview + import */}
                {preview && !error && (
                  <div
                    style={{
                      display: "grid",
                      gap: 12,
                      padding: "14px 16px",
                      border: "1px solid var(--etched-border)",
                      background: "var(--bg-surface, rgba(0,0,0,0.02))",
                    }}
                  >
                    <div style={{ ...body, opacity: 1 }}>
                      Found <strong>{preview.count}</strong> cookie{preview.count === 1 ? "" : "s"} across{" "}
                      <strong>{preview.domains.length}</strong> site{preview.domains.length === 1 ? "" : "s"}.
                    </div>
                    <button type="button" onClick={handleImport} disabled={busy} style={{ ...primaryBtn, opacity: busy ? 0.6 : 1 }}>
                      {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                      Import &amp; sign in
                    </button>
                  </div>
                )}

                {error && (
                  <div style={{ display: "flex", gap: 8, alignItems: "flex-start", color: "var(--accent-negative, #b3261e)", fontSize: 13 }}>
                    <AlertCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
                    <span>{error}</span>
                  </div>
                )}

                {/* Privacy note */}
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "flex-start",
                    paddingTop: 4,
                    borderTop: "1px solid var(--etched-border)",
                    color: "var(--text-muted)",
                    fontSize: 11.5,
                    lineHeight: 1.5,
                  }}
                >
                  <ShieldCheck size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>
                    These are your live logins. The file is read on your own agent&apos;s box, loaded straight into its
                    browser, and never shown to the AI model. Only import accounts you want your agent to use.
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </SafePortal>
  );
}
