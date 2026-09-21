'use client';

import { motion, type Variants } from 'framer-motion';
import { CheckCircle, Coins, CreditCard, Loader2, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import { LocalAddressQr } from '@/components/billing/LocalAddressQr';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { useLocale } from '@/components/i18n/LocaleProvider';
import {
  CREDIT_TOP_UP_PACKAGES,
  interpolateCopy,
  shortenAddress,
  type CreditTopUpPackageCredits,
  type CryptoTopUpIntentData,
  type TokenHoldingData,
} from '@/lib/billing/format';

/**
 * Billing dashboard building blocks: resource meters, the cadence toggle, the
 * payment-path tabs, the crypto-mode toggle, the status badge and the credits /
 * crypto top-up / token-holding panels. Extracted verbatim from page.tsx.
 */
// ── Sub-components ────────────────────────────────────────────────────────────

export function ResourceBar({
  label, used, total, unit,
}: {
  label: string; used: number; total: number; unit: string;
}) {
  const isUnlimited = total >= 999;
  const pct = isUnlimited ? 0 : (total > 0 ? Math.min(100, (used / total) * 100) : 0);
  const color = "var(--ink-black)";
  return (
    <div style={{ marginBottom: "1.25rem" }}>
      <div style={{
        display: "flex", justifyContent: "space-between",
        fontSize: 10, fontFamily: "var(--font-mono), monospace",
        marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.1em",
      }}>
        <span style={{ opacity: 0.55, fontWeight: 700 }}>{label}</span>
        <span style={{ fontWeight: 700, color }}>
          {used} / {isUnlimited ? '∞' : total} {unit}
        </span>
      </div>
      <div style={{ width: "100%", height: 5, background: "var(--etched-border)", borderRadius: 0 }}>
        <div style={{
          width: `${pct}%`, height: "100%", background: color,
          borderRadius: 0, transition: "width 0.6s ease",
        }} />
      </div>
    </div>
  );
}
/**
 * Monthly/Yearly cadence toggle.
 *
 * The two pills sit inside a single bordered chamber; an animated
 * `motion.div` thumb slides between them via `layoutId` so the
 * transition feels like one piece of UI rearranging, not two
 * separate buttons flickering. Right of the toggle, a gold-leaf
 * chip surfaces the headline savings — dimmed-but-present on
 * monthly so the user still sees the carrot, fully lit on yearly
 * to confirm "yep, you're getting the deal."
 */
export function CadenceToggle({
  cadence,
  onChange,
}: {
  cadence: "monthly" | "yearly";
  onChange: (cadence: "monthly" | "yearly") => void;
}) {
  const baseSegment: React.CSSProperties = {
    position: "relative",
    padding: "12px 28px",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.14em",
    fontFamily: "var(--font-mono), monospace",
    border: "none",
    background: "transparent",
    cursor: "pointer",
    transition: "color 200ms ease",
    zIndex: 1,
  };

  return (
    <div
      role="tablist"
      aria-label="Billing cadence"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 14,
        flexWrap: "wrap",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          position: "relative",
          display: "inline-flex",
          alignItems: "stretch",
          border: "1px solid var(--etched-border)",
          background: "var(--bg-surface)",
          padding: 4,
          gap: 0,
        }}
      >
        {/* Animated thumb that slides between the two segments. */}
        <motion.div
          aria-hidden
          layout
          transition={{ type: "spring", stiffness: 380, damping: 32 }}
          style={{
            position: "absolute",
            top: 4,
            bottom: 4,
            left: cadence === "monthly" ? 4 : "50%",
            right: cadence === "monthly" ? "50%" : 4,
            background: "var(--ink-black)",
            zIndex: 0,
          }}
        />
        <button
          type="button"
          role="tab"
          aria-selected={cadence === "monthly"}
          onClick={() => onChange("monthly")}
          style={{
            ...baseSegment,
            color: cadence === "monthly" ? "var(--bg-surface)" : "var(--ink-black)",
            opacity: cadence === "monthly" ? 1 : 0.55,
          }}
        >
          Monthly
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={cadence === "yearly"}
          onClick={() => onChange("yearly")}
          style={{
            ...baseSegment,
            color: cadence === "yearly" ? "var(--bg-surface)" : "var(--ink-black)",
            opacity: cadence === "yearly" ? 1 : 0.55,
          }}
        >
          Yearly
        </button>
      </div>

      <span
        className="mono"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.14em",
          fontWeight: 700,
          padding: "7px 12px",
          color: "var(--gold-leaf)",
          border: "1px solid var(--gold-leaf)",
          background: cadence === "yearly" ? "rgba(255, 44, 45, 0.12)" : "rgba(255, 44, 45, 0.04)",
          opacity: cadence === "yearly" ? 1 : 0.6,
          transition: "opacity 200ms ease, background 200ms ease",
          boxShadow: cadence === "yearly" ? "0 0 0 4px rgba(255, 44, 45, 0.08)" : "none",
        }}
      >
        <span style={{ width: 5, height: 5, background: "var(--gold-leaf)", display: "inline-block", boxShadow: cadence === "yearly" ? "0 0 8px var(--gold-leaf)" : "none" }} />
        Save up to ~59% with $HermesOS
      </span>
    </div>
  );
}
/**
 * Top-level payment-path tabs. Card vs $HermesOS. Sits above
 * CadenceToggle (Card) or CryptoModeToggle (Crypto). Mirrors the
 * welcome-flow split so the same "Card or Crypto?" question gets
 * asked once, in the same shape, on every plan-picking surface.
 */
