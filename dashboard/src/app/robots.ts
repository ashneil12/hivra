import type { MetadataRoute } from "next";
import { headers } from "next/headers";
import { SITE_URL } from "@/lib/seo-urls";
import { isCanaryHost } from "@/lib/seo-host";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const requestHeaders = await headers();

  if (isCanaryHost(requestHeaders.get("host"))) {
    return {
      rules: {
        userAgent: "*",
        disallow: "/",
      },
    };
  }

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/dashboard",
          "/dashboard/",
          "/sign-in",
          "/sign-in/",
          "/sign-up",
          "/sign-up/",
          "/get-started",
          "/get-started/",
          "/api/",
        ],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
