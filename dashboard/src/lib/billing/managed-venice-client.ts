import { normalizeManagedVeniceTopUpAmount } from "@/lib/venice/managed-credit-topup";

export interface ManagedVeniceTokenQuotePayload {
  id: string;
  tokenAmountRaw: string;
  tokenSymbol: string;
  tokenDecimals: number;
  snapshotPriceUsd: string;
  paidValueMicroUsd: number;
  creditValueMicroUsd: number;
  bonusValueMicroUsd: number;
  depositAddress: string;
  expiresAt: string;
  status: string;
  transactionHash?: string | null;
  settledAt?: string | null;
}

export type ManagedVeniceHermesQuoteResult =
  | { ok: true; quote: ManagedVeniceTokenQuotePayload }
  | { ok: false; message: string; reason?: string };

export type ManagedVeniceHermesQuoteCheckResult =
  | {
      ok: true;
      status: string;
      quote?: ManagedVeniceTokenQuotePayload;
      confirmations?: number;
      transactionHash?: string;
    }
  | { ok: false; message: string; reason?: string };

export interface ManagedVeniceWalletSummaryPayload {
  wallets: {
    hermesos: {
      tokenDisplay: string;
      lockedValueMicroUsd: number;
      availableMicroUsd: number;
      reservedMicroUsd: number;
    };
    card: {
      balanceMicroUsd: number;
      availableMicroUsd: number;
      reservedMicroUsd: number;
    };
  };
  discount?: {
    rate: string;
    discountBps: number;
    launchSubsidyUsedMicroUsd: number;
    launchSubsidyCapMicroUsd: number;
  };
  killSwitch?: {
    active: boolean;
    weeklySubsidyUsedMicroUsd: number;
    thresholdMicroUsd: number;
  };
  keys?: Array<{
    id: string;
    name: string;
    keyPrefix: string;
    status: string;
    createdAt: string | null;
    updatedAt: string | null;
    lastUsedAt: string | null;
    revokedAt: string | null;
    pausedReason: string | null;
    defaultWalletType: "hermesos" | "card";
  }>;
}

export type ManagedVeniceSummaryResult =
  | { ok: true; summary: ManagedVeniceWalletSummaryPayload }
  | { ok: false; message: string; reason?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

async function readApiPayload(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const payload = await response.json();
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function apiPayloadError(payload: Record<string, unknown> | null, fallback: string) {
  return typeof payload?.error === "string" ? payload.error : fallback;
}

function apiPayloadReason(payload: Record<string, unknown> | null) {
  return typeof payload?.reason === "string" ? payload.reason : undefined;
}

function apiSuccessData(payload: Record<string, unknown> | null): Record<string, unknown> | null {
  if (payload?.success !== true || !isRecord(payload.data)) return null;
  return payload.data;
}

export function readManagedVeniceTokenQuote(value: Record<string, unknown> | null): ManagedVeniceTokenQuotePayload | null {
  if (!value) return null;
  if (
    typeof value.id !== "string" ||
    typeof value.tokenAmountRaw !== "string" ||
    typeof value.tokenSymbol !== "string" ||
    typeof value.tokenDecimals !== "number" ||
    typeof value.snapshotPriceUsd !== "string" ||
    typeof value.paidValueMicroUsd !== "number" ||
    typeof value.creditValueMicroUsd !== "number" ||
    typeof value.bonusValueMicroUsd !== "number" ||
    typeof value.depositAddress !== "string" ||
    typeof value.expiresAt !== "string" ||
    typeof value.status !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    tokenAmountRaw: value.tokenAmountRaw,
    tokenSymbol: value.tokenSymbol,
    tokenDecimals: value.tokenDecimals,
    snapshotPriceUsd: value.snapshotPriceUsd,
    paidValueMicroUsd: value.paidValueMicroUsd,
    creditValueMicroUsd: value.creditValueMicroUsd,
    bonusValueMicroUsd: value.bonusValueMicroUsd,
    depositAddress: value.depositAddress,
    expiresAt: value.expiresAt,
    status: value.status,
    transactionHash: typeof value.transactionHash === "string" ? value.transactionHash : null,
    settledAt: typeof value.settledAt === "string" ? value.settledAt : null,
  };
}

export function managedVeniceUsdToMicroUsd(amountUsd: number) {
  return Math.round(normalizeManagedVeniceTopUpAmount(amountUsd) * 1_000_000);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readManagedVeniceDiscountSummary(value: unknown) {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.rate !== "string" ||
    !isFiniteNumber(value.discountBps) ||
    !isFiniteNumber(value.launchSubsidyUsedMicroUsd) ||
    !isFiniteNumber(value.launchSubsidyCapMicroUsd)
  ) {
    return undefined;
  }

  return {
    rate: value.rate,
    discountBps: value.discountBps,
    launchSubsidyUsedMicroUsd: value.launchSubsidyUsedMicroUsd,
    launchSubsidyCapMicroUsd: value.launchSubsidyCapMicroUsd,
  };
}

function readManagedVeniceKillSwitchSummary(value: unknown) {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.active !== "boolean" ||
    !isFiniteNumber(value.weeklySubsidyUsedMicroUsd) ||
    !isFiniteNumber(value.thresholdMicroUsd)
  ) {
    return undefined;
  }

  return {
    active: value.active,
    weeklySubsidyUsedMicroUsd: value.weeklySubsidyUsedMicroUsd,
    thresholdMicroUsd: value.thresholdMicroUsd,
  };
}

function nullableString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readManagedVeniceProxyKeys(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const keys = [];

  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.keyPrefix !== "string" ||
      typeof item.status !== "string"
    ) {
      continue;
    }

    keys.push({
      id: item.id,
      name: item.name,
      keyPrefix: item.keyPrefix,
      status: item.status,
      createdAt: nullableString(item.createdAt),
      updatedAt: nullableString(item.updatedAt),
      lastUsedAt: nullableString(item.lastUsedAt),
      revokedAt: nullableString(item.revokedAt),
      pausedReason: nullableString(item.pausedReason),
      defaultWalletType: item.defaultWalletType === "card" ? "card" as const : "hermesos" as const,
    });
  }

  return keys;
}

