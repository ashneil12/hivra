import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { ProxmoxSshHostSchema } from "@/lib/infrastructure/contracts";
import { captureServerHostKey, HOST_KEY_CAPTURE_FAILURE_DELAY_MS } from "@/lib/infrastructure/host-key-capture";
import {
  hasStrictJsonContentType,
  isSameOriginMutationRequest,
  readBoundedJson,
} from "../request-security";

const CaptureRequestSchema = z.object({
  sshHost: ProxmoxSshHostSchema,
  sshPort: z.number().int().min(1).max(65_535),
}).strict();

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

type Dependencies = {
  capture: typeof captureServerHostKey;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const defaults: Dependencies = {
  capture: captureServerHostKey,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function handleHostKeyCapture(request: NextRequest, dependencies: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...dependencies };
  const startedAt = deps.now();
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  if (request.nextUrl.search || !isSameOriginMutationRequest(request)) {
    return noStore(apiError("Same-origin request required.", 403));
  }
  if (!hasStrictJsonContentType(request)) return noStore(apiError("Content-Type must be application/json.", 415));
  // The same limit as owner-driven inspection and readiness checks.
  const limited = enforceAuthenticatedRouteRateLimit(request, {
    routeKey: "infrastructure_host_key_capture", userId, limit: 5, windowMs: 60_000,
  });
  if (limited) return noStore(limited);
  const body = await readBoundedJson(request, 1_024);
  const parsed = body.ok ? CaptureRequestSchema.safeParse(body.body) : null;
  if (!parsed?.success) return noStore(apiError("Enter a hostname or IP address and a port.", 400));
  const { sshHost, sshPort } = parsed.data;
  const key = await deps.capture({ sshHost, sshPort });
  if (key) return noStore(apiSuccess({ hostKey: { publicKey: key.publicKey, fingerprintSha256: key.fingerprintSha256 } }));
  // One text and one delay for every kind of failure.
  const remaining = startedAt + HOST_KEY_CAPTURE_FAILURE_DELAY_MS - deps.now();
  if (remaining > 0) await deps.sleep(remaining);
  return noStore(apiError(`Hivra couldn't read an Ed25519 SSH identity from ${sshHost}:${sshPort}.`, 422, undefined,
    { code: "host_key_unavailable" }));
}
