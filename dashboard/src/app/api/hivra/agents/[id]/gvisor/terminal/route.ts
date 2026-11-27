import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { apiError } from "@/lib/api-response";
import { GvisorComputerError, openClaudeSandboxTerminal } from "@/lib/hivra/gvisor-computer-service";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return apiError("Unauthorized", 401);
  if (request.nextUrl.search || !isSameOriginMutationRequest(request)) return apiError("Open Claude Code from Hivra.", 403);
  const limit = enforceAuthenticatedRouteRateLimit(request, { routeKey: "hivra_claude_sandbox_terminal", userId, limit: 10, windowMs: 60_000 });
  if (limit) return limit;
  try {
    const { origin, token } = await openClaudeSandboxTerminal(userId, (await context.params).id);
    const nonce = randomBytes(18).toString("base64");
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Open Claude Code</title>
<form method="post" action="${origin}/auth/bootstrap">
<input type="hidden" name="destination" value="/terminal/">
<input type="hidden" name="token" value="${token}">
<button>Open Claude Code</button></form>
<script nonce="${nonce}">document.forms[0].submit()</script></html>`, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "origin",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; form-action ${origin}; frame-ancestors 'none'; base-uri 'none'`,
      },
    });
  } catch (error) {
    if (error instanceof GvisorComputerError) {
      return apiError(error.message, error.code === "not_found" ? 404 : error.code === "not_ready" ? 409 : 503);
    }
    return apiError("The Claude Code terminal could not be opened.", 503);
  }
}
