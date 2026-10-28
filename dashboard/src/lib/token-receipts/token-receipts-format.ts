/**
 * Number and date wording for /token/receipts. Whole-wei bigint maths, no float
 * on the amount itself, so a large $HermesOS figure never rounds silently.
 *
 * Client-safe: no imports.
 */
/** The tokens the page names. Anything else a transaction moves is counted, not named. */
export type ReceiptToken = "ETH" | "WETH" | "HIVRA" | "HermesOS" | "USDC";
export const RECEIPT_TOKEN_DECIMALS: Record<ReceiptToken, number> = { ETH: 18, WETH: 18, HIVRA: 18, HermesOS: 18, USDC: 6 };

const WORDS: readonly [bigint, string][] = [
  [10n ** 9n, "billion"],
  [10n ** 6n, "million"],
];

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** `value / 10^scale` to at most `places` decimals, trailing zeros dropped, rounded down. */
function decimal(value: bigint, scale: bigint, places: number): string {
  const whole = value / scale;
  const fraction = ((value % scale) * 10n ** BigInt(places)) / scale;
  const fractionText = places > 0 ? fraction.toString().padStart(places, "0").replace(/0+$/, "") : "";
  return fractionText ? `${group(whole.toString())}.${fractionText}` : group(whole.toString());
}

/**
 * 500000000 tokens → "500 million"; 11340000000 → "11.34 billion"; 0.0421 → "0.0421";
 * 1234.5678 → "1,234.5678". Amounts under a million show up to four decimals,
 * and a non-zero amount too small for that shows as "less than 0.0001".
 */
export function formatTokenAmount(wei: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  for (const [size, word] of WORDS) {
    if (wei >= size * unit) return `${decimal(wei, size * unit, 2)} ${word}`;
  }
  const text = decimal(wei, unit, 4);
  return text === "0" && wei > 0n ? "less than 0.0001" : text;
}

/** "4 November 2026" for a UTC day; the time too ("4 November 2026, 16:00 UTC") when an instant is given. */
export function formatReceiptDate(iso: string, dateOnly: boolean): string {
  const date = new Date(iso);
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  if (dateOnly) return day;
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}
