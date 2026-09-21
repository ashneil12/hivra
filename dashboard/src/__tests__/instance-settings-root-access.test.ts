import {
  buildAdvancedInstanceConfigPayload,
  buildStoredInstanceConfig,
  getRuntimeAgentSettings,
} from "@/lib/instance-settings";

describe("instance settings root access behavior", () => {
  it("defaults root access off for runtime settings", () => {
    const runtime = getRuntimeAgentSettings(undefined);

    expect(runtime.enableRootAccess).toBe(false);
  });

  it("preserves mountPersistentSource and enableRootAccess through stored config", () => {
    const stored = buildStoredInstanceConfig(undefined, {
      agentSettings: {
        enableRootAccess: false,
        mountPersistentSource: true,
      },
    });

    const runtime = getRuntimeAgentSettings(stored);

    expect(runtime.enableRootAccess).toBe(false);
    expect(runtime.mountPersistentSource).toBe(true);
    expect(runtime.runtimeMode).toBe("developer");
  });

  it("does not force persistence just because runtimeMode is developer", () => {
    const runtime = getRuntimeAgentSettings({
      agentSettings: {
        runtimeMode: "developer",
      },
    });

    expect(runtime.runtimeMode).toBe("developer");
    expect(runtime.mountPersistentSource).toBe(false);
    expect(runtime.enableRootAccess).toBe(false);
  });

  it("preserves root access without forcing a persistent source mount", () => {
    const stored = buildStoredInstanceConfig(undefined, {
      agentSettings: {
        enableRootAccess: true,
        mountPersistentSource: false,
      },
    });

    const runtime = getRuntimeAgentSettings(stored);

    expect(runtime.runtimeMode).toBe("managed");
    expect(runtime.enableRootAccess).toBe(true);
    expect(runtime.mountPersistentSource).toBe(false);
  });

  it("can disable root without dropping an existing developer source mount", () => {
    const current = buildStoredInstanceConfig(undefined, {
      agentSettings: {
        runtimeMode: "developer",
        enableRootAccess: true,
        mountPersistentSource: true,
      },
    });

    const next = buildAdvancedInstanceConfigPayload(current, {
      agentSettings: {
        enableRootAccess: false,
      },
    });

    const runtime = getRuntimeAgentSettings(next);

    expect(runtime.runtimeMode).toBe("developer");
    expect(runtime.enableRootAccess).toBe(false);
    expect(runtime.mountPersistentSource).toBe(true);
  });

  it("can disable root on a managed instance without changing its runtime mode", () => {
    const current = buildStoredInstanceConfig(undefined, {
      agentSettings: {
        runtimeMode: "managed",
        enableRootAccess: true,
        mountPersistentSource: false,
      },
    });

    const next = buildAdvancedInstanceConfigPayload(current, {
      agentSettings: {
        enableRootAccess: false,
      },
    });

    const runtime = getRuntimeAgentSettings(next);

    expect(runtime.runtimeMode).toBe("managed");
    expect(runtime.enableRootAccess).toBe(false);
    expect(runtime.mountPersistentSource).toBe(false);
  });
});
