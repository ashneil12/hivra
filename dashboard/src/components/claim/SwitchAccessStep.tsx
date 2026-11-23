"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import type { HolderTierCarryover } from "@/lib/billing/token-access";
import { TOKEN_CONVERSION_GRACE_HOURS } from "@/lib/billing/token-registry";

const FALLBACK_ERROR = "Couldn't confirm the switch. Reload this page to see whether it went through.";

/** Changing access only updates the account. The holder confirms before the API checks their wallet. */
export function SwitchAccessStep({ carryover }: { carryover?: HolderTierCarryover }) {
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
      const payload = (await response.json().catch(() => null)) as { success?: boolean; error?: unknown; code?: string } | null;
      if (response.status === 409 && payload?.code === "already_converted") {
        // Already switched (another tab) or already on $HIVRA: the page's
        // current state is stale, so re-render it instead of showing an error.
        router.refresh();
        return;
      }
      if (!response.ok || payload?.success !== true) {
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
      {carryover && carryover.tiers.length === 0 ? (
        <>
          <p>You have no active Pro or Power holder tier to carry over. Any subscription you already paid for keeps its paid-through date. Switching alone grants no new tier.</p>
          <p>You can switch this account without a verified wallet or a token balance.</p>
          <p>Switching access does not transfer or claim tokens.</p>
        </>
      ) : carryover ? (
        <>
          <p>You can keep using $HermesOS or switch your existing tier to $HIVRA. Your qualifying amount carries over 1:1.</p>
          <ul className="list-disc pl-6">
            {carryover.tiers.map(({ tier, amountDisplay }) => (
              <li key={tier}><strong>{tier === "power" ? "Power" : "Pro"}</strong> requires {amountDisplay} $HIVRA in your verified wallet.</li>
            ))}
          </ul>
          {carryover.tiers.length > 1 ? <p>One balance covers both tiers. Hold at least the larger amount shown above.</p> : null}
          <p>Hivra checks your <Link className="underline" href="/dashboard/wallet">verified wallet</Link> on Base before switching. If the balance is too low, your $HermesOS access continues. Switching access does not transfer or claim tokens.</p>
        </>
      ) : <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
        <strong>Optional: switch your access to $HIVRA.</strong> Your tier counts the legacy $HermesOS in your
        verified wallet. If you plan to move $HermesOS out of that wallet, switch your access first so your tier
        counts $HIVRA instead.
      </p>}
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6 }}>
        For {TOKEN_CONVERSION_GRACE_HOURS} hours after you switch, either token can count toward holder access. After that,
        only $HIVRA counts. Switching can&apos;t be undone.
      </p>
      {!carryover && <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: "var(--text-secondary)" }}>
        If you keep your $HermesOS where it is, you don&apos;t need to switch. Your $HermesOS access continues.
      </p>}
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
