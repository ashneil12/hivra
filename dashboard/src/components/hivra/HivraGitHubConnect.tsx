"use client";

// Connect-your-GitHub step for dashboard-surface agents (Aeon). Unlike the
// claude/codex device-auth flows, Aeon authenticates by handing the box a GitHub
// personal access token: the box runs `gh auth login --with-token` and boots the
// dashboard against the user's own repo + Actions. Hivra passes the token to the
// box and never stores it.
//
// The PAT travels over the same token-gated box login endpoint as the other
// connect flows — we send it as the `code` field; the box's aeon handler treats
// it as the token to authenticate `gh`.

import { useState } from "react";
import posthog from "posthog-js";
import { ExternalLink, Loader2, Check, Wallet } from "lucide-react";

import { boxLoginComplete, type BoxVeniceWiring } from "@/lib/hivra/agent-api";

// Conversion-funnel instrumentation — must never make the connect flow fail.
function captureChannelEvent(event: string, properties: Record<string, unknown>) {
  try {
    posthog.capture(event, properties);
  } catch {
    // Best-effort instrumentation only.
  }
}

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

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 11, alignItems: "flex-start" }}>
      <span className="mono" style={{ flexShrink: 0, width: 22, height: 22, borderRadius: "50%", border: "1px solid var(--etched-border)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "var(--text-secondary)" }}>{n}</span>
      <span style={{ fontSize: 13.5, color: "var(--text-secondary)", lineHeight: 1.5, paddingTop: 2 }}>{children}</span>
    </div>
  );
}

// Fine-grained PAT, scoped to the user's Aeon fork. Pre-fills the scopes Aeon's
// skills need (contents, actions, secrets, workflows) on the new-token screen —
// plus variables, which the managed-credits wiring needs for `gh variable set
// VENICE_BASE_URL` (secrets and variables are separate fine-grained permissions).
const PAT_URL =
  "https://github.com/settings/personal-access-tokens/new?name=Aeon&contents=write&actions=write&secrets=write&workflows=write&variables=write";

