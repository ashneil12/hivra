/**
 * /token page content. Contract addresses come from the platform token
 * registry (the billing source of truth); this module only decides how the
 * page presents them. $HIVRA shows "not launched yet" until
 * hivra-token-launch.ts carries its address.
 */
import {
  HERMESOS_TOKEN,
  getConfiguredHivraToken,
  getHivraTokenPhase,
  type PlatformTokenKey,
} from "@/lib/billing/token-registry";

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

/** The two platform token entries in display order: $HIVRA first once it is configured. */
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

export const tokenVerificationContent = {
  metadata: {
    title: "Hivra token: current access and proposals",
    description: "Verify the existing $HermesOS contract, understand current holder access, and read the proposed $HIVRA migration. A wallet is optional.",
  },
  tokenDetails: {
    /** The $HermesOS contract, as published. Kept for existing page sections. */
    contractAddress: HERMESOS_TOKEN.publishedAddress,
  },
};
