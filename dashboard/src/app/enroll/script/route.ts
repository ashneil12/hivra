export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";

import { enrollIpLimit, headNotAllowed, servedScriptResponse } from "@/lib/infrastructure/server-enrollment-http";
import { serveScriptBody } from "@/lib/infrastructure/server-enrollment-service";

// The bare body, to read ("View the script first"). It holds no code and has
// no final line, so running it does nothing.
export async function GET(request: NextRequest) {
  const limited = enrollIpLimit(request, "server_enrollment_script_body", 60);
  if (limited) return limited;
  return servedScriptResponse(await serveScriptBody());
}

export function HEAD() {
  return headNotAllowed();
}
