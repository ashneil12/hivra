type TailscaleAccessState = "disconnected" | "connecting" | "connected" | "error";

export type TailscaleConfig = {
  enabled: boolean;
  hostScoped: boolean;
  state: TailscaleAccessState;
  machineName?: string;
  magicDnsName?: string;
  tailnetName?: string;
  ipv4?: string;
  ipv6?: string;
  sshEnabled?: boolean;
  tags?: string[];
  connectedAt?: string;
  lastError?: string | null;
};

type TailscaleSecretLikeFields = {
  authKey?: string;
};

export function sanitizeTailscaleConfig(
  config: TailscaleConfig & TailscaleSecretLikeFields
): TailscaleConfig {
  const { authKey, ...safeConfig } = config;
  void authKey;
  return safeConfig;
}

export function buildTailscaleConfigPatch(
  currentConfig: Record<string, unknown> | undefined,
  patch: Partial<TailscaleConfig>
): Record<string, unknown> {
  const currentPrivateAccess =
    typeof currentConfig?.privateAccess === "object" && currentConfig.privateAccess
      ? (currentConfig.privateAccess as Record<string, unknown>)
      : {};
  const currentTailscale =
    typeof currentPrivateAccess.tailscale === "object" && currentPrivateAccess.tailscale
      ? (currentPrivateAccess.tailscale as Record<string, unknown>)
      : {};

  return {
    ...(currentConfig || {}),
    privateAccess: {
      ...currentPrivateAccess,
      tailscale: {
        ...currentTailscale,
        ...patch,
      },
    },
  };
}

export function getPublicTailscaleConfig(
  config: (TailscaleConfig & TailscaleSecretLikeFields) | undefined
): TailscaleConfig | undefined {
  if (!config) return undefined;
  return sanitizeTailscaleConfig(config);
}
