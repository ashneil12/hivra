export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextRequest } from "next/server";
import { z } from "zod";

import {
  hasStrictJsonContentType,
  readBoundedJson,
} from "@/app/api/infrastructure/connections/request-security";
import {
  confirmRemoteDesktopInputTransitionByToken,
  SESSION_TOKEN_RE,
} from "@/lib/remote-computers/session-broker";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { remoteDesktopResponse } from "../../session-response";

const schema = z.object({
  protocol: z.literal("hivra-remote-desktop-input-v1"),
  action: z.enum(["agent-input-suspended", "agent-input-resumed"]),
  sessionId: z.string().uuid(),
  computerKind: z.enum(["hermes-instance", "hivra-agent"]),
  computerId: z.string().uuid(),
  capabilityGeneration: z.string().uuid(),
  transport: z.enum([
    "sunshine-moonlight",
    "selkies-webrtc",
    "selkies-websocket",
    "recovery-console",
  ]),
  agentInputSuspended: z.boolean(),
  controllerCount: z.number().int().min(0).max(1),
  observedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((receipt, context) => {
  const suspending = receipt.action === "agent-input-suspended";
  if (receipt.agentInputSuspended !== suspending) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Input state does not match action." });
  }
  if (receipt.controllerCount !== (suspending ? 1 : 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Controller count does not match action." });
  }
});

export async function POST(request: NextRequest) {
  // Guest-to-control-plane only. Browser ambient authority, cookies and URL
  // capabilities are never accepted for lifecycle acknowledgement.
  if (
    request.nextUrl.search || request.headers.has("origin")
    || request.headers.has("sec-fetch-site") || request.headers.has("cookie")
  ) return remoteDesktopResponse({ confirmed: false }, 403);
  if (!enforceRateLimit(`remote_desktop_input_transition:${getIP(request)}`, { limit: 120, windowMs: 60_000 }).success) {
    return remoteDesktopResponse({ confirmed: false }, 429);
  }
  const authorization = request.headers.get("authorization");
  const sessionToken = authorization?.match(/^Bearer (hrs1_[A-Za-z0-9_-]{43})$/)?.[1];
  if (!sessionToken || !SESSION_TOKEN_RE.test(sessionToken)) {
    return remoteDesktopResponse({ confirmed: false }, 401);
  }
  if (!hasStrictJsonContentType(request) || request.headers.has("content-encoding")) {
    return remoteDesktopResponse({ confirmed: false }, 415);
  }
  const body = await readBoundedJson(request, 2_048, 5_000);
  if (!body.ok) return remoteDesktopResponse({ confirmed: false }, body.reason === "too_large" ? 413 : 400);
  const receipt = schema.safeParse(body.body);
  if (!receipt.success) return remoteDesktopResponse({ confirmed: false }, 400);
  const result = await confirmRemoteDesktopInputTransitionByToken({ sessionToken, receipt: receipt.data });
  if (!result.ok) return remoteDesktopResponse({ confirmed: false }, result.status);
  return remoteDesktopResponse({ confirmed: true }, 200);
}
