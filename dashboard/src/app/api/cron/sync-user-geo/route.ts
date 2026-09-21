import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { reportOpsEvent } from "@/lib/ops-events";

// If more than this fraction of per-user session lookups fail (Clerk outage /
// sustained 429s), the resolved country distribution is NOT representative —
// writing it would overwrite the last good geo with a corrupted, under-counted
// aggregate. Above this threshold we keep the prior geo and flag the run.
const MAX_SESSION_FAILURE_RATE = 0.2;

/**
 * Sync the platform's country distribution from Clerk into `public.platform_geo`.
 *
 * Clerk is the real geography source: each user's latest session carries an
 * IP-geo country (the dashboard's `signup_risk_assessments` table only ever held
 * a sliver). We page every Clerk user, read their latest session's country,
 * normalize the name/ISO mix Clerk returns to canonical ISO-2 codes, and upsert
 * the aggregate `{ ISO2: user_count }` (+ distinct count) as a single row.
 *
 * `get_public_stats` ("Countries") and the daily rollup's country_distribution
 * both read from this row. Counts only — no per-user geo is stored.
 */

export const maxDuration = 300;

const CLERK_API = "https://api.clerk.com/v1";
const PAGE = 500;
const CONCURRENCY = 10;

// Clerk returns `latest_activity.country` as EITHER an ISO-2 code ("US") or an
// English name ("United States") depending on when the session was recorded.
// Normalize everything to ISO-2. Build a name→code map from Intl over the full
// ISO-3166 alpha-2 list, plus aliases for Clerk's non-canonical spellings.
const ALPHA2 =
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(
    " "
  );

const ALIASES: Record<string, string> = {
  "the netherlands": "NL",
  "united states of america": "US",
  "south korea": "KR",
  "north korea": "KP",
  "czech republic": "CZ",
  "ivory coast": "CI",
  "russia": "RU",
  "vietnam": "VN",
  "laos": "LA",
  "syria": "SY",
  "moldova": "MD",
  "bolivia": "BO",
  "venezuela": "VE",
  "tanzania": "TZ",
  "macau": "MO",
  "myanmar": "MM",
  "türkiye": "TR",
  "turkey": "TR",
};

function buildNameToCode(): Record<string, string> {
  const map: Record<string, string> = { ...ALIASES };
  try {
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    for (const code of ALPHA2) {
      const name = dn.of(code);
      if (name && name.toUpperCase() !== code) map[name.toLowerCase()] = code;
    }
  } catch {
    /* Intl unavailable — aliases + ISO passthrough still cover the common cases */
  }
  return map;
}

const NAME_TO_CODE = buildNameToCode();

function normalizeCountry(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return NAME_TO_CODE[s.toLowerCase()] ?? null;
}

