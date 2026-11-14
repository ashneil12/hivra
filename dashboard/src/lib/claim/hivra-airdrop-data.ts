/**
 * Whether the /token/airdrop lookup is open, the list it reads, and the Sablier
 * claim link.
 *
 * The list is src/data/token/hivra-airdrop.json, written by
 * scripts/token/build-hivra-airdrop.mjs and committed by a reviewed PR. Until
 * then it is the JSON `null`. It lives under src/, not public/, so the only
 * way to read an amount from the served app is the lookup page, which asks the
 * token geo gate first (a static file in public/ would reach every country).
 *
 * The lookup is open only when ALL of these hold, and is hidden otherwise:
 *   1. $HIVRA's launch block is filled in (hivra-token-launch.ts), so the
 *      phase is scheduled or active;
 *   2. the snapshot is published in hivra-airdrop-config.ts (block and URL);
 *   3. the committed list passes every check in hivra-airdrop-lookup.ts;
 *   4. the list was built at that same snapshot block.
 *
 * The Sablier claim link is a separate, later gate (claimHrefOf in
 * hivra-claim.ts, applied by /token/airdrop and /token/migration): it appears
 * only while the configured claim window is open, and nowhere else.
 *
 * Server-only: the full list never reaches a browser bundle.
 */
import "server-only";

import rawAirdropList from "@/data/token/hivra-airdrop.json";
import { getConfiguredHivraToken, getHivraTokenPhase } from "@/lib/billing/token-registry";
import { log } from "@/lib/logger";
import { newTokenSurfacesEnabled } from "@/lib/token-surfaces";

import { HIVRA_AIRDROP, type HivraAirdropConfig } from "./hivra-airdrop-config";
import { resolveAirdropFacts, type AirdropSnapshot, type TokenPageAirdropFacts } from "./conversion-state";
import { NO_CLAIM, type ResolvedHivraClaim } from "./hivra-claim";
import { parseHivraAirdropData, type ParsedHivraAirdrop } from "./hivra-airdrop-lookup";

export type OpenHivraAirdrop = {
  airdrop: ParsedHivraAirdrop;
  snapshot: AirdropSnapshot;
  /** The Airdrop wallet that funds the Sablier campaign. */
  senderAddress: string | null;
  /** The Sablier claim at the time of the request (hivra-claim.ts). */
  claim: ResolvedHivraClaim;
};

export type HivraAirdropLookupInputs = {
  /** Test seams; default to the committed launch block, airdrop config and list. */
  now?: Date;
  hivraAddress?: string | null;
  config?: HivraAirdropConfig;
  raw?: unknown;
};

const LOG_SOURCE = "claim/hivra-airdrop-data";
let reportedRaw: unknown = undefined;

function reportOnce(raw: unknown, message: string, problems: string[]) {
  if (reportedRaw === raw) return;
  reportedRaw = raw;
  log.error(message, null, { source: LOG_SOURCE, failureType: "hivra_airdrop_list_rejected", problems: problems.slice(0, 10).join("; ") });
}

const reportedConfig = new Set<string>();

/** A set but invalid config value is a release defect: log it once per distinct problem list, never render it. */
function reportConfigOnce(problems: string[]) {
  if (problems.length === 0) return;
  const key = problems.join("; ");
  if (reportedConfig.has(key)) return;
  if (reportedConfig.size > 50) reportedConfig.clear();
  reportedConfig.add(key);
  log.warn("HIVRA airdrop config rejected", {
    source: LOG_SOURCE,
    failureType: "hivra_airdrop_config_rejected",
    problems: problems.slice(0, 20).join("; "),
  });
}

const parsedCache = new WeakMap<object, ReturnType<typeof parseHivraAirdropData>>();

function parseCached(raw: unknown) {
  if (typeof raw !== "object" || raw === null) return parseHivraAirdropData(raw);
  let parsed = parsedCache.get(raw);
  if (!parsed) {
    parsed = parseHivraAirdropData(raw);
    parsedCache.set(raw, parsed);
  }
  return parsed;
}

/** The lookup's data when it is open (see above), else null. */
export function getOpenHivraAirdrop(inputs: HivraAirdropLookupInputs = {}): OpenHivraAirdrop | null {
  const now = inputs.now ?? new Date();
  const hivraAddress = inputs.hivraAddress !== undefined
    ? inputs.hivraAddress
    : getHivraTokenPhase(now) === "dormant" ? null : getConfiguredHivraToken()?.address ?? null;
  if (!hivraAddress) return null;

  const { snapshot, senderAddress, claim, problems } = resolveAirdropFacts(inputs.config ?? HIVRA_AIRDROP, hivraAddress, now);
  reportConfigOnce(problems);
  if (!snapshot) return null;

  const raw = "raw" in inputs ? inputs.raw : (rawAirdropList as unknown);
  // The JSON null is the committed "not published yet" state, not a problem.
  if (raw === null) return null;
  const parsed = parseCached(raw);
  if (!parsed.ok) {
    reportOnce(raw, "HIVRA airdrop list rejected; the lookup stays hidden", parsed.problems);
    return null;
  }
  if (parsed.airdrop.data.snapshotBlock !== snapshot.block) {
    reportOnce(raw, "HIVRA airdrop list is for another snapshot block; the lookup stays hidden", [
      `list block ${parsed.airdrop.data.snapshotBlock}, config block ${snapshot.block}`,
    ]);
    return null;
  }
  return { airdrop: parsed.airdrop, snapshot, senderAddress, claim: claim ?? NO_CLAIM };
}

/** Where the lookup is served. */
export const HIVRA_AIRDROP_LOOKUP_PATH = "/token/airdrop";

/**
 * The lookup's data when /token/airdrop actually serves it: the new token
 * surfaces are switched on (HIVRA_NEW_TOKEN_SURFACES) and the list is open
 * (getOpenHivraAirdrop). This is the page's own 404 check, so a link built
 * from it never points at a 404.
 */
export function getServedHivraAirdrop(
  inputs: HivraAirdropLookupInputs & { env?: Record<string, string | undefined> } = {},
): OpenHivraAirdrop | null {
  if (!newTokenSurfacesEnabled(inputs.env)) return null;
  return getOpenHivraAirdrop(inputs);
}

/**
 * The lookup link for another page, or null when the lookup is not served. The
 * caller passes null instead for a viewer the token geo-policy blocks.
 */
export function hivraAirdropLookupHref(
  inputs: HivraAirdropLookupInputs & { env?: Record<string, string | undefined> } = {},
): string | null {
  return getServedHivraAirdrop(inputs) ? HIVRA_AIRDROP_LOOKUP_PATH : null;
}

/**
 * What /token shows about the airdrop, resolved on the server at `now`: the
 * published snapshot (block, link, and the time it was taken) and the Airdrop
 * wallet. /token passes it down as props so the page's client code never
 * imports the airdrop config, which also holds the Sablier campaign link and
 * the claim window. A set but invalid config value is left out and reported
 * once, like every other reader of the config.
 */
export function getTokenPageAirdropFacts(
  hivraAddress: string,
  { now = new Date(), config = HIVRA_AIRDROP }: { now?: Date; config?: HivraAirdropConfig } = {},
): TokenPageAirdropFacts {
  const { snapshot, senderAddress, problems } = resolveAirdropFacts(config, hivraAddress, now);
  reportConfigOnce(problems);
  return { snapshot, senderAddress };
}
