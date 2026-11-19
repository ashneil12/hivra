export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";

import { homeConnectorEnabled } from "@/lib/infrastructure/home-connector";
import { renderHomeConnectorInstaller } from "@/lib/infrastructure/home-connector-install-script";
import { enrollIpLimit, enrollTextResponse, headNotAllowed } from "@/lib/infrastructure/server-enrollment-http";
import { trustedAppOrigin } from "@/lib/infrastructure/trusted-app-origin";

// Public on purpose: `curl ... | sudo bash` has no session. It serves the same
// bytes to everyone and carries no secret; the one-time code is an argument.
export async function GET(request: NextRequest) {
  const limited = enrollIpLimit(request, "home_connector_install", 30);
  if (limited) return limited;
  const origin = trustedAppOrigin();
  if (!homeConnectorEnabled() || !origin) return enrollTextResponse(404, "");
  try {
    return enrollTextResponse(200, await renderHomeConnectorInstaller(origin));
  } catch {
    return enrollTextResponse(503, "");
  }
}

export const HEAD = headNotAllowed;
