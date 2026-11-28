import { NextRequest } from "next/server";
import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { isCanonicalGitCanaryDeployment } from "@/lib/hivra/canonical-git-canary";
import { canaryMemoryOvercommitHost, readCanaryMemoryOvercommit } from "@/lib/hivra/canary-memory-overcommit";
import { managedHivraProvisionerChannelConfiguration, managedHivraProvisionerChannelForServerEnvironment } from "@/lib/hivra/managed-provisioner-channel";
import { managedCanaryLaunchSealScript } from "@/lib/hivra/managed-provisioner-readiness";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import { CANARY_MEMORY_OVERCOMMIT_PROVISIONER, canaryMemoryOvercommitShell } from "@/lib/infrastructure/host-capacity-policy";
import { log } from "@/lib/logger";
import { resolveHostCpuOvercommitRatio, resolveProxmoxCpuOvercommitRatio } from "@/lib/proxmox/placement-policy";
import { resolveProxmoxTargetConfiguration, runProxmoxHostScript } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 240;

export async function POST(req: NextRequest) {
  if (!isCanonicalGitCanaryDeployment()) return apiError("Not found", 404);
  const secret = process.env.CRON_SECRET;
  if (!secret || !verifyBearerHeader(req, secret)) return apiError("Unauthorized", 401);

  let value: unknown;
  try {
    value = await req.json();
  } catch {
    return apiError("Invalid JSON body", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return apiError("Invalid fixture request", 400);
  const { apply, ownerId, vmid, tag, templateConfigSha256, ...extra } = value as Record<string, unknown>;
  if (apply !== true || typeof ownerId !== "string" || !/^user_[A-Za-z0-9]+$/.test(ownerId)
    || typeof vmid !== "number" || !Number.isInteger(vmid) || vmid < 9300 || vmid > 9399 || vmid === 9302
    || typeof tag !== "string" || !/^hivra-qa-mem-[0-9a-f]{32}$/.test(tag)
    || typeof templateConfigSha256 !== "string" || !/^[0-9a-f]{64}$/.test(templateConfigSha256)
    || Object.keys(extra).length !== 0) return apiError("Invalid fixture request", 400);

  try {
    const channel = managedHivraProvisionerChannelForServerEnvironment(process.env);
    if (channel !== "canary") return apiError("Not found", 404);
    const host = canaryMemoryOvercommitHost();
    const templateVmid = process.env.HIVRA_CANARY_MEMORY_QA_TEMPLATE_VMID;
    if (!host || !templateVmid || !/^[1-9][0-9]{2,8}$/.test(templateVmid) || /^93[0-9]{2}$/.test(templateVmid)) {
      return apiError("The exact QA host and template were not configured", 503);
    }
    const grant = await readCanaryMemoryOvercommit({
      host, ownerId, channel, bundleVersion: CANARY_MEMORY_OVERCOMMIT_PROVISIONER,
    });
    if (!grant?.measuredGuests.includes(`${vmid}:${tag}`)) return apiError("No current permit for this fixture", 409);
    const placement = await supabaseAdmin?.from("proxmox_hosts").select("total_cpu,reserved_cpu,cpu_overcommit_ratio")
      .eq("id", host).eq("status", "active").is("decommissioned_at", null).maybeSingle();
    const capacity = placement?.data;
    if (!capacity || placement?.error || !Number.isSafeInteger(capacity.total_cpu) || !Number.isSafeInteger(capacity.reserved_cpu)
      || capacity.reserved_cpu < 0 || capacity.total_cpu <= capacity.reserved_cpu) {
      return apiError("The host CPU placement policy was not confirmed", 503);
    }
    const cpuRatio = Math.min(4, resolveHostCpuOvercommitRatio(capacity.cpu_overcommit_ratio, resolveProxmoxCpuOvercommitRatio()));
    const cpuBudgetMilli = Math.floor((capacity.total_cpu - capacity.reserved_cpu) * cpuRatio * 1000);
    const dir = managedHivraProvisionerChannelConfiguration(channel).runtime.provisionerDirectory;
    const target = resolveProxmoxTargetConfiguration(process.env, host);
    const result = await runProxmoxHostScript(`set -euo pipefail
install -d -m 0755 /run/lock
exec 8>>/run/lock/hivra-allocation.lock
flock -x -w 40 8 || { echo "Hivra allocation lock is busy" >&2; exit 1; }
PROVISIONER_DIR=${shellQuote(dir)}
${managedCanaryLaunchSealScript([CANARY_MEMORY_OVERCOMMIT_PROVISIONER])}
${canaryMemoryOvercommitShell(grant)}bash "$PROVISIONER_DIR/hivra-canary-memory-qa-clone.sh" ${vmid} ${shellQuote(tag)} ${shellQuote(templateConfigSha256)} ${cpuBudgetMilli} ${templateVmid}`, target.env, { timeoutMs: 210_000 });
    if (!result.ok || !result.stdout.split("\n").includes(`HIVRA_CANARY_MEMORY_QA_RUNNING ${vmid} ${tag}`)) {
      log.warn("Canary memory QA clone was not confirmed", {
        source: "ops:hivra:canary-memory-qa-clone", vmid, proxmoxHost: host,
      });
      return apiError("The host did not confirm the fixture. Reconcile the exact claim before retrying.", 503);
    }
    return apiSuccess({ host, vmid, tag, state: "running" });
  } catch {
    return apiError("Canary memory QA clone was not confirmed", 503);
  }
}
