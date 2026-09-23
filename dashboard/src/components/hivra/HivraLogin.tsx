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
import { ExternalLink, Loader2, Check, Copy } from "lucide-react";

import { boxLoginStartRaw, boxLoginComplete, boxLoginStatus } from "@/lib/hivra/agent-api";

// Classes rather than inline styles so the narrow-pane rules below can win.
// Phones tighten the rhythm so the only action clears the fold at 375x667
// with the bottom bar present; desktop keeps the original spacing.
const LOGIN_CSS = `
.hivra-login { max-width: 540px; margin: 0 auto; padding: clamp(2rem, 7vw, 3.5rem) 20px; }
.hivra-login__avatar { display: inline-flex; align-items: center; justify-content: center; width: 52px; height: 52px; border: 1px solid var(--gold-leaf); font-size: 24px; margin-bottom: 18px; }
.hivra-login__title { font-size: clamp(1.7rem, 5vw, 2.3rem); font-weight: 400; color: var(--ink-black); margin: 0 0 10px; line-height: 1.12; overflow-wrap: anywhere; }
.hivra-login__lede { font-size: 14px; color: var(--text-secondary); line-height: 1.65; margin: 0 0 26px; max-width: 470px; }
.hivra-login__steps { display: grid; gap: 12px; margin-bottom: 26px; }
.hivra-login__primary { border: 1px solid var(--ink-black); background: var(--ink-black); color: var(--bg-surface); font-family: var(--font-mono), monospace; font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 800; padding: 11px 18px; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px; text-decoration: none; }
.hivra-login__primary:disabled { cursor: default; opacity: 0.5; }
.hivra-login__secondary { border: 1px solid var(--etched-border); background: transparent; color: var(--ink-black); font-family: var(--font-mono), monospace; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; padding: 0 14px; min-height: 44px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
.hivra-login__primary:focus-visible, .hivra-login__secondary:focus-visible { outline: 2px solid var(--hivra-red); outline-offset: 2px; }
.hivra-login__device { display: flex; flex-wrap: wrap; gap: 8px; }
.hivra-login__device-box { flex: 1 1 200px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--etched-border); background: rgba(255,255,255,0.035); padding: 18px; }
.hivra-login__device-code { font-size: 28px; font-weight: 700; letter-spacing: 0.24em; color: var(--ink-black); user-select: all; white-space: nowrap; }
.hivra-login__code { font-size: 13px; }
/* One column that may shrink below its content, so the code row cannot widen
   the pane at 360px. */
.hivra-login__await { display: grid; grid-template-columns: minmax(0, 1fr); }
@media (max-width: 767px), (pointer: coarse) {
  .hivra-login__primary, .hivra-login__code { min-height: 44px; box-sizing: border-box; }
}
@media (max-width: 767px) {
  .hivra-login { padding: 16px 16px 24px; }
  .hivra-login__avatar { width: 40px; height: 40px; font-size: 20px; margin-bottom: 12px; }
  .hivra-login__title { font-size: 1.5rem; margin-bottom: 8px; }
  .hivra-login__lede { font-size: 13.5px; line-height: 1.55; margin-bottom: 16px; }
  .hivra-login__steps { gap: 8px; margin-bottom: 16px; }
  .hivra-login__primary { font-size: 12px; }
  .hivra-login__cta { width: 100%; min-height: 48px; }
  .hivra-login__code { font-size: 16px; }
}
/* The one-time code is typed by hand elsewhere, so it keeps the full width
   and one line; the copy button goes underneath. */
@media (max-width: 480px) {
  .hivra-login__device-box { flex-basis: 100%; padding: 14px 12px; }
  .hivra-login__device-code { letter-spacing: 0.16em; }
  .hivra-login__device .hivra-login__secondary { flex: 1 1 100%; }
}
`;

