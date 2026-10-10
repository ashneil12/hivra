import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import {
  GscApiError,
  type GscServiceAccount,
  getServiceAccountFromEnv,
  inspectUrl,
} from "@/lib/seo/gsc-client";
import { SITE_URL, getSiteUrls } from "@/lib/seo-urls";
import { supabaseAdmin } from "@/lib/supabase";

const SOURCE = "cron/seo-index-coverage";
const ROUTE = "/api/cron/seo/index-coverage";

/**
 * Weekly index-coverage sweep. For every URL in getSiteUrls() (the sitemap
 * source of truth) it asks the GSC URL Inspection API whether Google has the
 * page indexed, and records the answer in `public.seo_index_coverage`.
 *
 * Why this is not redundant with gsc-pull: seo_gsc_daily only ever contains
 * pages that earned an impression. A page missing from it might be unindexed,
 * or indexed and simply never surfacing — opposite problems with opposite
 * fixes (crawl/technical vs content/relevance). Only URL Inspection separates
 * them, and it also surfaces googleCanonical drift, which the impression data
 * cannot show at all.
 *
 * Like gsc-pull, a 403 means the service account has not been granted on the
 * property yet. That is an expected pre-launch state, so it responds 200 with
 * { ok: false, reason: "gsc_permission_pending" } rather than failing the cron.
 *
 * Quota is 2,000 inspections/day and 600/minute per property; the sitemap is
 * well under 100 URLs, so a weekly full sweep costs a rounding error of the
 * daily allowance. A 429 still stops the sweep early and reports it instead of
 * burning what is left.
 */

// One inspection is a real round-trip to Google; a full sitemap sweep needs
// the repo's long-cron budget rather than the default.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Google rate-limits per property, and this is a background sweep with no
// deadline pressure, so stay deliberately gentle.
const CONCURRENCY = 3;
// Stop pulling new URLs past this point so in-flight inspections + the final
// upsert finish safely under maxDuration. URLs skipped here are picked up by
// the next run, which starts from the staleest rows.
const DEADLINE_MS = 270_000;

interface CoverageRow {
  url: string;
  site: string;
  last_checked: string;
  verdict: string | null;
  coverage_state: string | null;
  robots_txt_state: string | null;
  indexing_state: string | null;
  page_fetch_state: string | null;
  google_canonical: string | null;
  user_canonical: string | null;
  last_crawl_time: string | null;
  notes: string | null;
}

/**
 * The GSC property matching our own site. Derived rather than hardcoded so a
 * domain change cannot leave this route silently inspecting the wrong property.
 */
export function siteProperty(): string {
  return `sc-domain:${new URL(SITE_URL).hostname}`;
}

/** A URL counts as indexed only on an outright PASS verdict from Google. */
function isIndexed(row: CoverageRow): boolean {
  return row.verdict === "PASS";
}

/**
 * Strip a single trailing slash so `https://hivra.cloud` and
 * `https://hivra.cloud/` compare equal.
 *
 * Deliberately NOT inventory-check's normalizeUrl: that one keeps the root's
 * trailing slash (`length > SITE_URL.length + 1`), which is exactly the case
 * this needs to collapse. Both values here are absolute URLs being compared
 * only against each other, so stripping unconditionally is safe.
 */
function normalizeUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Google chose a different canonical than we declared. Worth separating from a
 * plain "not indexed": the page is usually indexed, just consolidated onto
 * another URL, so the fix is canonical/dedup work rather than crawl work.
 *
 * Compared normalized, because a trailing-slash difference is not a mismatch —
 * the first live sweep flagged the homepage purely because getSiteUrls() emits
 * `https://hivra.cloud` while the page declares `https://hivra.cloud/`.
 *
 * Note when acting on this: userCanonical is what the page declared AT GOOGLE'S
 * LAST CRAWL, not what it declares now. The same sweep flagged /changelog with
 * a hermesos.cloud canonical from a 2026-06-12 crawl, long since fixed live.
 * Always re-check the live page before treating a mismatch as a real defect.
 */
