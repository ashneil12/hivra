// The white paper text. The token geo-policy decides which copy a viewer gets:
// see src/lib/compliance/token-geo-documents.ts. Never a file in public/.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";

import { serveTokenGeoDocument } from "@/lib/compliance/token-geo-documents";

export function GET(request: NextRequest) {
  return serveTokenGeoDocument(request, "WHITEPAPER.md");
}