export function readManagedVeniceSummary(
  value: Record<string, unknown> | null
): ManagedVeniceWalletSummaryPayload | null {
  if (!value || !isRecord(value.wallets)) return null;
  const wallets = value.wallets;
  if (!isRecord(wallets.hermesos) || !isRecord(wallets.card)) return null;

  const hermesos = wallets.hermesos;
  const card = wallets.card;
  if (
    typeof hermesos.tokenDisplay !== "string" ||
    !isFiniteNumber(hermesos.lockedValueMicroUsd) ||
    !isFiniteNumber(hermesos.availableMicroUsd) ||
    !isFiniteNumber(hermesos.reservedMicroUsd) ||
    !isFiniteNumber(card.balanceMicroUsd) ||
    !isFiniteNumber(card.availableMicroUsd) ||
    !isFiniteNumber(card.reservedMicroUsd)
  ) {
    return null;
  }

  const summary: ManagedVeniceWalletSummaryPayload = {
    wallets: {
      hermesos: {
        tokenDisplay: hermesos.tokenDisplay,
        lockedValueMicroUsd: hermesos.lockedValueMicroUsd,
        availableMicroUsd: hermesos.availableMicroUsd,
        reservedMicroUsd: hermesos.reservedMicroUsd,
      },
      card: {
        balanceMicroUsd: card.balanceMicroUsd,
        availableMicroUsd: card.availableMicroUsd,
        reservedMicroUsd: card.reservedMicroUsd,
      },
    },
  };

  const discount = readManagedVeniceDiscountSummary(value.discount);
  if (discount) summary.discount = discount;

  const killSwitch = readManagedVeniceKillSwitchSummary(value.killSwitch);
  if (killSwitch) summary.killSwitch = killSwitch;

  const keys = readManagedVeniceProxyKeys(value.keys);
  if (keys) summary.keys = keys;

  return summary;
}

export async function requestManagedVeniceSummary(): Promise<ManagedVeniceSummaryResult> {
  try {
    const response = await fetch("/api/billing/managed-venice/summary");
    const payload = await readApiPayload(response);
    if (!response.ok) {
      return {
        ok: false,
        message: apiPayloadError(payload, "Managed Venice wallet balance is unavailable."),
        reason: apiPayloadReason(payload),
      };
    }
    const summary = readManagedVeniceSummary(apiSuccessData(payload));
    if (!summary) {
      return {
        ok: false,
        message: "Managed Venice wallet response was incomplete.",
      };
    }
    return { ok: true, summary };
  } catch {
    return {
      ok: false,
      message: "Managed Venice wallet balance is unavailable.",
    };
  }
}

const HERMES_TOP_UP_FALLBACK_MESSAGE =
  "We couldn't start the $HermesOS top-up yet. Please try again in a moment, or use card credits for now.";

export async function requestManagedVeniceHermesQuote(amountUsd: number): Promise<ManagedVeniceHermesQuoteResult> {
  try {
    const response = await fetch("/api/billing/managed-venice/hermesos/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetPaidMicroUsd: managedVeniceUsdToMicroUsd(amountUsd) }),
    });
    const payload = await readApiPayload(response);
    if (!response.ok) {
      return {
        ok: false,
        message: apiPayloadError(payload, HERMES_TOP_UP_FALLBACK_MESSAGE),
        reason: apiPayloadReason(payload),
      };
    }
    const quote = readManagedVeniceTokenQuote(apiSuccessData(payload));
    if (!quote) {
      return {
        ok: false,
        message: "Quote response was incomplete. Please try again.",
      };
    }
    return { ok: true, quote };
  } catch {
    return {
      ok: false,
      message: HERMES_TOP_UP_FALLBACK_MESSAGE,
    };
  }
}

export async function checkManagedVeniceHermesQuote(
  quoteId: string
): Promise<ManagedVeniceHermesQuoteCheckResult> {
  try {
    const response = await fetch("/api/billing/managed-venice/hermesos/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quoteId }),
    });
    const payload = await readApiPayload(response);
    if (!response.ok) {
      return {
        ok: false,
        message: apiPayloadError(payload, "We couldn't check Base right now. Try Verify payment again in a moment."),
        reason: apiPayloadReason(payload),
      };
    }
    const data = apiSuccessData(payload);
    if (!data || typeof data.status !== "string") {
      return {
        ok: false,
        message: "Top-up check response was incomplete.",
      };
    }
    const quote = readManagedVeniceTokenQuote(
      isRecord(data.quote) ? data.quote : null
    );
    return {
      ok: true,
      status: data.status,
      quote: quote ?? undefined,
      confirmations: typeof data.confirmations === "number" ? data.confirmations : undefined,
      transactionHash: typeof data.transactionHash === "string" ? data.transactionHash : undefined,
    };
  } catch {
    return {
      ok: false,
      message: "We couldn't check Base right now. Try Verify payment again in a moment.",
    };
  }
}
