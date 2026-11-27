import { SITE_URL } from "@/lib/seo-urls";

export function siteProperty(): string {
  return `sc-domain:${new URL(SITE_URL).hostname}`;
}
