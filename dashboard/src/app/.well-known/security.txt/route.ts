// /.well-known/security.txt (RFC 9116): where to report a vulnerability. The
// content comes from lib/security-contact.ts, the same constants as /security.
// Not served from a self-hosted installation: the contact is Hivra's, not the
// operator's, so an installation answers 404 rather than point researchers at
// the wrong people.

import { isLocalAuthMode } from "@/lib/self-host/config";
import { buildSecurityTxt } from "@/lib/security-contact";
import { SITE_URL } from "@/lib/seo-urls";

export const dynamic = "force-static";
export const revalidate = 3600;

export function GET() {
  if (isLocalAuthMode()) {
    return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return new Response(buildSecurityTxt(SITE_URL), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
