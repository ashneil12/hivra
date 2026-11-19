import { NextResponse } from "next/server";

import { loadPublicStatus } from "@/lib/status/load-status";
import { statusPageEnabled } from "@/lib/status/status-switch";

export const dynamic = "force-dynamic";

// Public, read-only. Returns component names, states and incident times only.
// 404 unless the status page switch is on.
export async function GET() {
  if (!statusPageEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const status = await loadPublicStatus();
  return NextResponse.json(status, {
    headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" },
  });
}
