export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";

import { enrollIpLimit, headNotAllowed, servedScriptResponse } from "@/lib/infrastructure/server-enrollment-http";
import { serveScriptSha256 } from "@/lib/infrastructure/server-enrollment-service";

// The body's sha256, as pinned in the repository.
export async function GET(request: NextRequest) {
  const limited = enrollIpLimit(request, "server_enrollment_script_sha256", 60);
  if (limited) return limited;
  return servedScriptResponse(await serveScriptSha256());
}

export function HEAD() {
  return headNotAllowed();
}
