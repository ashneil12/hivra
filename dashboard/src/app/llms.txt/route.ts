// Public /llms.txt — AI-crawler discovery map (the emerging robots.txt-for-LLMs
// convention). Serves the curated buildLlmsTxt() document as text/plain. Mirrors
// the changelog RSS route-handler shape: public-surface, read-only output — no
// auth, no tenant data, no writes. (#llms-txt)

import { resolveTokenGeoBlock } from "@/lib/compliance/token-geo-gate";
import { isTokenGeoPolicyActive } from "@/lib/compliance/token-geo-policy";
import { buildLlmsTxt } from "@/lib/llms-txt";
import { SITE_URL } from "@/lib/seo-urls";
import { newTokenSurfacesEnabled } from "@/lib/token-surfaces";

// The link map is in-source, but the body depends on the viewer's country once
// the token geo-policy lists one: a listed country gets the copy with no token
// sentence and no token links. Static rendering cannot see the request, so this
// is rendered per request. The CDN is told to keep it only while the body is the
// same for everyone (no country listed). With a country listed the response is
// private and uncached: a shared cache key has no country in it, so a cached
// copy made for one country would be served to the other. The $HIVRA sentences
// also change at its activation instant, which an hour of s-maxage still follows.
export const dynamic = "force-dynamic";

const SAME_FOR_EVERYONE = "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400";
const PER_VIEWER = "private, no-store";

export async function GET(request?: Request) {
  const tokenSurfaces = newTokenSurfacesEnabled();
  // The country list is inert while the token surfaces are held back.
  const countryListed = tokenSurfaces && isTokenGeoPolicyActive();
  // A crawler is signed out, so the request's IP country is the only signal.
  const restricted = countryListed && (await resolveTokenGeoBlock(request, null)).blocked;
  const body = buildLlmsTxt({ siteUrl: SITE_URL, restricted, tokenSurfaces });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": countryListed ? PER_VIEWER : SAME_FOR_EVERYONE,
    },
  });
}
