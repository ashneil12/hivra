// Public /llms.txt — AI-crawler discovery map (the emerging robots.txt-for-LLMs
// convention). Serves the curated buildLlmsTxt() document as text/plain. Mirrors
// the changelog RSS route-handler shape: public-surface, read-only output — no
// auth, no tenant data, no writes. (#llms-txt)

import { buildLlmsTxt } from "@/lib/llms-txt";
import { SITE_URL } from "@/lib/seo-urls";

// The link map is in-source, so render it statically like robots.ts /
// sitemap.ts / the changelog feed. The $HIVRA sentences also change at its
// activation instant, so revalidate on the same hour the CDN caches it for,
// rather than freezing the build-time phase.
export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
  const body = buildLlmsTxt({ siteUrl: SITE_URL });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
