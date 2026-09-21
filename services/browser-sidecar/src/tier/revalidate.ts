import type { Logger } from "../logger.js";
import type { Config } from "../config.js";

// SCRIPTURE_ANCHOR: tier-fruit | Matthew 7:20 | Verse: Therefore by their fruits you will know them.
export interface TierCheckResult {
  ok: boolean;
  tier?: string;
  reason?: string;
}

// Layer 2 of the tier-gating defense.
//
// Runs once on container start. Hits the dashboard's internal tier-check endpoint
// with the instance ID and a signed token. The dashboard's response is the source
// of truth — this code does not interpret tier values, it just trusts the boolean.
//
// On non-200 or tier_ok=false: caller (server.ts) exits 0. The watchdog/reconcile
// job stops restarting the container.
//
// On network failure: we fail OPEN, not CLOSED. Layer 1 (provisioning) means the
// container only exists if the user qualified; transient dashboard outages should
// not knock out paying users mid-session. The reconcile job catches lingering
// downgrades within minutes via the webhook path.
export async function revalidateTierOrExit(
  config: Config,
  logger: Logger,
): Promise<TierCheckResult> {
  const tierEnvPresence = [
    Boolean(config.TIER_CHECK_URL),
    Boolean(config.TIER_CHECK_INSTANCE_ID),
    Boolean(config.TIER_CHECK_TOKEN),
  ];
  const presentCount = tierEnvPresence.filter(Boolean).length;

  if (presentCount === 0) {
    // Intentional disable: all three env vars are empty. Tests + dev rely on
    // this path. Provisioning seeds all three, so a production VM that hits
    // this branch is "tier-check explicitly off" rather than misconfigured.
    logger.warn(
      "tier-check disabled: TIER_CHECK_URL/INSTANCE_ID/TOKEN all unset. Provisioning gate (Layer 1) is the only barrier.",
    );
    return { ok: true, reason: "disabled" };
  }

  if (presentCount < 3) {
    // Partial misconfig: an operator set some but not all of the three env
    // vars. Previously this silently fell back to disabled, which masked
    // ops typos. Fail closed at startup so the deploy fails loudly instead.
    logger.error(
      {
        TIER_CHECK_URL: Boolean(config.TIER_CHECK_URL),
        TIER_CHECK_INSTANCE_ID: Boolean(config.TIER_CHECK_INSTANCE_ID),
        TIER_CHECK_TOKEN: Boolean(config.TIER_CHECK_TOKEN),
      },
      "tier-check misconfigured: some but not all of TIER_CHECK_URL/INSTANCE_ID/TOKEN are set; refusing to start",
    );
    return { ok: false, reason: "tier-check-misconfigured" };
  }

  // presentCount === 3 here, so all three are set; re-narrow for the type
  // system (and fail closed in the otherwise-impossible empty case).
  const { TIER_CHECK_URL, TIER_CHECK_INSTANCE_ID, TIER_CHECK_TOKEN } = config;
  if (!TIER_CHECK_URL || !TIER_CHECK_INSTANCE_ID || !TIER_CHECK_TOKEN) {
    return { ok: false, reason: "tier-check-misconfigured" };
  }

  const url = new URL(TIER_CHECK_URL);
  url.searchParams.set("instance_id", TIER_CHECK_INSTANCE_ID);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${TIER_CHECK_TOKEN}` },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, "tier-check non-200; failing open");
      return { ok: true, reason: "dashboard-unreachable" };
    }

    const body = (await res.json()) as { tier_ok?: boolean; tier?: string };
    if (body.tier_ok === false) {
      logger.error({ tier: body.tier }, "tier-check returned tier_ok=false; refusing to start");
      return { ok: false, tier: body.tier, reason: "tier-revoked" };
    }
    logger.info({ tier: body.tier }, "tier-check passed");
    return { ok: true, tier: body.tier };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "tier-check fetch failed; failing open");
    return { ok: true, reason: "fetch-error" };
  }
}
