import type { ManagedVeniceKeySummary } from "@/components/billing/ManagedVeniceKeysPanel";
import type { ManagedVeniceWalletSummary } from "@/components/billing/ManagedVeniceWalletPanel";
import type { BrowserWalletProvider } from "@/lib/client/wallet-provider-errors";
import { readJsonWithDiagnostics } from "@/lib/client/json-response-diagnostics";
import { normalizeManagedVeniceTopUpAmount } from "@/lib/venice/managed-credit-topup";
import posthog from "posthog-js";

/**
 * Pure formatters, validators, payload readers and feature-flag gates for the
 * billing dashboard. Extracted verbatim from billing/page.tsx so the page
 * focuses on rendering and these can be unit-tested without a DOM.
 */
export interface ManagedVeniceDashboardSummary extends ManagedVeniceWalletSummary {
  keys: ManagedVeniceKeySummary[];
}
export interface TokenHoldingData {
  token: {
    chainId: number;
    tokenAddress: string;
    tokenSymbol: string;
    minimumBalanceDisplay: string;
  };
  wallet: {
    id: string;
    address: string;
    normalizedAddress: string;
    chainId: number;
    verifiedAt: string | null;
  } | null;
  snapshot: {
    id: string;
    balanceDisplay: string;
    qualifiesBaseTier: boolean;
    checkedAt: string;
  } | null;
  entitlement: {
    verified: boolean;
    qualifiesBaseTier: boolean;
  };
}
export const CREDIT_TOP_UP_PACKAGES = [
  { credits: 500, usd: 5 },
  { credits: 1000, usd: 10 },
  { credits: 2500, usd: 25 },
  { credits: 5000, usd: 50 },
] as const;
// Conversion-funnel instrumentation. Mirrors WelcomeFlow's captureWelcomeEvent:
// analytics must never make billing controls fail closed.
export function captureBillingEvent(event: string, properties: Record<string, unknown>) {
  try {
    posthog.capture(event, properties);
  } catch {
    // Best-effort instrumentation only.
  }
}
export function isCryptoBillingUiEnabled() {
  return process.env.NEXT_PUBLIC_CRYPTO_BILLING_ENABLED === "true";
}
export function isBillingV2UiEnabled() {
  return process.env.NEXT_PUBLIC_BILLING_V2_ENABLED === "true";
}
export function isCreditTopUpsUiEnabled() {
  return process.env.NEXT_PUBLIC_CREDIT_TOPUPS_ENABLED === "true";
}
// Cosmetic gate for the "switch to a smaller plan" affordance. The SERVER route
// (/api/billing/change-plan) independently enforces HERMES_SELF_SERVE_DOWNGRADE_ENABLED,
// so leaving this NEXT_PUBLIC flag off simply hides the button; the route stays
// the source of truth. Both default OFF so the feature ships dark for canary.
export function isSelfServeDowngradeUiEnabled() {
  return process.env.NEXT_PUBLIC_SELF_SERVE_DOWNGRADE_ENABLED === "true";
}
export type CreditTopUpPackageCredits = (typeof CREDIT_TOP_UP_PACKAGES)[number]["credits"];
export type VerifiedWalletData = NonNullable<TokenHoldingData["wallet"]>;
export interface CryptoTopUpIntentData {
  referenceId: string;
  packageCredits: number;
  amountDisplay: string;
  depositAddress: string;
  asset: {
    symbol: string;
    network: string;
    label?: string;
  };
}
/**
 * Shape of a yearly $HermesOS quote returned by /api/billing/yearly-token-quote.
 * Server-persisted in `yearly_token_quotes`. Both the modal and the durable
 * top-of-page banner consume this shape; a refresh / back-nav restores the
 * exact same locked amount + deposit address + countdown.
 */
export interface YearlyTokenQuotePayload {
  id: string;
  tier: "pro" | "power";
  usdTargetCents: number;
  priceUsdAtQuote: string;
  tokensRequiredDisplay: string;
  tokenSymbol: string;
  depositAddress: string;
  expiresAt: string;
  status: string;
}
/**
 * Wire shape of a yearly_token_subscriptions row, served by GET
 * /api/billing/yearly-token-quote alongside the active quote. Drives
 * the post-pay progress stepper (paid → activated → swept) on the
 * dashboard banner without needing a reload.
 */
