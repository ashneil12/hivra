import { NextResponse } from "next/server";

import { requireLocalAuthMode, SELF_HOST_SESSION_COOKIE } from "@/lib/self-host/config";
import { isSameOriginRequest } from "@/lib/self-host/request-origin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    requireLocalAuthMode();
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: "Cross-origin sign-out is not allowed." }, { status: 403 });
    }
    const response = NextResponse.json({ authenticated: false });
    response.cookies.set(SELF_HOST_SESSION_COOKIE, "", {
      expires: new Date(0),
      httpOnly: true,
      path: "/",
      sameSite: "strict",
      secure: new URL(request.url).protocol === "https:",
    });
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Local authentication is unavailable." },
      { status: 503 },
    );
  }
}
