"use client";

// Invite & Earn card (paioclaw rip-list). Shows the user's referral code + link
// with a copy button and a count of rewarded referrals. Loads from
// GET /api/account/referral, which degrades to a disabled/empty summary when the
// feature flag is off or the migration is unapplied — in that case we render a
// quiet "coming soon" state rather than an error. Mirrors AccountMemoryEditor's
// fetch + status patterns and the settings page's Tailwind-free inline styling.

import { useCallback, useEffect, useState } from "react";
import { Copy, Check, Gift } from "lucide-react";

type Summary = {
  enabled: boolean;
  code: string | null;
  link: string | null;
  rewardedCount: number;
  pendingCount: number;
  rewardCreditsPerReferral: number;
  maxRewardedReferrals: number;
};

type Status = "loading" | "ready" | "error";

function creditsToUsd(credits: number): string {
  const usd = credits / 100;
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

export function ReferralCard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/account/referral", { cache: "no-store" });
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok || !data?.success) {
          setStatus("error");
          return;
        }
        setSummary(data.data as Summary);
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

  const link = summary?.link ?? null;
  const copy = useCallback(async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked — leave the field for manual copy.
    }
  }, [link]);

  if (status === "loading") {
    return <p style={{ opacity: 0.5, fontSize: 14 }}>Loading…</p>;
  }

  // Flag off / migration unapplied / error → quiet empty state. No fake numbers.
  if (status === "error" || !summary?.enabled || !summary?.code || !summary?.link) {
    return (
      <div
        style={{
          background: "var(--bg-surface)",
          border: "1px dashed var(--etched-border)",
          padding: "1.5rem",
          display: "flex",
          alignItems: "center",
          gap: "1rem",
        }}
      >
        <Gift size={18} style={{ opacity: 0.4, flexShrink: 0 }} />
        <p style={{ fontSize: 13, opacity: 0.6, margin: 0, lineHeight: 1.6 }}>
          Invites aren&apos;t available on your account yet. Check back soon.
        </p>
      </div>
    );
  }

  const reward = creditsToUsd(summary.rewardCreditsPerReferral);

  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--etched-border)",
        padding: "1.5rem",
        display: "flex",
        flexDirection: "column",
        gap: "1.5rem",
      }}
    >
      <p style={{ fontSize: 13, opacity: 0.75, margin: 0, lineHeight: 1.6 }}>
        Share your link. When someone you invite gets going, you both get{" "}
        <strong>{reward}</strong> in credits. Good for up to{" "}
        {summary.maxRewardedReferrals} rewarded invites.
      </p>

      {/* Link + copy */}
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <input
          readOnly
          value={summary.link}
          onFocus={(e) => e.currentTarget.select()}
          style={{
            flex: "1 1 240px",
            minWidth: 0,
            padding: "0.75rem 1rem",
            fontFamily: "var(--font-mono), monospace",
            fontSize: 12,
            border: "1px solid var(--etched-border)",
            background: "var(--bg-base, var(--bg-surface))",
            color: "var(--ink-black)",
            borderRadius: 0,
          }}
        />
        <button
          type="button"
          onClick={copy}
          style={{
            padding: "0.75rem 1.25rem",
            background: copied ? "var(--green, #16a34a)" : "var(--ink-black)",
            color: "var(--bg-surface)",
            border: "1px solid var(--ink-black)",
            cursor: "pointer",
            fontFamily: "var(--font-mono), monospace",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            whiteSpace: "nowrap",
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>

      {/* Stats — only real, defensible numbers. */}
      <div
        style={{
          display: "flex",
          gap: "2rem",
          flexWrap: "wrap",
          paddingTop: "1.25rem",
          borderTop: "1px dashed var(--etched-border)",
        }}
      >
        <div>
          <div
            className="mono"
            style={{ fontSize: 28, fontWeight: 300, lineHeight: 1 }}
          >
            {summary.rewardedCount}
          </div>
          <div
            style={{
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.12em",
              opacity: 0.55,
              marginTop: 6,
              fontFamily: "var(--font-mono), monospace",
            }}
          >
            Rewarded invites
          </div>
        </div>
        {summary.pendingCount > 0 && (
          <div>
            <div
              className="mono"
              style={{ fontSize: 28, fontWeight: 300, lineHeight: 1, opacity: 0.6 }}
            >
              {summary.pendingCount}
            </div>
            <div
              style={{
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: "0.12em",
                opacity: 0.55,
                marginTop: 6,
                fontFamily: "var(--font-mono), monospace",
              }}
            >
              Joined, not yet active
            </div>
          </div>
        )}
      </div>

      <p style={{ fontSize: 12, opacity: 0.5, lineHeight: 1.6, margin: 0 }}>
        Your code: <span style={{ fontFamily: "var(--font-mono), monospace" }}>{summary.code}</span>
      </p>
    </div>
  );
}