export function PaymentPathTabs({
  paidPath,
  onChange,
}: {
  paidPath: "card" | "crypto";
  onChange: (path: "card" | "crypto") => void;
}) {
  const tab = (
    label: string,
    icon: React.ReactNode,
    sub: string,
    isActive: boolean,
    onClick: () => void,
    accent?: "gold",
  ) => (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      onClick={onClick}
      style={{
        padding: "12px 22px",
        background: isActive ? "var(--ink-black)" : "transparent",
        color: isActive ? "var(--bg-surface)" : "var(--ink-black)",
        opacity: isActive ? 1 : 0.65,
        border: "none",
        cursor: "pointer",
        fontFamily: "var(--font-mono), monospace",
        fontSize: 11,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.14em",
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 4,
        minWidth: 168,
        transition: "background 200ms ease, color 200ms ease, opacity 200ms ease",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: accent === "gold" ? "var(--gold-leaf)" : "inherit" }}>{icon}</span>
        {label}
      </span>
      <span
        style={{
          fontSize: 9,
          letterSpacing: "0.05em",
          opacity: isActive ? 0.7 : 0.55,
          textTransform: "none",
          fontWeight: 500,
        }}
      >
        {sub}
      </span>
    </button>
  );
  return (
    <div role="tablist" aria-label="Payment method" style={{ display: "inline-flex", border: "1px solid var(--etched-border)", background: "var(--bg-surface)", padding: 4 }}>
      {tab("Card", <CreditCard size={13} />, "Stripe · monthly or yearly", paidPath === "card", () => onChange("card"))}
      {tab("$HermesOS", <Coins size={13} />, "Pay or hold tokens", paidPath === "crypto", () => onChange("crypto"), "gold")}
    </div>
  );
}
/**
 * Crypto-side sub-toggle. Yearly vs Permanent.
 *   yearly    → one-shot $49/$99 token payment, 365-day sub
 *   permanent → hold-to-qualify, withdraw any time
 */
