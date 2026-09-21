import {
  projectWorkspaceHermes,
  projectWorkspaceHivra,
  type WorkspaceProjectionResult,
} from "../workspace-projection";

const SECRET_SENTINEL = "DO_NOT_SERIALIZE_WORKSPACE_SECRET";
const QUERY_SENTINEL = "secret_query=DO_NOT_COPY";
const FRAGMENT_SENTINEL = "DO_NOT_COPY_FRAGMENT";
const FORBIDDEN_KEYS = new Set([
  "token",
  "secret",
  "password",
  "apiKey",
  "config",
  "api_token",
  "chat_url",
  "gateway_url",
]);

function requireProjected(
  result: WorkspaceProjectionResult,
): Extract<WorkspaceProjectionResult, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected a projection, received ${result.reason}`);
  return result;
}

function assertSecretSafe(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(SECRET_SENTINEL);
  expect(serialized).not.toContain(QUERY_SENTINEL);
  expect(serialized).not.toContain(FRAGMENT_SENTINEL);

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

describe("workspace agent-computer projection", () => {
  it("keeps colliding Hermes and Hivra source identities distinct", () => {
    const hermes = requireProjected(
      projectWorkspaceHermes({
        id: "shared-id",
        name: "Hermes computer",
        status: "running",
        backend: "gateway",
      }),
    );
    const hivra = requireProjected(
      projectWorkspaceHivra({
        id: "shared-id",
        name: "Codex computer",
        status: "running",
        type: "codex",
        browserEnabled: true,
      }),
    );

    expect(hermes.computer.id).toBe("h-shared-id");
    expect(hermes.computer.source).toEqual({ kind: "hermes", id: "shared-id" });
    expect(hivra.computer.id).toBe("x-shared-id");
    expect(hivra.computer.source).toEqual({ kind: "hivra", id: "shared-id" });
  });

  it("describes only surfaces advertised by the parsed Hermes projection", () => {
    const result = requireProjected(
      projectWorkspaceHermes({
        id: "hermes-1",
        name: "Hermes",
        status: "running",
        backend: "webui",
      }),
    );

    // Only the terminal genuinely adds a surface beside the conversation; the
    // other three were the conversation's own embed under different labels.
    expect(result.computer.capabilities.surfaces).toEqual(["terminal"]);
    expect(result.surfaces).toEqual([{ surface: "terminal", label: "Terminal" }]);
    expect(result.compatibility).toEqual({ mode: "projected", label: "Compatibility mode" });
  });

  it("describes only surfaces advertised by the parsed Hivra projection", () => {
    const result = requireProjected(
      projectWorkspaceHivra({
        id: "hivra-1",
        name: "Codex",
        status: "running",
        type: "codex",
        browserEnabled: false,
      }),
    );

    expect(result.computer.capabilities.surfaces).toEqual([
      "files",
      "git",
      "terminal",
    ]);
    expect(result.surfaces.map(({ surface }) => surface)).toEqual(
      result.computer.capabilities.surfaces,
    );
    expect(result.surfaces).not.toContainEqual(expect.objectContaining({ surface: "browser" }));
    expect(result.surfaces).not.toContainEqual(expect.objectContaining({ surface: "desktop" }));
    expect(result.surfaces).not.toContainEqual(expect.objectContaining({ surface: "native" }));
  });

  it("accepts a Linux desktop and exposes only its computer surfaces", () => {
    const result = requireProjected(
      projectWorkspaceHivra({
        id: "desktop-1",
        name: "Ubuntu",
        status: "running",
        type: "linux-desktop",
      }),
    );

    expect(result.surfaces.map(({ surface }) => surface)).toEqual([
      "files",
      "terminal",
      "desktop",
    ]);
  });

  it("does not project Linux Files or Terminal capabilities for Windows", () => {
    const result = requireProjected(
      projectWorkspaceHivra({
        id: "windows-1",
        name: "Windows",
        status: "running",
        type: "linux-desktop",
        computerProfile: "windows",
      }),
    );

    expect(result.surfaces).toEqual([{ surface: "desktop", label: "Desktop" }]);
  });

  it("preserves desired, observed, health, and operation evidence independently", () => {
    const result = requireProjected(
      projectWorkspaceHermes(
        {
          id: "hermes-2",
          name: "Contradictory Hermes",
          status: "stopped",
          backend: "gateway",
        },
        {
          desired: "running",
          health: "unreachable",
          operation: {
            state: "starting",
            id: "operation-2",
            observedAt: "2026-08-24T16:00:00.000Z",
          },
        },
      ),
    );

    expect(result.computer.state).toEqual({
      desired: "running",
      observed: "stopped",
      health: "unreachable",
      operation: {
        state: "starting",
        id: "operation-2",
        observedAt: "2026-08-24T16:00:00.000Z",
      },
    });
    expect(result).not.toHaveProperty("status");
  });

  it.each([
    ["sparse Hermes", projectWorkspaceHermes({ id: "sparse-h", name: "Sparse" })],
    [
      "deleted Hermes",
      projectWorkspaceHermes({
        id: "deleted-h",
        name: "Deleted",
        status: "deleted",
        backend: "gateway",
      }),
    ],
    [
      "unknown Hermes backend",
      projectWorkspaceHermes({
        id: "unknown-h",
        name: "Unknown",
        status: "running",
        backend: "future-backend",
      }),
    ],
    ["sparse Hivra", projectWorkspaceHivra({ id: "sparse-x", name: "Sparse" })],
    [
      "deleted Hivra",
      projectWorkspaceHivra({
        id: "deleted-x",
        name: "Deleted",
        status: "deleted",
        type: "codex",
      }),
    ],
    [
      "unknown Hivra type",
      projectWorkspaceHivra({
        id: "unknown-x",
        name: "Unknown",
        status: "running",
        type: "future-agent",
      }),
    ],
  ])("fails closed for %s", (_label, result) => {
    expect(result).toMatchObject({ ok: false, state: "unknown", surfaces: [] });
    expect(result).not.toHaveProperty("computer");
  });

  it.each([
    ["non-object Hermes", projectWorkspaceHermes(null)],
    ["malformed Hermes", projectWorkspaceHermes({ id: 42, name: "Bad" })],
    ["non-object Hivra", projectWorkspaceHivra("bad")],
    [
      "malformed Hivra evidence",
      projectWorkspaceHivra(
        { id: "hivra-bad", name: "Bad evidence", status: "running", type: "codex" },
        { desired: "definitely-running" } as never,
      ),
    ],
  ])("returns a typed invalid result for %s", (_label, result) => {
    expect(result).toEqual({
      ok: false,
      state: "invalid",
      reason: "invalid-record",
      surfaces: [],
    });
  });

  it("excludes secret-shaped fields, sentinels, query strings, and fragments recursively", () => {
    const hermes = projectWorkspaceHermes({
      id: "secret-h",
      name: "Secret Hermes",
      status: "running",
      backend: "gateway",
      gateway_url: `https://example.invalid/workspace?${QUERY_SENTINEL}#${FRAGMENT_SENTINEL}`,
      config: { password: SECRET_SENTINEL },
      token: SECRET_SENTINEL,
    });
    const hivra = projectWorkspaceHivra({
      id: "secret-x",
      name: "Secret Hivra",
      status: "running",
      type: "codex",
      browserEnabled: true,
      api_token: SECRET_SENTINEL,
      chat_url: `https://example.invalid/chat?${QUERY_SENTINEL}#${FRAGMENT_SENTINEL}`,
      secret: SECRET_SENTINEL,
      apiKey: SECRET_SENTINEL,
    });

    assertSecretSafe(hermes);
    assertSecretSafe(hivra);
  });
});
