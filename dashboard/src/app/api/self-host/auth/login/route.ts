import { NextResponse } from "next/server";

import {
  localOperatorEmail,
  localOperatorName,
  requireLocalAuthMode,
  requireLocalJwtSecret,
  SELF_HOST_SESSION_COOKIE,
  SELF_HOST_SESSION_TTL_SECONDS,
} from "@/lib/self-host/config";
import { verifyLocalOperatorPassword } from "@/lib/self-host/password";
import { isSameOriginRequest } from "@/lib/self-host/request-origin";
import { createLocalSessionToken } from "@/lib/self-host/session-token";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    requireLocalAuthMode();
    if (!isSameOriginRequest(request)) {
      return NextResponse.json({ error: "Cross-origin sign-in is not allowed." }, { status: 403 });
    }
    const rateLimit = enforceRateLimit(`local-login:${getIP(request)}`, {
      limit: 10,
      windowMs: 15 * 60 * 1000,
    });
    if (!rateLimit.success) {
      return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > 8_192) {
      return NextResponse.json({ error: "Invalid sign-in request." }, { status: 413 });
    }
    const body = await request.json().catch(() => null) as { email?: unknown; password?: unknown } | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const passwordHash = process.env.HIVRA_OPERATOR_PASSWORD_HASH?.trim() || "";
    const passwordValid = passwordHash
      ? await verifyLocalOperatorPassword(password, passwordHash)
      : false;

    if (email !== localOperatorEmail() || !passwordValid) {
      return NextResponse.json({ error: "Invalid operator credentials." }, { status: 401 });
    }

    const token = await createLocalSessionToken({
      email,
      name: localOperatorName(),
      secret: requireLocalJwtSecret(),
    });
    const response = NextResponse.json({ authenticated: true });
    response.cookies.set(SELF_HOST_SESSION_COOKIE, token, {
      httpOnly: true,
      maxAge: SELF_HOST_SESSION_TTL_SECONDS,
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
