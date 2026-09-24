/**
 * The launch requests the welcome forms built before the Launch journey's
 * adapters existed, transcribed from WelcomeFlow.tsx as it stood at c59440f
 * (the last commit before the forms and the journey shared one set of
 * builders). Parity tests compare the shared builders, and every adapter,
 * against these, so a runtime keeps being provisioned exactly as its own
 * setup form provisioned it.
 *
 * Only the request construction is copied. Inputs are what the form had in
 * scope at the moment it sent the request.
 */

import type { AgentDeploymentDestination } from "@/lib/hivra/agent-placement";
import { getManagedVeniceProxyBaseUrl } from "@/lib/venice/managed-endpoints";
import { buildWelcomeAgentSettings } from "@/lib/welcome-deploy";

/** DeployForm's Hermes deploy (WelcomeFlow handleDeploy). */
export function legacyHermesDeployBody(input: {
  agentName: string;
  cleanSlateDeploy: boolean;
  managedVeniceDeploy: boolean;
  selectedProviderId: string;
  model: string;
  customBaseUrl: string;
  systemPrompt?: string;
  managedVeniceWalletType: "card" | "hermesos";
  resolvedVaultKeyId?: string;
  apiKey: string;
  resolvedHonchoVaultKeyId?: string;
  honchoApiKey: string;
  fingerprintRequestId: string | null;
  cpuLimit: number;
  deployRamGb: number;
}): Record<string, unknown> {
  const {
    agentName, cleanSlateDeploy, managedVeniceDeploy, model, customBaseUrl, managedVeniceWalletType,
    resolvedVaultKeyId, apiKey, resolvedHonchoVaultKeyId, honchoApiKey, fingerprintRequestId, cpuLimit,
  } = input;
  const selectedProvider = { id: input.selectedProviderId };
  const ramLimit = input.deployRamGb * 1024;
  const agentSettings = buildWelcomeAgentSettings({
    providerId: cleanSlateDeploy ? "" : selectedProvider.id,
    model: cleanSlateDeploy ? "" : model,
    customBaseUrl: cleanSlateDeploy
      ? ""
      : managedVeniceDeploy
        ? getManagedVeniceProxyBaseUrl()
        : customBaseUrl,
    systemPrompt: input.systemPrompt,
    runtimeMode: "managed",
    enableRootAccess: false,
    webUseGateway: false,
    imageGenUseGateway: false,
    ttsUseGateway: false,
    browserUseGateway: false,
  });
  const aiPeer = agentName
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .toLowerCase();
  return JSON.parse(JSON.stringify({
    name: agentName.trim(),
    ...(cleanSlateDeploy
      ? { unconfigured: true }
      : {
          provider: selectedProvider.id,
          model,
          ...(managedVeniceDeploy
            ? { apiKey: "" }
            : resolvedVaultKeyId
              ? { vaultKeyId: resolvedVaultKeyId }
              : apiKey.trim()
                ? { apiKey: apiKey.trim() }
                : {}),
          ...(managedVeniceDeploy
            ? {
                managedVenice: {
                  enabled: true,
                  walletType: managedVeniceWalletType,
                },
              }
            : {}),
        }),
    honcho: {
      enabled: true,
      peerName: "user",
      aiPeer,
      memoryMode: "hybrid",
      recallMode: "hybrid",
      ...(!resolvedHonchoVaultKeyId && honchoApiKey.trim()
        ? { apiKey: honchoApiKey.trim() }
        : {}),
    },
    ...(resolvedHonchoVaultKeyId ? { honchoVaultKeyId: resolvedHonchoVaultKeyId } : {}),
    ...(fingerprintRequestId ? { fingerprintRequestId } : {}),
    agentSettings,
    cpuLimit,
    ramLimit,
  }));
}

/** The Claude Code / native Codex form (HivraBoxLaunchForOwner). */
export function legacyNativeCliBody(input: {
  agentId: "claude-code" | "codex";
  agentName: string;
  resolvedCpu: number;
  resolvedRam: number;
  effectiveBrowser: boolean;
  deployment: AgentDeploymentDestination;
  nativeRequestId: string | null;
}): Record<string, unknown> {
  return JSON.parse(JSON.stringify({
    type: input.agentId,
    name: input.agentName.trim(),
    cpu: input.resolvedCpu,
    ram: input.resolvedRam,
    browser: input.effectiveBrowser,
    deployment: input.deployment,
    ...(input.nativeRequestId ? { launchRequestId: input.nativeRequestId } : {}),
  }));
}

/** The OpenClaw / Agent Zero / Aeon form (DashboardAgentLaunchForm). */
export function legacyDashboardAgentBody(input: {
  agentId: "openclaw" | "agent-zero" | "aeon";
  agentName: string;
  resolvedCpu: number;
  resolvedRam: number;
  effectiveBrowser: boolean;
  wantManaged: boolean;
  cardMicro: number;
  hermesosMicro: number;
  deployment: AgentDeploymentDestination;
}): Record<string, unknown> {
  const { agentId, wantManaged, cardMicro, hermesosMicro } = input;
  const launchWalletType: "card" | "hermesos" = cardMicro <= 0 && hermesosMicro > 0 ? "hermesos" : "card";
  const llmForLaunch = (agentId === "openclaw" || agentId === "agent-zero") && wantManaged
    ? { provider: "venice" as const, mode: "managed" as const, walletType: launchWalletType }
    : undefined;
  return JSON.parse(JSON.stringify({
    type: agentId,
    name: input.agentName.trim(),
    cpu: input.resolvedCpu,
    ram: input.resolvedRam,
    browser: input.effectiveBrowser,
    managedVenice: wantManaged,
    llm: llmForLaunch,
    deployment: input.deployment,
  }));
}