function hasCanonicalMismatch(row: CoverageRow): boolean {
  if (!row.google_canonical || !row.user_canonical) return false;
  return normalizeUrl(row.google_canonical) !== normalizeUrl(row.user_canonical);
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    log.error("CRON_SECRET is not configured; refusing to run", new Error("CRON_SECRET missing"), {
      source: SOURCE,
      route: ROUTE,
      method: "GET",
      failureType: "cron_secret_missing",
    });
    return apiError("Cron secret is not configured", 500);
  }
  if (!verifyBearerHeader(req, cronSecret)) {
    return apiError("Unauthorized", 401);
  }

  if (!supabaseAdmin) {
    log.error("Supabase admin client is not configured", new Error("missing supabase admin"), {
      source: SOURCE,
      route: ROUTE,
      method: "GET",
      failureType: "supabase_admin_missing",
    });
    return apiError("Supabase service role is not configured", 500);
  }

  const configuredAccount = getServiceAccountFromEnv();
  if (!configuredAccount) {
    log.info("GSC_SA_KEY is not configured; index-coverage sweep is dormant", {
      source: SOURCE,
      route: ROUTE,
    });
    return apiSuccess({ ok: false, reason: "gsc_not_configured", checked: 0 });
  }
  // Re-bind non-null: the narrowing above does not survive into the worker
  // closures below, and inspectUrl's optional param rejects `null`.
  const serviceAccount: GscServiceAccount = configuredAccount;

  const site = siteProperty();
  const startedAt = Date.now();
  const urls = getSiteUrls().map((entry) => entry.url);
  const rows: CoverageRow[] = [];

  let cursor = 0;
  let skipped = 0;
  let permissionPending = false;
  let quotaExhausted = false;
  let failed = 0;

  /**
   * Inspect one URL, retrying once on a 5xx.
   *
   * Google's inspection endpoint returns sporadic 500s: the first live sweep
   * lost 2 of 68 URLs that way. A 5xx is transient and says nothing about the
   * URL, unlike 403 (permission) or 429 (quota), which are property-wide and
   * must not be retried. One retry is enough to clear the observed rate without
   * meaningfully touching the daily budget.
   */
  async function inspectOnceRetrying5xx(url: string) {
    try {
      return await inspectUrl(site, url, serviceAccount);
    } catch (err) {
      if (err instanceof GscApiError && err.status >= 500) {
        return await inspectUrl(site, url, serviceAccount);
      }
      throw err;
    }
  }

  async function worker(): Promise<void> {
    for (;;) {
      // A 403/429 applies to the whole property, so retrying other URLs would
      // only burn quota for the same answer. Drain instead.
      if (permissionPending || quotaExhausted) return;
      if (cursor >= urls.length) return;
      if (Date.now() - startedAt > DEADLINE_MS) {
        skipped += urls.length - cursor;
        cursor = urls.length;
        return;
      }
      const url = urls[cursor];
      cursor += 1;

      try {
        const status = await inspectOnceRetrying5xx(url);
        rows.push({
          url,
          site,
          last_checked: new Date().toISOString(),
          verdict: status.verdict,
          coverage_state: status.coverageState,
          robots_txt_state: status.robotsTxtState,
          indexing_state: status.indexingState,
          page_fetch_state: status.pageFetchState,
          google_canonical: status.googleCanonical,
          user_canonical: status.userCanonical,
          last_crawl_time: status.lastCrawlTime,
          notes: null,
        });
      } catch (err) {
        if (err instanceof GscApiError && err.status === 403) {
          permissionPending = true;
          return;
        }
        if (err instanceof GscApiError && err.status === 429) {
          quotaExhausted = true;
          skipped += urls.length - cursor;
          return;
        }
        failed += 1;
        rows.push({
          url,
          site,
          last_checked: new Date().toISOString(),
          verdict: null,
          coverage_state: null,
          robots_txt_state: null,
          indexing_state: null,
          page_fetch_state: null,
          google_canonical: null,
          user_canonical: null,
          last_crawl_time: null,
          notes: `inspection failed: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, () => worker()));

  if (permissionPending) {
    log.info("GSC service account is not granted on the property yet", {
      source: SOURCE,
      route: ROUTE,
      site,
    });
    return apiSuccess({ ok: false, reason: "gsc_permission_pending", checked: 0 });
  }

  if (rows.length > 0) {
    // first_seen is intentionally NOT in the payload: it has a DB default of
    // now() on insert and the upsert leaves omitted columns untouched on update.
    const { error } = await supabaseAdmin
      .from("seo_index_coverage")
      .upsert(rows, { onConflict: "url" });
    if (error) {
      log.error("seo_index_coverage upsert failed", new Error(error.message), {
        source: SOURCE,
        route: ROUTE,
        failureType: "seo_index_coverage_upsert_failed",
      });
      return apiError("Failed to write index coverage", 500);
    }
  }

  const indexed = rows.filter(isIndexed).length;
  const notIndexed = rows.filter((row) => row.verdict !== null && !isIndexed(row)).length;
  const canonicalMismatch = rows.filter(hasCanonicalMismatch).length;

  log.info("SEO index coverage sweep complete", {
    source: SOURCE,
    route: ROUTE,
    site,
    totalUrls: urls.length,
    checked: rows.length,
    indexed,
    notIndexed,
    canonicalMismatch,
    skipped,
    failed,
    quotaExhausted,
  });

  return apiSuccess({
    ok: true,
    site,
    totalUrls: urls.length,
    checked: rows.length,
    indexed,
    notIndexed,
    canonicalMismatch,
    skipped,
    failed,
    quotaExhausted,
  });
}
