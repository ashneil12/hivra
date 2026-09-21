import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { getInstanceBackend } from "@/lib/instance-backend";
import { ProfileService } from "@/lib/services/profile-service";
import { supabaseAdmin } from "@/lib/supabase";
import { isWebfreeBackend } from "@/lib/types/instance";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; name: string }> }) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    const { id: instanceId, name } = await params;

    const { searchParams } = new URL(request.url);
    const action = searchParams.get("action");

    if (action !== "start" && action !== "stop") {
      return apiError("Invalid action. Must be 'start' or 'stop'", 400);
    }

    // Webfree boxes run no per-profile gateway process — WebUI handles profiles
    // internally and their profile rows never get a gateway_port. Gate here like
    // every sibling profile route (profiles/route.ts, profiles/[name]/route.ts)
    // instead of letting the legacy ProfileService lane reach the box.
    if (isWebfreeBackend(await getInstanceBackend(instanceId, userId))) {
      return apiError("Profile gateways are not available on this instance", 400);
    }

    if (action === "start") {
      await ProfileService.startProfileGateway(instanceId, userId, name);
    } else {
      await ProfileService.stopProfileGateway(instanceId, userId, name);
    }

    // Refresh Caddy config whenever we start or stop a gateway, 
    // to make sure routes are mapped. 
    // We could do this dynamically or just recreate the whole Caddy config.
    // Let's rely on the DB state to rebuild Caddy, we'll implement this next.
    
    // For now, return success
    // F093: scope the status read by user_id as well, matching the sibling
    // profiles/[name] route. The start/stop calls above already validate
    // ownership, but defense-in-depth keeps this SELECT from ever returning
    // another tenant's profile row on an instance_id+name collision.
    const { data: profile } = await supabaseAdmin!
       .from("profiles")
       .select("*")
       .eq("instance_id", instanceId)
       .eq("user_id", userId)
       .eq("name", name)
       .single();

    return apiSuccess({ status: profile?.status });
  } catch (err) {
    return handleApiError(err);
  }
}
