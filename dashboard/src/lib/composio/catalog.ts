import "server-only";

// src/lib/composio/catalog.ts
//
// The Composio app catalog for the in-dashboard app picker. Composio publishes
// its FULL toolkit list as a public, auth-free JSON docs artifact — 1,400+
// toolkits with {slug, name, logo, category, toolCount}. We proxy + cache it
// server-side (per serverless instance, revalidated daily via ETag) so the
// picker gets the whole catalog in one small payload, and new apps Composio adds
// appear automatically. Logos come from logos.composio.dev/api/<slug> (SVG).
//
// If the fetch ever fails we degrade to a bundled snapshot (the surfaced slugs)
// so the picker never hard-breaks.

import { COMPOSIO_SURFACED_SLUGS } from "@/lib/composio/config";

const CATALOG_URL = "https://docs.composio.dev/data/toolkits-list.json";
const TTL_MS = 24 * 60 * 60 * 1000; // refresh at most once a day

export interface CatalogApp {
  slug: string;
  name: string;
  logo: string;
  category: string;
  toolCount: number;
}

export interface ComposioCatalog {
  apps: CatalogApp[];
  categories: string[];
}

interface RawToolkit {
  slug?: unknown;
  name?: unknown;
  logo?: unknown;
  category?: unknown;
  toolCount?: unknown;
}

// Popularity seed: the curated "surfaced" slugs are Composio's most-common apps.
// We sort them first (in their listed order), then everything else alphabetically
// — the chosen default of "popularity → A–Z". (OAuth-managed-first would need the
// 18.7 MB toolkits.json; deferred — the curated head already fronts the OAuth apps.)
const POPULAR_ORDER = new Map<string, number>(
  COMPOSIO_SURFACED_SLUGS.map((slug, i) => [slug, i]),
);

function sortApps(apps: CatalogApp[]): CatalogApp[] {
  return [...apps].sort((a, b) => {
    const pa = POPULAR_ORDER.has(a.slug) ? (POPULAR_ORDER.get(a.slug) as number) : Number.POSITIVE_INFINITY;
    const pb = POPULAR_ORDER.has(b.slug) ? (POPULAR_ORDER.get(b.slug) as number) : Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
}

/** Normalize + sort a raw toolkits-list.json array into our catalog shape. */
export function normalizeCatalog(raw: unknown): ComposioCatalog {
  const arr: RawToolkit[] = Array.isArray(raw) ? (raw as RawToolkit[]) : [];
  const apps: CatalogApp[] = [];
  const categories = new Set<string>();
  for (const t of arr) {
    if (typeof t?.slug !== "string" || !t.slug || typeof t?.name !== "string" || !t.name) continue;
    const slug = t.slug.toLowerCase();
    const category = typeof t.category === "string" && t.category ? t.category : "other";
    apps.push({
      slug,
      name: t.name,
      logo:
        typeof t.logo === "string" && t.logo
          ? t.logo
          : `https://logos.composio.dev/api/${slug}`,
      category,
      toolCount: typeof t.toolCount === "number" ? t.toolCount : 0,
    });
    categories.add(category);
  }
  return { apps: sortApps(apps), categories: [...categories].sort() };
}

// Minimal bundled fallback (surfaced slugs only) if the docs artifact is ever
// unreachable — the picker still renders the popular apps.
const FALLBACK_CATALOG: ComposioCatalog = normalizeCatalog(
  COMPOSIO_SURFACED_SLUGS.map((slug) => ({ slug, name: slug, category: "other", toolCount: 0 })),
);

let cache: { at: number; etag: string | null; data: ComposioCatalog } | null = null;
let inflight: Promise<ComposioCatalog> | null = null;

/**
 * The full Composio catalog, cached per serverless instance and revalidated at
 * most daily (ETag-conditional). Never throws — degrades to the last cache or the
 * bundled fallback.
 */
export async function getComposioCatalog(): Promise<ComposioCatalog> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(CATALOG_URL, {
        headers: cache?.etag ? { "if-none-match": cache.etag } : {},
        cache: "no-store",
      });
      if (res.status === 304 && cache) {
        cache = { at: Date.now(), etag: cache.etag, data: cache.data };
        return cache.data;
      }
      if (!res.ok) return cache?.data ?? FALLBACK_CATALOG;
      const raw = await res.json().catch(() => null);
      const data = normalizeCatalog(raw);
      if (!data.apps.length) return cache?.data ?? FALLBACK_CATALOG;
      cache = { at: Date.now(), etag: res.headers.get("etag"), data };
      return data;
    } catch {
      return cache?.data ?? FALLBACK_CATALOG;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
