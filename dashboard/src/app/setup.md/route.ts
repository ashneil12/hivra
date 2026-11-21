// Public /setup.md: instructions an AI coding agent follows to set its person up
// on Hivra ("Read https://hivra.cloud/setup.md and follow it"). Plain public
// docs: no auth, no tenant data, no writes. The link-and-code handshake section
// appears only while HIVRA_AGENT_SETUP_HANDSHAKE is on; links point at the site
// serving the file, so Canary's copy points at Canary.

import type { NextRequest } from "next/server";
import { agentSetupHandshakeEnabled } from "@/lib/agent-setup/flag";
import { buildSetupMarkdown } from "@/lib/agent-setup/setup-md";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const body = buildSetupMarkdown({ origin: request.nextUrl.origin, handshake: agentSetupHandshakeEnabled() });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
