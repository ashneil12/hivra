export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { auth } from "@clerk/nextjs/server";
import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import {
  preparedConsoleHostPreparationScript,
  readPreparedCanarySlot,
  type PreparedCanaryProfile,
} from "@/lib/hivra/prepared-canary-computers";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import { resolveProxmoxTargetConfiguration, runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

const Ticket = z.object({
  // Proxmox pvesh serializes this numeric field as a JSON string.
  port: z.union([z.number().int(), z.string().regex(/^\d{4}$/)]).transform(Number).pipe(z.number().int().min(5900).max(5999)),
  ticket: z.string().min(20).max(4096),
  password: z.string().min(1).max(4096),
}).passthrough();

function response(body: unknown, status: number) {
  const result = status >= 400 ? apiError(String((body as { error?: unknown })?.error ?? "Console unavailable"), status) : apiSuccess(body, status);
  result.headers.set("Cache-Control", "no-store, private");
  result.headers.set("Pragma", "no-cache");
  return result;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return response({ error: "Unauthorized" }, 401);
    if (!isHivraApiAllowed(request.headers.get("host"))) return response({ error: "Not found" }, 404);
    if (request.nextUrl.search || !isSameOriginMutationRequest(request)) return response({ error: "Request denied" }, 403);
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success || !supabaseAdmin) return response({ error: "Computer not found" }, 404);
    const limited = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "prepared_computer_console", userId, limit: 12, windowMs: 15 * 60_000,
    });
    if (limited) return limited;

    const { data, error } = await supabaseAdmin.from("hivra_agents")
      .select("id,user_id,status,desired_state,type,computer_profile,proxmox_host,vmid,ip")
      .eq("id", id).eq("user_id", userId).maybeSingle();
    if (error || !data) return response({ error: "Computer not found" }, 404);
    const profile = data.computer_profile as PreparedCanaryProfile;
    if (data.type !== "linux-desktop" || !["omarchy", "windows"].includes(profile)
      || data.status !== "running" || data.desired_state !== "running") {
      return response({ error: "This computer is not ready for its setup console." }, 409);
    }
    const slot = readPreparedCanarySlot(profile);
    if (!slot || data.proxmox_host !== slot.host || data.vmid !== slot.vmid || data.ip !== slot.ip) {
      return response({ error: "This computer is not bound to an admitted Canary console." }, 409);
    }
    const encodedMarker = `hivra-${profile}-operation%3A${slot.claim}`;
    const plainMarker = `hivra-${profile}-operation:${slot.claim}`;
    const bridgePort = profile === "windows" ? 6088 : 6089;
    const bridgeToken = randomBytes(32).toString("hex");
    const tokenFile = `/run/hivra-console/${slot.vmid}.tokens`;
    const script = `set -euo pipefail
CONFIG="$(qm config ${slot.vmid})"
case "$CONFIG" in *${shellQuote(encodedMarker)}*|*${shellQuote(plainMarker)}*) ;; *) exit 41 ;; esac
${preparedConsoleHostPreparationScript(profile, slot.vmid)}
command -v websockify >/dev/null
TICKET="$(pvesh create /nodes/${slot.node}/qemu/${slot.vmid}/vncproxy --websocket 1 --output-format json)"
PORT="$(printf '%s' "$TICKET" | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["port"]))')"
install -d -m 0700 /run/hivra-console
umask 077
printf '%s: 127.0.0.1:%s\\n' ${shellQuote(bridgeToken)} "$PORT" > ${shellQuote(tokenFile)}
pkill -f ${shellQuote(`websockify.*127.0.0.1:${bridgePort}`)} 2>/dev/null || true
websockify --daemon --run-once --timeout=45 --idle-timeout=7200 --token-plugin=TokenFile --token-source=${shellQuote(tokenFile)} 127.0.0.1:${bridgePort}
printf '%s' "$TICKET"`;
    const hostEnv = resolveProxmoxTargetConfiguration(process.env, slot.host).env;
    const issued = await runProxmoxHostScript(script, hostEnv, { timeoutMs: 20_000, maxOutputBytes: 16_384 });
    if (!issued.ok) return response({ error: "The computer console did not become available." }, 503);
    let ticket: z.infer<typeof Ticket>;
    try {
      ticket = Ticket.parse(JSON.parse(issued.stdout));
    } catch {
      return response({ error: "The computer console returned an invalid handoff." }, 503);
    }
    const base = process.env.HIVRA_CANARY_CONSOLE_ORIGIN?.trim();
    if (base !== "https://console-canary.hermesos.cloud") {
      return response({ error: "The Canary console gateway is not configured." }, 503);
    }
    const path = `/console/${slot.vmid}`;
    const websocketUrl = `${base.replace(/^https:/, "wss:")}${path}?token=${bridgeToken}`;
    return response({ websocketUrl, password: ticket.password, profile }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
