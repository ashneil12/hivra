import type { MetadataRoute } from "next";
import { isLocalAuthMode } from "@/lib/self-host/config";
import { getSiteUrls } from "@/lib/seo-urls";
import { newTokenSurfacesEnabled } from "@/lib/token-surfaces";

// Read per request: the held-back token pages must leave the sitemap the moment
// HIVRA_NEW_TOKEN_SURFACES is off, not when the next build bakes it in.
export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  return isLocalAuthMode() ? [] : getSiteUrls({ tokenSurfaces: newTokenSurfacesEnabled() });
}
