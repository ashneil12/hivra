import { buildInstanceInsertPayload } from "@/lib/instance-record";

describe("buildInstanceInsertPayload", () => {
  it("omits honcho_api_key_encrypted when no Honcho key is provided", () => {
    const payload = buildInstanceInsertPayload({
      userId: "user-1",
      name: "bio",
      subdomain: "subdomain-1",
      provider: "alibaba",
      encryptedApiKey: "enc-primary",
      apiKeyPreview: "enc-pr...mary",
      config: { model: "qwen3.5-plus" },
      honchoApiKeyEncrypted: undefined,
      resourceTier: "operator",
      diskSizeGb: 40,
      infrastructureProvider: "proxmox",
    });

    expect(payload).not.toHaveProperty("honcho_api_key_encrypted");
    expect(payload).toMatchObject({
      lifecycle_state: "provisioning",
      resource_tier: "operator",
      disk_size_gb: 40,
      infrastructure_provider: "proxmox",
    });
  });

  it("includes honcho_api_key_encrypted when a Honcho key is provided", () => {
    const payload = buildInstanceInsertPayload({
      userId: "user-1",
      name: "bio",
      subdomain: "subdomain-1",
      provider: "alibaba",
      encryptedApiKey: "enc-primary",
      apiKeyPreview: "enc-pr...mary",
      config: { model: "qwen3.5-plus" },
      honchoApiKeyEncrypted: "enc-honcho",
    });

    expect(payload).toHaveProperty("honcho_api_key_encrypted", "enc-honcho");
  });
});
