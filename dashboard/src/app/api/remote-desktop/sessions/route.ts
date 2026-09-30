export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { z } from "zod";

import { issueRemoteDesktopSession } from "@/lib/remote-computers/session-broker";
import { MAX_UNANSWERED_DESKTOP_ISSUES } from "@/lib/remote-computers/desktop-session-limits";
import { enforceRateLimit } from "@/lib/rate-limit";
import {
  hasStrictJsonContentType,
  isSameOriginMutationRequest,
  readBoundedJson,
} from "@/app/api/infrastructure/connections/request-security";
import { remoteDesktopResponse } from "../session-response";

const BODY_LIMIT = 24_576;
const PKCE_CHALLENGE = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const schema = z.object({
  ownerHandoff: z.boolean().optional(),
  // Earlier requests from this browser tab whose answers it never read; the
  // broker may retire only this owner's never-exchanged leases bearing them.
  unansweredPkceChallenges: z.array(PKCE_CHALLENGE).min(1).max(MAX_UNANSWERED_DESKTOP_ISSUES).optional(),
  sessionId: z.string().uuid().optional(),
  computerKind: z.enum(["hermes-instance", "hivra-agent"]),
  computerId: z.string().uuid(),
  purpose: z.enum(["daily-driver", "recovery"]),
  inputRole: z.enum(["controller", "viewer"]),
  // Keep already-open clients valid across the HQ/performance rollout. HQ is
  // the product default, so an older bundle that omits this field receives the
  // same profile it used before the selector existed.
  streamingMode: z.enum(["hq", "qhd", "uhd", "performance"]).default("hq"),
  requestedTransport: z.enum([
    "sunshine-moonlight",
    "selkies-webrtc",
    "selkies-websocket",
    "recovery-console",
  ]).optional(),
  client: z.object({
    kind: z.enum(["browser", "native"]),
    moonlight: z.boolean(),
    webCodecs: z.boolean(),
    udp: z.enum(["direct", "relay", "blocked"]),
  }).strict(),
  nativeProfile: z.object({
    clientId: z.string().uuid(),
    clientCertificatePem: z.string().min(64).max(16_384),
    clientCertificateSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
  pkceChallenge: PKCE_CHALLENGE,
  ttlSeconds: z.number().int().min(30).max(300).optional(),
}).strict().superRefine((value, context) => {
  const browserHivraController = value.computerKind === "hivra-agent"
    && value.purpose === "daily-driver" && value.inputRole === "controller"
    && value.client.kind === "browser" && value.requestedTransport === "selkies-websocket"
    && value.sessionId === undefined && value.nativeProfile === undefined;
  if (value.ownerHandoff === true && !browserHivraController) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["ownerHandoff"], message: "Owner handoff requires a Hivra browser Selkies controller." });
  }
  if (value.unansweredPkceChallenges !== undefined && (!browserHivraController
    || new Set(value.unansweredPkceChallenges).size !== value.unansweredPkceChallenges.length
    || value.unansweredPkceChallenges.includes(value.pkceChallenge))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["unansweredPkceChallenges"], message: "Only a Hivra browser Selkies controller may name its own earlier, distinct requests." });
  }
  const preparedNativeSunshine = value.sessionId !== undefined
    && value.client.kind === "native" && value.client.moonlight
    && value.requestedTransport === "sunshine-moonlight"
    && value.purpose === "daily-driver" && value.inputRole === "controller";
  if (
    value.sessionId !== undefined
    && !preparedNativeSunshine
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sessionId"],
      message: "Only a native Sunshine controller may bind its prepared profile session.",
    });
  }
  if (preparedNativeSunshine !== (value.nativeProfile !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["nativeProfile"],
      message: "A public native profile is required only for a prepared Sunshine session.",
    });
  }
});

export async function POST(request: NextRequest) {
  const { userId } = await auth();
  if (!userId) return remoteDesktopResponse({ success: false, error: "Unauthorized" }, 401);
  if (request.nextUrl.search || !isSameOriginMutationRequest(request)) {
    return remoteDesktopResponse({ success: false, error: "Request denied" }, 403);
  }
  if (!enforceRateLimit(`remote_desktop_issue:${userId}`, { limit: 30, windowMs: 60_000 }).success) {
    return remoteDesktopResponse({ success: false, error: "Too many requests" }, 429);
  }
  if (!hasStrictJsonContentType(request) || request.headers.has("content-encoding")) {
    return remoteDesktopResponse({ success: false, error: "JSON required" }, 415);
  }
  const parsedBody = await readBoundedJson(request, BODY_LIMIT, 5_000);
  if (!parsedBody.ok) {
    const status = parsedBody.reason === "too_large" ? 413 : parsedBody.reason === "timeout" ? 408 : 400;
    return remoteDesktopResponse({ success: false, error: "Invalid request" }, status);
  }
  const parsed = schema.safeParse(parsedBody.body);
  if (!parsed.success) return remoteDesktopResponse({ success: false, error: "Invalid request" }, 400);

  const result = await issueRemoteDesktopSession({
    userId,
    ownerHandoff: parsed.data.ownerHandoff,
    unansweredPkceChallenges: parsed.data.unansweredPkceChallenges,
    sessionId: parsed.data.sessionId,
    computerKind: parsed.data.computerKind,
    computerId: parsed.data.computerId,
    purpose: parsed.data.purpose,
    inputRole: parsed.data.inputRole,
    streamingMode: parsed.data.streamingMode,
    requestedTransport: parsed.data.requestedTransport,
    client: parsed.data.client,
    nativeProfile: parsed.data.nativeProfile,
    pkceChallenge: parsed.data.pkceChallenge,
    ttlMs: parsed.data.ttlSeconds === undefined ? undefined : parsed.data.ttlSeconds * 1_000,
  });
  if (!result.ok) {
    return remoteDesktopResponse({ success: false, error: result.error, code: result.code }, result.status);
  }
  return remoteDesktopResponse({ success: true, data: result.session }, 201);
}
