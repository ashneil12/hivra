import type { MetadataRoute } from "next";
import { isLocalAuthMode } from "@/lib/self-host/config";
import { getSiteUrls } from "@/lib/seo-urls";

export default function sitemap(): MetadataRoute.Sitemap {
  return isLocalAuthMode() ? [] : getSiteUrls();
}
