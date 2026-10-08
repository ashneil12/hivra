import "server-only";

import { getIP, enforceRateLimit } from "@/lib/rate-limit";
import { retryAfterSeconds } from "@/lib/authenticated-rate-limit";

import type { ServedScript } from "./server-enrollment-service";

/** Headers on every /enroll* response: plain text, never cached, never
 * indexed, never sent as a referrer. There are no redirects. */
export const ENROLL_TEXT_HEADERS: Record<string, string> = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store, private",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex",
};

export function enrollTextResponse(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...ENROLL_TEXT_HEADERS, ...extra } });
}

export function servedScriptResponse(served: ServedScript): Response {
  return enrollTextResponse(served.status, served.body);
}

/** In-memory per-IP limiter for the public script routes. It only sheds load:
 * the key can be spoofed and each serverless instance has its own. The real
 * bounds are durable, in SQL. */
export function enrollIpLimit(request: Request, route: string, limit: number): Response | null {
  const result = enforceRateLimit(`${route}:${getIP(request)}`, { limit, windowMs: 60_000 });
  return result.success ? null : enrollTextResponse(429, "", { "Retry-After": String(retryAfterSeconds(result.retryAfterMs)) });
}

/** HEAD is refused outright, so a HEAD can never count as a download. */
export function headNotAllowed(): Response {
  return enrollTextResponse(405, "", { Allow: "GET" });
}
