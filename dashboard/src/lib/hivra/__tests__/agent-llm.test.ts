import {
  validateLlmInput,
  readStoredLlmConfig,
  buildBoxLlmPayload,
  publicLlmConfig,
  sanitizeHivraAgentRow,
  llmBaseUrl,
  VENICE_DIRECT_BASE_URL,
  VENICE_DEFAULT_MODEL,
  type StoredLlmConfig,
} from "@/lib/hivra/agent-llm";

describe("validateLlmInput", () => {
  it("treats null/empty selector as no-op (native auth)", () => {
    expect(validateLlmInput(null, "codex")).toEqual({ ok: true });
    expect(validateLlmInput(undefined, "codex")).toEqual({ ok: true });
    expect(validateLlmInput({ provider: "" }, "codex")).toEqual({ ok: true });
  });

  it("rejects non-object llm", () => {
    expect(validateLlmInput("venice", "codex").ok).toBe(false);
  });

  it("rejects unsupported provider", () => {
    const r = validateLlmInput({ provider: "openai", mode: "byok", apiKey: "k" }, "codex");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unsupported/);
  });

  it("rejects venice on an agent type that doesn't declare the capability", () => {
    // claude-code declares providers:[] (shim not shipped); hermes/aeon omit llm.
    expect(validateLlmInput({ provider: "venice", mode: "byok", apiKey: "k" }, "claude-code").ok).toBe(false);
    expect(validateLlmInput({ provider: "venice", mode: "byok", apiKey: "k" }, "aeon").ok).toBe(false);
    expect(validateLlmInput({ provider: "venice", mode: "byok", apiKey: "k" }, "hermes").ok).toBe(false);
  });

  it("accepts venice byok on codex with a key", () => {
    const r = validateLlmInput({ provider: "venice", mode: "byok", apiKey: " vk_test_123 ", model: "deepseek-v4-pro" }, "codex");
    expect(r.ok).toBe(true);
    expect(r.input).toEqual({ provider: "venice", mode: "byok", apiKey: "vk_test_123", model: "deepseek-v4-pro", walletType: undefined });
  });

  it("requires a key for byok", () => {
    const r = validateLlmInput({ provider: "venice", mode: "byok" }, "codex");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/key is required/i);
  });

  it("does NOT require a key for managed (Hivra mints it)", () => {
    const r = validateLlmInput({ provider: "venice", mode: "managed", walletType: "card" }, "codex");
    expect(r.ok).toBe(true);
    expect(r.input).toMatchObject({ mode: "managed", walletType: "card", apiKey: undefined });
  });

  it("defaults managed wallet to hermesos", () => {
    const r = validateLlmInput({ provider: "venice", mode: "managed" }, "codex");
    expect(r.input?.walletType).toBe("hermesos");
  });

  it("rejects an invalid mode", () => {
    expect(validateLlmInput({ provider: "venice", mode: "free" }, "codex").ok).toBe(false);
  });

  it("rejects a malformed model id (charset clamp)", () => {
    const r = validateLlmInput({ provider: "venice", mode: "byok", apiKey: "k", model: "bad model!" }, "codex");
    expect(r.ok).toBe(false);
  });

  it("rejects an over-long key", () => {
    const r = validateLlmInput({ provider: "venice", mode: "byok", apiKey: "x".repeat(300) }, "codex");
    expect(r.ok).toBe(false);
  });

  it.each([
    [], { provider: "", apiKey: "synthetic-private-key" }, { apiKey: "synthetic-private-key" },
    { provider: "venice", mode: "byok", apiKey: "short" },
    { provider: "venice", mode: "byok", apiKey: "synthetic key" },
    { provider: "venice", mode: "byok", apiKey: "synthetic\nkey" },
    { provider: "venice", mode: "byok", apiKey: "synthetic-private-key", model: 42 },
    { provider: "venice", mode: "byok", apiKey: "synthetic-private-key", host: "different.example" },
    { provider: "venice", mode: "byok", apiKey: "synthetic-private-key", walletType: "card" },
    { provider: "venice", mode: "managed", walletType: "unknown" },
    { provider: "venice", mode: "managed", apiKey: "synthetic-private-key" },
  ])("rejects invalid launch credentials without a native or wallet fallback: %j", input => {
    const result = validateLlmInput(input, "codex");
    expect(result.ok).toBe(false);
    expect(result.input).toBeUndefined();
    expect(result.error).not.toContain("synthetic-private-key");
  });
});

