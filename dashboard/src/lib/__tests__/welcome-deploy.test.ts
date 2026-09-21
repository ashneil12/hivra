import {
  buildPostDeployDestination,
  buildWelcomeAgentSettings,
  hasWelcomeGatewaySelection,
} from "@/lib/welcome-deploy";

describe("buildWelcomeAgentSettings", () => {
  it("defaults welcome deployments to admin-mode-off managed mode", () => {
    const settings = buildWelcomeAgentSettings({
      providerId: "openai",
      model: "gpt-5.4",
      customBaseUrl: "",
    });

    expect(settings.runtimeMode).toBe("managed");
    expect(settings.enableRootAccess).toBe(false);
    expect(settings.mountPersistentSource).toBe(false);
    expect(settings.browserProvider).toBe("local");
    expect(settings.webUseGateway).toBe(false);
    expect(settings.imageGenUseGateway).toBe(false);
    expect(settings.ttsUseGateway).toBe(false);
    expect(settings.browserUseGateway).toBe(false);
    expect(settings.fallbackModels).toContain('"provider":"openai"');
  });

  it("only includes a custom base URL for custom_llm providers", () => {
    const customSettings = buildWelcomeAgentSettings({
      providerId: "custom_llm",
      model: "my-model",
      customBaseUrl: "https://llm.example.com/v1",
    });
    const standardSettings = buildWelcomeAgentSettings({
      providerId: "openai",
      model: "gpt-5.4",
      customBaseUrl: "https://ignored.example.com/v1",
    });

    expect(customSettings.customLlmBaseUrl).toBe("https://llm.example.com/v1");
    expect(standardSettings.customLlmBaseUrl).toBeUndefined();
  });

  it("passes operator template system prompts into welcome deploy settings", () => {
    const settings = buildWelcomeAgentSettings({
      providerId: "openai",
      model: "gpt-5.4",
      customBaseUrl: "",
      systemPrompt: "  You are Crypto Radar.  ",
    });

    expect(settings.systemPrompt).toBe("You are Crypto Radar.");
  });

  it("includes gateway toggles when welcome deploy opts into the Nous subscription path", () => {
    const settings = buildWelcomeAgentSettings({
      providerId: "openai",
      model: "gpt-5.4",
      customBaseUrl: "",
      webUseGateway: true,
      imageGenUseGateway: true,
      ttsUseGateway: true,
      browserUseGateway: true,
    });

    expect(settings.webUseGateway).toBe(true);
    expect(settings.imageGenUseGateway).toBe(true);
    expect(settings.ttsUseGateway).toBe(true);
    expect(settings.browserUseGateway).toBe(true);
  });

  it("enables persistent developer runtime defaults without changing admin mode", () => {
    const settings = buildWelcomeAgentSettings({
      providerId: "openai",
      model: "gpt-5.4",
      customBaseUrl: "",
      runtimeMode: "developer",
    });

    expect(settings.runtimeMode).toBe("developer");
    expect(settings.mountPersistentSource).toBe(false);
    expect(settings.enableRootAccess).toBe(false);
  });

  it("allows welcome deploys to opt into persistent source mounts separately", () => {
    const settings = buildWelcomeAgentSettings({
      providerId: "openai",
      model: "gpt-5.4",
      customBaseUrl: "",
      runtimeMode: "developer",
      mountPersistentSource: true,
    });

    expect(settings.runtimeMode).toBe("developer");
    expect(settings.mountPersistentSource).toBe(true);
  });

  it("allows welcome deploys to opt out of root explicitly", () => {
    const settings = buildWelcomeAgentSettings({
      providerId: "openai",
      model: "gpt-5.4",
      customBaseUrl: "",
      enableRootAccess: false,
    });

    expect(settings.runtimeMode).toBe("managed");
    expect(settings.mountPersistentSource).toBe(false);
    expect(settings.enableRootAccess).toBe(false);
  });

  it("detects when the welcome deploy selected any gateway-backed tool", () => {
    expect(hasWelcomeGatewaySelection({})).toBe(false);
    expect(hasWelcomeGatewaySelection({ browserUseGateway: true })).toBe(true);
  });

  it("routes gateway-enabled first deploys to the main instance onboarding prompt", () => {
    expect(
      buildPostDeployDestination({
        instanceId: "inst-123",
        imageGenUseGateway: true,
      })
    ).toBe("/dashboard/instances/inst-123?focus=nous-tool-gateway");

    expect(
      buildPostDeployDestination({
        instanceId: "inst-123",
      })
    ).toBe("/dashboard/instances/inst-123");

    expect(
      buildPostDeployDestination({
        instanceId: "inst-123",
        welcome: true,
      })
    ).toBe("/dashboard/instances/inst-123?surface=chat&welcome=1");
  });

  it("routes primary Nous deployments into the first-launch OAuth prompt", () => {
    expect(
      buildPostDeployDestination({
        instanceId: "inst-123",
        providerId: "nous",
      })
    ).toBe("/dashboard/instances/inst-123?focus=nous-tool-gateway");
  });
});
