import { AgentComputerSchema } from "../contracts";
import { projectHermesInstance, projectHivraAgent } from "../projectors";

const SECRET_SENTINEL = "DO_NOT_SERIALIZE_PROJECTOR_SECRET";
const FORBIDDEN_KEYS = new Set([
  "token",
  "secret",
  "password",
  "apiKey",
  "privateKey",
  "honcho_api_key_encrypted",
  "config",
]);

function assertSecretSafe(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(SECRET_SENTINEL);

  function walk(node: unknown): void {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, nested] of Object.entries(node)) {
      expect(FORBIDDEN_KEYS).not.toContain(key);
      walk(nested);
    }
  }

  walk(value);
}

describe("Hermes compatibility projection", () => {
  it("advertises bounded webfree capabilities for a known running record", () => {
    const projected = projectHermesInstance({
      id: "instance-1",
      name: "Hermes",
      status: "running",
      backend: "gateway",
    });

    expect(projected.id).toBe("h-instance-1");
    expect(projected.capabilities).toEqual({
      surfaces: ["terminal"],
      actions: ["stop", "reboot", "delete"],
    });
    expect(projected.state).toEqual({
      desired: "unknown",
      observed: "running",
      health: "unknown",
      operation: null,
    });
    expect(AgentComputerSchema.safeParse(projected).success).toBe(true);
  });

  it("preserves contradictory lifecycle evidence independently", () => {
    const projected = projectHermesInstance(
      {
        id: "instance-2",
        name: "Contradictory Hermes",
        status: "stopped",
        backend: "webui",
      },
      {
        desired: "running",
        health: "unreachable",
        operation: {
          state: "starting",
          id: "operation-2",
          observedAt: "2026-08-24T16:00:00.000Z",
        },
      }
    );

    expect(projected.state).toEqual({
      desired: "running",
      observed: "stopped",
      health: "unreachable",
      operation: {
        state: "starting",
        id: "operation-2",
        observedAt: "2026-08-24T16:00:00.000Z",
      },
    });
  });

  it.each([
    ["sparse", { id: "instance-3", name: "Sparse" }],
    [
      "unknown",
      {
        id: "instance-4",
        name: "Unknown",
        status: "teleporting",
        backend: "gateway",
      },
    ],
    [
      "deleted",
      {
        id: "instance-5",
        name: "Deleted",
        status: "deleted",
        backend: "gateway",
      },
    ],
  ])("fails closed for a %s record", (_label, record) => {
    const projected = projectHermesInstance(record);

    expect(projected.capabilities).toEqual({ surfaces: [], actions: [] });
    expect(AgentComputerSchema.safeParse(projected).success).toBe(true);
  });

  it("drops raw config and credential-shaped fields by construction", () => {
    const projected = projectHermesInstance({
      id: "instance-6",
      name: "Secret fixture",
      status: "running",
      backend: "gateway",
      config: { token: SECRET_SENTINEL },
      honcho_api_key_encrypted: SECRET_SENTINEL,
      apiKey: SECRET_SENTINEL,
    } as Parameters<typeof projectHermesInstance>[0] & Record<string, unknown>);

    assertSecretSafe(projected);
  });
});

describe("Hivra compatibility projection", () => {
  it("projects a running Linux desktop with computer-only surfaces and evidenced actions", () => {
    const projected = projectHivraAgent({
      id: "desktop-1",
      name: "Ubuntu",
      status: "running",
      type: "linux-desktop",
      computerSubstrate: "proxmox-kvm",
    });

    expect(projected.capabilities).toEqual({
      surfaces: ["files", "terminal", "desktop"],
      actions: ["stop", "reboot", "delete", "resize", "snapshot", "restore"],
    });
    expect(AgentComputerSchema.safeParse(projected).success).toBe(true);
  });

  it("advertises only the accepted desktop surface for Windows", () => {
    const projected = projectHivraAgent({
      id: "windows-1",
      name: "Windows",
      status: "running",
      type: "linux-desktop",
      computerProfile: "windows",
      computerSubstrate: "proxmox-kvm",
    });

    expect(projected.capabilities).toEqual({
      surfaces: ["desktop"],
      actions: ["stop", "reboot", "delete", "resize", "snapshot", "restore"],
    });
  });

  it("does not advertise Proxmox-only lifecycle actions for a provider VM", () => {
    const projected = projectHivraAgent({
      id: "desktop-provider-1",
      name: "Provider Ubuntu",
      status: "running",
      type: "linux-desktop",
      computerSubstrate: "provider-vm",
    });

    expect(projected.capabilities).toEqual({
      surfaces: ["files", "terminal", "desktop"],
      actions: ["stop", "reboot", "delete"],
    });
  });

  it("fails closed on advanced lifecycle actions without substrate evidence", () => {
    const projected = projectHivraAgent({
      id: "desktop-unknown-1",
      name: "Unclassified Ubuntu",
      status: "stopped",
      type: "linux-desktop",
    });

    expect(projected.capabilities.actions).toEqual(["start", "delete"]);
  });

  it("advertises only evidenced surfaces and provision/delete behavior", () => {
    const projected = projectHivraAgent({
      id: "agent-1",
      name: "Codex",
      status: "running",
      type: "codex",
      browserEnabled: true,
      canProvision: true,
    });

    expect(projected.id).toBe("x-agent-1");
    expect(projected.capabilities).toEqual({
      surfaces: ["files", "git", "terminal", "browser"],
      actions: ["provision", "delete"],
    });
    expect(projected.state).toEqual({
      desired: "unknown",
      observed: "running",
      health: "unknown",
      operation: null,
    });
    expect(AgentComputerSchema.safeParse(projected).success).toBe(true);
  });

  it("keeps explicit evidence separate from source status", () => {
    const projected = projectHivraAgent(
      {
        id: "agent-2",
        name: "Stopped Codex",
        status: "stopped",
        type: "codex",
      },
      {
        desired: "running",
        health: "degraded",
        operation: { state: "starting", idempotencyKey: "request-2" },
      }
    );

    expect(projected.state).toEqual({
      desired: "running",
      observed: "stopped",
      health: "degraded",
      operation: { state: "starting", idempotencyKey: "request-2" },
    });
  });

  it.each([
    ["sparse", { id: "agent-3", name: "Sparse" }],
    [
      "unknown",
      {
        id: "agent-4",
        name: "Unknown",
        status: "running",
        type: "future-agent",
      },
    ],
    [
      "deleted",
      {
        id: "agent-5",
        name: "Deleted",
        status: "deleted",
        type: "codex",
      },
    ],
  ])("fails closed for a %s record", (_label, record) => {
    const projected = projectHivraAgent(record);

    expect(projected.capabilities).toEqual({ surfaces: [], actions: [] });
    expect(AgentComputerSchema.safeParse(projected).success).toBe(true);
  });

  it("bounds source status and strips token, URL, config, and secret sentinels", () => {
    const projected = projectHivraAgent({
      id: "agent-6",
      name: "Secret fixture",
      status: `RUNNING${"x".repeat(100)}`,
      type: "codex",
      api_token: SECRET_SENTINEL,
      chat_url: `https://example.invalid/${SECRET_SENTINEL}`,
      config: { password: SECRET_SENTINEL },
      privateKey: SECRET_SENTINEL,
    } as Parameters<typeof projectHivraAgent>[0] & Record<string, unknown>);

    expect(projected.compatibility.sourceStatus).toHaveLength(64);
    expect(projected.capabilities).toEqual({ surfaces: [], actions: [] });
    assertSecretSafe(projected);
  });
});
