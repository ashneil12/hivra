export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

import type { NextRequest } from "next/server";

import { handleHostKeyCapture } from "./handler";

/** Read it from the server: the advanced wizard's fallback when the owner
 * doesn't have the fingerprint. Pins nothing; the owner confirms. */
export async function POST(request: NextRequest) {
  return handleHostKeyCapture(request);
}
