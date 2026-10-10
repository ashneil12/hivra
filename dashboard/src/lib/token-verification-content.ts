/**
 * /token page content. Contract addresses come from the platform token
 * registry (the billing source of truth); this module only decides how the
 * page presents them. $HIVRA shows "not launched yet" until
 * hivra-token-launch.ts carries its address. Copy that changes with the
 * $HIVRA phase lives in token-phase-copy.ts.
 *
 * The official accounts, lookalike warning and risk line are token-facing
 * copy: factual only, and they need UK financial-promotion / legal review
 * before any Promote.
 *
 * Client-safe: no server imports.
 */
import {
  HERMESOS_TOKEN,
  getConfiguredHivraToken,
  getHivraTokenPhase,
  type HivraTokenPhase,
  type PlatformTokenKey,
} from "@/lib/billing/token-registry";
import { PUBLIC_PROJECT_LINKS } from "@/lib/public-project-links";
import { SUPPORT_DISCORD_URL } from "@/lib/support-channels";

export type TokenPageEntryStatus = "legacy" | "live" | "scheduled" | "not_launched";

export interface TokenPageEntry {
  key: PlatformTokenKey;
  /** Canonical label, e.g. "$HermesOS". */
  label: string;
  status: TokenPageEntryStatus;
  /** Published contract address, or null before $HIVRA launches. */
  contractAddress: string | null;
  basescanUrl: string | null;
  activatesAt: string | null;
}

export function basescanTokenUrl(address: string): string {
  return `https://basescan.org/token/${address}`;
}

/** The two platform token entries in display order: $HIVRA first once it is live. */
export function getTokenPageEntries(now: Date = new Date()): TokenPageEntry[] {
  const hivra = getConfiguredHivraToken();
  const phase = getHivraTokenPhase(now);
  const hivraEntry: TokenPageEntry = {
    key: "hivra",
    label: "$HIVRA",
    status: phase === "active" ? "live" : phase === "scheduled" ? "scheduled" : "not_launched",
    contractAddress: hivra?.publishedAddress ?? null,
    basescanUrl: hivra ? basescanTokenUrl(hivra.publishedAddress) : null,
    activatesAt: hivra?.activatesAt?.toISOString() ?? null,
  };
  const hermesosEntry: TokenPageEntry = {
    key: "hermesos",
    label: HERMESOS_TOKEN.displayUnit,
    status: phase === "active" ? "legacy" : "live",
    contractAddress: HERMESOS_TOKEN.publishedAddress,
    basescanUrl: basescanTokenUrl(HERMESOS_TOKEN.publishedAddress),
    activatesAt: null,
  };
  return phase === "active" ? [hivraEntry, hermesosEntry] : [hermesosEntry, hivraEntry];
}

/**
 * The $HIVRA phase the entries were built for. The entries are computed on the
 * server at render, so the page reads the phase from them rather than from
 * the viewer's clock.
 */
export function tokenPhaseFromEntries(entries: readonly TokenPageEntry[]): HivraTokenPhase {
  const status = entries.find((entry) => entry.key === "hivra")?.status;
  if (status === "live") return "active";
  if (status === "scheduled") return "scheduled";
  return "dormant";
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/** A UTC instant as "1 October 2026, 16:00 UTC", the same on server and client. */
export function formatLaunchInstantUtc(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  const seconds = date.getUTCSeconds() ? `:${pad(date.getUTCSeconds())}` : "";
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}${seconds} UTC`;
}

export interface OfficialAccount {
  /** Where the account lives, e.g. "X". */
  service: string;
  /** The exact handle or address to compare, e.g. "@HivraOS". */
  handle: string;
  href: string;
}

const OFFICIAL_X_URL = "https://x.com/HivraOS";

function officialAccounts(): OfficialAccount[] {
  const accounts: OfficialAccount[] = [
    { service: "X", handle: "@HivraOS", href: OFFICIAL_X_URL },
    { service: "Discord", handle: SUPPORT_DISCORD_URL.replace(/^https:\/\//, ""), href: SUPPORT_DISCORD_URL },
  ];
  // Listed only while the public repository is published (public-project-links.ts).
  const repository = PUBLIC_PROJECT_LINKS.repository;
  if (repository.status === "published") {
    accounts.push({ service: "GitHub", handle: repository.href.replace(/^https:\/\//, ""), href: repository.href });
  }
  return accounts;
}

export const tokenVerificationContent = {
  tokenDetails: {
    /** The $HermesOS contract, as published. Kept for existing page sections. */
    contractAddress: HERMESOS_TOKEN.publishedAddress,
  },
  officialAccounts: officialAccounts(),
  noTelegram: "Hivra has no Telegram. Anyone offering a Hivra Telegram, airdrop, presale or claim in DMs is not Hivra.",
  lookalikeWarning:
    "Tokens named Hivra, HivraOS or HIVRA at other addresses on Base have nothing to do with Hivra. Compare the full address with this page.",
  riskLine: "This page is information, not an offer or an invitation to buy. Cryptoassets can lose all of their value.",
} as const;
