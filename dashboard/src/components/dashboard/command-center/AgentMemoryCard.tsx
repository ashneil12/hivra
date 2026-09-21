"use client";

// "What your agent knows about you" — a READ-ONLY command-center card that
// surfaces the account-level shared memory (Wave 5.1) so users SEE memory
// accumulating. The blob is the same plain-text "what should all my agents
// know about me" the user edits at /dashboard/settings/memory; here we only
// display it. No editing happens in this card.
//
// Data source: GET /api/account/memory -> { success, data: { content } }
// (backed by lib/account-memory.ts -> public.user_memory, keyed on Clerk user).
//
// Styling mirrors ManagedVeniceCreditsPocket (same sibling card surface): the
// bordered translucent <section>, mono kicker, lucide accent icon, gold-leaf.

import { useEffect, useState } from "react";
import Link from "next/link";
import { Brain, ArrowRight } from "lucide-react";

const SETTINGS_HREF = "/dashboard/settings/memory";

/** Max remembered facts to show before we truncate with a "+N more" note. */
const MAX_FACTS = 5;
/** Max characters per fact line before we ellipsize a single fact. */
const MAX_FACT_LEN = 140;

/**
 * Split the free-text memory blob into a few displayable "facts". The blob is
 * user-authored prose; we treat newline-separated lines (stripping common
 * bullet markers) as the natural unit, falling back to sentence-ish splitting
 * for a single run-on paragraph so the card never shows one giant wall.
 */
function extractFacts(blob: string): string[] {
  const trimmed = (blob || "").trim();
  if (!trimmed) return [];

  const byLine = trimmed
    .split(/\r?\n+/)
    .map((line) => line.replace(/^\s*[-*•·]+\s*/, "").trim())
    .filter(Boolean);

  let facts = byLine;
  // Single paragraph with no line breaks → split on sentence boundaries so we
  // still surface a handful of distinct-looking facts rather than one blob.
  if (facts.length <= 1) {
    facts = trimmed
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return facts;
}

function truncateFact(fact: string): string {
  if (fact.length <= MAX_FACT_LEN) return fact;
  return `${fact.slice(0, MAX_FACT_LEN - 1).trimEnd()}…`;
}

type Status = "loading" | "ready" | "error";

export function AgentMemoryCard() {
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/account/memory", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !data?.success) {
          setStatus("error");
          return;
        }
        setContent(typeof data.data?.content === "string" ? data.data.content : "");
        setStatus("ready");
      } catch {
        if (cancelled) return;
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const allFacts = extractFacts(content);
  const shownFacts = allFacts.slice(0, MAX_FACTS);
  const overflowCount = allFacts.length - shownFacts.length;
  const isEmpty = status === "ready" && allFacts.length === 0;

  return (
    <section
      data-testid="agent-memory-card"
      style={{
        border: "1px solid var(--etched-border)",
        background: "rgba(255,255,255,0.035)",
        padding: "clamp(1rem, 3vw, 1.4rem)",
        display: "grid",
        gap: 14,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.16em", opacity: 0.64 }}>
            What your agent knows about you
          </div>
          <strong style={{ display: "block", marginTop: 8, fontSize: 22, lineHeight: 1.1 }}>
            Shared memory
          </strong>
        </div>
        <Brain size={22} style={{ color: "var(--gold-leaf)", flexShrink: 0 }} />
      </div>

      {status === "loading" ? (
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "var(--text-secondary)" }}>
          Loading what your agents remember…
        </p>
      ) : status === "error" ? (
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "var(--text-secondary)" }}>
          Memory couldn&apos;t load right now. Try again in a moment.
        </p>
      ) : isEmpty ? (
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "var(--text-secondary)" }}>
          Your agents don&apos;t know anything about you yet. Add a few facts —
          your work, how you like answers — and every new agent will start
          already knowing them.
        </p>
      ) : (
        <>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: "var(--text-secondary)" }}>
            Every new agent you deploy starts already knowing this about you.
          </p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
            {shownFacts.map((fact, i) => (
              <li
                key={i}
                style={{
                  border: "1px solid var(--etched-border)",
                  padding: "9px 10px",
                  display: "flex",
                  gap: 8,
                  alignItems: "flex-start",
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: "50%",
                    background: "var(--gold-leaf)",
                    marginTop: 6,
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 13, lineHeight: 1.5, color: "var(--ink-black)", wordBreak: "break-word" }}>
                  {truncateFact(fact)}
                </span>
              </li>
            ))}
          </ul>
          {overflowCount > 0 ? (
            <span className="mono" style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.55 }}>
              +{overflowCount} more remembered
            </span>
          ) : null}
        </>
      )}

      <Link
        href={SETTINGS_HREF}
        style={{
          border: "1px solid var(--etched-border)",
          background: "transparent",
          color: "var(--ink-black)",
          padding: "9px 12px",
          textDecoration: "none",
          fontFamily: "var(--font-mono), monospace",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          fontWeight: 800,
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          justifySelf: "start",
        }}
      >
        {isEmpty ? "Add memory" : "Manage memory"} <ArrowRight size={13} />
      </Link>
    </section>
  );
}
