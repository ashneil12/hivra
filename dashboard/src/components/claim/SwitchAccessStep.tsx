"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";

import { TOKEN_CONVERSION_GRACE_HOURS } from "@/lib/billing/token-registry";

const FALLBACK_ERROR = "Couldn't confirm the switch. Reload this page to see whether it went through.";

/**
 * Optional for a grandfathered holder once the $HIVRA airdrop is sent: move
 * their tier from $HermesOS to $HIVRA before they move $HermesOS out of their
 * verified wallet, so that can't drop them below it. The switch itself is
 * lib/billing/token-access.ts (POST /api/billing/token-access).
 */
export function SwitchAccessStep() {
  const router = useRouter();
  const confirmId = useId();
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function switchAccess() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/billing/token-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "convert" }),
      });
      const payload = (await response.json().catch(() => null)) as { success?: boolean; error?: unknown } | null;
      if (response.status === 409) {
        // Already switched (another tab) or already on $HIVRA: the page's
        // current state is stale, so re-render it instead of showing an error.
        router.refresh();
        return;
      }
      if (!response.ok || payload?.success === false) {
        setError(typeof payload?.error === "string" ? payload.error : FALLBACK_ERROR);
        return;
      }
      router.refresh();
    } catch {
      setError(FALLBACK_ERROR);
    } finally {
      setPending(false);
    }
  }

  return (
    <div data-testid="convert-switch-access" style={{ display: "grid", gap: 12 }}>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
        <strong>Optional: switch your access to $HIVRA.</strong> Your tier counts the legacy $HermesOS in your
        verified wallet. If you plan to move $HermesOS out of that wallet, switch your access first so your tier
        counts $HIVRA instead.
      </p>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
        For {TOKEN_CONVERSION_GRACE_HOURS} hours after you switch, holding either token keeps your tier. After that,
        only $HIVRA counts. Switching can&apos;t be undone.
      </p>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: "var(--text-secondary)" }}>
        If you keep your $HermesOS where it is, you don&apos;t need to switch. Your $HermesOS access continues.
      </p>
      <label htmlFor={confirmId} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 14, lineHeight: 1.5 }}>
        <input
          id={confirmId}
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          style={{ marginTop: 3 }}
        />
        I understand switching can&apos;t be undone, and that after {TOKEN_CONVERSION_GRACE_HOURS} hours only $HIVRA
        counts toward my tier.
      </label>
      <div>
        <button
          type="button"
          onClick={switchAccess}
          disabled={!confirmed || pending}
          style={{
            padding: "10px 16px",
            border: "1px solid var(--etched-border)",
            borderRadius: 8,
            background: "transparent",
            color: "inherit",
            cursor: !confirmed || pending ? "not-allowed" : "pointer",
            opacity: !confirmed || pending ? 0.6 : 1,
          }}
        >
          {pending ? "Switching…" : "Switch my access to $HIVRA"}
        </button>
      </div>
      {error ? (
        <p role="alert" style={{ margin: 0, fontSize: 14, color: "var(--red)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
