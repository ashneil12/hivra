import { NextRequest } from "next/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { log } from "@/lib/logger";
import { SITE_URL, getSiteUrls } from "@/lib/seo-urls";
import { supabaseAdmin } from "@/lib/supabase";

const SOURCE = "cron/seo-inventory-check";
const ROUTE = "/api/cron/seo/inventory-check";

/**
 * Weekly crawl of our own sitemap. For every URL in getSiteUrls() (the
 * sitemap source of truth) it records into `public.seo_page_inventory`:
 *
 *   last_status      HTTP status (HEAD, falling back to GET when HEAD is
 *                    rejected or fails)
 *   redirect_target  Location header when the response is a 3xx
 *   canonical_ok     for 200 HTML pages: does <link rel="canonical"> point
 *                    at the URL itself?
 *
 * Catches dead pages, accidental redirects, and canonical drift before
 * Google does. Concurrency-capped and deadline-guarded so the function
 * returns cleanly inside maxDuration instead of being SIGKILLed mid-crawl;
 * URLs skipped at the deadline are re-checked next run.
 */

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const CONCURRENCY = 5;
// Stop pulling new URLs past this point so in-flight checks + the final
// upsert finish safely under maxDuration.
const DEADLINE_MS = 50_000;
const FETCH_TIMEOUT_MS = 10_000;

interface InventoryRow {
  url: string;
  kind: string;
  last_checked: string;
  last_status: number | null;
  redirect_target: string | null;
  canonical_ok: boolean | null;
  notes: string | null;
}

function classifyUrl(url: string): string {
  const path = url.startsWith(SITE_URL) ? url.slice(SITE_URL.length) : url;
  if (path === "" || path === "/") return "home";
  if (path.startsWith("/blog")) return "blog";
  if (path.startsWith("/features")) return "feature";
  if (path.startsWith("/compare")) return "compare";
  return "core";
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Strip a single trailing slash so /features and /features/ compare equal. */
function normalizeUrl(url: string): string {
  return url.endsWith("/") && url.length > SITE_URL.length + 1 ? url.slice(0, -1) : url;
}

function extractCanonical(html: string): string | null {
  // <link rel="canonical" href="..."> in either attribute order.
  const match =
    html.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) ??
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']canonical["']/i);
  return match ? match[1] : null;
}

async function checkUrl(url: string): Promise<InventoryRow> {
  const row: InventoryRow = {
    url,
    kind: classifyUrl(url),
    last_checked: new Date().toISOString(),
    last_status: null,
    redirect_target: null,
    canonical_ok: null,
    notes: null,
  };

  let response: Response | null = null;
  try {
    response = await fetchWithTimeout(url, { method: "HEAD" });
    // Some frameworks reject HEAD outright; retry those as GET.
    if (response.status === 405 || response.status === 501) {
      response = await fetchWithTimeout(url, { method: "GET" });
    }
  } catch {
    try {
      response = await fetchWithTimeout(url, { method: "GET" });
    } catch (err) {
      row.notes = `fetch failed: ${err instanceof Error ? err.name : "unknown"}`;
      return row;
    }
  }

  row.last_status = response.status;

  if (response.status >= 300 && response.status < 400) {
    row.redirect_target = response.headers.get("location");
    return row;
  }

  if (response.status === 200) {
    try {
      const pageResponse = await fetchWithTimeout(url, { method: "GET" });
      const contentType = pageResponse.headers.get("content-type") ?? "";
      if (pageResponse.status === 200 && contentType.includes("text/html")) {
        const html = await pageResponse.text();
        const canonical = extractCanonical(html);
        if (canonical) {
          row.canonical_ok = normalizeUrl(canonical) === normalizeUrl(url);
          if (!row.canonical_ok) {
            row.notes = `canonical points at ${canonical.slice(0, 200)}`;
          }
        } else {
          row.canonical_ok = false;
          row.notes = "no canonical tag";
        }
      }
    } catch {
      row.notes = "canonical check failed";
    }
  }

  return row;
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

  const startedAt = Date.now();
  const urls = getSiteUrls().map((entry) => entry.url);
  const results: InventoryRow[] = [];
  let skippedAtDeadline = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      if (cursor >= urls.length) return;
      if (Date.now() - startedAt > DEADLINE_MS) {
        skippedAtDeadline += urls.length - cursor;
        cursor = urls.length;
        return;
      }
      const url = urls[cursor];
      cursor += 1;
      results.push(await checkUrl(url));
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, urls.length) }, () => worker()),
  );

  // first_seen is intentionally NOT in the payload: it has a DB default of
  // now() on insert and the upsert leaves omitted columns untouched on update.
  const { error } = await supabaseAdmin
    .from("seo_page_inventory")
    .upsert(results, { onConflict: "url" });
  if (error) {
    log.error("seo_page_inventory upsert failed", new Error(error.message), {
      source: SOURCE,
      route: ROUTE,
      failureType: "seo_page_inventory_upsert_failed",
    });
    return apiError("Failed to write page inventory", 500);
  }

  const broken = results.filter(
    (row) => row.last_status === null || row.last_status >= 400,
  ).length;
  const redirecting = results.filter((row) => row.redirect_target !== null).length;
  const badCanonical = results.filter((row) => row.canonical_ok === false).length;

  log.info("SEO inventory check complete", {
    source: SOURCE,
    route: ROUTE,
    checked: results.length,
    skippedAtDeadline,
    broken,
    redirecting,
    badCanonical,
  });

  return apiSuccess({
    ok: true,
    totalUrls: urls.length,
    checked: results.length,
    skippedAtDeadline,
    broken,
    redirecting,
    badCanonical,
  });
}
