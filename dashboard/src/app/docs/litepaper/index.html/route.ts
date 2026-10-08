// The litepaper page. The token geo-policy decides which copy a viewer gets:
// see src/lib/compliance/token-geo-documents.ts. Never a file in public/. Its
// stylesheet, scripts and images stay static files under /docs/litepaper/.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";

import { serveTokenGeoDocument } from "@/lib/compliance/token-geo-documents";

export function GET(request: NextRequest) {
  return serveTokenGeoDocument(request, "litepaper.html");
}
