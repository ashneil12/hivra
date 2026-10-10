/**
 * The launch request each runtime's setup has always sent, built in one place.
 * The welcome forms and the Launch journey both call these, so a runtime is
 * provisioned the same way whichever door the owner came through.
 *
 * Pure: nothing here reads the network or stores anything. A key passed in is
 * placed in the request for that one call and nowhere else.
 */

import type { AgentLlmInput, CreateAgentInput } from "@/lib/hivra/agent-api";
import type { AgentDeploymentDestination } from "@/lib/hivra/agent-placement";
import { getManagedVeniceProxyBaseUrl } from "@/lib/venice/managed-endpoints";
import { buildWelcomeAgentSettings } from "@/lib/welcome-deploy";

type Wallet = "card" | "hermesos";

/** Claude Code and native Codex: the runtime's own sign-in after it opens.
 * Native Codex carries its stable receipt ID; Claude Code has none. */
export function nativeCliAgentRequest(input: {
  type: "claude-code" | "codex";
  name: string;
  cpu: number;
  ram: number;
  browser: boolean;
  deployment: AgentDeploymentDestination;
  launchRequestId?: string | null;
}): CreateAgentInput {
  return {
    type: input.type,
    name: input.name.trim(),
    cpu: input.cpu,
    ram: input.ram,
    browser: input.browser,
    deployment: input.deployment,
    ...(input.launchRequestId ? { launchRequestId: input.launchRequestId } : {}),
  };
}

/** OpenClaw, Agent Zero and Aeon. Hivra credits set `managedVenice`; OpenClaw
 * and Agent Zero have no connect step, so their credit key is minted at launch
 * from a managed Venice selection. Aeon sets its credits up when GitHub is
 * connected. */
export function dashboardAgentRequest(input: {
  type: "openclaw" | "agent-zero" | "aeon";
  name: string;
  cpu: number;
  ram: number;
  browser: boolean;
  /** The wallet Hivra credits bill, or null to set up a model inside the agent. */
  credits: { walletType: Wallet } | null;
  deployment: AgentDeploymentDestination;
}): CreateAgentInput {
  const llm: AgentLlmInput | undefined = (input.type === "openclaw" || input.type === "agent-zero") && input.credits
    ? { provider: "venice", mode: "managed", walletType: input.credits.walletType }
    : undefined;
  return {
    type: input.type,
    name: input.name.trim(),
    cpu: input.cpu,
    ram: input.ram,
    browser: input.browser,
    managedVenice: Boolean(input.credits),
    ...(llm ? { llm } : {}),
    deployment: input.deployment,
  };
}

/** Codex on a Venice model: the owner's own key (pasted, or saved in the
 * Vault and read by the server), or Hivra credits. Always receipt-bearing. */
export type CodexModelSelection =
  | { mode: "byok"; model: string; apiKey: string }
  | { mode: "byok"; model: string; vaultKeyId: string }
  | { mode: "managed"; model: string; walletType: Wallet };

export function codexModelRequest(input: {
  name: string;
  cpu: number;
  ram: number;
  maximumCpu?: number;
  maximumRam?: number;
  browser: boolean;
  deployment: AgentDeploymentDestination;
  llm: CodexModelSelection;
  launchRequestId: string;
}): CreateAgentInput & { llm: AgentLlmInput; launchRequestId: string } {
  const llm: AgentLlmInput = input.llm.mode === "managed"
    ? { provider: "venice", mode: "managed", model: input.llm.model, walletType: input.llm.walletType }
    : "vaultKeyId" in input.llm
      ? { provider: "venice", mode: "byok", model: input.llm.model, vaultKeyId: input.llm.vaultKeyId }
      : { provider: "venice", mode: "byok", model: input.llm.model, apiKey: input.llm.apiKey };
  return {
    type: "codex",
    name: input.name.trim(),
    cpu: input.cpu,
    ram: input.ram,
    ...(input.maximumCpu === undefined ? {} : { maximumCpu: input.maximumCpu }),
    ...(input.maximumRam === undefined ? {} : { maximumRam: input.maximumRam }),
    browser: input.browser,
    deployment: input.deployment,
    llm,
    launchRequestId: input.launchRequestId,
  };
}

/** How a Hermes agent reaches a model. "unconfigured" seeds nothing, so
 * Hermes asks for a provider itself before the first chat. */
export type HermesModelChoice =
  | { kind: "unconfigured" }
  | { kind: "managed"; model: string; walletType: Wallet }
  | { kind: "key"; provider: string; model: string; vaultKeyId?: string | null; apiKey?: string | null; baseUrl?: string };

/** The body the Hermes setup form posts to /api/instances. */
export function hermesInstanceRequest(input: {
  name: string;
  model: HermesModelChoice;
  honcho?: { vaultKeyId?: string | null; apiKey?: string | null };
  systemPrompt?: string;
  fingerprintRequestId?: string | null;
  cpu: number;
  ramGb: number;
}): Record<string, unknown> {
  const name = input.name.trim();
  const choice = input.model;
  const providerId = choice.kind === "unconfigured" ? "" : choice.kind === "managed" ? "venice" : choice.provider;
  const model = choice.kind === "unconfigured" ? "" : choice.model;
  const agentSettings = buildWelcomeAgentSettings({
    // Unconfigured leaves the agent without a provider, model or base URL so
    // its own onboarding asks for one. (The server also seeds nothing then.)
    providerId,
    model,
    customBaseUrl: choice.kind === "unconfigured"
      ? ""
      : choice.kind === "managed"
        ? getManagedVeniceProxyBaseUrl()
        : choice.baseUrl ?? "",
    systemPrompt: input.systemPrompt,
    runtimeMode: "managed",
    // Privileged VM/Docker control is an explicit opt-in in Advanced Cloud
    // Access. New agents start in the managed, non-root posture.
    enableRootAccess: false,
    webUseGateway: false,
    imageGenUseGateway: false,
    ttsUseGateway: false,
    browserUseGateway: false,
  });
  const vaultKeyId = choice.kind === "key" ? choice.vaultKeyId?.trim() || null : null;
  const apiKey = choice.kind === "key" ? choice.apiKey?.trim() || null : null;
  const honchoVaultKeyId = input.honcho?.vaultKeyId?.trim() || null;
  const honchoApiKey = input.honcho?.apiKey?.trim() || null;
  const aiPeer = name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  return {
    name,
    ...(choice.kind === "unconfigured"
      ? { unconfigured: true }
      : {
          provider: providerId,
          model,
          ...(choice.kind === "managed"
            ? { apiKey: "" }
            : vaultKeyId
              ? { vaultKeyId }
              : apiKey
                ? { apiKey }
                : {}),
          ...(choice.kind === "managed"
            ? { managedVenice: { enabled: true, walletType: choice.walletType } }
            : {}),
        }),
    honcho: {
      enabled: true,
      peerName: "user",
      aiPeer,
      memoryMode: "hybrid",
      recallMode: "hybrid",
      ...(!honchoVaultKeyId && honchoApiKey ? { apiKey: honchoApiKey } : {}),
    },
    ...(honchoVaultKeyId ? { honchoVaultKeyId } : {}),
    ...(input.fingerprintRequestId ? { fingerprintRequestId: input.fingerprintRequestId } : {}),
    agentSettings,
    cpuLimit: input.cpu,
    ramLimit: input.ramGb * 1024,
  };
}