export interface YearlyTokenSubscriptionPayload {
  id: string;
  tier: "pro" | "power";
  /** The quote whose payment created this row (null for manual grants). */
  yearlyQuoteId: string | null;
  paidAt: string;
  expiresAt: string;
  status: "active" | "grace" | "expired" | "cancelled" | "renewed";
  sweepStatus: "pending" | "sweeping" | "swept" | "failed" | "skipped" | "needs_operator";
  sweepTxHash: string | null;
  amountReceivedRaw: string;
}
export type EthereumProvider = BrowserWalletProvider;
export type BrowserWalletWindow = Window & {
  ethereum?: EthereumProvider;
};
export function getBrowserWalletProvider(): EthereumProvider | null {
  if (typeof window === "undefined") return null;
  return (window as BrowserWalletWindow).ethereum ?? null;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
export async function readApiPayload(response: Response): Promise<Record<string, unknown> | null> {
  const payload = await readJsonWithDiagnostics(response, {
    source: "billing-page",
    route: "/dashboard/billing",
  });
  return isRecord(payload) ? payload : null;
}
export function apiPayloadError(payload: Record<string, unknown> | null, fallback: string) {
  return typeof payload?.error === "string" ? payload.error : fallback;
}
export function apiSuccessData(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (payload?.success !== true || !isRecord(payload.data)) return null;
  return payload.data;
}
export function interpolateCopy(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? `{${key}}`);
}
export function readWalletAccounts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}
export function readChallengeData(value: Record<string, unknown> | null) {
  if (
    !value ||
    typeof value.challengeId !== "string" ||
    typeof value.message !== "string"
  ) {
    return null;
  }

  return {
    challengeId: value.challengeId,
    message: value.message,
  };
}
export function readVerifiedWallet(value: Record<string, unknown> | null): VerifiedWalletData | null {
  if (!value || !isRecord(value.wallet)) return null;
  const wallet = value.wallet;
  if (
    typeof wallet.id !== "string" ||
    typeof wallet.address !== "string" ||
    typeof wallet.normalizedAddress !== "string" ||
    typeof wallet.chainId !== "number"
  ) {
    return null;
  }

  return {
    id: wallet.id,
    address: wallet.address,
    normalizedAddress: wallet.normalizedAddress,
    chainId: wallet.chainId,
    verifiedAt: typeof wallet.verifiedAt === "string" ? wallet.verifiedAt : null,
  };
}
export function readCryptoTopUpIntent(value: Record<string, unknown> | null): CryptoTopUpIntentData | null {
  if (!value || !isRecord(value.intent)) return null;
  const intent = value.intent;
  if (!isRecord(intent.asset)) return null;
  if (
    typeof intent.referenceId !== "string" ||
    typeof intent.packageCredits !== "number" ||
    typeof intent.amountDisplay !== "string" ||
    typeof intent.depositAddress !== "string" ||
    typeof intent.asset.symbol !== "string" ||
    typeof intent.asset.network !== "string"
  ) {
    return null;
  }

  return {
    referenceId: intent.referenceId,
    packageCredits: intent.packageCredits,
    amountDisplay: intent.amountDisplay,
    depositAddress: intent.depositAddress,
    asset: {
      symbol: intent.asset.symbol,
      network: intent.asset.network,
      label: typeof intent.asset.label === "string" ? intent.asset.label : undefined,
    },
  };
}
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
export function isManagedVeniceDiscountRate(value: unknown): value is ManagedVeniceDashboardSummary["discount"]["rate"] {
  return (
    value === "launch_20" ||
    value === "standard_10" ||
    value === "mixed_launch_standard" ||
    value === "none"
  );
}
export function readManagedVeniceKeySummary(value: unknown): ManagedVeniceKeySummary | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.keyPrefix !== "string" ||
    typeof value.status !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    keyPrefix: value.keyPrefix,
    status: value.status,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
    lastUsedAt: typeof value.lastUsedAt === "string" ? value.lastUsedAt : null,
    revokedAt: typeof value.revokedAt === "string" ? value.revokedAt : null,
  };
}
export function readManagedVeniceSummary(value: unknown): ManagedVeniceDashboardSummary | null {
  if (!isRecord(value)) return null;
  if (
    !isRecord(value.wallets) ||
    !isRecord(value.wallets.hermesos) ||
    !isRecord(value.wallets.card) ||
    !isRecord(value.discount) ||
    !isRecord(value.killSwitch) ||
    !Array.isArray(value.keys)
  ) {
    return null;
  }

  const hermesos = value.wallets.hermesos;
  const card = value.wallets.card;
  const discount = value.discount;
  const killSwitch = value.killSwitch;
  if (
    typeof hermesos.tokenDisplay !== "string" ||
    !isFiniteNumber(hermesos.lockedValueMicroUsd) ||
    !isFiniteNumber(hermesos.availableMicroUsd) ||
    !isFiniteNumber(hermesos.reservedMicroUsd) ||
    !Array.isArray(hermesos.lots) ||
    !isFiniteNumber(card.balanceMicroUsd) ||
    !isFiniteNumber(card.availableMicroUsd) ||
    !isFiniteNumber(card.reservedMicroUsd) ||
    !isManagedVeniceDiscountRate(discount.rate) ||
    !isFiniteNumber(discount.discountBps) ||
    !isFiniteNumber(discount.launchSubsidyUsedMicroUsd) ||
    !isFiniteNumber(discount.launchSubsidyCapMicroUsd) ||
    typeof killSwitch.active !== "boolean" ||
    !isFiniteNumber(killSwitch.weeklySubsidyUsedMicroUsd) ||
    !isFiniteNumber(killSwitch.thresholdMicroUsd)
  ) {
    return null;
  }

  return {
    wallets: {
      hermesos: {
        tokenDisplay: hermesos.tokenDisplay,
        lockedValueMicroUsd: hermesos.lockedValueMicroUsd,
        availableMicroUsd: hermesos.availableMicroUsd,
        reservedMicroUsd: hermesos.reservedMicroUsd,
        lots: hermesos.lots,
      },
      card: {
        balanceMicroUsd: card.balanceMicroUsd,
        availableMicroUsd: card.availableMicroUsd,
        reservedMicroUsd: card.reservedMicroUsd,
      },
    },
    discount: {
      rate: discount.rate,
      discountBps: discount.discountBps,
      launchSubsidyUsedMicroUsd: discount.launchSubsidyUsedMicroUsd,
      launchSubsidyCapMicroUsd: discount.launchSubsidyCapMicroUsd,
    },
    killSwitch: {
      active: killSwitch.active,
      weeklySubsidyUsedMicroUsd: killSwitch.weeklySubsidyUsedMicroUsd,
      thresholdMicroUsd: killSwitch.thresholdMicroUsd,
    },
    keys: value.keys
      .map(readManagedVeniceKeySummary)
      .filter((key): key is ManagedVeniceKeySummary => Boolean(key)),
  };
}
export function usdToMicroUsd(amountUsd: number) {
  return Math.round(normalizeManagedVeniceTopUpAmount(amountUsd) * 1_000_000);
}
export function shortenAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
