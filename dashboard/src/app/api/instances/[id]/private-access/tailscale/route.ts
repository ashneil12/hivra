import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiError, apiSuccess, handleApiError, type ApiErrorOptions } from "@/lib/api-response";
import { supabaseAdmin } from "@/lib/supabase";
import { resolveInstanceIpv4 } from "@/lib/services/instance-orchestrator";
import { sshExec, type SshResult } from "@/lib/hetzner/ssh";
import {
  buildTailscaleConfigPatch,
  getPublicTailscaleConfig,
} from "@/lib/private-access/tailscale";
import {
  getProxmoxHostRoutingConfigFromInfrastructure,
  getProxmoxInfrastructure,
  type ProxmoxHostRoutingConfig,
} from "@/lib/services/proxmox-infrastructure";
import {
  buildTailscaleDisableScript,
  buildTailscaleEnrollCommand,
  buildTailscaleInstallScript,
  buildTailscaleSetCommand,
  formatTailscaleCommandError,
  parseTailscaleStatusJson,
} from "@/lib/services/tailscale-private-access";

const TailscaleSetupSchema = z.object({
  authKey: z.string().min(1),
  machineName: z.string().trim().min(1).optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  enableSsh: z.boolean().optional(),
});

const TailscaleUpdateSchema = z
  .object({
    machineName: z.string().trim().min(1).optional(),
    enableSsh: z.boolean().optional(),
  })
  .refine((value) => value.machineName !== undefined || value.enableSsh !== undefined, {
    message: "No Tailscale settings were provided.",
  });

type InstanceRow = {
  id: string;
  user_id: string;
  status: string;
  provider: string;
  gateway_url?: string | null;
  host_id?: string | null;
  hetzner_server_id?: number | null;
  api_key_encrypted: string;
  api_server_key_encrypted?: string | null;
  honcho_api_key_encrypted?: string | null;
  ipv4_address?: string | null;
  cpu_limit?: number;
  ram_limit?: number;
  config?: Record<string, unknown>;
};

type InstanceSshOptions = {
  proxmoxHostConfig: ProxmoxHostRoutingConfig;
};

const ROUTE = "/api/instances/[id]/private-access/tailscale";

async function getInstance(id: string, userId: string): Promise<InstanceRow | null> {
  if (!supabaseAdmin) {
    throw new Error("Database not configured");
  }

  const { data, error } = await supabaseAdmin
    .from("hermes_instances")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .neq("status", "deleted")
    .single<InstanceRow>();

  if (error || !data) return null;
  return data;
}

function getInstanceSshOptions(instance: InstanceRow): InstanceSshOptions | undefined {
  const infrastructure = getProxmoxInfrastructure(instance.config);
  if (!infrastructure) return undefined;

  const proxmoxHostConfig = getProxmoxHostRoutingConfigFromInfrastructure(infrastructure, instance);

  return proxmoxHostConfig ? { proxmoxHostConfig } : undefined;
}

function tailscaleFailureOptions(params: {
  method: string;
  phase: string;
  userId: string;
  instance: InstanceRow;
  sshOptions?: InstanceSshOptions;
}): ApiErrorOptions {
  return {
    source: "tailscale-private-access",
    route: ROUTE,
    method: params.method,
    userId: params.userId,
    instanceId: params.instance.id,
    failureType: `tailscale_${params.phase}_failed`,
    metadata: {
      phase: params.phase,
      hostId: params.instance.host_id ?? null,
      proxmoxHostConfig: params.sshOptions?.proxmoxHostConfig
        ? {
            hostId: params.sshOptions.proxmoxHostConfig.hostId ?? null,
            hostSlug: params.sshOptions.proxmoxHostConfig.hostSlug ?? null,
            envPrefix: params.sshOptions.proxmoxHostConfig.envPrefix ?? null,
            failClosed: params.sshOptions.proxmoxHostConfig.failClosed ?? null,
          }
        : null,
    },
  };
}

