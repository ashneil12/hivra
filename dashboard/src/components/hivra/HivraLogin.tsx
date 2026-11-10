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
import { ExternalLink, Loader2, Check, Copy, RefreshCw } from "lucide-react";
import { ThinkingOrb } from "@/components/ui/ThinkingOrb";

import { boxLoginStartRaw, boxLoginComplete, boxLoginStatus } from "@/lib/hivra/agent-api";
import { isTrustedSignInLink } from "@/lib/agent-computers/attach-client";

// Classes rather than inline styles so the narrow-pane rules below can win.
// Phones tighten the rhythm so the only action clears the fold at 375x667
// with the bottom bar present; desktop keeps the original spacing.
const LOGIN_CSS = `
.hivra-login { max-width: 540px; margin: 0 auto; padding: clamp(2rem, 7vw, 3.5rem) 20px; }
.hivra-login__avatar { display: inline-flex; align-items: center; justify-content: center; width: 52px; height: 52px; border: 1px solid var(--hg-stroke); border-radius: 50%; background: var(--hg-fill-1); font-size: 24px; margin-bottom: 18px; }
.hivra-login__title { font-family: var(--font-display); font-size: clamp(1.6rem, 4.5vw, 2.1rem); font-weight: 600; letter-spacing: -0.03em; color: var(--ink-black); margin: 0 0 10px; line-height: 1.12; overflow-wrap: anywhere; }
.hivra-login__lede { font-size: 14px; color: var(--text-secondary); line-height: 1.65; margin: 0 0 26px; max-width: 470px; }
.hivra-login__steps { display: grid; gap: 12px; margin-bottom: 26px; }
.hivra-login__primary { border: 1px solid var(--hg-accent); background: var(--hg-accent); color: var(--hg-on-accent); border-radius: var(--hg-radius-sm); font-family: var(--font-sans); font-size: 13px; font-weight: 600; transition: opacity var(--hg-fast) var(--hg-ease); padding: 11px 18px; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px; text-decoration: none; }
.hivra-login__primary:disabled { cursor: default; opacity: 0.5; }
.hivra-login__secondary { border: 1px solid var(--hg-stroke); background: transparent; color: var(--hg-text); border-radius: var(--hg-radius-sm); font-family: var(--font-sans); font-size: 13px; font-weight: 500; transition: background var(--hg-fast) var(--hg-ease), border-color var(--hg-fast) var(--hg-ease); padding: 0 14px; min-height: 44px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
.hivra-login__primary:hover:not(:disabled) { opacity: 0.88; }
.hivra-login__secondary:hover:not(:disabled) { background: var(--hg-fill-hover); border-color: var(--hg-stroke-strong); }
.hivra-login__primary:focus-visible, .hivra-login__secondary:focus-visible { outline: 2px solid var(--hg-focus); outline-offset: 2px; }
.hivra-login__device { display: flex; flex-wrap: wrap; gap: 8px; }
.hivra-login__device-box { flex: 1 1 200px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--hg-stroke); background: var(--hg-fill-1); border-radius: var(--hg-radius-lg); padding: 18px; }
.hivra-login__device-code { font-size: 28px; font-weight: 600; letter-spacing: 0.2em; color: var(--ink-black); user-select: all; white-space: nowrap; }
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

/** Codex device sign-in: check the box this often, and for this long before it asks the person to check again. */
const CODEX_POLL_MS = 3_000;
const CODEX_POLL_WINDOW_MS = 10 * 60_000;

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
  untrustedLinks = false,
  reauth = false,
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
  /**
   * The sign-in link comes from an agent added to its owner's computer, whose
   * answers are its own (design 5.4, T28): it is shown as a link only on the
   * OpenAI or ChatGPT sign-in hosts, and as plain text with a warning otherwise.
   */
  untrustedLinks?: boolean;
  /**
   * Signing in again from Manage while the computer still says it is signed in
   * (an expired or revoked login). The sign-in status can't show when the new
   * sign-in is done, so Codex asks the person to say so instead of waiting.
   */
  reauth?: boolean;
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
  const [pollExpired, setPollExpired] = useState(false);
  const [pollRound, setPollRound] = useState(0);
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

  // Codex device-auth: once awaiting, poll the box until login completes. It
  // checks for a bounded window, skips checks while the tab is hidden, and then
  // stops and offers a visible "Check again" instead of polling forever.
  useEffect(() => {
    if (!isCodex || reauth || step !== "awaiting") return;
    const controller = new AbortController();
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (controller.signal.aborted) return;
      if (Date.now() - started > CODEX_POLL_WINDOW_MS) {
        setPollExpired(true);
        return;
      }
      if (!document.hidden) {
        const st = await boxLoginStatus(boxUrl, token).catch(() => null);
        if (controller.signal.aborted) return;
        // fresh === false: still signed in on the previous account, the new
        // sign-in has not landed yet.
        if (st?.loggedIn && st.fresh !== false) {
          setStep("done");
          onDoneRef.current();
          return;
        }
      }
      timer = setTimeout(tick, CODEX_POLL_MS);
    };
    timer = setTimeout(tick, CODEX_POLL_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [isCodex, reauth, step, boxUrl, token, pollRound]);

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
      // A link from an attached agent opens only on the trusted sign-in hosts.
      if (!untrustedLinks || isTrustedSignInLink(s.url)) {
        try {
          window.open(s.url, "_blank", "noopener,noreferrer");
        } catch {
          /* popup blocked — the button below opens it */
        }
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

  // Hivra can't see a second Codex sign-in finish, so this trusts the person
  // and the box's own answer; a message to the agent is the real check.
  async function finishCodexReauth() {
    setBusy(true);
    setError(null);
    try {
      await boxLoginComplete(boxUrl, "", token);
      setStep("done");
      onDoneRef.current();
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

  const openSignIn = !untrustedLinks || isTrustedSignInLink(url) ? (
    <a href={url} target="_blank" rel="noopener noreferrer" className="hivra-login__primary hivra-login__cta">
      <ExternalLink size={15} /> Open sign-in page
    </a>
  ) : (
    <div role="alert" style={{ border: "1px solid color-mix(in srgb, var(--hg-bad) 40%, transparent)", borderRadius: "var(--hg-radius-md)", padding: "10px 14px", fontSize: 13, lineHeight: 1.55 }}>
      <p style={{ margin: 0, color: "var(--ink-black)" }}>This sign-in address isn&apos;t an OpenAI or ChatGPT page, so Hivra won&apos;t open it. Don&apos;t enter your password there.</p>
      <code style={{ display: "block", marginTop: 6, overflowWrap: "anywhere", color: "var(--text-secondary)" }}>{url}</code>
    </div>
  );

  return (
    <div className="hivra-login">
      <style>{LOGIN_CSS}</style>
      {/* Identity — who's about to come online */}
      <div className="hivra-login__avatar">
        {emoji ? <span aria-hidden>{emoji}</span> : <span className="serif" style={{ color: "var(--gold-leaf)", fontSize: "0.92em" }}>{who.charAt(0).toUpperCase()}</span>}
      </div>
      <h2 className="serif hivra-login__title">
        {reauth ? `Sign in to ${product} again.` : `${who} is almost ready.`}
      </h2>
      <p className="hivra-login__lede">
        {reauth ? (
          <>Use this if {who} says it needs you to sign in, or stops answering because your sign-in ran out. Sign in to the same <strong style={{ color: "var(--ink-black)" }}>{accountLabel}</strong> again; your files and chats stay as they are. </>
        ) : (
          <>It runs the official {product} on <strong style={{ color: "var(--ink-black)" }}>your own {accountLabel}</strong>. Connect once — </>
        )}
        {reauth ? "The new session is stored on this computer. " : "the session is stored on this computer. "}Administrators of its host may have infrastructure access.
      </p>

      {error ? (
        <div style={{ border: "1px solid color-mix(in srgb, var(--hg-bad) 40%, transparent)", background: "color-mix(in srgb, var(--hg-bad) 8%, transparent)", color: "var(--hg-bad)", borderRadius: "var(--hg-radius-md)", fontSize: 13, padding: "10px 14px", marginBottom: 18 }}>{error}</div>
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
            {reauth ? `When you finish, ${who} uses your new sign-in.` : `Once connected, ${who} introduces itself and gets straight to work.`}
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
          {reauth ? (
            <div style={{ display: "grid", gap: 8, justifyItems: "start" }}>
              <button type="button" onClick={() => void finishCodexReauth()} disabled={busy} className="hivra-login__primary hivra-login__cta">
                {busy ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Check size={14} />} I&apos;ve entered the code
              </button>
              <span style={{ fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.5 }}>Press this after you authorize on the sign-in page. Then send {who} a message to check it works.</span>
            </div>
          ) : pollExpired ? (
            <div role="status" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, fontSize: 12.5, color: "var(--text-muted)" }}>
              <span>Hivra hasn&apos;t seen the sign-in yet.</span>
              <button type="button" className="hivra-login__secondary" onClick={() => { setPollExpired(false); setPollRound((n) => n + 1); }}>
                <RefreshCw size={13} /> Check again
              </button>
            </div>
          ) : (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--text-muted)" }}>
              <span aria-hidden="true" style={{ display: "inline-flex", flexShrink: 0 }}><ThinkingOrb state="connecting" size={20} /></span> Waiting for you to authorize…
            </div>
          )}
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
              style={{ flex: 1, minWidth: 0, padding: "11px 12px", border: "1px solid var(--hg-stroke)", background: "var(--hg-fill-1)", borderRadius: "var(--hg-radius-md)", color: "var(--ink-black)", fontFamily: "var(--font-mono), monospace", outline: "none" }}
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
