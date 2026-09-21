interface BuildInstanceInsertPayloadParams {
  userId: string;
  name: string;
  subdomain: string;
  provider: string;
  encryptedApiKey: string;
  apiKeyPreview: string;
  config: Record<string, unknown>;
  honchoApiKeyEncrypted?: string;
  hostId?: string;
  cpuLimit?: number;
  ramLimit?: number;
  diskSizeGb?: number;
  resourceTier?: string;
  infrastructureProvider?: "hetzner" | "proxmox";
  backend?: "gateway" | "webui";
  productSurface?: "hermesos" | "workspace_cloud";
}

export function buildInstanceInsertPayload(params: BuildInstanceInsertPayloadParams) {
  const payload = {
    user_id: params.userId,
    name: params.name,
    subdomain: params.subdomain,
    status: "provisioning",
    lifecycle_state: "provisioning",
    provider: params.provider,
    api_key_encrypted: params.encryptedApiKey,
    api_key_preview: params.apiKeyPreview,
    config: params.config,
    host_id: params.hostId,
    cpu_limit: params.cpuLimit,
    ram_limit: params.ramLimit,
    disk_size_gb: params.diskSizeGb,
    resource_tier: params.resourceTier,
    infrastructure_provider: params.infrastructureProvider,
    backend: params.backend,
    product_surface: params.productSurface ?? "hermesos",
  } as {
    user_id: string;
    name: string;
    subdomain: string;
    status: "provisioning";
    lifecycle_state: "provisioning";
    provider: string;
    api_key_encrypted: string;
    api_key_preview: string;
    config: Record<string, unknown>;
    honcho_api_key_encrypted?: string;
    host_id?: string;
    cpu_limit?: number;
    ram_limit?: number;
    disk_size_gb?: number;
    resource_tier?: string;
    infrastructure_provider?: "hetzner" | "proxmox";
    backend?: "gateway" | "webui";
    product_surface: "hermesos" | "workspace_cloud";
  };

  if (params.honchoApiKeyEncrypted) {
    payload.honcho_api_key_encrypted = params.honchoApiKeyEncrypted;
  }

  return payload;
}
