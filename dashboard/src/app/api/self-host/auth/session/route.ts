import { NextResponse } from "next/server";

import {
  requireLocalAuthMode,
  requireLocalJwtSecret,
  SELF_HOST_SESSION_COOKIE,
} from "@/lib/self-host/config";
import { createLocalOperatorUser } from "@/lib/self-host/local-user";
import { loadLocalOperatorState } from "@/lib/self-host/operator-store";
import { readCookieValue, verifyLocalSessionToken } from "@/lib/self-host/session-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    requireLocalAuthMode();
    const token = readCookieValue(request.headers.get("cookie"), SELF_HOST_SESSION_COOKIE);
    const claims = await verifyLocalSessionToken({ token, secret: requireLocalJwtSecret() });
    if (!claims || !token) {
      return NextResponse.json({ authenticated: false }, { status: 401 });
    }
    const state = await loadLocalOperatorState();
    return NextResponse.json({
      accessToken: token,
      authenticated: true,
      user: createLocalOperatorUser(state.publicMetadata),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Local authentication is unavailable." },
      { status: 503 },
    );
  }
}
