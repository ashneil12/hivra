import {
  codexModelRequest,
  dashboardAgentRequest,
  hermesInstanceRequest,
  nativeCliAgentRequest,
} from "../runtime-requests";
import {
  legacyDashboardAgentBody,
  legacyHermesDeployBody,
  legacyNativeCliBody,
} from "./legacy-welcome-requests";

/** What the request looks like on the wire (undefined fields are dropped). */
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));

const MANAGED = { mode: "hivra-managed" } as const;
const SELF_MANAGED = {
  mode: "self-managed",
  connectionId: "11111111-1111-4111-8111-111111111111",
  targetId: "22222222-2222-4222-8222-222222222222",
  expectedConnectionRevision: 3,
} as const;

describe("Hermes instance request parity with the welcome deploy form", () => {
  const base = {
    agentName: "  Research Bot 7! ",
    selectedProviderId: "venice",
    model: "deepseek-v4-flash",
    customBaseUrl: "",
    managedVeniceWalletType: "card" as const,
    apiKey: "",
    honchoApiKey: "",
    fingerprintRequestId: "fp-request-1",
    cpuLimit: 2,
    deployRamGb: 4,
  };

  it("sends an unconfigured Hermes (set up inside it) exactly as Managed off did", () => {
    expect(wire(hermesInstanceRequest({
      name: base.agentName,
      model: { kind: "unconfigured" },
      honcho: { vaultKeyId: null },
      fingerprintRequestId: base.fingerprintRequestId,
      cpu: 2,
      ramGb: 4,
    }))).toEqual(legacyHermesDeployBody({ ...base, cleanSlateDeploy: true, managedVeniceDeploy: false }));
  });

  it.each(["card", "hermesos"] as const)("sends Hivra credits (%s wallet) exactly as managed Venice did", walletType => {
    expect(wire(hermesInstanceRequest({
      name: base.agentName,
      model: { kind: "managed", model: "deepseek-v4-flash", walletType },
      fingerprintRequestId: base.fingerprintRequestId,
      cpu: 2,
      ramGb: 4,
    }))).toEqual(legacyHermesDeployBody({
      ...base, cleanSlateDeploy: false, managedVeniceDeploy: true, managedVeniceWalletType: walletType,
    }));
  });

  it("sends a saved Vault key by its id, never the key", () => {
    const body = wire(hermesInstanceRequest({
      name: base.agentName,
      model: { kind: "key", provider: "openrouter", model: "openai/gpt-5.4-pro", vaultKeyId: "vault-key-1" },
      honcho: { vaultKeyId: "honcho-key-1" },
      fingerprintRequestId: base.fingerprintRequestId,
      cpu: 4,
      ramGb: 8,
    }));
    expect(body).toEqual(legacyHermesDeployBody({
      ...base, cleanSlateDeploy: false, managedVeniceDeploy: false, selectedProviderId: "openrouter",
      model: "openai/gpt-5.4-pro", resolvedVaultKeyId: "vault-key-1", resolvedHonchoVaultKeyId: "honcho-key-1",
      cpuLimit: 4, deployRamGb: 8,
    }));
    expect(body).not.toHaveProperty("apiKey");
  });

  it("sends a pasted key and a custom endpoint exactly as the form did", () => {
    expect(wire(hermesInstanceRequest({
      name: base.agentName,
      model: {
        kind: "key", provider: "custom_llm", model: "llama3.2", apiKey: "  sk-local-1234  ",
        baseUrl: "https://llm.example.test/v1",
      },
      honcho: { apiKey: " honcho-pasted " },
      fingerprintRequestId: null,
      cpu: 0.5,
      ramGb: 1,
    }))).toEqual(legacyHermesDeployBody({
      ...base, cleanSlateDeploy: false, managedVeniceDeploy: false, selectedProviderId: "custom_llm",
      model: "llama3.2", apiKey: "  sk-local-1234  ", customBaseUrl: "https://llm.example.test/v1",
      honchoApiKey: " honcho-pasted ", fingerprintRequestId: null, cpuLimit: 0.5, deployRamGb: 1,
    }));
  });

  it("sends an OAuth provider with no key at all, as the form allowed", () => {
    expect(wire(hermesInstanceRequest({
      name: "Hermes 1",
      model: { kind: "key", provider: "nous", model: "nousresearch/hermes-4-405b" },
      fingerprintRequestId: null,
      cpu: 2,
      ramGb: 4,
    }))).toEqual(legacyHermesDeployBody({
      ...base, agentName: "Hermes 1", cleanSlateDeploy: false, managedVeniceDeploy: false,
      selectedProviderId: "nous", model: "nousresearch/hermes-4-405b", fingerprintRequestId: null,
    }));
  });
});

