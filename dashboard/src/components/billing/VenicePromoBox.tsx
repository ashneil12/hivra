"use client";

import { useEffect, useState } from "react";

import styles from "./BillingPanels.module.css";

interface PromoState {
  enabled: boolean;
  lines: Array<{ grantId: string; label: string }>;
  codeEntry: boolean;
}

/**
 * Venice promo money shown as part of the user's credits, plus a one-line code
 * field. Renders nothing while the promo is off.
 */
export function VenicePromoBox() {
  const [state, setState] = useState<PromoState | null>(null);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/billing/venice-promo")
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled && body?.data) setState(body.data as PromoState);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!state?.enabled) return null;

  async function redeem() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/billing/venice-promo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const body = await res.json().catch(() => null);
      setMessage(body?.data?.message ?? body?.error ?? "That code did not work.");
      if (res.ok) setCode("");
    } catch {
      setMessage("That code did not work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.panel} aria-label="Venice credit">
      {state.lines.map((line) => (
        <p key={line.grantId} className={styles.lede}>{line.label}</p>
      ))}
      {state.codeEntry && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim() && !busy) void redeem();
          }}
        >
          <label className={styles.lede} htmlFor="venice-promo-code">Have a code?</label>{" "}
          <input
            id="venice-promo-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            maxLength={32}
            autoComplete="off"
          />{" "}
          <button type="submit" className={styles.button} disabled={busy || !code.trim()}>
            Apply
          </button>
          {message && <p className={styles.lede} role="status">{message}</p>}
        </form>
      )}
    </section>
  );
}
