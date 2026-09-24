export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";

import { enrollIpLimit, headNotAllowed, servedScriptResponse } from "@/lib/infrastructure/server-enrollment-http";
import { serveUninstallScript } from "@/lib/infrastructure/server-enrollment-service";

// The same pinned body with the uninstall entry. Needs no code and contacts
// no one; it asks before changing anything and acts only where Hivra's
// marker is present.
export async function GET(request: NextRequest) {
  const limited = enrollIpLimit(request, "server_enrollment_uninstall", 60);
  if (limited) return limited;
  return servedScriptResponse(await serveUninstallScript());
}

export function HEAD() {
  return headNotAllowed();
}