describe("Claude Code and native Codex request parity with their welcome form", () => {
  it.each([
    ["claude-code", null, MANAGED, true],
    ["claude-code", null, SELF_MANAGED, false],
    ["codex", "33333333-3333-4333-8333-333333333333", MANAGED, false],
  ] as const)("sends %s exactly as the form did (request id %s)", (type, launchRequestId, deployment, browser) => {
    expect(wire(nativeCliAgentRequest({
      type, name: " Claude Code 1 ", cpu: 2, ram: 4, browser, deployment, launchRequestId,
    }))).toEqual(legacyNativeCliBody({
      agentId: type, agentName: " Claude Code 1 ", resolvedCpu: 2, resolvedRam: 4,
      effectiveBrowser: browser, deployment, nativeRequestId: launchRequestId,
    }));
  });

  it("names Claude Code's launch without a receipt id: its lane takes none", () => {
    expect(nativeCliAgentRequest({ type: "claude-code", name: "Claude Code 1", cpu: 0.5, ram: 1, browser: false, deployment: MANAGED }))
      .not.toHaveProperty("launchRequestId");
  });
});

describe("OpenClaw, Agent Zero and Aeon request parity with their welcome form", () => {
  it.each([
    ["openclaw", false, 0, 0],
    ["openclaw", true, 5_000_000, 0],
    ["openclaw", true, 0, 5_000_000],
    ["agent-zero", true, 0, 0],
    ["agent-zero", false, 1, 1],
    ["aeon", true, 5_000_000, 5_000_000],
    ["aeon", false, 0, 0],
  ] as const)("sends %s with credits %s (card %d, token %d) exactly as the form did", (type, credits, card, token) => {
    // The form billed the card wallet unless only the token wallet had credit.
    const walletType = card <= 0 && token > 0 ? "hermesos" : "card";
    expect(wire(dashboardAgentRequest({
      type, name: "Agent 1", cpu: 1, ram: 2, browser: type === "openclaw",
      credits: credits ? { walletType } : null,
      deployment: MANAGED,
    }))).toEqual(legacyDashboardAgentBody({
      agentId: type, agentName: "Agent 1", resolvedCpu: 1, resolvedRam: 2, effectiveBrowser: type === "openclaw",
      wantManaged: credits, cardMicro: card, hermesosMicro: token, deployment: MANAGED,
    }));
  });

  it("mints OpenClaw and Agent Zero credits at launch, but leaves Aeon's to its GitHub connect step", () => {
    const openclaw = dashboardAgentRequest({ type: "openclaw", name: "OpenClaw 1", cpu: 1, ram: 2, browser: false, credits: { walletType: "card" }, deployment: MANAGED });
    const aeon = dashboardAgentRequest({ type: "aeon", name: "Aeon 1", cpu: 0.5, ram: 1, browser: false, credits: { walletType: "card" }, deployment: MANAGED });
    expect(openclaw).toMatchObject({ managedVenice: true, llm: { provider: "venice", mode: "managed", walletType: "card" } });
    expect(aeon).toMatchObject({ managedVenice: true });
    expect(aeon).not.toHaveProperty("llm");
  });
});

describe("Codex model launch requests", () => {
  const shared = {
    name: "Codex 1",
    cpu: 0.5,
    ram: 1,
    browser: false,
    deployment: MANAGED,
    launchRequestId: "33333333-3333-4333-8333-333333333333",
  };

  it("carries a saved Vault key by reference only", () => {
    const request = codexModelRequest({ ...shared, llm: { mode: "byok", model: "deepseek-v4-pro", vaultKeyId: "44444444-4444-4444-8444-444444444444" } });
    expect(request.llm).toEqual({ provider: "venice", mode: "byok", model: "deepseek-v4-pro", vaultKeyId: "44444444-4444-4444-8444-444444444444" });
    expect(request.llm).not.toHaveProperty("apiKey");
  });

  it("sends Codex's size maxima only when the journey chose them", () => {
    const withoutMaxima = codexModelRequest({ ...shared, llm: { mode: "managed", model: "deepseek-v4-pro", walletType: "card" } });
    expect(withoutMaxima).not.toHaveProperty("maximumCpu");
    expect(withoutMaxima).not.toHaveProperty("maximumRam");
    expect(codexModelRequest({ ...shared, maximumCpu: 2, maximumRam: 4, llm: { mode: "managed", model: "deepseek-v4-pro", walletType: "card" } }))
      .toMatchObject({ maximumCpu: 2, maximumRam: 4 });
  });
});
