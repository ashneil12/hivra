"use client";

// Self-contained editor for the account-level shared memory (Wave 5.1).
// Loads the current blob from GET /api/account/memory and saves via PUT.
// The API stores the canonical (trimmed + clamped) value and echoes it back,
// so we reflect that on save rather than the raw textarea contents.

import { useCallback, useEffect, useState } from "react";

const MAX_LEN = 4000;

type Status = "idle" | "loading" | "saving" | "saved" | "error";

export function AccountMemoryEditor() {
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/account/memory", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !data?.success) {
          setError(data?.error || "Couldn't load your memory. Try refreshing.");
          setStatus("error");
          return;
        }
        setContent(typeof data.data?.content === "string" ? data.data.content : "");
        setStatus("idle");
      } catch {
        if (cancelled) return;
        setError("Couldn't load your memory. Try refreshing.");
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async () => {
    setStatus("saving");
    setError(null);
    try {
      const res = await fetch("/api/account/memory", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(data?.error || "Save failed. Try again.");
        setStatus("error");
        return;
      }
      if (typeof data.data?.content === "string") setContent(data.data.content);
      setStatus("saved");
    } catch {
      setError("Save failed. Try again.");
      setStatus("error");
    }
  }, [content]);

  const disabled = status === "loading" || status === "saving";
  const remaining = MAX_LEN - content.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
      <label
        htmlFor="account-memory"
        style={{ fontSize: 14, fontWeight: 500, display: "block" }}
      >
        What should all your agents know about you?
      </label>

      <textarea
        id="account-memory"
        value={content}
        maxLength={MAX_LEN}
        disabled={disabled}
        onChange={(e) => {
          setContent(e.target.value);
          if (status === "saved" || status === "error") setStatus("idle");
        }}
        placeholder={
          status === "loading"
            ? "Loading…"
            : "e.g. I run a B2B SaaS for dentists. I prefer concise, direct answers. Always show your work before taking destructive actions."
        }
        rows={10}
        autoCapitalize="sentences"
        style={{
          width: "100%",
          resize: "vertical",
          padding: "1rem",
          fontFamily: "var(--font-mono), monospace",
          fontSize: 13,
          lineHeight: 1.6,
          border: "1px solid var(--etched-border)",
          background: "var(--bg-surface)",
          color: "var(--ink-black)",
          borderRadius: 0,
          opacity: disabled ? 0.6 : 1,
        }}
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 12, minHeight: 18 }}>
          {status === "saved" && (
            <span style={{ color: "var(--green, #16a34a)" }}>Saved — new agents will start with this.</span>
          )}
          {status === "error" && error && (
            <span style={{ color: "var(--red, #ef4444)" }}>{error}</span>
          )}
          {(status === "idle" || status === "saving") && (
            <span style={{ opacity: 0.5 }}>{remaining} characters left</span>
          )}
        </div>

        <button
          type="button"
          onClick={save}
          disabled={disabled}
          style={{
            padding: "12px 24px",
            background: "var(--ink-black)",
            color: "var(--bg-surface)",
            border: "1px solid var(--ink-black)",
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.6 : 1,
            fontFamily: "var(--font-mono), monospace",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            fontWeight: 600,
          }}
        >
          {status === "saving" ? "Saving…" : "Save"}
        </button>
      </div>

      <p style={{ fontSize: 12, opacity: 0.55, lineHeight: 1.6, margin: 0 }}>
        Read-only for your agents — they fold this into their starting notes but keep their own
        private memory per agent. Changing it here only affects agents you deploy from now on.
      </p>
    </div>
  );
}
