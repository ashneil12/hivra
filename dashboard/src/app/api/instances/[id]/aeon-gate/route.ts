import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

/**
 * AEON run-eligibility gate.
 *
 * Called by a tenant's Aeon GitHub Actions workflow (the scheduler `tick` job)
 * BEFORE it dispatches any scheduled skill. Aeon's compute lives on GitHub
 * Actions — decoupled from the tenant VM for resilience — which means a paused /
 * stopped / suspended VM would otherwise keep doing autonomous work (burning the
 * user's LLM quota, sending notifications) off-box. This endpoint re-couples
 * run-eligibility to the tenant's intended state: the workflow no-ops unless
 * this returns active:true.
 *
 * Auth: capability-by-UUID. The instance id is an unguessable v4 UUID and the
 * response is a single boolean, so the URL itself is the capability — and it's
 * more tenant-scoped than a shared bearer secret (you must already know the
 * specific instance's id). Fail-closed: unknown id, missing db, or any non-
 * "running" status => active:false. Follow-up hardening: per-instance HMAC token
 * once the install flow can mint + plumb it.
 *
 * "running" is sufficient on its own: every pause path (inactivity / dormant /
 * ram-cap) and the non-payment suspend path flip `status` off "running".
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    if (!supabaseAdmin) {
      return NextResponse.json({ active: false, status: "unconfigured" });
    }
    const { data, error } = await supabaseAdmin
      .from("hermes_instances")
      .select("status")
      .eq("id", id)
      .neq("status", "deleted")
      .maybeSingle<{ status: string }>();

    if (error || !data) {
      return NextResponse.json({ active: false, status: "not_found" });
    }
    return NextResponse.json({ active: data.status === "running", status: data.status });
  } catch {
    return NextResponse.json({ active: false, status: "error" });
  }
}
