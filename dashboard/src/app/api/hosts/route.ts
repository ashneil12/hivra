import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { apiError, apiSuccess, handleApiError } from "@/lib/api-response";
import { getHetznerInstanceStatus } from "@/lib/services/hetzner-instance-service";

type HostSyncStatus = "provisioning" | "running" | "stopped" | "error";

// The hosts table doesn't allow "redeploying", so map Hetzner rebuilds back to "provisioning".
function normalizeHostStatus(status: string): HostSyncStatus {
  switch (status) {
    case "redeploying":
    case "provisioning":
      return "provisioning";
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    default:
      return "error";
  }
}

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    if (!supabaseAdmin) return apiError("Database not configured", 500);

    // 1. Fetch real host records from the DB
    const { data: hostsData, error: hostsError } = await supabaseAdmin
      .from("hermes_hosts")
      .select("*")
      .eq("user_id", userId)
      .neq("status", "deleted")
      .order("created_at", { ascending: true });

    if (hostsError) {
      return apiError("Failed to fetch hosts", 500, { errorType: "hosts_fetch_failed" });
    }

    // 1.5 Sync host statuses with Hetzner.
    // Each host's live status fetch is isolated: one unreachable host (a rejected
    // status fetch or a failed status write) must degrade to that host's last-known
    // status, NOT sink the whole list and 500 the page.
    const hosts = await Promise.all(
      (hostsData || []).map(async (host) => {
        if (!host.hetzner_server_id) return host;
        try {
          const hs = await getHetznerInstanceStatus(host.hetzner_server_id);
          const nextStatus = normalizeHostStatus(hs.status);
          if (nextStatus && nextStatus !== host.status) {
            await supabaseAdmin!
              .from("hermes_hosts")
              .update({ status: nextStatus, updated_at: new Date().toISOString() })
              .eq("id", host.id);
            return { ...host, status: nextStatus };
          }
          return host;
        } catch {
          // Unreachable host or transient write failure: keep the existing row
          // (last-known status) so the rest of the fleet still renders.
          return host;
        }
      })
    );

    // 2. Fetch all active instances to compute per-host usage stats
    const { data: instances } = await supabaseAdmin
      .from("hermes_instances")
      .select("host_id, cpu_limit, ram_limit")
      .eq("user_id", userId)
      .neq("status", "deleted");

    // Build a usage map keyed by host_id
    const usageByHost = new Map<string, { usedCpu: number; usedRam: number; agentCount: number }>();
    for (const inst of instances || []) {
      if (!inst.host_id) continue;
      const existing = usageByHost.get(inst.host_id) ?? { usedCpu: 0, usedRam: 0, agentCount: 0 };
      usageByHost.set(inst.host_id, {
        usedCpu: existing.usedCpu + (inst.cpu_limit || 0),
        usedRam: existing.usedRam + (inst.ram_limit || 0),
        agentCount: existing.agentCount + 1,
      });
    }

    // 3. Annotate each host with live usage stats
    const annotated = (hosts || []).map((host) => {
      const usage = usageByHost.get(host.id) ?? { usedCpu: 0, usedRam: 0, agentCount: 0 };
      return {
        ...host,
        used_cpu: usage.usedCpu,
        used_ram: usage.usedRam,
        agent_count: usage.agentCount,
      };
    });

    return apiSuccess(annotated);
  } catch (err) {
    return handleApiError(err);
  }
}
