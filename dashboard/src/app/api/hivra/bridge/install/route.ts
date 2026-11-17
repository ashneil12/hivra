export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";

import { enrollIpLimit, enrollTextResponse, headNotAllowed } from "@/lib/infrastructure/server-enrollment-http";
import { trustedAppOrigin } from "@/lib/infrastructure/trusted-app-origin";
import { renderBridgeInstaller } from "@/lib/local-bridge/install-script";
import { isLocalBridgeEnabled } from "@/lib/local-bridge/flag";

// Public on purpose: `curl ... | bash` has no session. It serves the same bytes
// to everyone and carries no secret; the one-time code is an argument. 404 while
// the local bridge is off.
export async function GET(request: NextRequest) {
  const limited = enrollIpLimit(request, "local_bridge_install", 30);
  if (limited) return limited;
  const origin = trustedAppOrigin();
  if (!isLocalBridgeEnabled() || !origin) return enrollTextResponse(404, "");
  try {
    return enrollTextResponse(200, await renderBridgeInstaller(origin));
  } catch {
    return enrollTextResponse(503, "");
  }
}

export const HEAD = headNotAllowed;
