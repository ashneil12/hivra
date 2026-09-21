import "server-only";

import { redactSensitiveCommandOutput } from "@/lib/command-output-redaction";
import { sshExec } from "@/lib/hetzner/ssh";
import { log } from "@/lib/logger";
import { buildResolveAgentContainerScript } from "@/lib/services/agent-container";
import type { ProxmoxHostRoutingConfig } from "@/lib/services/proxmox-infrastructure";
import { sanitizeDockerName } from "@/lib/services/profile-service";
import { normalizeWebUIProfileName } from "@/lib/webui/profiles";
import { buildGuardedSoulWriteExecSh, classifySoulWriteStdout } from "@/lib/webui/soul-guard";

export const WEBUI_HERMES_HOME = "/home/hermes/.hermes";
const DEFAULT_SOUL_READ_TIMEOUT_MS = 8_000;

function getWebUIProfileHome(profileName?: string | null): string {
  const normalizedProfile = normalizeWebUIProfileName(profileName);
  return normalizedProfile === "default"
    ? WEBUI_HERMES_HOME
    : `${WEBUI_HERMES_HOME}/profiles/${sanitizeDockerName(normalizedProfile)}`;
}

function getWebUIProfileSoulPath(profileName?: string | null): string {
  return `${getWebUIProfileHome(profileName)}/SOUL.md`;
}

export async function readWebUIProfileSystemPrompt(input: {
  instanceId: string;
  hostIp: string;
  profileName?: string | null;
  timeoutMs?: number;
  proxmoxHostConfig?: ProxmoxHostRoutingConfig | null;
}): Promise<string | null> {
  const baseContainerName = `agent-${sanitizeDockerName(input.instanceId)}`;
  const profileName = normalizeWebUIProfileName(input.profileName);
  const soulPath = getWebUIProfileSoulPath(profileName);
  const result = await sshExec(
    input.hostIp,
    [
      `set -e`,
      // Resolve the live agent container (webfree runs -gateway/-official-dashboard,
      // not a bare agent-<id>; both mount the same webui-state volume).
      buildResolveAgentContainerScript(baseContainerName, { varName: "CONTAINER_NAME" }),
      `if [ -z "$CONTAINER_NAME" ]; then echo "no running agent container" >&2; exit 1; fi`,
      `SOUL_PATH=${JSON.stringify(soulPath)}`,
      `docker exec -u root "$CONTAINER_NAME" sh -c 'soul_path="$1"; test -f "$soul_path"; cat "$soul_path"' sh "$SOUL_PATH"`,
    ].join("\n"),
    {
      timeoutMs: input.timeoutMs ?? DEFAULT_SOUL_READ_TIMEOUT_MS,
      ...(input.proxmoxHostConfig ? { proxmoxHostConfig: input.proxmoxHostConfig } : {}),
    }
  );

  if (!result.ok) {
    const details = [result.error, result.stderr].filter(Boolean).join("\n").toLowerCase();
    if (
      details.includes("ssh") ||
      details.includes("timed out") ||
      details.includes("timeout") ||
      details.includes("proxmox") ||
      details.includes("connection") ||
      details.includes("configured") ||
      details.includes("docker")
    ) {
      log.warn("WebUI profile system prompt read failed", {
        source: "webui-profile-files",
        route: "/api/instances/[id]/profiles/[name]",
        method: "GET",
        instanceId: input.instanceId,
        profileName,
        hostIp: input.hostIp,
        timeoutMs: input.timeoutMs ?? DEFAULT_SOUL_READ_TIMEOUT_MS,
        failureType: "webui_profile_system_prompt_read_failed",
        ...(result.error?.trim()
          ? { error: redactSensitiveCommandOutput(result.error.trim(), 600) }
          : {}),
        ...(result.stderr?.trim()
          ? { stderr: redactSensitiveCommandOutput(result.stderr.trim(), 600) }
          : {}),
      });
    }
    return null;
  }

  return result.stdout;
}

export type WriteWebUIProfileSystemPromptResult =
  | { status: "written" }
  | { status: "skipped_existing_identity" };

export async function writeWebUIProfileSystemPrompt(input: {
  instanceId: string;
  hostIp: string;
  profileName?: string | null;
  systemPrompt: string;
  /**
   * When false/omitted (default), an already-authored identity is preserved:
   * the write only lands if the box's SOUL.md is empty or still the
   * factory-default / un-run onboarding ritual (see soul-guard.ts). This stops
   * an unrelated profile save from silently clobbering an identity the agent or
   * user built. Pass true to deliberately replace it (explicit UI opt-in).
   */
  overwriteExistingIdentity?: boolean;
}): Promise<WriteWebUIProfileSystemPromptResult> {
  const baseContainerName = `agent-${sanitizeDockerName(input.instanceId)}`;
  const profileHome = getWebUIProfileHome(input.profileName);
  const encodedPrompt = Buffer.from(input.systemPrompt, "utf8").toString("base64");
  const result = await sshExec(
    input.hostIp,
    [
      `set -e`,
      // Resolve the live agent container (webfree runs -gateway/-official-dashboard,
      // not a bare agent-<id>; both mount the same webui-state volume).
      buildResolveAgentContainerScript(baseContainerName, { varName: "CONTAINER_NAME" }),
      `if [ -z "$CONTAINER_NAME" ]; then echo "no running agent container" >&2; exit 1; fi`,
      `PROMPT_B64=${JSON.stringify(encodedPrompt)}`,
      // Guarded write: never clobber an authored SOUL.md unless the caller opted
      // in. Shared with the legacy PATCH path and the provision seeder so the
      // guard can't drift.
      `printf "%s" "$PROMPT_B64" | base64 -d | docker exec -u root -i "$CONTAINER_NAME" ${buildGuardedSoulWriteExecSh(
        profileHome,
        input.overwriteExistingIdentity === true,
      )}`,
    ].join("\n")
  );

  if (!result.ok) {
    // Carry the failure reason. This message is what the soul-seed reconcile
    // surfaces in its warn log (and in SoulReconcileInstanceResult.error), so a
    // bare "Failed to write…" makes a failed reseed undiagnosable from logs.
    // Both fields matter: sshExec reports command failures on `stderr` but
    // connection/timeout failures ONLY on `error` (see hetzner/ssh.ts) — the
    // exact case worth diagnosing. Redacted; safe to throw, since every route
    // caller funnels this through handleApiError, which suppresses err.message
    // outside development.
    const details = redactSensitiveCommandOutput(
      [result.error, result.stderr].map((part) => part?.trim()).filter(Boolean).join("\n"),
      300,
    );
    throw new Error(
      details
        ? `Failed to write WebUI profile system prompt: ${details}`
        : "Failed to write WebUI profile system prompt",
    );
  }

  return { status: classifySoulWriteStdout(result.stdout) };
}
