import { NextRequest } from 'next/server';
import { apiSuccess, handleApiError } from '@/lib/api-response';
import { sshExec } from '@/lib/hetzner/ssh';
import { validateConsoleAccess } from '@/lib/services/console-helpers';
import { log } from '@/lib/logger';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await validateConsoleAccess(params);
    if (access.errorResponse) return access.errorResponse;
    const { id, instance, hostIp, proxmoxHostConfig } = access;

    // Exact-match the main container. Sibling services (gateway, official-dashboard,
    // dashboard-sidecar, browser-sidecar) share the `agent-${id}` prefix, so the
    // previous `grep … | head -n 1` could surface a sub-container's hardcoded
    // memory limit (e.g. official-dashboard's 768M) as the user's tier allocation.
    const script = `
      C="agent-${id}"
      S=$(docker stats "$C" --no-stream --format "{{.CPUPerc}}|||{{.MemUsage}}|||{{.NetIO}}" 2>&1)
      U=$(docker ps -a -f "name=^/?$C$" --format '{{.Status}}' 2>/dev/null)
      echo "$C###$S###$U"
    `;

    log.debug("fetching unified stats", {
      source: "console-overview",
      route: "/api/instances/[id]/console/overview",
      method: "GET",
      instanceId: id,
      hostIp,
    });
    const result = proxmoxHostConfig
      ? await sshExec(hostIp, script, { proxmoxHostConfig })
      : await sshExec(hostIp, script);

    // Default values if missing
    let statsRaw = "";
    let uptimeRaw = "";

    const parts = (result.stdout || "").split("###");
    if (parts.length >= 3) {
      // containerName = parts[0].trim(); // ignored
      statsRaw = parts[1].trim();
      uptimeRaw = parts[2].trim();
    } else {
      // SSH returned without our marker — connection issue or wrapper
      // chatter. Not an error worth alarming on, just degrade the panel.
      log.warn("unexpected SSH payload format", {
        source: "console-overview",
        route: "/api/instances/[id]/console/overview",
        method: "GET",
        instanceId: id,
        failureType: "ssh_overview_payload_unexpected",
      });
    }

    let uptimeVal = "Unknown";
    if (uptimeRaw.startsWith("Up ")) {
        uptimeVal = uptimeRaw.replace("Up ", "").split("(")[0].trim();
    }

    // F079: report the LIVE container status we just read from `docker ps -a`
    // ({{.Status}} in uptimeRaw), not the (possibly stale) DB instance.status.
    // A DB row marked 'running' with a dead container must NOT report 'running'.
    // Docker status strings: "Up ..." (running), "Exited (...)"/"Created"/
    // "Restarting"/"Paused"/"Dead" (not running), "" (couldn't read → unknown).
    let liveStatus: string;
    if (!uptimeRaw) {
        liveStatus = "unknown";
    } else if (uptimeRaw.startsWith("Up ")) {
        liveStatus = "running";
    } else if (/^(Restarting|Paused)/.test(uptimeRaw)) {
        liveStatus = uptimeRaw.split(" ")[0].toLowerCase();
    } else {
        liveStatus = "stopped";
    }

    // F079: distinguish a genuine SSH/stats failure from benign stderr wrapper
    // chatter. We only degrade the panel when we actually couldn't read stats
    // (empty statsRaw, or an explicit not-found/error marker). A non-empty
    // statsRaw with valid CPU/Mem means the stats DID come back even if some
    // benign text landed on stderr.
    const statsLookValid = statsRaw.length > 0 && statsRaw.includes("|||");
    const hardFailure =
        statsRaw.includes("No such container") ||
        statsRaw.includes("not found") ||
        (result.stderr ? result.stderr.includes("not found") : false);
    if (hardFailure || (!statsLookValid && (result.error || result.stderr || statsRaw.length === 0))) {
        if (hardFailure) {
            return apiSuccess({
                uptime: "Node Disconnected",
                cpu: "0.00%",
                memory: "0B / 0B",
                network: "0B / 0B",
                status: "stopped",
                error: "Container not found on host."
            });
        }

        // SSH itself failed (timeout, auth issue, host unreachable, etc.).
        // The overview panel is decorative — the agent's own /health is
        // the source of truth. Return a graceful 200 with degraded values
        // so the polling UI doesn't 500-spam, and demote the log to warn
        // so it doesn't trip alarms either.
        //
        // CRITICAL: do NOT include the raw SSH error in the log payload.
        // SSH stderr can contain remote secrets (refresh tokens, etc.)
        // and the test "does not log or report raw remote SSH errors"
        // guards against that.
        log.warn("SSH stats unavailable; returning degraded overview", {
          source: "console-overview",
          route: "/api/instances/[id]/console/overview",
          method: "GET",
          instanceId: id,
          failureType: "ssh_stats_unavailable",
        });
        return apiSuccess({
          uptime: "Unknown",
          cpu: "—",
          memory: "—",
          network: "—",
          status: "unreachable",
          error: "Stats temporarily unavailable.",
        });
    }

    const [cpu, mem, net] = statsRaw.split('|||').map(s => s?.trim());

    return apiSuccess({
      uptime: uptimeVal,
      cpu: cpu || "0.00%",
      memory: mem || "0B / 0B",
      network: net || "0B / 0B",
      // F079: report the live docker-ps status, falling back to the DB row
      // only when the container status line was unreadable.
      status: liveStatus === "unknown" ? instance.status : liveStatus,
    });

  } catch (err) {
    return handleApiError(err);
  }
}
