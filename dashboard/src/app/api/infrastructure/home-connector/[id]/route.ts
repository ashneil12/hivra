export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit, RATE_LIMIT_PRESETS } from "@/lib/authenticated-rate-limit";
import { getHomeConnector } from "@/lib/infrastructure/home-connector-store";
import { HomeConnectorError, homeConnectorEnabled, revokeHomeConnector } from "@/lib/infrastructure/home-connector";
import { connectorHostname } from "@/lib/infrastructure/home-connector-host";
import { hostRelayStatus } from "@/lib/infrastructure/host-relay";
import { isSameOriginMutationRequest } from "../../connections/request-security";

type RouteContext = { params: Promise<{ id: string }> };
const noStore = (response: Response) => { response.headers.set("Cache-Control", "no-store"); return response; };

/** Is this machine's connector connected right now? Owner only. */
export async function GET(_request: NextRequest, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  if (!homeConnectorEnabled()) return noStore(apiError("Not available.", 404));
  const id = z.string().uuid().safeParse((await context.params).id);
  if (!id.success) return noStore(apiError("Not found.", 404));
  try {
    const row = await getHomeConnector(userId, id.data);
    if (!row) return noStore(apiError("Not found.", 404));
    const hostname = connectorHostname(row.id);
    if (row.revoked_at) return noStore(apiSuccess({ online: false, revoked: true, hostname }));
    const status = await hostRelayStatus(row.id);
    return noStore(apiSuccess({ online: status.online, revoked: false, hostname }));
  } catch {
    return noStore(apiError("Hivra could not check this machine right now.", 503));
  }
}

/** Disconnect this machine: its connector is stopped and its sessions end. */
export async function DELETE(request: NextRequest, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) return noStore(apiError("Unauthorized", 401));
  if (!isSameOriginMutationRequest(request)) return noStore(apiError("Same-origin request required.", 403));
  const id = z.string().uuid().safeParse((await context.params).id);
  if (!id.success) return noStore(apiError("Not found.", 404));
  const limited = enforceAuthenticatedRouteRateLimit(request, {
    routeKey: "infrastructure_home_connector_revoke",
    userId,
    ...RATE_LIMIT_PRESETS.secretWrite,
  });
  if (limited) return noStore(limited);
  try {
    await revokeHomeConnector(userId, id.data);
    return noStore(apiSuccess({ revoked: true }));
  } catch (error) {
    if (error instanceof HomeConnectorError) {
      return noStore(apiError(error.message, error.code === "not_found" ? 404 : 503));
    }
    return noStore(apiError("Hivra could not disconnect this machine. Try again.", 503));
  }
}
