"use client";

// ComposioKeyPanel — the BYO "paste your Composio key" gate. Until a key is
// saved, the connect tiles/browser are hidden behind this. Mirrors the BYO-Venice
// key UX: one paste, validated server-side (with a distinct IP-allowlist error).

import { useState } from "react";
import { Check, KeyRound, Loader2, ChevronRight } from "lucide-react";

import type { UseComposioKey } from "@/lib/composio/use-composio-connect";

export function ComposioKeyPanel({
  composioKey,
  onSaved,
}: {
  composioKey: UseComposioKey;
  /** Fired after a successful key save/rotation (parent force-syncs the box). */
  onSaved?: () => void;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (composioKey.loading) {
    return (
      <div style={{ padding: 12, color: "var(--text-muted)", fontSize: 12.5 }}>
        <Loader2 size={13} style={{ animation: "spin 1s linear infinite", verticalAlign: "-2px", marginRight: 6 }} />
        Checking your Composio connection…
      </div>
    );
  }

  if (composioKey.hasKey) {
    return (
      <div
        style={{
          border: "1px solid rgba(22,163,74,0.35)",
          background: "rgba(22,163,74,0.05)",
          padding: "12px 13px",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <Check size={16} style={{ color: "#16a34a", flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="serif" style={{ fontSize: 14.5, color: "var(--ink-black)" }}>
            Composio connected
          </div>
          <div className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {composioKey.keyPreview ?? "key saved"}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void composioKey.remove()}
          className="mono"
          style={{
            border: "1px solid var(--etched-border)",
            background: "transparent",
            color: "var(--text-secondary)",
            fontSize: 9.5,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            fontWeight: 700,
            padding: "7px 10px",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          Remove
        </button>
      </div>
    );
  }

  const onSave = async () => {
    const key = value.trim();
    if (!key) return;
    setSaving(true);
    setError(null);
    const res = await composioKey.save(key);
    setSaving(false);
    if (res.ok) {
      setValue("");
      onSaved?.();
    } else {
      setError(res.message ?? "That key was rejected.");
    }
  };

  return (
    <div
      style={{
        border: "1px solid var(--etched-border)",
        background: "rgba(255,255,255,0.02)",
        padding: "13px",
        display: "grid",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <KeyRound size={16} style={{ color: "var(--gold-leaf)", flexShrink: 0 }} />
        <span className="serif" style={{ fontSize: 15, color: "var(--ink-black)" }}>
          Connect your apps
        </span>
      </div>
      <span style={{ fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
        One free key connects Gmail, Calendar, Slack, Notion and 1,000+ apps to your
        agent — free, 20,000 actions / month. Here&apos;s where to find your key:
      </span>
      <ol
        style={{
          margin: 0,
          paddingLeft: 18,
          display: "grid",
          gap: 6,
          fontSize: 12.5,
          color: "var(--text-secondary)",
          lineHeight: 1.45,
        }}
      >
        <li>
          Open{" "}
          <a
            href="https://dashboard.composio.dev"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "var(--gold-leaf)", textDecoration: "underline", fontWeight: 600 }}
          >
            dashboard.composio.dev ↗
          </a>{" "}
          and sign in (free).
        </li>
        <li>
          Open the <strong style={{ color: "var(--ink-black)" }}>MCP</strong> setup (under{" "}
          <strong style={{ color: "var(--ink-black)" }}>Install</strong> / Connect).
        </li>
        <li>
          Reveal (eye icon) the key labelled{" "}
          <span className="mono" style={{ fontSize: 11.5 }}>X-CONSUMER-API-KEY</span> (starts with{" "}
          <span className="mono" style={{ fontSize: 11.5 }}>ck_</span>), copy it, and paste it below.
        </li>
      </ol>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          border: `1px solid ${error ? "rgba(220,38,38,0.5)" : "var(--etched-border)"}`,
          background: "rgba(255,255,255,0.02)",
          padding: "8px 10px",
        }}
      >
        <input
          type="password"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !saving) void onSave();
          }}
          placeholder="ck_..."
          autoComplete="off"
          style={{
            border: "none",
            outline: "none",
            background: "transparent",
            color: "var(--ink-black)",
            fontSize: 13.5,
            width: "100%",
            fontFamily: "var(--font-mono, monospace)",
          }}
        />
      </div>
      {error ? (
        <span style={{ fontSize: 12, color: "#dc2626", lineHeight: 1.4 }}>{error}</span>
      ) : null}
      <button
        type="button"
        onClick={() => void onSave()}
        disabled={saving || !value.trim()}
        className="mono"
        style={{
          border: "1px solid var(--ink-black)",
          background: "transparent",
          color: "var(--ink-black)",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          fontWeight: 800,
          padding: "9px 12px",
          cursor: saving || !value.trim() ? "default" : "pointer",
          opacity: saving || !value.trim() ? 0.6 : 1,
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          justifySelf: "start",
        }}
      >
        {saving ? <Loader2 size={12} style={{ animation: "spin 1s linear infinite" }} /> : null}
        {saving ? "Verifying…" : "Save key"} {!saving ? <ChevronRight size={12} /> : null}
      </button>
    </div>
  );
}