async function sshExecForInstance(
  ip: string,
  command: string,
  sshOptions?: InstanceSshOptions
): Promise<SshResult> {
  return sshOptions ? sshExec(ip, command, sshOptions) : sshExec(ip, command);
}

const PREFLIGHT_TOKEN = "hermes-tailscale-preflight-ok";
const PREFLIGHT_TIMEOUT_MS = 15_000;

// Cheap probe over the SAME SSH path the install will use. For Proxmox
// instances the install path is Vercel → pve host → guest VM, and the
// guest hop frequently fails with the opaque "Remote bash exited with
// code 255". By running this before we ask the user to commit an auth
// key + 30s wait, we either confirm the bridge works or fast-fail with
// a specific message — no more screenshots of a bare exit 255.
async function preflightInstanceSshBridge(
  ipv4: string,
  sshOptions: InstanceSshOptions,
): Promise<
  | { ok: true }
  | { ok: false; userMessage: string; result: SshResult }
> {
  const result = await sshExec(ipv4, `echo ${PREFLIGHT_TOKEN}`, {
    ...sshOptions,
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
  });
  if (result.ok && result.stdout.includes(PREFLIGHT_TOKEN)) {
    return { ok: true };
  }
  // No auth key in play here — pass undefined so the formatter doesn't
  // need to redact (and so a stray substring match can't accidentally
  // blank out part of the diagnostic).
  const userMessage = formatTailscaleCommandError(
    result,
    "Couldn't reach this agent over its management SSH bridge — Tailscale setup needs the host to be reachable. Open the instance console to confirm the VM is running, then retry.",
  );
  return { ok: false, userMessage, result };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const { id } = await params;
    const instance = await getInstance(id, userId);
    if (!instance) return apiError("Instance not found", 404);

    return apiSuccess({
      tailscale: getPublicTailscaleConfig(
        (instance.config?.privateAccess as { tailscale?: unknown } | undefined)?.tailscale as
          | Parameters<typeof getPublicTailscaleConfig>[0]
          | undefined
      ),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const parsed = TailscaleSetupSchema.safeParse(await request.json());
    if (!parsed.success) return apiError(parsed.error.issues[0].message, 400);

    const { id } = await params;
    const instance = await getInstance(id, userId);
    if (!instance) return apiError("Instance not found", 404);

    if (instance.status !== "running") {
      return apiError(
        `Tailscale setup needs the agent to be running. Current status: ${instance.status}.`,
        409,
        null,
        undefined,
        tailscaleFailureOptions({
          method: "POST",
          phase: "preflight_status",
          userId,
          instance,
        }),
      );
    }

    const { authKey, machineName, tags, enableSsh } = parsed.data;

    // Enroll Tailscale on the VM host itself — Ubuntu + systemd + a real
    // TUN device — never inside a container. We reach the host over the
    // management SSH bridge; the install script is idempotent, so VMs whose
    // template already bakes in Tailscale skip straight to `tailscale up`.
    const ipv4 = await resolveInstanceIpv4(instance, supabaseAdmin!);
    if (!ipv4) return apiError("Host has no IPv4 address", 400);
    const sshOptions = getInstanceSshOptions(instance);

    if (sshOptions) {
      const preflight = await preflightInstanceSshBridge(ipv4, sshOptions);
      if (!preflight.ok) {
        return apiError(
          preflight.userMessage,
          502,
          preflight.result,
          undefined,
          tailscaleFailureOptions({
            method: "POST",
            phase: "preflight_ssh",
            userId,
            instance,
            sshOptions,
          }),
        );
      }
    }

    const installAndEnrollScript = [
      `export TAILSCALE_AUTH_KEY='${authKey.replace(/'/g, `'\"'\"'`)}'`,
      buildTailscaleInstallScript(),
      buildTailscaleEnrollCommand({
        authKeyEnvVar: "TAILSCALE_AUTH_KEY",
        machineName,
        tags,
        enableSsh,
      }),
      "unset TAILSCALE_AUTH_KEY",
    ].join("\n");

    const installResult = await sshExecForInstance(ipv4, installAndEnrollScript, sshOptions);
    if (!installResult.ok) {
      return apiError(
        formatTailscaleCommandError(installResult, "Failed to configure Tailscale", authKey),
        500,
        installResult,
        undefined,
        tailscaleFailureOptions({
          method: "POST",
          phase: "setup",
          userId,
          instance,
          sshOptions,
        })
      );
    }

    const statusResult = await sshExecForInstance(ipv4, "tailscale status --json", sshOptions);
    if (!statusResult.ok) {
      return apiError(
        formatTailscaleCommandError(statusResult, "Failed to read Tailscale status", authKey),
        500,
        statusResult,
        undefined,
        tailscaleFailureOptions({
          method: "POST",
          phase: "status_after_setup",
          userId,
          instance,
          sshOptions,
        })
      );
    }
    const statusJson = statusResult.stdout || "{}";

    const snapshot = parseTailscaleStatusJson(statusJson || "{}");
    const nextConfig = buildTailscaleConfigPatch(instance.config, {
      enabled: true,
      hostScoped: true,
      state: "connected",
      machineName: snapshot.machineName || machineName,
      magicDnsName: snapshot.magicDnsName,
      tailnetName: snapshot.tailnetName,
      ipv4: snapshot.ipv4,
      ipv6: snapshot.ipv6,
      sshEnabled: snapshot.sshEnabled ?? enableSsh ?? false,
      tags,
      connectedAt: new Date().toISOString(),
      lastError: null,
    });

    const { error: persistError } = await supabaseAdmin!
      .from("hermes_instances")
      .update({
        config: nextConfig,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", userId);

    if (persistError) {
      throw new Error("Failed to persist Tailscale configuration");
    }

    return apiSuccess({
      tailscale: getPublicTailscaleConfig(
        (nextConfig.privateAccess as { tailscale?: unknown } | undefined)?.tailscale as
          | Parameters<typeof getPublicTailscaleConfig>[0]
          | undefined
      ),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const { id } = await params;
    const instance = await getInstance(id, userId);
    if (!instance) return apiError("Instance not found", 404);

    // When the host-side teardown fails (e.g. Tailscale was already removed
    // manually, or the host is unreachable), the config used to stay stuck
    // 'enabled' in the DB forever — the user could never re-enroll. `?force=1`
    // lets the owner clear the DB snapshot anyway so the host can be
    // re-enrolled. Default (no force) behavior is unchanged: a real SSH
    // teardown failure still 500s instead of silently dropping config.
    const forceClear =
      new URL(request.url).searchParams.get("force") === "1";

    // Tracks whether the DB snapshot was cleared without a confirmed host-side
    // teardown (forced). Surfaced to the UI so the user can be warned the host
    // may still hold orphaned tailnet membership.
    let hostTeardownConfirmed = true;

    const ipv4 = await resolveInstanceIpv4(instance, supabaseAdmin!);
    if (ipv4) {
      const sshOptions = getInstanceSshOptions(instance);
      const disableResult = await sshExecForInstance(ipv4, buildTailscaleDisableScript(), sshOptions);
      if (!disableResult.ok) {
        if (!forceClear) {
          return apiError(
            formatTailscaleCommandError(disableResult, "Failed to disable Tailscale"),
            500,
            disableResult,
            { canForce: true },
            tailscaleFailureOptions({
              method: "DELETE",
              phase: "disable",
              userId,
              instance,
              sshOptions,
            })
          );
        }
        hostTeardownConfirmed = false;
      }
    } else {
      // No reachable IPv4 to run teardown against — clearing config only.
      hostTeardownConfirmed = false;
    }

    const currentPrivateAccess =
      typeof instance.config?.privateAccess === "object" && instance.config.privateAccess
        ? (instance.config.privateAccess as Record<string, unknown>)
        : {};
    const nextConfig = {
      ...(instance.config || {}),
      privateAccess: {
        ...currentPrivateAccess,
        tailscale: undefined,
      },
    };

    const { error: persistError } = await supabaseAdmin!
      .from("hermes_instances")
      .update({
        config: nextConfig,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", userId);

    if (persistError) {
      throw new Error("Failed to clear Tailscale configuration");
    }

    return apiSuccess({
      tailscale: undefined,
      hostTeardownConfirmed,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const parsed = TailscaleUpdateSchema.safeParse(await request.json());
    if (!parsed.success) return apiError(parsed.error.issues[0].message, 400);

    const { id } = await params;
    const instance = await getInstance(id, userId);
    if (!instance) return apiError("Instance not found", 404);

    const currentTailscaleConfig = (
      instance.config?.privateAccess as { tailscale?: unknown } | undefined
    )?.tailscale as Parameters<typeof getPublicTailscaleConfig>[0] | undefined;

    if (!currentTailscaleConfig?.enabled) {
      return apiError("Tailscale is not connected on this host.", 400);
    }

    if (instance.status !== "running") {
      return apiError(
        `Tailscale settings can only be updated while the agent is running. Current status: ${instance.status}.`,
        409,
        null,
        undefined,
        tailscaleFailureOptions({
          method: "PATCH",
          phase: "preflight_status",
          userId,
          instance,
        }),
      );
    }

    const { machineName, enableSsh } = parsed.data;

    const ipv4 = await resolveInstanceIpv4(instance, supabaseAdmin!);
    if (!ipv4) return apiError("Host has no IPv4 address", 400);
    const sshOptions = getInstanceSshOptions(instance);

    if (sshOptions) {
      const preflight = await preflightInstanceSshBridge(ipv4, sshOptions);
      if (!preflight.ok) {
        return apiError(
          preflight.userMessage,
          502,
          preflight.result,
          undefined,
          tailscaleFailureOptions({
            method: "PATCH",
            phase: "preflight_ssh",
            userId,
            instance,
            sshOptions,
          }),
        );
      }
    }

    const updateCommand = buildTailscaleSetCommand({
      machineName,
      enableSsh,
    });

    const updateResult = await sshExecForInstance(ipv4, updateCommand, sshOptions);
    if (!updateResult.ok) {
      return apiError(
        formatTailscaleCommandError(updateResult, "Failed to update Tailscale settings"),
        500,
        updateResult,
        undefined,
        tailscaleFailureOptions({
          method: "PATCH",
          phase: "update",
          userId,
          instance,
          sshOptions,
        })
      );
    }

    const statusResult = await sshExecForInstance(ipv4, "tailscale status --json", sshOptions);
    if (!statusResult.ok) {
      return apiError(
        formatTailscaleCommandError(statusResult, "Failed to read Tailscale status"),
        500,
        statusResult,
        undefined,
        tailscaleFailureOptions({
          method: "PATCH",
          phase: "status_after_update",
          userId,
          instance,
          sshOptions,
        })
      );
    }
    const statusJson = statusResult.stdout || "{}";

    const snapshot = parseTailscaleStatusJson(statusJson || "{}");
    const nextConfig = buildTailscaleConfigPatch(instance.config, {
      enabled: true,
      hostScoped: true,
      state: "connected",
      machineName: snapshot.machineName || machineName || currentTailscaleConfig.machineName,
      magicDnsName: snapshot.magicDnsName,
      tailnetName: snapshot.tailnetName,
      ipv4: snapshot.ipv4,
      ipv6: snapshot.ipv6,
      sshEnabled:
        snapshot.sshEnabled ?? enableSsh ?? currentTailscaleConfig.sshEnabled ?? false,
      tags: currentTailscaleConfig.tags,
      connectedAt: currentTailscaleConfig.connectedAt ?? new Date().toISOString(),
      lastError: null,
    });

    const { error: persistError } = await supabaseAdmin!
      .from("hermes_instances")
      .update({
        config: nextConfig,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", userId);

    if (persistError) {
      throw new Error("Failed to persist updated Tailscale configuration");
    }

    return apiSuccess({
      tailscale: getPublicTailscaleConfig(
        (nextConfig.privateAccess as { tailscale?: unknown } | undefined)?.tailscale as
          | Parameters<typeof getPublicTailscaleConfig>[0]
          | undefined
      ),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
