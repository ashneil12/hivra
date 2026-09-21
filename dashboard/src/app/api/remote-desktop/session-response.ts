import { NextResponse } from "next/server";

export const REMOTE_DESKTOP_RESPONSE_HEADERS = {
  "Cache-Control": "no-store, private",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

export function remoteDesktopResponse(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: REMOTE_DESKTOP_RESPONSE_HEADERS });
}
