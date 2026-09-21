"use client";

// Connect-your-account step, in the Command Center vocabulary (serif header,
// mono buttons, theme-aware tokens). Drives the box's own native login. Host
// administrators retain infrastructure access; this is not a zero-access claim.
// Alternative providers use a separate live configuration check for Chat.
//
// Two per-agent flows:
//   • Claude  → `claude auth login` (OAuth URL, paste the code back).
//   • Codex   → `codex login --device-auth` (URL + one-time code entered AT the
//               site; the box polls OpenAI itself, so we just wait for status).

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, Check } from "lucide-react";

import { boxLoginStartRaw, boxLoginComplete, boxLoginStatus } from "@/lib/hivra/agent-api";

const primaryBtn: React.CSSProperties = {
  border: "1px solid var(--ink-black)",
  background: "var(--ink-black)",
  color: "var(--bg-surface)",
  fontFamily: "var(--font-mono), monospace",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  fontWeight: 800,
  padding: "11px 18px",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  textDecoration: "none",
};

// One numbered step in the guide.
function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
      <span className="mono" style={{ flexShrink: 0, width: 22, height: 22, borderRadius: "50%", border: "1px solid var(--etched-border)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "var(--text-secondary)" }}>{n}</span>
      <span style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.5, paddingTop: 2 }}>{children}</span>
    </div>
  );
}

export function HivraLogin({
  boxUrl,
  onDone,
  agentKind = "claude",
  productName,
  displayName,
  emoji,
  token,
}: {
  boxUrl: string;
  onDone: () => void;
  agentKind?: "claude" | "codex" | "operatoros";
  /** Catalog product name, for the "runs the official X" copy (e.g. "Claude Code"). */
  productName?: string;
  /** The agent's own identity name (e.g. "Atlas"). */
  displayName?: string;
  /** The agent's signature emoji. */
  emoji?: string | null;
  /** Per-box bearer token — the box's login endpoints are token-gated. */
  token?: string | null;
}) {
  const isCodex = agentKind === "codex";
  const product = productName || (isCodex ? "Codex" : "Claude Code");
  const accountLabel = isCodex ? "ChatGPT account" : "Claude account";
  const signInWith = isCodex ? "ChatGPT" : "Claude";
  const who = (displayName || "").trim() || product;

  const [step, setStep] = useState<"idle" | "awaiting" | "done">("idle");
  const [url, setUrl] = useState("");
  const [deviceCode, setDeviceCode] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  // Codex device-auth: once awaiting, poll the box until login completes.
  useEffect(() => {
    if (!isCodex || step !== "awaiting") return;
    let stop = false;
    (async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, 3000));
        if (stop) return;
        const st = await boxLoginStatus(boxUrl, token);
        if (st.loggedIn) {
          if (!stop) {
            setStep("done");
            onDoneRef.current();
          }
          return;
        }
      }
    })();
    return () => {
      stop = true;
    };
  }, [isCodex, step, boxUrl, token]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const s = await boxLoginStartRaw(boxUrl, token);
      setUrl(s.url);
      if (s.code) setDeviceCode(s.code);
      setStep("awaiting");
      try {
        window.open(s.url, "_blank", "noopener,noreferrer");
      } catch {
        /* popup blocked — link shown below */
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function complete() {
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await boxLoginComplete(boxUrl, code.trim(), token);
      setStep("done");
      onDoneRef.current();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 540, margin: "0 auto", padding: "clamp(2rem, 7vw, 3.5rem) 20px" }}>
      {/* Identity — who's about to come online */}
      <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 52, height: 52, border: "1px solid var(--gold-leaf)", fontSize: 24, marginBottom: 18 }}>
        {emoji ? <span aria-hidden>{emoji}</span> : <span className="serif" style={{ color: "var(--gold-leaf)", fontSize: 22 }}>{who.charAt(0).toUpperCase()}</span>}
      </div>
      <h2 className="serif" style={{ fontSize: "clamp(1.7rem, 5vw, 2.3rem)", fontWeight: 400, color: "var(--ink-black)", margin: "0 0 10px", lineHeight: 1.12 }}>
        {who} is almost ready.
      </h2>
      <p style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.65, margin: "0 0 26px", maxWidth: 470 }}>
        It runs the official {product} on <strong style={{ color: "var(--ink-black)" }}>your own {accountLabel}</strong>.
        Connect once — the session is stored on this computer. Administrators of its host may have infrastructure access.
      </p>

      {error ? (
        <div style={{ border: "1px solid #c0392b", background: "rgba(192,57,43,0.08)", color: "#e06c5a", fontSize: 13, padding: "10px 14px", marginBottom: 18 }}>{error}</div>
      ) : null}

      {step === "idle" ? (
        <>
          <div style={{ display: "grid", gap: 12, marginBottom: 26 }}>
            <Step n={1}>Click below — a {signInWith} sign-in tab opens.</Step>
            <Step n={2}>Authorize it with your {accountLabel}.</Step>
            <Step n={3}>
              {isCodex ? "Enter the one-time code we show you on the sign-in page — we detect it automatically." : "Copy the code it gives you and paste it back here."}
            </Step>
          </div>
          <button type="button" onClick={() => void start()} disabled={busy} style={{ ...primaryBtn, cursor: busy ? "default" : "pointer" }}>
            {busy ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : <ExternalLink size={15} />}
            Sign in with {signInWith}
          </button>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "18px 0 0", lineHeight: 1.55 }}>
            Once connected, {who} introduces itself and gets straight to work.
          </p>
        </>
      ) : isCodex ? (
        <div style={{ display: "grid", gap: 16 }}>
          <div style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            A {signInWith} sign-in tab opened. Sign in, then enter this one-time code on the page. (No tab?{" "}
            <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--gold-leaf)" }}>open it manually</a>.)
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.035)", padding: "18px" }}>
            <span className="mono" style={{ fontSize: 28, fontWeight: 700, letterSpacing: "0.24em", color: "var(--ink-black)" }}>{deviceCode || "—"}</span>
          </div>
          <a href={url} target="_blank" rel="noopener noreferrer" style={{ ...primaryBtn, justifyContent: "center" }}>
            <ExternalLink size={15} /> Open the sign-in page
          </a>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--text-muted)" }}>
            <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> Waiting for you to authorize…
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          <div style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            A {signInWith} sign-in tab opened. Authorize it, copy the code it gives you, and paste it here. (No tab?{" "}
            <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--gold-leaf)" }}>open it manually</a>.)
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void complete();
              }}
              autoFocus
              placeholder="Paste the authorization code"
              style={{ flex: 1, padding: "11px 12px", border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.04)", color: "var(--ink-black)", fontSize: 13, fontFamily: "var(--font-mono), monospace", outline: "none" }}
            />
            <button type="button" onClick={() => void complete()} disabled={busy || !code.trim()} style={{ ...primaryBtn, padding: "0 16px", opacity: busy || !code.trim() ? 0.5 : 1, cursor: busy || !code.trim() ? "default" : "pointer" }}>
              {busy ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Check size={14} />} Connect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