/** Touch devices raise a keyboard on focus; let the person choose when. */
function coarsePointer(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

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
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const codeInputRef = useRef<HTMLInputElement>(null);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    if (step === "awaiting" && !isCodex && !coarsePointer()) codeInputRef.current?.focus();
  }, [step, isCodex]);

  useEffect(() => {
    if (copied === "idle") return;
    const timer = window.setTimeout(() => setCopied("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

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
      // Runs after an await, outside the tap's user gesture, so mobile Safari
      // may block it. The "Open sign-in page" button below is always shown.
      try {
        window.open(s.url, "_blank", "noopener,noreferrer");
      } catch {
        /* popup blocked — the button below opens it */
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function copyDeviceCode() {
    try {
      await navigator.clipboard.writeText(deviceCode);
      setCopied("copied");
    } catch {
      setCopied("failed");
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

  const openSignIn = (
    <a href={url} target="_blank" rel="noopener noreferrer" className="hivra-login__primary hivra-login__cta">
      <ExternalLink size={15} /> Open sign-in page
    </a>
  );

  return (
    <div className="hivra-login">
      <style>{LOGIN_CSS}</style>
      {/* Identity — who's about to come online */}
      <div className="hivra-login__avatar">
        {emoji ? <span aria-hidden>{emoji}</span> : <span className="serif" style={{ color: "var(--gold-leaf)", fontSize: "0.92em" }}>{who.charAt(0).toUpperCase()}</span>}
      </div>
      <h2 className="serif hivra-login__title">
        {who} is almost ready.
      </h2>
      <p className="hivra-login__lede">
        It runs the official {product} on <strong style={{ color: "var(--ink-black)" }}>your own {accountLabel}</strong>.
        Connect once — the session is stored on this computer. Administrators of its host may have infrastructure access.
      </p>

      {error ? (
        <div style={{ border: "1px solid #c0392b", background: "rgba(192,57,43,0.08)", color: "#e06c5a", fontSize: 13, padding: "10px 14px", marginBottom: 18 }}>{error}</div>
      ) : null}

      {step === "idle" ? (
        <>
          <div className="hivra-login__steps">
            <Step n={1}>Use the button below to open the {signInWith} sign-in page.</Step>
            <Step n={2}>Authorize it with your {accountLabel}.</Step>
            <Step n={3}>
              {isCodex ? "Enter the one-time code we show you on the sign-in page — we detect it automatically." : "Copy the code it gives you and paste it back here."}
            </Step>
          </div>
          <button type="button" onClick={() => void start()} disabled={busy} className="hivra-login__primary hivra-login__cta" style={{ opacity: 1 }}>
            {busy ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : <ExternalLink size={15} />}
            Sign in with {signInWith}
          </button>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "18px 0 0", lineHeight: 1.55 }}>
            Once connected, {who} introduces itself and gets straight to work.
          </p>
        </>
      ) : isCodex ? (
        <div className="hivra-login__await" style={{ gap: 16 }}>
          <div style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            Open the {signInWith} sign-in page, sign in, then enter this one-time code there. We detect it automatically.
          </div>
          <div className="hivra-login__device">
            <div className="hivra-login__device-box">
              <span className="mono hivra-login__device-code">{deviceCode || "—"}</span>
            </div>
            {deviceCode ? (
              <button type="button" onClick={() => void copyDeviceCode()} className="hivra-login__secondary">
                {copied === "copied" ? <Check size={14} /> : <Copy size={14} />}
                {copied === "copied" ? "Copied" : copied === "failed" ? "Select code to copy" : "Copy code"}
              </button>
            ) : null}
            {/* A focused button's new label is not reliably announced. */}
            <span role="status" className="sr-only">
              {copied === "copied" ? "Code copied" : copied === "failed" ? "Copy failed. Select the code to copy it." : ""}
            </span>
          </div>
          {openSignIn}
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--text-muted)" }}>
            <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} /> Waiting for you to authorize…
          </div>
        </div>
      ) : (
        <div className="hivra-login__await" style={{ gap: 14 }}>
          <div style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            Open the {signInWith} sign-in page, authorize it, then paste the code it gives you here.
          </div>
          {openSignIn}
          <div style={{ display: "flex", gap: 8, minWidth: 0 }}>
            <input
              ref={codeInputRef}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void complete();
              }}
              aria-label="Authorization code"
              placeholder="Paste the authorization code"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="one-time-code"
              enterKeyHint="go"
              className="hivra-login__code"
              style={{ flex: 1, minWidth: 0, padding: "11px 12px", border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.04)", color: "var(--ink-black)", fontFamily: "var(--font-mono), monospace", outline: "none" }}
            />
            <button type="button" onClick={() => void complete()} disabled={busy || !code.trim()} className="hivra-login__primary" style={{ padding: "0 16px" }}>
              {busy ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Check size={14} />} Connect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