async function clerkGet(path: string, key: string, tries = 4): Promise<unknown> {
  for (let t = 0; t < tries; t++) {
    const res = await fetch(`${CLERK_API}${path}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1000 * (t + 1)));
      continue;
    }
    if (!res.ok) return null;
    return res.json();
  }
  return null;
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("missing CRON_SECRET"), {
      source: "sync-user-geo",
      route: "/api/cron/sync-user-geo",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }
  if (!supabaseAdmin) {
    return apiError("Supabase service role is not configured", 500);
  }
  const clerkKeyRaw = process.env.CLERK_SECRET_KEY?.trim();
  if (!clerkKeyRaw) {
    return apiError("CLERK_SECRET_KEY is not configured", 500);
  }
  const key: string = clerkKeyRaw;

  // 1. Page every Clerk user; collect ids + signup dates (created_at is a ms
  //    epoch) bucketed by UTC day for signups_by_day.
  const userIds: string[] = [];
  const signupsByDay: Record<string, number> = {};
  for (let offset = 0; ; offset += PAGE) {
    const batch = (await clerkGet(`/users?limit=${PAGE}&offset=${offset}`, key)) as
      | Array<{ id: string; created_at?: number }>
      | null;
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const u of batch) {
      if (!u?.id) continue;
      userIds.push(u.id);
      if (typeof u.created_at === "number" && Number.isFinite(u.created_at)) {
        const day = new Date(u.created_at).toISOString().slice(0, 10);
        signupsByDay[day] = (signupsByDay[day] ?? 0) + 1;
      }
    }
    if (batch.length < PAGE) break;
  }
  const totalUsers = userIds.length;

  // 2. Resolve each user's latest-session country (bounded concurrency).
  const counts: Record<string, number> = {};
  let withGeo = 0;
  // Count session lookups that FAILED outright (clerkGet returned null after
  // exhausting retries) vs ones that simply had no country. Only the former
  // signals a degraded run that could corrupt the aggregate.
  let sessionFailures = 0;
  let idx = 0;
  async function worker() {
    while (idx < userIds.length) {
      const id = userIds[idx++];
      const sessions = (await clerkGet(`/sessions?user_id=${id}&limit=1`, key)) as
        | Array<{ latest_activity?: { country?: string } }>
        | null;
      if (sessions === null) {
        // Request failed (non-429 error or retries exhausted) — this user
        // contributes no geo NOT because they have none, but because we
        // couldn't read it. Track it so a partial Clerk outage doesn't quietly
        // overwrite good geo with an under-counted distribution.
        sessionFailures++;
        continue;
      }
      const raw = Array.isArray(sessions) ? sessions[0]?.latest_activity?.country : undefined;
      const code = normalizeCountry(raw);
      if (code) {
        counts[code] = (counts[code] ?? 0) + 1;
        withGeo++;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const distinct = Object.keys(counts).length;
  const sessionFailureRate = totalUsers > 0 ? sessionFailures / totalUsers : 0;
  // A degraded run (too many session lookups failed) yields a non-representative
  // distribution. We still refresh user + signup counts (those came from the
  // page fetch and are reliable), but we must NOT overwrite the prior geo.
  const geoDegraded = sessionFailureRate > MAX_SESSION_FAILURE_RATE;

  // No users came back = almost certainly a failed/empty Clerk fetch — don't
  // wipe the existing aggregate.
  if (totalUsers === 0) {
    log.warn("sync-user-geo got 0 users; leaving platform_geo unchanged", {
      source: "sync-user-geo",
    });
    return apiSuccess({ users: 0, withGeo, distinct, updated: false });
  }

  // Degraded run: too many session lookups failed for the distribution to be
  // representative. Preserve the prior geo and flag it so a Clerk outage can't
  // silently corrupt the aggregate (the totalUsers===0 guard below only catches
  // a TOTAL collapse, not a partial one). User/signup counts still refresh.
  if (geoDegraded) {
    log.warn("sync-user-geo run degraded; preserving prior geo", {
      source: "sync-user-geo",
      route: "/api/cron/sync-user-geo",
      failureType: "sync_user_geo_degraded",
      totalUsers,
      sessionFailures,
      sessionFailureRate: Number(sessionFailureRate.toFixed(3)),
    });
    await reportOpsEvent({
      source: "cron.sync-user-geo",
      severity: "warn",
      title: "sync-user-geo run degraded; geo not updated",
      message:
        `${sessionFailures}/${totalUsers} Clerk session lookups failed ` +
        `(${(sessionFailureRate * 100).toFixed(1)}% > ${(MAX_SESSION_FAILURE_RATE * 100).toFixed(0)}% threshold), ` +
        `so the resolved country distribution is not representative. Kept the last good geo ` +
        `rather than overwrite it. Likely a Clerk outage or sustained rate-limiting.`,
      route: "/api/cron/sync-user-geo",
      metadata: {
        failureType: "sync_user_geo_degraded",
        totalUsers,
        sessionFailures,
        sessionFailureRate: Number(sessionFailureRate.toFixed(3)),
      },
    });
  }

  // 3. Upsert the singleton aggregate. Always refresh user + signup counts; only
  //    overwrite the geo fields when we actually resolved geo AND the run was
  //    not degraded (else preserve the last good country distribution).
  const writeGeo = distinct > 0 && !geoDegraded;
  const payload: Record<string, unknown> = {
    id: 1,
    total_users: totalUsers,
    signups_by_day: signupsByDay,
    generated_at: new Date().toISOString(),
  };
  if (writeGeo) {
    payload.country_distribution = counts;
    payload.distinct_countries = distinct;
    payload.users_with_geo = withGeo;
  }

  const { error } = await supabaseAdmin.from("platform_geo").upsert(payload, { onConflict: "id" });

  if (error) {
    log.error("platform_geo upsert failed", new Error(error.message || "upsert error"), {
      source: "sync-user-geo",
      route: "/api/cron/sync-user-geo",
      failureType: "platform_geo_upsert_failed",
    });
    return apiError("Failed to upsert platform_geo", 500);
  }

  return apiSuccess({
    users: totalUsers,
    withGeo,
    distinct,
    updated: true,
    geoUpdated: writeGeo,
    sessionFailures,
    degraded: geoDegraded,
  });
}
