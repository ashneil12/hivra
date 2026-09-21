"use client";

// DismissibleCredits — wraps the managed-Venice credits pocket so it can be
// PERMANENTLY hidden. Credits only matter if you're on managed billing; for
// everyone else it shouldn't dominate the Command Center. Hiding persists in
// localStorage; a small "Show credits" affordance brings it back.

import { useEffect, useState } from "react";
import { X, Wallet } from "lucide-react";

import { ManagedVeniceCreditsPocket } from "./ManagedVeniceCreditsPocket";
import type { ManagedVeniceWalletSummaryPayload } from "@/lib/billing/managed-venice-client";

const KEY = "hivra_cc_credits_hidden";

export function DismissibleCredits(props: {
  summary: ManagedVeniceWalletSummaryPayload | null;
  loading: boolean;
  error: string | null;
  onTopUp: () => void;
  onManage: () => void;
}) {
  // Lazy initializer reads localStorage during render; on the server window is
  // undefined and we fall back to false. The `ready` gate keeps the first client
  // render === the server render (both null), so hidden's value never
  // participates in hydration — no mismatch, and no flash of the wrong state.
  const [hidden, setHidden] = useState(() => {
    try {
      return window.localStorage.getItem(KEY) === "1";
    } catch {
      return false; // SSR / private mode
    }
  });
  const [ready, setReady] = useState(false);

  // Flip `ready` only after mount so the null gate above can drop. This
  // deliberate one-time, post-hydration write is what the rule flags.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Mount flag for the post-hydration render gate; intentional one-time write.
    setReady(true);
  }, []);

  function dismiss() {
    try {
      window.localStorage.setItem(KEY, "1");
    } catch {
      /* ignore */
    }
    setHidden(true);
  }
  function restore() {
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    setHidden(false);
  }

  if (!ready) return null;

  if (hidden) {
    return (
      <button
        type="button"
        onClick={restore}
        className="mono"
        style={{
          border: "1px solid var(--etched-border)",
          background: "transparent",
          color: "var(--text-muted)",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.14em",
          padding: "8px 12px",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          justifySelf: "start",
        }}
      >
        <Wallet size={12} /> Show credits
      </button>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Hide credits"
        title="Hide credits"
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          zIndex: 2,
          border: "1px solid var(--etched-border)",
          background: "var(--bg-surface)",
          color: "var(--text-muted)",
          width: 22,
          height: 22,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
        }}
      >
        <X size={12} />
      </button>
      <ManagedVeniceCreditsPocket {...props} />
    </div>
  );
}