export function HivraGitHubConnect({
  boxUrl,
  onDone,
  productName,
  displayName,
  emoji,
  token,
  boxId,
  defaultManagedCredits = false,
}: {
  boxUrl: string;
  onDone: () => void;
  /** Catalog product name (e.g. "Aeon"). */
  productName?: string;
  /** The agent's own identity name. */
  displayName?: string;
  /** The agent's signature emoji. */
  emoji?: string | null;
  /** Per-box bearer token — the box's login endpoints are token-gated. */
  token?: string | null;
  /** Stable agent/box id for analytics (falls back to boxUrl). */
  boxId?: string | null;
  /** Seeds the managed-credits toggle from the launch-time deploy-card choice.
   *  OFF unless the user opted in at deploy (hivra_agents.managed_venice). */
  defaultManagedCredits?: boolean;
}) {
  const product = productName || "Aeon";
  const who = (displayName || "").trim() || product;

  const [pat, setPat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useManagedCredits, setUseManagedCredits] = useState(defaultManagedCredits);

  // Mint a managed-Venice proxy key for this box and shape the wiring payload.
  // Wallet pick mirrors the chat proxy's defaultWalletType semantics: bill the
  // wallet that actually holds funds (card first — the fiat path), falling
  // back to hermesos. Mint failure degrades to a plain connect (the user can
  // add an LLM key in Aeon's own Authenticate modal) rather than blocking.
  async function mintVeniceWiring(): Promise<BoxVeniceWiring | null> {
    try {
      let walletType: "card" | "hermesos" = "card";
      try {
        const s = await fetch("/api/billing/managed-venice/summary", { cache: "no-store" });
        const sj = (await s.json()) as {
          data?: { wallets?: { card?: { availableMicroUsd?: number }; hermesos?: { availableMicroUsd?: number } } };
        };
        const card = sj.data?.wallets?.card?.availableMicroUsd ?? 0;
        const hermesos = sj.data?.wallets?.hermesos?.availableMicroUsd ?? 0;
        if (card <= 0 && hermesos > 0) walletType = "hermesos";
      } catch {
        // Balance unknown — card is the right default for fiat top-up users.
      }
      const r = await fetch("/api/managed-venice/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `Aeon box ${who}`.slice(0, 80), walletType }),
      });
      const j = (await r.json()) as { success?: boolean; data?: { plaintextKey?: string } };
      if (!r.ok || !j.success || !j.data?.plaintextKey) return null;
      return {
        key: j.data.plaintextKey,
        baseUrl: `${window.location.origin}/api/managed-venice/v1/chat/completions`,
        model: "claude-sonnet-4-6",
      };
    } catch {
      return null;
    }
  }

  async function connect() {
    const value = pat.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    const channelProps = { channel: "github", box_id: boxId ?? boxUrl };
    captureChannelEvent("channel_connect_started", channelProps);
    try {
      const venice = useManagedCredits ? await mintVeniceWiring() : null;
      const result = await boxLoginComplete(boxUrl, value, token, venice);
      captureChannelEvent("channel_connected", {
        ...channelProps,
        managed_credits_requested: useManagedCredits,
        managed_credits_wiring: result.venice ?? (venice ? "not_reported" : "off"),
      });
      onDone();
    } catch (e) {
      captureChannelEvent("channel_connect_failed", channelProps);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 540, margin: "0 auto", padding: "clamp(2rem, 7vw, 3.5rem) 20px" }}>
      <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 52, height: 52, border: "1px solid var(--gold-leaf)", fontSize: 24, marginBottom: 18 }}>
        {emoji ? <span aria-hidden>{emoji}</span> : <span className="serif" style={{ color: "var(--gold-leaf)", fontSize: 22 }}>{who.charAt(0).toUpperCase()}</span>}
      </div>
      <h2 className="serif" style={{ fontSize: "clamp(1.7rem, 5vw, 2.3rem)", fontWeight: 400, color: "var(--ink-black)", margin: "0 0 10px", lineHeight: 1.12 }}>
        Connect {who} to GitHub.
      </h2>
      <p style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.65, margin: "0 0 26px", maxWidth: 470 }}>
        {product} runs on <strong style={{ color: "var(--ink-black)" }}>your own GitHub</strong> — its tasks execute on your Actions and its state lives in your repo.
        Paste a personal access token once; the box uses it to sign in and start the dashboard. Hivra never stores it.
      </p>

      {error ? (
        <div style={{ border: "1px solid #c0392b", background: "rgba(192,57,43,0.08)", color: "#e06c5a", fontSize: 13, padding: "10px 14px", marginBottom: 18 }}>{error}</div>
      ) : null}

      <div style={{ display: "grid", gap: 12, marginBottom: 22 }}>
        <Step n={1}>
          <a href={PAT_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--gold-leaf)" }}>Create a fine-grained token</a> on your Aeon fork with Contents, Actions, Secrets, and Workflows access.
        </Step>
        <Step n={2}>Copy the token (starts with <span className="mono">github_pat_</span>) and paste it below.</Step>
        <Step n={3}>{who} signs in, boots its dashboard, and is ready to configure.</Step>
      </div>

      <label
        style={{
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
          border: "1px solid var(--etched-border)",
          background: "rgba(255,255,255,0.03)",
          padding: "11px 13px",
          marginBottom: 14,
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={useManagedCredits}
          onChange={(e) => setUseManagedCredits(e.target.checked)}
          style={{ marginTop: 2, accentColor: "var(--gold-leaf)" }}
        />
        <span style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--ink-black)", fontWeight: 700 }}>
            <Wallet size={13} /> Power {who} with your managed Venice credits
          </span>
          <br />
          Hivra sets a billing key on your fork so {product} runs without you supplying an AI
          provider key — usage is billed from your Hivra credit wallet at provider rates.
        </span>
      </label>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="password"
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void connect();
          }}
          autoFocus
          placeholder="github_pat_…"
          style={{ flex: 1, padding: "11px 12px", border: "1px solid var(--etched-border)", background: "rgba(255,255,255,0.04)", color: "var(--ink-black)", fontSize: 13, fontFamily: "var(--font-mono), monospace", outline: "none" }}
        />
        <button type="button" onClick={() => void connect()} disabled={busy || !pat.trim()} style={{ ...primaryBtn, padding: "0 16px", opacity: busy || !pat.trim() ? 0.5 : 1, cursor: busy || !pat.trim() ? "default" : "pointer" }}>
          {busy ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Check size={14} />} Connect
        </button>
      </div>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "16px 0 0", lineHeight: 1.55 }}>
        No fork yet? <a href="https://github.com/aaronjmars/aeon" target="_blank" rel="noopener noreferrer" style={{ color: "var(--gold-leaf)", display: "inline-flex", alignItems: "center", gap: 4 }}>Fork Aeon <ExternalLink size={11} /></a> first, then create the token on your copy.
      </p>
    </div>
  );
}
