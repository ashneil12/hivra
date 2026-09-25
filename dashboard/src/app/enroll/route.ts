export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";

import { enrollIpLimit, headNotAllowed, servedScriptResponse } from "@/lib/infrastructure/server-enrollment-http";
import { serveEnrollScript } from "@/lib/infrastructure/server-enrollment-service";

// Machine-facing and session-free: `curl … -H 'Authorization: Bearer hse1_…'
// https://<origin>/enroll | sudo bash`. The code travels only in the header,
// never in the URL. The middleware excludes exactly this path.
export async function GET(request: NextRequest) {
  const limited = enrollIpLimit(request, "server_enrollment_script", 60);
  if (limited) return limited;
  return servedScriptResponse(await serveEnrollScript({
    authorization: request.headers.get("authorization"),
    hasQuery: Boolean(request.nextUrl.search),
  }));
}

export function HEAD() {
  return headNotAllowed();
}
