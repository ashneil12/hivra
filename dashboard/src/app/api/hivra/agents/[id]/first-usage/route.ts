export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { isHivraApiAllowed } from "@/lib/hivra/hivra-flag";
import { supabaseAdmin } from "@/lib/supabase";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    if (!isHivraApiAllowed(req.headers.get("host"))) return apiError("Not found", 404);
    const { id } = await params;
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const { data, error } = await supabaseAdmin
      .from("hivra_agents")
      .update({ first_usage_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", userId)
      .is("first_usage_at", null)
      .select("id");

    if (error) return apiError("Could not stamp first usage", 500);
    return apiSuccess({ stamped: (data?.length ?? 0) === 1 });
  } catch (err) {
    return handleApiError(err);
  }
}
