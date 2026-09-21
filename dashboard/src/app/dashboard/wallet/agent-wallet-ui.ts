export const AGENT_WITHDRAWAL_GAS_NOTICE =
  "Gas sponsorship covers Base withdrawal fees for this Bankr wallet.";

export function formatWalletAmountDisplay(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed === "—") return trimmed || "—";

  const normalized = trimmed.replace(/,/g, "");
  const match = normalized.match(/^(-?)(\d+)(\.\d+)?$/);
  if (!match) return trimmed;

  const [, sign, whole, fraction = ""] = match;
  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${groupedWhole}${fraction}`;
}