describe("readStoredLlmConfig", () => {
  it("returns null for junk / non-venice / bad mode", () => {
    expect(readStoredLlmConfig(null)).toBeNull();
    expect(readStoredLlmConfig("nope")).toBeNull();
    expect(readStoredLlmConfig({ provider: "openai", mode: "byok" })).toBeNull();
    expect(readStoredLlmConfig({ provider: "venice", mode: "weird" })).toBeNull();
  });

  it("parses a managed config and drops a malformed model", () => {
    const cfg = readStoredLlmConfig({
      provider: "venice",
      mode: "managed",
      model: "has space",
      proxyKeyId: "pk_1",
      keyPrefix: "hven_live_ab",
      walletType: "card",
      enabledAt: "2026-06-11T00:00:00.000Z",
    });
    expect(cfg).toMatchObject({ provider: "venice", mode: "managed", model: null, proxyKeyId: "pk_1", walletType: "card" });
  });
});

describe("llmBaseUrl + buildBoxLlmPayload", () => {
  it("byok points at Venice directly", () => {
    expect(llmBaseUrl("byok")).toBe(VENICE_DIRECT_BASE_URL);
  });

  it("managed points at the dashboard gateway", () => {
    expect(llmBaseUrl("managed")).toMatch(/\/api\/managed-venice\/v1$/);
  });

  it("falls back to the default model when none stored", () => {
    const cfg: StoredLlmConfig = { provider: "venice", mode: "byok", model: null, enabledAt: "x" };
    expect(buildBoxLlmPayload(cfg, "vk_key").model).toBe(VENICE_DEFAULT_MODEL);
  });

  it("carries the plaintext key + resolved base url", () => {
    const cfg: StoredLlmConfig = { provider: "venice", mode: "managed", model: "deepseek-v4-pro", enabledAt: "x" };
    expect(buildBoxLlmPayload(cfg, "hven_live_abc")).toMatchObject({
      provider: "venice",
      apiKey: "hven_live_abc",
      model: "deepseek-v4-pro",
    });
  });
});

