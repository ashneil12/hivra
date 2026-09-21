import type { AgentSettings } from "@/lib/services/hetzner-instance-service";
import { isNousAuthProvider } from "@/lib/provider-auth";

type WelcomeGatewayFlags = {
  webUseGateway?: boolean;
  imageGenUseGateway?: boolean;
  ttsUseGateway?: boolean;
  browserUseGateway?: boolean;
};

export function buildWelcomeAgentSettings(params: {
  providerId: string;
  model: string;
  customBaseUrl: string;
  runtimeMode?: "managed" | "developer";
  enableRootAccess?: boolean;
  mountPersistentSource?: boolean;
  systemPrompt?: string;
} & WelcomeGatewayFlags): AgentSettings {
  const {
    providerId,
    model,
    customBaseUrl,
    runtimeMode = "managed",
    enableRootAccess = false,
    mountPersistentSource = false,
    systemPrompt,
    webUseGateway = false,
    imageGenUseGateway = false,
    ttsUseGateway = false,
    browserUseGateway = false,
  } = params;

  return {
    runtimeMode,
    maxIterations: 60,
    toolProgressMode: "all",
    compressionThreshold: 0.85,
    sessionResetMode: "both",
    enableRootAccess,
    mountPersistentSource: runtimeMode === "developer" ? mountPersistentSource : false,
    browserProvider: "local",
    webUseGateway,
    imageGenUseGateway,
    ttsUseGateway,
    browserUseGateway,
    fallbackModels: JSON.stringify([{ provider: providerId, model, apiKey: "" }]),
    ...(systemPrompt?.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
    ...(providerId === "custom_llm" || (providerId === "venice" && customBaseUrl.trim())
      ? { customLlmBaseUrl: customBaseUrl.trim() }
      : {}),
  };
}

export function hasWelcomeGatewaySelection(flags: WelcomeGatewayFlags): boolean {
  return Boolean(
    flags.webUseGateway ||
      flags.imageGenUseGateway ||
      flags.ttsUseGateway ||
      flags.browserUseGateway
  );
}

export function buildPostDeployDestination(params: {
  instanceId: string;
  providerId?: string;
  welcome?: boolean;
} & WelcomeGatewayFlags): string {
  const { instanceId, providerId, welcome, ...flags } = params;

  if (!hasWelcomeGatewaySelection(flags) && !isNousAuthProvider(providerId)) {
    return welcome
      ? `/dashboard/instances/${instanceId}?surface=chat&welcome=1`
      : `/dashboard/instances/${instanceId}`;
  }

  const search = new URLSearchParams({ focus: "nous-tool-gateway" });
  if (welcome) {
    search.set("surface", "chat");
    search.set("welcome", "1");
  }
  return `/dashboard/instances/${instanceId}?${search.toString()}`;
}
