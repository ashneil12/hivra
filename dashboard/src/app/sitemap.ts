import type { MetadataRoute } from "next";
import { getSiteUrls } from "@/lib/seo-urls";

export default function sitemap(): MetadataRoute.Sitemap {
  return getSiteUrls();
}
