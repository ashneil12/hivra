import {
  isWorkspaceShellEnabled,
  isWorkspaceShellNavigationEnabled,
} from "../workspace-shell";

const ENV_KEYS = [
  "HIVRA_WORKSPACE_SHELL_ENABLED",
  "NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED",
  "NEXT_PUBLIC_HIVRA_AGENTS",
] as const;

const originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined> = {
  HIVRA_WORKSPACE_SHELL_ENABLED: undefined,
  NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED: undefined,
  NEXT_PUBLIC_HIVRA_AGENTS: undefined,
};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("workspace shell rollout decisions", () => {
  it.each([undefined, "", "   ", "0", "false", "off", "yes", "enabled"])(
    "keeps the server shell disabled for %p",
    (value) => {
      expect(isWorkspaceShellEnabled(value)).toBe(false);
    },
  );

  it.each(["1", "true", "on", " TRUE ", " On "])(
    "enables the server shell for %p",
    (value) => {
      expect(isWorkspaceShellEnabled(value)).toBe(true);
    },
  );

  it("reads the server-only environment decision when no value is supplied", () => {
    expect(isWorkspaceShellEnabled()).toBe(false);

    process.env.HIVRA_WORKSPACE_SHELL_ENABLED = "1";
    expect(isWorkspaceShellEnabled()).toBe(true);
  });

  it("keeps client navigation default-off and parses only its public counterpart", () => {
    expect(isWorkspaceShellNavigationEnabled()).toBe(false);

    process.env.NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED = " true ";
    expect(isWorkspaceShellNavigationEnabled()).toBe(true);

    process.env.NEXT_PUBLIC_HIVRA_WORKSPACE_SHELL_ENABLED = "0";
    expect(isWorkspaceShellNavigationEnabled()).toBe(false);
  });

  it("does not enable either workspace decision from the broader Hivra-agent flag", () => {
    process.env.NEXT_PUBLIC_HIVRA_AGENTS = "1";

    expect(isWorkspaceShellEnabled()).toBe(false);
    expect(isWorkspaceShellNavigationEnabled()).toBe(false);
  });
});