export function CryptoModeToggle({
  mode,
  onChange,
}: {
  mode: "yearly" | "permanent";
  onChange: (mode: "yearly" | "permanent") => void;
}) {
  const segment = (value: "yearly" | "permanent", label: string, hint: string) => {
    const active = mode === value;
    return (
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={() => onChange(value)}
        style={{
          padding: "10px 20px",
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.14em",
          fontFamily: "var(--font-mono), monospace",
          border: "none",
          background: active ? "var(--gold-leaf)" : "transparent",
          color: "var(--ink-black)",
          opacity: active ? 1 : 0.6,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          transition: "background 200ms ease, opacity 200ms ease",
        }}
      >
        {label}
        <span
          style={{
            fontSize: 8,
            padding: "2px 6px",
            background: active ? "var(--ink-black)" : "transparent",
            color: active ? "var(--gold-leaf)" : "var(--gold-leaf)",
            border: active ? "none" : "1px solid var(--gold-leaf)",
            letterSpacing: "0.08em",
          }}
        >
          {hint}
        </span>
      </button>
    );
  };
  return (
    <div role="tablist" aria-label="$HermesOS payment mode" style={{ display: "inline-flex", border: "1px solid var(--gold-leaf)", background: "rgba(255, 44, 45,0.06)", padding: 4 }}>
      {segment("yearly", "Yearly", "Pay once · 365d")}
      {segment("permanent", "Permanent", "Hold to qualify")}
    </div>
  );
}
export function StatusBadge({ status }: { status: string }) {
  const isActive = status === "active";
  return (
    <span style={{
      fontSize: 9, textTransform: "uppercase", letterSpacing: "0.15em",
      fontWeight: 700, padding: "4px 10px", fontFamily: "var(--font-mono), monospace",
      background: "transparent",
      color: isActive ? "#16a34a" : "#dc2626",
      border: `1px solid ${isActive ? "#16a34a" : "#dc2626"}`,
    }}>
      {status}
    </span>
  );
}
export function CreditsPanel({
  balance,
  topUpsEnabled,
  toppingUp,
  variants,
  onTopUp,
}: {
  balance: number;
  topUpsEnabled: boolean;
  toppingUp: CreditTopUpPackageCredits | null;
  variants: Variants;
  onTopUp: (packageCredits: CreditTopUpPackageCredits) => void;
}) {
  const { copy } = useLocale();
  const creditsCopy = copy.dashboard.billing.credits;

  return (
    <motion.div variants={variants} style={{
      border: "1px solid var(--ink-black)", background: "var(--bg-surface)",
      padding: "clamp(1.5rem, 4vw, 2rem)", marginBottom: "2rem",
    }}>
      <div style={{ marginBottom: "1.5rem" }}>
        <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.2em", opacity: 0.5, fontWeight: 700 }}>
          {creditsCopy.title}
        </span>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 }}>
          <span className="serif" style={{ fontSize: "2.4rem", lineHeight: 1, fontWeight: 700 }}>
            {balance.toLocaleString()}
          </span>
          <span className="mono" style={{ fontSize: 10, opacity: 0.5 }}>{creditsCopy.available}</span>
        </div>
        <p style={{ fontSize: 12, opacity: 0.55, marginTop: 8, maxWidth: 480, lineHeight: 1.6 }}>
          {creditsCopy.description}
        </p>
      </div>

      {topUpsEnabled && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "0.75rem" }}>
          {CREDIT_TOP_UP_PACKAGES.map((pkg) => (
            <button
              key={pkg.credits}
              onClick={() => onTopUp(pkg.credits)}
              disabled={toppingUp !== null}
              style={{
                border: "1px solid var(--etched-border)",
                background: "transparent",
                color: "var(--ink-black)",
                padding: "12px 14px",
                cursor: toppingUp === null ? "pointer" : "wait",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                opacity: toppingUp !== null && toppingUp !== pkg.credits ? 0.55 : 1,
              }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {toppingUp === pkg.credits ? (
                  <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
                ) : (
                  <CreditCard size={14} />
                )}
                <span className="mono" style={{ fontSize: 10, fontWeight: 700 }}>
                  ${pkg.usd}
                </span>
              </span>
              <span className="mono" style={{ fontSize: 10, opacity: 0.55 }}>
                {pkg.credits.toLocaleString()}
              </span>
            </button>
          ))}
        </div>
      )}
    </motion.div>
  );
}
export function CryptoTopUpPanel({
  intent,
  error,
  toppingUp,
  variants,
  onTopUp,
}: {
  intent: CryptoTopUpIntentData | null;
  error: string | null;
  toppingUp: CreditTopUpPackageCredits | null;
  variants: Variants;
  onTopUp: (packageCredits: CreditTopUpPackageCredits) => void;
}) {
  const { copy } = useLocale();
  const cryptoCopy = copy.dashboard.billing.cryptoCredits;

  return (
    <motion.div variants={variants} style={{
      border: "1px solid var(--etched-border)", background: "var(--bg-surface)",
      padding: "clamp(1.5rem, 4vw, 2rem)", marginBottom: "2rem",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1.5rem", flexWrap: "wrap", marginBottom: "1.25rem" }}>
        <div>
          <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.2em", opacity: 0.5, fontWeight: 700 }}>
            {cryptoCopy.eyebrow}
          </span>
          <h3 className="serif" style={{ fontSize: "1.5rem", fontWeight: 700, marginTop: 4 }}>
            USDC on Base
          </h3>
          <p style={{ fontSize: 12, opacity: 0.55, marginTop: 6, maxWidth: 520, lineHeight: 1.6 }}>
            {cryptoCopy.description}
          </p>
        </div>
        <div style={{ border: "1px solid var(--etched-border)", padding: "10px 12px", minWidth: 170 }}>
          <div className="mono" style={{ fontSize: 9, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, marginBottom: 6 }}>
            $HermesOS
          </div>
          <div className="mono" style={{ fontSize: 10, fontWeight: 700 }}>
            {cryptoCopy.bonusPath}
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "0.75rem" }}>
        {CREDIT_TOP_UP_PACKAGES.map((pkg) => (
          <button
            key={pkg.credits}
            aria-label={interpolateCopy(cryptoCopy.createTopUpLabel, { credits: pkg.credits.toString() })}
            onClick={() => onTopUp(pkg.credits)}
            disabled={toppingUp !== null}
            style={{
              border: "1px solid var(--etched-border)",
              background: "transparent",
              color: "var(--ink-black)",
              padding: "12px 14px",
              cursor: toppingUp === null ? "pointer" : "wait",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              opacity: toppingUp !== null && toppingUp !== pkg.credits ? 0.55 : 1,
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {toppingUp === pkg.credits ? (
                <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
              ) : (
                <Wallet size={14} />
              )}
              <span className="mono" style={{ fontSize: 10, fontWeight: 700 }}>
                {pkg.usd} USDC
              </span>
            </span>
            <span className="mono" style={{ fontSize: 10, opacity: 0.55 }}>
              {pkg.credits.toLocaleString()}
            </span>
          </button>
        ))}
      </div>

      {intent && (
        <div style={{ border: "1px solid #16a34a", padding: "14px 16px", marginTop: "1.25rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "#16a34a", marginBottom: 8 }}>
              <CheckCircle size={14} />
              <span className="mono" style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em" }}>
              {cryptoCopy.pendingDeposit}
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <LocalAddressQr address={intent.depositAddress} size={116} label="Credit deposit address QR code" />
            <div style={{ display: "grid", gap: 8, flex: "1 1 220px", minWidth: 0 }}>
              <div className="mono" style={{ fontSize: 11, fontWeight: 700 }}>
                {cryptoCopy.sendPrefix} {intent.amountDisplay} {intent.asset.symbol} {cryptoCopy.onNetwork} {intent.asset.network}
              </div>
              <div className="mono" style={{ fontSize: 11, wordBreak: "break-all", opacity: 0.7 }}>
                {intent.depositAddress}
              </div>
              <div className="mono" style={{ fontSize: 9, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                {cryptoCopy.reference} {intent.referenceId}
              </div>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div style={{ marginTop: "1rem" }}>
          <ErrorBanner
            error={error}
            context={{
              source: "client.diagnostic",
              route: "/api/billing/confirm-checkout",
              metadata: { surface: "BillingCheckoutSection" },
            }}
          />
        </div>
      )}
    </motion.div>
  );
}
export function TokenHoldingPanel({
  tokenHolding,
  loading,
  refreshing,
  connectingWallet,
  error,
  variants,
  onRefresh,
  onConnectWallet,
}: {
  tokenHolding: TokenHoldingData | null;
  loading: boolean;
  refreshing: boolean;
  connectingWallet: boolean;
  error: string | null;
  variants: Variants;
  onRefresh: () => void;
  onConnectWallet: () => void;
}) {
  const { copy } = useLocale();
  const tokenCopy = copy.dashboard.billing.tokenAccess;
  const token = tokenHolding?.token ?? null;
  const qualifies = tokenHolding?.entitlement?.qualifiesBaseTier ?? false;
  const wallet = tokenHolding?.wallet ?? null;
  const snapshot = tokenHolding?.snapshot ?? null;
  const statusLabel = loading
    ? tokenCopy.checking
    : error
      ? tokenCopy.unavailable
      : qualifies
        ? tokenCopy.ready
        : wallet
          ? tokenCopy.belowMinimum
          : tokenCopy.noWallet;
  const statusColor = qualifies ? "#16a34a" : error ? "#dc2626" : "var(--ink-black)";

  return (
    <motion.div variants={variants} style={{
      border: "1px solid var(--etched-border)", background: "var(--bg-surface)",
      padding: "clamp(1.5rem, 4vw, 2rem)", marginBottom: "2rem",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1.5rem", flexWrap: "wrap" }}>
        <div>
          <span className="mono" style={{ fontSize: 9, textTransform: "uppercase", letterSpacing: "0.2em", opacity: 0.5, fontWeight: 700 }}>
            {tokenCopy.eyebrow}
          </span>
          <h3 className="serif" style={{ fontSize: "1.5rem", fontWeight: 700, marginTop: 4 }}>
            {tokenCopy.title}
          </h3>
          <p style={{ fontSize: 12, opacity: 0.55, marginTop: 6, maxWidth: 520, lineHeight: 1.6 }}>
            {tokenCopy.description}
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: statusColor, fontFamily: "var(--font-mono), monospace", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em" }}>
          {loading ? (
            <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
          ) : qualifies ? (
            <ShieldCheck size={14} />
          ) : (
            <Wallet size={14} />
          )}
          {statusLabel}
        </div>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
        gap: "0.75rem",
        marginTop: "1.25rem",
      }}>
        <div style={{ border: "1px solid var(--etched-border)", padding: "12px 14px" }}>
          <div className="mono" style={{ fontSize: 9, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, marginBottom: 6 }}>
            {tokenCopy.wallet}
          </div>
          <div className="mono" style={{ fontSize: 11, fontWeight: 700 }}>
            {wallet ? shortenAddress(wallet.normalizedAddress || wallet.address) : tokenCopy.notVerified}
          </div>
        </div>
        <div style={{ border: "1px solid var(--etched-border)", padding: "12px 14px" }}>
          <div className="mono" style={{ fontSize: 9, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, marginBottom: 6 }}>
            {tokenCopy.balance}
          </div>
          <div className="mono" style={{ fontSize: 11, fontWeight: 700 }}>
            {snapshot ? `${snapshot.balanceDisplay} ${token?.tokenSymbol ?? "Hivra"}` : tokenCopy.noSnapshot}
          </div>
        </div>
        <div style={{ border: "1px solid var(--etched-border)", padding: "12px 14px" }}>
          <div className="mono" style={{ fontSize: 9, opacity: 0.45, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700, marginBottom: 6 }}>
            {tokenCopy.minimum}
          </div>
          <div className="mono" style={{ fontSize: 11, fontWeight: 700 }}>
            {token ? `${token.minimumBalanceDisplay} ${token.tokenSymbol}` : "1 Hivra"}
          </div>
        </div>
      </div>

      {error && (
        <div style={{ marginTop: "1rem" }}>
          <ErrorBanner
            error={error}
            context={{
              source: "client.diagnostic",
              route: "/api/billing/wallet/verify",
              metadata: { surface: "BillingWalletConnectSection" },
            }}
          />
        </div>
      )}

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginTop: "1.25rem" }}>
        <button
          onClick={() => onConnectWallet()}
          disabled={loading || refreshing || connectingWallet}
          style={{
            background: "var(--ink-black)", color: "var(--bg-surface)",
            border: "1px solid var(--ink-black)", padding: "12px 18px",
            cursor: loading || refreshing || connectingWallet ? "wait" : "pointer",
            display: "inline-flex", alignItems: "center", gap: 8,
            fontFamily: "var(--font-mono), monospace", fontSize: 10,
            fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em",
            opacity: loading || refreshing || connectingWallet ? 0.7 : 1,
          }}
        >
          {connectingWallet ? (
            <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
          ) : (
            <Wallet size={14} />
          )}
          {connectingWallet ? tokenCopy.connecting : wallet ? tokenCopy.verifyDifferent : tokenCopy.connectWallet}
        </button>
        <button
          onClick={() => onRefresh()}
          disabled={loading || refreshing || connectingWallet}
          style={{
            background: "transparent", color: "var(--ink-black)",
            border: "1px solid var(--etched-border)", padding: "12px 18px",
            cursor: loading || refreshing || connectingWallet ? "wait" : "pointer",
            display: "inline-flex", alignItems: "center", gap: 8,
            fontFamily: "var(--font-mono), monospace", fontSize: 10,
            fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em",
            opacity: loading || refreshing || connectingWallet ? 0.7 : 1,
          }}
        >
          {refreshing ? (
            <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />
          ) : (
            <RefreshCw size={14} />
          )}
          {refreshing ? tokenCopy.refreshing : tokenCopy.refresh}
        </button>
      </div>
    </motion.div>
  );
}
