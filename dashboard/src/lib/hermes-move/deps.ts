// Production wiring of the Hermes move's dependencies.

import { randomBytes } from "node:crypto";

import { launchHivraAgentForUser } from "@/lib/hivra/launch-agent";
import { advanceProxmoxProvisionPoll } from "@/lib/hivra/proxmox-provision-poll";
import { deleteProxmoxHivraAgent } from "@/lib/hivra/delete-hivra-agent";
import { hivraAgentProvisionLogPath, resolveHivraAgentExecutionContext } from "@/lib/hivra/agent-execution-context";
import { buildPinnedGuestHostScript, resolvePinnedGuestTarget } from "@/lib/hivra/pinned-guest-seed";
import { shellQuote } from "@/lib/hivra/proxmox-target";
import { isHermesComputerEnabled } from "@/lib/hermes-computer/flag";
import { sshExec } from "@/lib/hetzner/ssh";
import { resolveInstanceIpv4 } from "@/lib/instance-resolvers";
import { reportOpsEvent } from "@/lib/ops-events";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
  getHermesGuestSshTarget,
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInfrastructure,
} from "@/lib/services/proxmox-infrastructure";
import { runProxmoxHostScript, shutdownProxmoxInstance, startProxmoxInstance } from "@/lib/services/proxmox-instance-service";
import { supabaseAdmin } from "@/lib/supabase";
import { createSupabaseMoveStore } from "@/lib/hermes-move/store";
import { createSupabaseWaveStore } from "@/lib/hermes-move/wave-store";
import type { WaveDeps } from "@/lib/hermes-move/wave";
import { sendHermesMovedEmail, sendHermesMoveNoticeEmail } from "@/lib/email/hermes-move";
import type { AgentRow, CommandResult, InstanceRow, MoveDeps } from "@/lib/hermes-move/orchestrator";

const BUCKET = "hermes-moves";
const DOWNLOAD_TTL_SECONDS = 2 * 60 * 60;

function bucket() {
  if (!supabaseAdmin) throw new Error("Database not configured");
  return supabaseAdmin.storage.from(BUCKET);
}

function infraFor(instance: InstanceRow) {
  const infra = getProxmoxInfrastructure(instance.config);
  if (!infra) throw new Error("the old agent has no computer handle");
  return {
    infra,
    hostConfig: getProxmoxHostRoutingConfigFromInfrastructure(infra, { host_id: (instance.host_id as string | null | undefined) ?? null }),
  };
}

const asCommand = (r: { ok: boolean; stdout?: string; stderr?: string; error?: string }): CommandResult => ({
  ok: r.ok, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error ? { error: r.error } : {}),
});

export function createMoveDeps(): MoveDeps {
  return {
    store: createSupabaseMoveStore(),
    now: () => new Date(),
    randomKeyHex: () => randomBytes(32).toString("hex"),
    encrypt: encryptSecret,
    decrypt: decryptSecret,
    isEnabled: () => isHermesComputerEnabled(),
    launch: (userId, body, options) => launchHivraAgentForUser(userId, body, options),
    observeLaunch: async (userId, agent) => {
      const polled = await advanceProxmoxProvisionPoll(
        userId,
        agent,
        () => resolveHivraAgentExecutionContext(userId, agent as unknown as Parameters<typeof resolveHivraAgentExecutionContext>[1]),
      );
      if ("error" in polled) throw new Error(polled.error.message);
      return polled.agent as AgentRow;
    },
    sshOld: async (instance, command, timeoutMs) => {
      // The same VMID-bound route the instance's console commands use.
      const hostConfig =
        getHermesGuestSshTarget(instance as Parameters<typeof getHermesGuestSshTarget>[0]) ??
        getProxmoxHostRoutingConfigFromInfrastructure(getProxmoxInfrastructure(instance.config), {
          host_id: (instance.host_id as string | null | undefined) ?? null,
        });
      const hostIp = await resolveInstanceIpv4(instance as unknown as Parameters<typeof resolveInstanceIpv4>[0]);
      const res = await sshExec(hostIp, command, { timeoutMs, proxmoxHostConfig: hostConfig ?? null });
      return asCommand(res as { ok: boolean; stdout?: string; stderr?: string });
    },
    runNewGuest: async (userId, agent, guestScript, timeoutMs) => {
      const context = await resolveHivraAgentExecutionContext(userId, agent as unknown as Parameters<typeof resolveHivraAgentExecutionContext>[1]);
      const pinned = resolvePinnedGuestTarget({ ip: agent.ip as string | null, vmid: agent.vmid as number | null }, context);
      if (!pinned.ok) return { ok: false, stdout: "", stderr: `the new computer's identity cannot be verified (${pinned.reason})` };
      return asCommand(await runProxmoxHostScript(buildPinnedGuestHostScript(pinned.target, guestScript), context.env, timeoutMs));
    },
    shutdownOldVm: async (instance) => {
      const { infra, hostConfig } = infraFor(instance);
      return asCommand(await shutdownProxmoxInstance(infra, { expectedInstanceId: instance.id, hostConfig }));
    },
    startOldVm: async (instance) => {
      const { infra, hostConfig } = infraFor(instance);
      return asCommand(await startProxmoxInstance(infra, { expectedInstanceId: instance.id, hostConfig, setOnboot: 1 }));
    },
    readNewSetupLog: async (userId, agent) => {
      const vmid = Number(agent.vmid);
      if (!Number.isSafeInteger(vmid) || vmid < 1) return null;
      const context = await resolveHivraAgentExecutionContext(userId, agent as unknown as Parameters<typeof resolveHivraAgentExecutionContext>[1]);
      const path = hivraAgentProvisionLogPath(context, vmid);
      const res = await runProxmoxHostScript(`tail -n 120 -- ${shellQuote(path)} 2>/dev/null || true`, context.env, 30_000);
      return res.ok && res.stdout ? res.stdout : null;
    },
    deleteNewComputer: async (userId, agent) => {
      const result = await deleteProxmoxHivraAgent(userId, agent);
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    },
    storage: {
      uploadUrl: async (path) => {
        const { data, error } = await bucket().createSignedUploadUrl(path, { upsert: true });
        if (error || !data?.signedUrl) throw new Error(`could not sign an upload: ${error?.message ?? "no url"}`);
        return data.signedUrl;
      },
      downloadUrl: async (path) => {
        const { data, error } = await bucket().createSignedUrl(path, DOWNLOAD_TTL_SECONDS);
        if (error || !data?.signedUrl) throw new Error(`could not sign a download: ${error?.message ?? "no url"}`);
        return data.signedUrl;
      },
      remove: async (paths) => {
        if (paths.length === 0) return;
        const { error } = await bucket().remove(paths);
        if (error) throw new Error(error.message);
      },
    },
    alert: async (event) => {
      await reportOpsEvent({
        source: "hermes.move_needs_attention",
        severity: "error",
        title: event.title,
        message: event.message,
        userId: event.userId,
        instanceId: event.instanceId,
        metadata: { moveId: event.moveId, failureType: event.failureType },
      });
    },
    notifyMoved: (p) => sendHermesMovedEmail(p),
  };
}

export function createWaveDeps(moves: MoveDeps = createMoveDeps()): WaveDeps {
  return { store: createSupabaseWaveStore(), moves, sendNotice: (p) => sendHermesMoveNoticeEmail(p) };
}
