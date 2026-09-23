export const AGENT_WITHDRAWAL_GAS_NOTICE =
  "Gas sponsorship covers Base withdrawal fees for this Bankr wallet.";

const WALLET_AMOUNT = /^(-?)(\d+)(?:\.(\d+))?$/;

function groupThousands(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatWalletAmountDisplay(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed === "—") return trimmed || "—";

  const normalized = trimmed.replace(/,/g, "");
  const match = normalized.match(WALLET_AMOUNT);
  if (!match) return trimmed;

  const [, sign, whole, fraction] = match;
  return `${sign}${groupThousands(whole)}${fraction === undefined ? "" : `.${fraction}`}`;
}

export const WALLET_AMOUNT_MAX_FRACTION_DIGITS = 6;

/**
 * Display form of a wallet balance that fits a card: thousands grouped and at
 * most `maxFractionDigits` fraction digits.
 *
 * String operations only (never Number or float), and it never rounds up:
 * extra digits are cut, so the shown amount is never more than the balance.
 * A non-zero balance that cuts to zero shows as "<0.000001". Values with no
 * more digits than the cap come back exactly as formatWalletAmountDisplay
 * shows them (trailing zeros kept), so short balances don't change. Callers
 * keep the exact value available (title and a copy button).
 */
export function formatWalletAmountCompact(
  value: string | null | undefined,
  maxFractionDigits: number = WALLET_AMOUNT_MAX_FRACTION_DIGITS
): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed === "—") return trimmed || "—";

  const normalized = trimmed.replace(/,/g, "");
  const match = normalized.match(WALLET_AMOUNT);
  if (!match) return trimmed;

  const [, sign, whole, fraction] = match;
  const cap = Math.max(0, Math.floor(maxFractionDigits));
  if (fraction === undefined || fraction.length <= cap) {
    return formatWalletAmountDisplay(normalized);
  }

  const kept = fraction.slice(0, cap).replace(/0+$/, "");
  const wholeIsZero = /^0+$/.test(whole);
  if (wholeIsZero && kept === "" && /[1-9]/.test(fraction)) {
    // Dust: non-zero, but below the smallest amount the cap can show.
    const smallest = cap === 0 ? "1" : `0.${"0".repeat(cap - 1)}1`;
    return sign ? `>-${smallest}` : `<${smallest}`;
  }
  return `${sign}${groupThousands(whole)}${kept ? `.${kept}` : ""}`;
}

/** True when formatWalletAmountCompact had to shorten the value. */
export function isWalletAmountShortened(
  value: string | null | undefined,
  maxFractionDigits: number = WALLET_AMOUNT_MAX_FRACTION_DIGITS
): boolean {
  return formatWalletAmountCompact(value, maxFractionDigits) !== formatWalletAmountDisplay(value);
}