describe("sanitizeHivraAgentRow", () => {
  it("keeps the server-selected managed provisioner channel private", () => {
    const out = sanitizeHivraAgentRow({
      id: "agent",
      managed_provisioner_channel: "canary",
    });
    expect(out).not.toHaveProperty("managed_provisioner_channel");
  });

  it.each(["provider_install_not_after", "provider_install_identity", "provider_install_dispatched_at", "provider_install_stopped_at", "provider_install_outcome"])("keeps private installer journal %s server-side", field => {
    const out = sanitizeHivraAgentRow({ id: "agent", status: "provisioning", operation_kind: "provision", [field]: { operationId: "private-install-identity" } });
    expect(out).not.toHaveProperty(field);
    expect(JSON.stringify(out)).not.toContain("private-install-identity");
    expect(out.activity).toBe("provision");
  });
  it.each(["provision", "start", "restart", "resize", "stop", null])("honors delete intent while the %s lease is retained", (operation_kind) => {
    const out = sanitizeHivraAgentRow({
      status: "provisioning", desired_state: "deleted", operation_kind,
      provisioned_at: null, operation_id: "retained-private-lease",
    });
    expect(out.activity).toBe("cancelling");
    expect(out).not.toHaveProperty("operation_id");
    expect(out).not.toHaveProperty("operation_kind");
  });

  it("distinguishes active deletion from requested cancellation", () => {
    expect(sanitizeHivraAgentRow({ status: "provisioning", desired_state: "deleted", operation_kind: "delete" }).activity).toBe("delete");
  });

  it.each(["provision", "start", "stop", "restart", "resize", "delete"])("projects only the display activity for %s", (operation_kind) => {
    const out = sanitizeHivraAgentRow({
      status: "provisioning", operation_kind, operation_id: "private-lease-id",
      operation_payload: { cpu: 8, ram: 16 }, activity: "untrusted value",
    });
    expect(out.activity).toBe(operation_kind);
    expect(out).not.toHaveProperty("operation_kind");
    expect(out).not.toHaveProperty("operation_id");
    expect(out).not.toHaveProperty("operation_payload");
  });

  it.each([
    { status: "running", operation_kind: "restart" },
    { status: "error", operation_kind: "provision" },
    { status: "provisioning", operation_kind: "unknown" },
    { status: "provisioning", operation_kind: null },
    { status: "provisioning", operation_kind: { restart: true } },
  ])("does not expose inactive or unknown operation details: %j", (row) => {
    expect(sanitizeHivraAgentRow(row).activity).toBeNull();
  });

  it("strips the encrypted key and exposes only the key-free summary", () => {
    const row = {
      id: "a1",
      name: "Box",
      llm_api_key_encrypted: "ENCRYPTED_SECRET",
      infrastructure_binding_token_hash: "b".repeat(64),
      infrastructure_binding_token_enforced: true,
      allocation_operation_id: "11111111-1111-4111-8111-111111111111",
      operation_id: "22222222-2222-4222-8222-222222222222",
      operation_kind: "provision",
      operation_started_at: "2026-08-26T12:00:00.000Z",
      operation_payload: { cpu: 8, ram: 16 },
      llm_config: {
        provider: "venice",
        mode: "managed",
        model: "deepseek-v4-pro",
        proxyKeyId: "pk_1",
        keyPrefix: "hven_live_ab",
        walletType: "hermesos",
        enabledAt: "2026-06-11T00:00:00.000Z",
      },
    };
    const out = sanitizeHivraAgentRow(row);
    expect(out).not.toHaveProperty("llm_api_key_encrypted");
    expect(JSON.stringify(out)).not.toContain("ENCRYPTED_SECRET");
    expect(out).not.toHaveProperty("infrastructure_binding_token_hash");
    expect(out).not.toHaveProperty("infrastructure_binding_token_enforced");
    expect(out).not.toHaveProperty("allocation_operation_id");
    expect(out).not.toHaveProperty("operation_id");
    expect(out).not.toHaveProperty("operation_kind");
    expect(out).not.toHaveProperty("operation_started_at");
    expect(out).not.toHaveProperty("operation_payload");
    // proxyKeyId is internal; the public summary must not leak it either.
    expect(out.llm_config).toEqual({
      provider: "venice",
      mode: "managed",
      model: "deepseek-v4-pro",
      keyPrefix: "hven_live_ab",
      walletType: "hermesos",
      enabledAt: "2026-06-11T00:00:00.000Z",
    });
  });

  it("yields llm_config:null for a row with no config", () => {
    const out = sanitizeHivraAgentRow({ id: "a2", name: "Plain" });
    expect(out.llm_config).toBeNull();
  });
});

describe("publicLlmConfig", () => {
  it("never includes proxyKeyId", () => {
    const summary = publicLlmConfig({
      provider: "venice",
      mode: "managed",
      model: null,
      proxyKeyId: "pk_secret",
      keyPrefix: "hven_live_xy",
      walletType: "hermesos",
      enabledAt: "x",
    });
    expect(JSON.stringify(summary)).not.toContain("pk_secret");
    expect(summary).not.toHaveProperty("proxyKeyId");
  });
});
